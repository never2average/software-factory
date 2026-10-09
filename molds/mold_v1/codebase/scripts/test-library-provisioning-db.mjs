/**
 * WHAT A WORKSPACE IS PROVISIONED WITH, AND WHAT THE CLEANUP REMOVES, AGAINST A REAL POSTGRES.
 *
 * Base code used to write its own content into every workspace of every deployment: a recipe list in
 * agent/lib/provision-workspace.ts, every workflow script under one base directory, and one row per specialist in
 * the registry. The library is the deployment profile's now (`library.sources`), and this proves, with the real
 * provisionWorkspace against a fail-closed database:
 *
 *   1. a deployment on the default profile provisions NO recipe and NO library workflow: only one row per specialist;
 *   2. a deployment that opts into library/account-delivery is provisioned with exactly what base code carried
 *      before (scripts/fixtures/workflow-library/built-in-before.json): the 13 workflows and the 5 recipes, byte
 *      for byte what the old code stored. Nothing was lost in the move;
 *   3. under the relabelled fixture profile (scripts/fixtures/agent-vocabulary/50-relabelled.json, which mirrors a
 *      research pack) a specialist the profile excludes gets no row, a pack's specialist gets its own, and no
 *      provisioned workflow delegates to an excluded specialist;
 *   4. `operator:library-cleanup` on a workspace the OLD code provisioned: a dry run changes nothing; with --apply
 *      it removes only rows nobody edited, ran or built on, keeps and reports the rest with the evidence, and
 *      never touches a row that was not a leftover. A deployment that names the library keeps its rows.
 *
 * On the commit before this one it fails at the first import: provisionWorkspace took no source, the generated
 * library had no recipes, and scripts/operator/lib/library-cleanup.mjs did not exist. (With those stubbed, check 1
 * fails with 5 recipes and 13 library workflows in a default deployment's workspace.)
 *
 * NON-DESTRUCTIVE: every row lives under throwaway workspaces whose ids carry this process's pid, removed in a
 * finally block. Needs the app_rw url CI's `isolation` job builds; without DATABASE_URL it skips.
 *
 * Run:  DATABASE_URL=postgres://app_rw:…@127.0.0.1:5432/workspace_test npm run test:library-provisioning-db
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("test-library-provisioning-db: SKIPPED — needs DATABASE_URL (the app_rw url).");
  process.exit(0);
}
const ROOT = new URL("..", import.meta.url).pathname;

const { and, eq, inArray } = await import("drizzle-orm");
const { closeDb, getDb, withOrgDb } = await import("../agent/lib/db/index.ts");
const schema = await import("../agent/lib/db/schema.ts");
const { apps, automationRuns, orgs, recipes, workflowInstructionVersions, workflowRuns, workflows } = schema;
const { provisionWorkspace, deploymentSpecialists } = await import("../agent/lib/provision-workspace.ts");
const { deploymentRecipes, deploymentWorkflowLibrary, delegatesTo } = await import("../agent/lib/workflow-library-view.ts");
const generated = await import("../agent/lib/workflow-library.generated.ts");
const vocab = await import("../agent/lib/agent-vocabulary.ts");
const { SUBAGENT_KEYS } = await import("../agent/lib/subagent-registry.generated.ts");
const { knownLibraries, readLibrary, scriptSkeleton } = await import("./lib/profile-library.mjs");
const { applyPlan, planWorkspace } = await import("./operator/lib/library-cleanup.mjs");

let passed = 0;
const check = (label, condition, detail = "") => {
  assert.ok(condition, `${label}${detail ? `\n     ${detail}` : ""}`);
  passed++;
  console.log(`  ok   ${label}`);
};

const P = process.pid;
const ORG = { default: `libprov-default-${P}`, optin: `libprov-optin-${P}`, relabel: `libprov-relabel-${P}`, legacy: `libprov-legacy-${P}`, cli: `libprov-cli-${P}`, keeps: `libprov-keeps-${P}` };
const OWNER = "owner@example.com";
const BEFORE = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/workflow-library/built-in-before.json"), "utf8"));
const db = getDb();
assert.ok(db, "DATABASE_URL is set but getDb() returned null");

const rowsOf = (org) => withOrgDb(org, (tx) => tx.select().from(workflows).where(eq(workflows.orgId, org)));
const recipesOf = (org) => withOrgDb(org, (tx) => tx.select().from(recipes).where(eq(recipes.orgId, org)).orderBy(recipes.sortOrder));

/** The relabelled fixture profile, merged and validated by the real generator. */
function fixtureProfile() {
  const dir = mkdtempSync(join(tmpdir(), "libprov-profiles-"));
  cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
  cpSync(join(ROOT, "scripts/fixtures/agent-vocabulary/50-relabelled.json"), join(dir, "50-relabelled.json"));
  const r = spawnSync(process.execPath, ["scripts/gen-deployment-profile.mjs", "--print"], { cwd: ROOT, env: { ...process.env, PROFILES_DIR: dir }, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

try {
  for (const [k, id] of Object.entries(ORG)) await db.insert(orgs).values({ orgId: id, name: `Library provisioning probe (${k})`, status: "active" });

  console.log("\n1. The default profile: base code pushes no content into a workspace");
  {
    check("this build is on the default profile: no library source, an empty generated library", generated.LIBRARY_SOURCES.length === 0 && generated.WORKFLOW_LIBRARY.length === 0 && generated.RECIPE_LIBRARY.length === 0);
    const result = await withOrgDb(ORG.default, (tx) => provisionWorkspace(tx, ORG.default, OWNER));
    const rows = await rowsOf(ORG.default);
    check("no recipe is written", result.recipesCreated === 0 && (await recipesOf(ORG.default)).length === 0);
    check("no workflow with a script is written", rows.every((w) => !w.script), rows.filter((w) => w.script).map((w) => w.name).join(", "));
    const expected = deploymentSpecialists().map((s) => s.key).sort();
    check(`the only rows are one "on delegation" row per specialist of this deployment (${expected.length})`,
      JSON.stringify(rows.map((w) => w.name).sort()) === JSON.stringify(expected) && rows.every((w) => w.trigger === "on delegation"), rows.map((w) => w.name).sort().join(", "));
    check("none of the names base code used to seed is there", !rows.some((w) => BEFORE.workflows.some((b) => b.name === w.name)));
    const again = await withOrgDb(ORG.default, (tx) => provisionWorkspace(tx, ORG.default, OWNER));
    check("idempotent: a second run writes nothing", again.workflowsCreated === 0 && again.recipesCreated === 0 && again.workflowsSkipped === expected.length);
  }

  console.log("\n2. A deployment that opts into library/account-delivery gets exactly what base code carried before");
  const optIn = readLibrary(ROOT, { "account-delivery": "library/account-delivery" });
  {
    check("the library directory holds the 13 workflows, identical to the built-ins before the move", JSON.stringify(optIn.workflows) === JSON.stringify(BEFORE.workflows));
    check("…and the 5 recipes, identical and in the same order", JSON.stringify(optIn.recipes) === JSON.stringify(BEFORE.recipes));
    const result = await withOrgDb(ORG.optin, (tx) =>
      provisionWorkspace(tx, ORG.optin, OWNER, { workflows: deploymentWorkflowLibrary(vocab.VOCABULARY, optIn.workflows), recipes: deploymentRecipes(vocab.VOCABULARY, optIn.recipes) }),
    );
    const rows = (await rowsOf(ORG.optin)).filter((w) => w.script);
    check("13 library workflows and 5 recipes are written", rows.length === 13 && result.recipesCreated === 5, `${rows.length} workflows, ${result.recipesCreated} recipes`);
    // What the code before this change stored for a library workflow: the same view over the same bytes.
    const old = deploymentWorkflowLibrary(vocab.VOCABULARY, BEFORE.workflows);
    for (const o of old) {
      const row = rows.find((w) => w.name === o.name);
      assert.ok(row, `missing ${o.name}`);
      assert.equal(row.script, o.script, `${o.name}: script`);
      assert.equal(row.description, o.description, `${o.name}: description`);
      assert.deepEqual(row.steps, [...o.steps], `${o.name}: steps`);
      assert.equal(row.trigger, "manual");
    }
    check("each stored workflow is byte for byte what the old code stored (script, description, steps, trigger)", true);
    const stored = await recipesOf(ORG.optin);
    const oldRecipes = BEFORE.recipes.map((r, i) => ({ slug: r.slug, title: vocab.fill(r.title), summary: vocab.fill(r.summary), satisfiesCheck: r.satisfiesCheck, sortOrder: i }));
    check("each stored recipe is what the old code stored (slug, filled title and summary, check, order)",
      JSON.stringify(stored.map((r) => ({ slug: r.slug, title: r.title, summary: r.summary, satisfiesCheck: r.satisfiesCheck, sortOrder: r.sortOrder }))) === JSON.stringify(oldRecipes));
    check("no placeholder is stored unfilled in a recipe", !stored.some((r) => /\{[a-z_]+\}/.test(`${r.title} ${r.summary}`)));
  }

  console.log("\n3. The relabelled fixture profile: excluded specialists get no row, a pack's specialist gets its own");
  const profile = fixtureProfile();
  const PACK_SPECIALIST = "ledger-reader";
  const registry = [...SUBAGENT_KEYS, PACK_SPECIALIST];
  const v = vocab.createVocabulary(profile, registry.filter((k) => !profile.specialists.exclude.includes(k)));
  {
    check("the fixture excludes base specialists", v.excludedSpecialists.length > 0, v.excludedSpecialists.join(", "));
    // The registry as a stale build has it: every base specialist still listed, the pack's added.
    const specialists = deploymentSpecialists(registry, v.excludedSpecialists, { [PACK_SPECIALIST]: "Reads ledgers." });
    const library = deploymentWorkflowLibrary(v, optIn.workflows);
    await withOrgDb(ORG.relabel, (tx) => provisionWorkspace(tx, ORG.relabel, OWNER, { workflows: library, recipes: deploymentRecipes(v, optIn.recipes), specialists }));
    const rows = await rowsOf(ORG.relabel);
    const names = rows.map((w) => w.name);
    check("no excluded specialist has a row, even though the registry still lists it", !v.excludedSpecialists.some((k) => names.includes(k)), names.join(", "));
    check("the pack's specialist has its row, with its summary", rows.some((w) => w.name === PACK_SPECIALIST && w.trigger === "on delegation" && w.description === "Reads ledgers."));
    check("every specialist the profile keeps has its row", registry.filter((k) => !v.excludedSpecialists.includes(k)).every((k) => names.includes(k)));
    const scripted = rows.filter((w) => w.script);
    check("no provisioned workflow delegates to an excluded specialist", scripted.every((w) => !delegatesTo(w.script).some((k) => v.excludedSpecialists.includes(k))) && scripted.length === library.length && library.length < 13,
      `${scripted.length} provisioned of 13`);
  }

  console.log("\n4. operator:library-cleanup on a workspace the old code provisioned");
  const ctx = { libraries: knownLibraries(ROOT), skeleton: scriptSkeleton, provisioned: { workflows: new Set(), recipes: new Set() }, excluded: v.excludedSpecialists };
  /** What the old code wrote: its 13 workflows (in the vocabulary of the day), its 5 recipes, a row per base specialist. */
  async function seedLegacy(org, vocabulary) {
    const { speakLibraryWorkflow } = await import("../agent/lib/workflow-library-view.ts");
    await withOrgDb(org, async (tx) => {
      for (const w of BEFORE.workflows.map((x) => speakLibraryWorkflow(vocabulary, x))) {
        await tx.insert(workflows).values({ orgId: org, name: w.name, description: w.description, trigger: "manual", steps: w.steps, script: w.script, instructionsEnabled: false, enabled: true, createdBy: "system" });
      }
      for (const [i, r] of BEFORE.recipes.entries()) await tx.insert(recipes).values({ orgId: org, slug: r.slug, version: "1", title: vocab.fillWith(vocabulary, r.title), summary: vocab.fillWith(vocabulary, r.summary), satisfiesCheck: r.satisfiesCheck, sortOrder: i });
      for (const key of SUBAGENT_KEYS) await tx.insert(workflows).values({ orgId: org, name: key, description: "A specialist.", trigger: "on delegation", steps: [], script: null, instructionsEnabled: false, enabled: true, createdBy: OWNER });
    });
  }
  {
    // Stored in the RELABELLED vocabulary: the stored text is not the library's text, the code around it is.
    await seedLegacy(ORG.legacy, v);
    const before = await rowsOf(ORG.legacy);
    const id = (name) => before.find((w) => w.name === name).id;
    check("the legacy workspace holds 13 library workflows, 5 recipes and a row per base specialist", before.filter((w) => w.script).length === 13 && (await recipesOf(ORG.legacy)).length === 5);
    check("a row stored in the relabelled vocabulary is not byte-identical to the library's file", before.some((w) => w.script && w.script !== BEFORE.workflows.find((b) => b.name === w.name).script));
    const [excludedUsed, excludedIdle] = v.excludedSpecialists.filter((k) => SUBAGENT_KEYS.includes(k));
    assert.ok(excludedUsed && excludedIdle, "the fixture must exclude at least two base specialists");
    const kept = SUBAGENT_KEYS.find((k) => !v.excludedSpecialists.includes(k));
    await withOrgDb(ORG.legacy, async (tx) => {
      // edited: a person saved a new script (the route bumps updated_at and files a version)
      await tx.update(workflows).set({ description: "Ours now", updatedAt: new Date(Date.now() + 60_000) }).where(eq(workflows.id, id("qbr-prep")));
      await tx.insert(workflowInstructionVersions).values({ orgId: ORG.legacy, workflowId: id("renewal-risk"), kind: "script", content: "x", author: OWNER });
      await tx.update(workflows).set({ instructions: "Always cite the page." }).where(eq(workflows.id, id("route-incident")));
      // ran
      await tx.insert(workflowRuns).values({ orgId: ORG.legacy, runId: `wfr_libprov_${P}`, workflowId: id("infra-sizing"), workflowName: "infra-sizing", status: "completed" });
      await tx.insert(automationRuns).values({ orgId: ORG.legacy, automationType: "workflow", automationId: id(excludedUsed), status: "success", startedAt: new Date() });
      // built on
      await tx.insert(apps).values({ orgId: ORG.legacy, slug: `libprov-${P}`, name: "Sizing board", sourceKind: "workflow", workflow: "go-live-sprint", createdBy: OWNER });
      // rewritten in place without a trace in the bookkeeping: the script is no longer the library's
      await tx.update(workflows).set({ script: 'export const meta = { name: "assign-account", description: "ours" };\nreturn await agent("something else entirely");\n' }).where(eq(workflows.id, id("assign-account")));
      // somebody's own workflow, and a recipe somebody gave a body
      await tx.insert(workflows).values({ orgId: ORG.legacy, name: "our-own", description: "Written here.", trigger: "manual", steps: [], script: 'return await agent("hello");', createdBy: OWNER });
      await tx.update(recipes).set({ body: "Our own steps." }).where(and(eq(recipes.orgId, ORG.legacy), eq(recipes.slug, "connect-sources")));
    });

    const plan = await withOrgDb(ORG.legacy, (tx) => planWorkspace(tx, schema, ORG.legacy, ctx));
    const removable = plan.removable.map((r) => `${r.table}:${r.name}`).sort();
    const keptNames = Object.fromEntries(plan.kept.map((r) => [`${r.table}:${r.name}`, r.why.join("; ")]));
    const untouchedLibrary = BEFORE.workflows.map((w) => w.name).filter((n) => !["qbr-prep", "renewal-risk", "route-incident", "infra-sizing", "go-live-sprint", "assign-account"].includes(n));
    check("removable: every library workflow nobody touched (7 of 13), matched by its code although stored in other words",
      untouchedLibrary.length === 7 && untouchedLibrary.every((n) => removable.includes(`workflows:${n}`)), removable.join(", "));
    check("removable: the rows of excluded specialists that never ran", removable.includes(`workflows:${excludedIdle}`) && !removable.includes(`workflows:${excludedUsed}`));
    check("removable: the 4 recipes nobody edited", ["onboard-self", "import-roster", "seed-workflows", "onboard-customer"].every((s) => removable.includes(`recipes:${s}`)) && !removable.includes("recipes:connect-sources"));
    check("kept, with the evidence: edited after creation", /edited: changed after it was created/.test(keptNames["workflows:qbr-prep"] ?? ""), JSON.stringify(keptNames));
    check("kept: a saved version", /saved version/.test(keptNames["workflows:renewal-risk"] ?? ""));
    check("kept: operator instructions", /operator instructions/.test(keptNames["workflows:route-incident"] ?? ""));
    check("kept: it ran", /ran: 1 workflow run/.test(keptNames["workflows:infra-sizing"] ?? ""));
    check("kept: an app is built on it, named", /built on: app\(s\) "Sizing board"/.test(keptNames["workflows:go-live-sprint"] ?? ""));
    check("kept: an excluded specialist's row with a recorded run", /ran: 1 recorded run/.test(keptNames[`workflows:${excludedUsed}`] ?? ""));
    check("kept: a library name whose script is not the library's", /not that library's/.test(keptNames["workflows:assign-account"] ?? ""));
    check("kept: a recipe with a body", /has a body/.test(keptNames["recipes:connect-sources"] ?? ""));
    const mentioned = [...plan.removable, ...plan.kept].map((r) => r.name);
    check("never mentioned: a person's own workflow, and the row of a specialist this deployment has", !mentioned.includes("our-own") && !mentioned.includes(kept));

    const countAfterPlan = (await rowsOf(ORG.legacy)).length;
    check("planning is a dry run: no row was removed", countAfterPlan === before.length + 1 && (await recipesOf(ORG.legacy)).length === 5);

    const removed = await withOrgDb(ORG.legacy, (tx) => applyPlan(tx, schema, ORG.legacy, plan));
    const after = await rowsOf(ORG.legacy);
    const left = after.map((w) => w.name);
    check("apply removes exactly the removable rows", removed.workflows === plan.removable.filter((r) => r.table === "workflows").length && removed.recipes === 4 && after.length === countAfterPlan - removed.workflows);
    check("every kept row is still there", plan.kept.filter((r) => r.table === "workflows").every((r) => left.includes(r.name)) && (await recipesOf(ORG.legacy)).map((r) => r.slug).join() === "connect-sources");
    check("…and so is everything that was never a leftover", left.includes("our-own") && left.includes(kept));
    const second = await withOrgDb(ORG.legacy, (tx) => planWorkspace(tx, schema, ORG.legacy, ctx));
    check("a second run finds nothing more to remove", second.removable.length === 0 && second.kept.length === plan.kept.length);
  }
  {
    // A deployment whose profile NAMES the library: its rows are not leftovers.
    await seedLegacy(ORG.keeps, vocab.VOCABULARY);
    const named = { ...ctx, excluded: [], provisioned: { workflows: new Set(optIn.workflows.map((w) => w.name)), recipes: new Set(optIn.recipes.map((r) => r.slug)) } };
    const plan = await withOrgDb(ORG.keeps, (tx) => planWorkspace(tx, schema, ORG.keeps, named));
    check("a deployment that opts into the library is offered nothing to remove", plan.removable.length === 0 && plan.kept.length === 0);
  }
  {
    // The command itself, as an operator runs it against this build (default profile: no library, nothing excluded).
    await seedLegacy(ORG.cli, vocab.VOCABULARY);
    const run = (...args) => spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/operator/library-cleanup.mjs", ...args], { cwd: ROOT, env: process.env, encoding: "utf8" });
    const cli = (...flags) => run("--org", ORG.cli, ...flags);
    const dry = cli();
    check("the command's default is a dry run that says so and lists 13 workflows and 5 recipes", dry.status === 0 && /DRY RUN/.test(dry.stdout) && /would remove \(18\)/.test(dry.stdout) && /Nothing was changed/.test(dry.stdout), dry.stdout + dry.stderr);
    check("…and removes nothing", (await rowsOf(ORG.cli)).filter((w) => w.script).length === 13 && (await recipesOf(ORG.cli)).length === 5);
    const json = cli("--json");
    const parsed = JSON.parse(json.stdout);
    check("--json prints the same plan for a program, still without changing anything", parsed.applied === false && parsed.workspaces[0].removable.length === 18 && (await recipesOf(ORG.cli)).length === 5);
    const applied = cli("--apply");
    const left = await rowsOf(ORG.cli);
    check("--apply removes them, and leaves the specialists' rows (this build excludes none)", applied.status === 0 && /removed 13 workflow row\(s\), 5 recipe row\(s\) and 0 starter app\(s\)/.test(applied.stdout) && left.length === SUBAGENT_KEYS.length && left.every((w) => !w.script), applied.stdout + applied.stderr);
    const other = run("--org", "no-such-workspace", "--apply");
    check("an unknown workspace is refused", other.status === 1 && /No such workspace/.test(other.stderr));
  }

  console.log(`\ntest-library-provisioning-db: ${passed} checks passed`);
} finally {
  try {
    for (const org of Object.values(ORG)) {
      await withOrgDb(org, async (tx) => {
        const ids = (await tx.select({ id: workflows.id }).from(workflows).where(eq(workflows.orgId, org))).map((r) => r.id);
        if (ids.length) await tx.delete(workflowInstructionVersions).where(inArray(workflowInstructionVersions.workflowId, ids));
        await tx.delete(automationRuns).where(eq(automationRuns.orgId, org));
        await tx.delete(workflowRuns).where(eq(workflowRuns.orgId, org));
        await tx.delete(apps).where(eq(apps.orgId, org));
        await tx.delete(workflows).where(eq(workflows.orgId, org));
        await tx.delete(recipes).where(eq(recipes.orgId, org));
      });
      await db.delete(orgs).where(eq(orgs.orgId, org));
    }
  } catch (error) {
    console.error("cleanup failed:", error);
  }
  await closeDb();
}
