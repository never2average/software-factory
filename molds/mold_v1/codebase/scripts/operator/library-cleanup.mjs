// operator:library-cleanup — list, and only when told to remove, the rows an earlier build seeded into a workspace
// that this deployment does not use.
//
//   npm run operator:library-cleanup                       # DRY RUN, every workspace: what would go, what stays and why
//   npm run operator:library-cleanup -- --org <id>         # one workspace
//   npm run operator:library-cleanup -- --org <id> --apply # remove the rows listed as removable; nothing else
//   npm run operator:library-cleanup -- --json             # the same plan as JSON on stdout
//
// It knows starter apps too (the apps a library gives a new workspace): one from a library this build no longer
// names is removable while nobody has edited, opened or refreshed it, and kept from then on.
//
// Nothing is ever removed without --apply, and --apply removes only rows nobody edited, ran or built on. A row a
// person touched is kept and listed with the evidence. The rules are in scripts/operator/lib/library-cleanup.mjs.
//
// A deployment whose profile names a library (`library.sources`) keeps that library's rows: they are not leftovers.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDb, closeDb, withOrgDb } from "../../agent/lib/db/index.ts";
import * as schema from "../../agent/lib/db/schema.ts";
import { VOCABULARY } from "../../agent/lib/agent-vocabulary.ts";
import { deploymentRecipes, deploymentStarterApps, deploymentWorkflowLibrary } from "../../agent/lib/workflow-library-view.ts";
import { LIBRARY_SOURCES } from "../../agent/lib/workflow-library.generated.ts";
import { knownLibraries, scriptSkeleton } from "../lib/profile-library.mjs";
import { applyPlan, planWorkspace } from "./lib/library-cleanup.mjs";
import { flag, glyph, hasFlag } from "./lib/operator.mjs";
import { eq } from "drizzle-orm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function main() {
  const apply = hasFlag("apply");
  const json = hasFlag("json");
  const only = flag("org").trim();
  const db = getDb();
  if (!db) {
    console.error(`${glyph.bad} No DATABASE_URL — run with --env-file=.env.local.`);
    process.exit(1);
  }
  const ctx = {
    libraries: knownLibraries(ROOT),
    skeleton: scriptSkeleton,
    provisioned: {
      workflows: new Set(deploymentWorkflowLibrary().map((w) => w.name)),
      recipes: new Set(deploymentRecipes().map((r) => r.slug)),
      apps: new Set(deploymentStarterApps().map((a) => a.key)),
    },
    sources: LIBRARY_SOURCES,
    excluded: VOCABULARY.excludedSpecialists,
  };
  const all = only
    ? await db.select({ orgId: schema.orgs.orgId, name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.orgId, only))
    : await db.select({ orgId: schema.orgs.orgId, name: schema.orgs.name }).from(schema.orgs);
  if (only && !all.length) {
    console.error(`${glyph.bad} No such workspace: ${only}`);
    await closeDb();
    process.exit(1);
  }
  const say = (line = "") => { if (!json) console.log(line); };
  say(`${apply ? "REMOVING" : "DRY RUN (nothing is changed; add --apply to remove what is listed as removable)"}`);
  say(`The library of this build: ${LIBRARY_SOURCES.length ? LIBRARY_SOURCES.join(", ") : "none"}. Specialists it excludes: ${ctx.excluded.length ? ctx.excluded.join(", ") : "none"}.`);
  say(`Libraries known to this repository: ${ctx.libraries.map((l) => l.id).join(", ") || "none"}.`);
  const report = [];
  for (const org of all.sort((a, b) => a.orgId.localeCompare(b.orgId))) {
    const result = await withOrgDb(org.orgId, async (tx) => {
      const plan = await planWorkspace(tx, schema, org.orgId, ctx);
      const removed = apply ? await applyPlan(tx, schema, org.orgId, plan) : null;
      return { ...plan, removed };
    });
    report.push({ workspace: org.orgId, ...result });
    say(`\n${org.orgId}  (${org.name})`);
    if (!result.removable.length && !result.kept.length) { say(`  ${glyph.ok} nothing left over`); continue; }
    const kind = (r) => (r.table === "recipes" ? "recipe  " : r.table === "apps" ? "app     " : "workflow");
    say(`  ${apply ? "removed" : "would remove"} (${result.removable.length}): never edited, never run or opened, nothing built on them`);
    for (const r of result.removable) say(`    ${glyph.info} ${kind(r)} ${r.name}  — ${r.origin}`);
    say(`  kept (${result.kept.length}):`);
    for (const r of result.kept) say(`    ${glyph.warn} ${kind(r)} ${r.name}  — ${r.origin}; ${r.why.join("; ")}`);
    if (result.removed) say(`  ${glyph.ok} removed ${result.removed.workflows} workflow row(s), ${result.removed.recipes} recipe row(s) and ${result.removed.apps} starter app(s)`);
  }
  if (json) console.log(JSON.stringify({ applied: apply, library: LIBRARY_SOURCES, excluded: ctx.excluded, workspaces: report }, null, 2));
  else if (!apply && report.some((r) => r.removable.length)) say(`\nNothing was changed. To remove the rows listed as removable: npm run operator:library-cleanup -- ${only ? `--org ${only} ` : ""}--apply`);
  await closeDb();
}

main().catch(async (e) => {
  console.error(`${glyph.bad} library-cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
  await closeDb().catch(() => {});
  process.exit(1);
});
