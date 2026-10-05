// What `npm run operator:library-cleanup` decides, kept apart from the command so a test can drive it against a
// database (scripts/test-library-provisioning-db.mjs).
//
// A workspace keeps every row it was ever given. Before the library became the deployment profile's, base code
// seeded its own workflows and recipes into every workspace of every deployment, and one row per base specialist
// whether or not the profile excluded it. This finds those rows in a workspace whose deployment does not use them,
// and sorts each into REMOVABLE (nobody ever touched it) or KEPT (somebody did), with the evidence.
//
// A row is a LEFTOVER when all of these hold:
//   workflow    its name is one a library directory in this repository has shipped (library/<id>/, today's files and
//               history.json), this deployment's profile does not provision that workflow, and the stored script's
//               code skeleton is one of that library's (scripts/lib/profile-library.mjs: the code without the words it
//               sends, so a row stored in another vocabulary still matches and a script somebody rewrote does not);
//   specialist  it is the scriptless "on delegation" row of a specialist this build's profile excludes;
//   recipe      its slug is one a library directory has shipped and this deployment's profile does not provision it.
//
// A leftover is KEPT, and reported with why, when a person edited it, ran it, or built on it:
//   edited      updated after it was created; operator instructions; a saved version (script or instructions);
//               notification recipients; an account scope; for a recipe, a body or a later update
//   ran         a workflow run or a recorded specialist run
//   built on    an app, a schedule or a system cron names it
//
// A row with a library workflow's NAME whose script is not the library's is not a leftover at all: it is somebody's
// own workflow. It is reported (so the operator sees why it was not offered for removal) and never removed.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

const EDIT_GRACE_MS = 2000;
const ms = (d) => (d instanceof Date ? d.getTime() : d ? new Date(d).getTime() : 0);

/**
 * Sort one workspace's rows. Pure: `rows` are the workflows and recipes, `evidence` what the database holds about
 * each workflow (by id), `ctx` what the deployment and the repository say.
 *
 *   ctx.libraries   knownLibraries(root): [{ id, workflows: Map<name, Set<skeleton>>, recipes: Set<slug> }]
 *   ctx.skeleton    scriptSkeleton
 *   ctx.provisioned { workflows: Set<name>, recipes: Set<slug> } what THIS deployment's profile provisions
 *   ctx.excluded    the specialists this deployment's profile excludes
 */
export function classify({ workflows, recipes, evidence }, ctx) {
  const removable = [];
  const kept = [];
  const libraryOf = (name) => ctx.libraries.find((l) => l.workflows.has(name));
  for (const w of workflows) {
    let origin = null;
    const script = (w.script ?? "").trim();
    const lib = ctx.provisioned.workflows.has(w.name) ? null : libraryOf(w.name);
    if (lib && script) {
      if (lib.workflows.get(w.name).has(ctx.skeleton(script))) origin = `workflow of the "${lib.id}" library, which this build's profile does not name`;
      else {
        kept.push({ table: "workflows", id: w.id, name: w.name, origin: `has the name of a workflow of the "${lib.id}" library`, why: ["its script is not that library's: edited, or written here"] });
        continue;
      }
    } else if (!script && (w.trigger ?? "on delegation") === "on delegation" && ctx.excluded.includes(w.name)) {
      origin = "row of a specialist this build's profile excludes";
    }
    if (!origin) continue;
    const e = evidence.get(w.id) ?? {};
    const why = [];
    if (ms(w.updatedAt) - ms(w.createdAt) > EDIT_GRACE_MS) why.push("edited: changed after it was created");
    if ((w.instructions ?? "").trim()) why.push("edited: has operator instructions");
    if (e.versions) why.push(`edited: ${e.versions} saved version(s)`);
    if (w.notifyEmail || (Array.isArray(w.notifyEmails) && w.notifyEmails.length)) why.push("edited: has notification recipients");
    if (w.customerId) why.push("edited: scoped to one account");
    if (e.workflowRuns) why.push(`ran: ${e.workflowRuns} workflow run(s)`);
    if (e.automationRuns) why.push(`ran: ${e.automationRuns} recorded run(s)`);
    if (e.apps?.length) why.push(`built on: app(s) ${e.apps.map((a) => `"${a}"`).join(", ")}`);
    if (e.schedules) why.push(`built on: ${e.schedules} schedule(s)`);
    if (e.crons) why.push(`built on: ${e.crons} system cron(s)`);
    (why.length ? kept : removable).push({ table: "workflows", id: w.id, name: w.name, origin, ...(why.length ? { why } : {}) });
  }
  for (const r of recipes) {
    if (ctx.provisioned.recipes.has(r.slug)) continue;
    const lib = ctx.libraries.find((l) => l.recipes.has(r.slug));
    if (!lib) continue;
    const origin = `recipe of the "${lib.id}" library, which this build's profile does not name`;
    const why = [];
    if (ms(r.updatedAt) - ms(r.createdAt) > EDIT_GRACE_MS) why.push("edited: changed after it was created");
    if ((r.body ?? "").trim()) why.push("edited: has a body");
    (why.length ? kept : removable).push({ table: "recipes", id: r.id, name: r.slug, origin, ...(why.length ? { why } : {}) });
  }
  return { removable, kept };
}

/** One workspace's plan. `tx` is scoped to `orgId` (withOrgDb); `schema` is agent/lib/db/schema.ts. */
export async function planWorkspace(tx, schema, orgId, ctx) {
  const { workflows, recipes, workflowInstructionVersions, workflowRuns, automationRuns, apps, scheduleRules, systemCronOverrides } = schema;
  const wfRows = await tx.select().from(workflows).where(eq(workflows.orgId, orgId));
  const recipeRows = await tx.select().from(recipes).where(eq(recipes.orgId, orgId));
  const evidence = new Map(wfRows.map((w) => [w.id, {}]));
  const ids = wfRows.map((w) => w.id);
  const names = [...new Set(wfRows.map((w) => w.name))];
  const idByName = new Map();
  for (const w of wfRows) idByName.set(w.name, [...(idByName.get(w.name) ?? []), w.id]);
  const bump = (id, key, n) => { const e = evidence.get(id); if (e) e[key] = (e[key] ?? 0) + Number(n); };
  if (ids.length) {
    for (const r of await tx.select({ id: workflowInstructionVersions.workflowId, n: sql`count(*)` }).from(workflowInstructionVersions)
      .where(and(eq(workflowInstructionVersions.orgId, orgId), inArray(workflowInstructionVersions.workflowId, ids))).groupBy(workflowInstructionVersions.workflowId)) bump(r.id, "versions", r.n);
    // A run names its workflow by id and by name; an older one by name only.
    for (const r of await tx.select({ id: workflowRuns.workflowId, name: workflowRuns.workflowName, n: sql`count(*)` }).from(workflowRuns)
      .where(and(eq(workflowRuns.orgId, orgId), inArray(workflowRuns.workflowName, names))).groupBy(workflowRuns.workflowId, workflowRuns.workflowName)) {
      for (const id of r.id && evidence.has(r.id) ? [r.id] : (idByName.get(r.name) ?? [])) bump(id, "workflowRuns", r.n);
    }
    for (const r of await tx.select({ id: automationRuns.automationId, n: sql`count(*)` }).from(automationRuns)
      .where(and(eq(automationRuns.orgId, orgId), eq(automationRuns.automationType, "workflow"), inArray(automationRuns.automationId, ids))).groupBy(automationRuns.automationId)) bump(r.id, "automationRuns", r.n);
    for (const a of await tx.select({ name: apps.name, workflow: apps.workflow }).from(apps)
      .where(and(eq(apps.orgId, orgId), isNull(apps.deletedAt), eq(apps.sourceKind, "workflow"), inArray(apps.workflow, names)))) {
      for (const id of idByName.get(a.workflow) ?? []) { const e = evidence.get(id); e.apps = [...(e.apps ?? []), a.name]; }
    }
    for (const r of await tx.select({ workflow: scheduleRules.workflow, n: sql`count(*)` }).from(scheduleRules)
      .where(and(eq(scheduleRules.orgId, orgId), inArray(scheduleRules.workflow, names))).groupBy(scheduleRules.workflow)) for (const id of idByName.get(r.workflow) ?? []) bump(id, "schedules", r.n);
    // A system cron's routing is the deployment's, not one workspace's: a cron that names the workflow keeps it everywhere.
    for (const r of await tx.select({ workflow: systemCronOverrides.workflow, n: sql`count(*)` }).from(systemCronOverrides)
      .where(inArray(systemCronOverrides.workflow, names)).groupBy(systemCronOverrides.workflow)) for (const id of idByName.get(r.workflow) ?? []) bump(id, "crons", r.n);
  }
  return classify({ workflows: wfRows, recipes: recipeRows, evidence }, ctx);
}

/** Delete exactly the rows a plan called removable, re-checked by id inside the workspace's scope. Returns counts. */
export async function applyPlan(tx, schema, orgId, plan) {
  const out = { workflows: 0, recipes: 0 };
  for (const table of ["workflows", "recipes"]) {
    const ids = plan.removable.filter((r) => r.table === table).map((r) => r.id);
    if (!ids.length) continue;
    const t = schema[table];
    const gone = await tx.delete(t).where(and(eq(t.orgId, orgId), inArray(t.id, ids))).returning({ id: t.id });
    out[table] = gone.length;
  }
  return out;
}
