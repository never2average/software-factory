/**
 * test:workflow-library — a workspace's library is the deployment profile's, never base code's. Offline.
 *
 * Base code used to carry thirteen workflow scripts and five onboarding recipes and write them into every workspace
 * of every deployment. They are content now (library/account-delivery/), named by a profile that wants them
 * (`library.sources`), and this proves:
 *
 *   1. the default profile names no library, and the committed generated module is empty: a deployment that adds
 *      nothing provisions no workflow and no recipe;
 *   2. NOTHING WAS LOST: a build whose profile opts in (the one line in library/account-delivery/profile.json)
 *      generates exactly the thirteen workflows and five recipes base code carried on the commit before
 *      (scripts/fixtures/workflow-library/built-in-before.json), byte for byte; a later profile turns it off again.
 *      The before-image was edited once, in the same words as the library: two prompts name the account's owner by
 *      `account_owner` (drizzle/0037) instead of the key it had (a stored copy is rewritten at run time,
 *      withCurrentToolNames); their code skeletons, which the cleanup matches on, are unchanged;
 *   3. a source that cannot be used fails the build with the profile key and the reason; two sources that ship the
 *      same workflow or recipe are refused;
 *   4. recipes are spoken like every other text: placeholders filled under the default profile, the profile's words
 *      under a relabelling one;
 *   5. a row an older build left in a workspace that delegates to a specialist the profile excludes cannot run and
 *      says why, whether or not this build has a library to recognise it by; so does an excluded specialist's own row;
 *   6. the cleanup's rules (scripts/operator/lib/library-cleanup.mjs): what counts as a leftover, and each kind of
 *      evidence that keeps one; every version of the old built-ins is still recognised;
 *   7. the base code that seeds a workspace holds no list of its own, and seed-workflows no longer deletes.
 *
 * The database half is scripts/test-library-provisioning-db.mjs (CI's isolation job).
 *
 * On the commit before this one it fails at the first import: scripts/lib/profile-library.mjs did not exist. (With
 * that stubbed, 1 fails: the generated module held 13 workflows under the default profile.)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownLibraries, librarySources, readLibrary, scriptSkeleton, validateSource } from "./lib/profile-library.mjs";
import { classify } from "./operator/lib/library-cleanup.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const BEFORE = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/workflow-library/built-in-before.json"), "utf8"));
const FIXTURE = join(ROOT, "scripts/fixtures/agent-vocabulary/50-relabelled.json");
let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`);
    process.exitCode = 1;
  }
};
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/** A profiles directory: the default plus the given files. */
function profiles(extra) {
  const dir = mkdtempSync(join(tmpdir(), "wf-library-profiles-"));
  cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
  for (const [name, body] of Object.entries(extra)) typeof body === "string" ? cpSync(body, join(dir, name)) : writeFileSync(join(dir, name), JSON.stringify(body));
  return dir;
}
const build = (dir) => spawnSync(process.execPath, ["scripts/build-workflow-library.mjs", "--print"], { cwd: ROOT, env: { ...process.env, PROFILES_DIR: dir }, encoding: "utf8" });
const constant = (module, name) => {
  const at = module.indexOf(`export const ${name}`);
  assert.ok(at >= 0, `${name} not generated`);
  const from = module.indexOf(" = ", at) + 3;
  const end = module.indexOf(";\n", from);
  return JSON.parse(module.slice(from, end).replace(/ as const$/, ""));
};

console.log("\n1. The default profile names no library");
check("profiles/00-default.json: library.sources is empty", () => assert.deepEqual(JSON.parse(read("profiles/00-default.json")).library.sources, {}));
check("the committed generated module holds no workflow, no recipe and no source", () => {
  const m = read("agent/lib/workflow-library.generated.ts");
  assert.deepEqual([constant(m, "LIBRARY_SOURCES"), constant(m, "WORKFLOW_LIBRARY"), constant(m, "RECIPE_LIBRARY")], [[], [], []]);
});
check("…and is what the default profile builds", () => {
  const dir = profiles({});
  try {
    const r = build(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, read("agent/lib/workflow-library.generated.ts"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log("\n2. Nothing was lost: a deployment that opts in gets exactly the former built-ins");
{
  const dir = profiles({ "40-library-account-delivery.json": join(ROOT, "library/account-delivery/profile.json") });
  const r = build(dir);
  check("the one-line opt-in builds", () => assert.equal(r.status, 0, r.stderr));
  check("its 13 workflows are byte for byte the ones base code carried", () => {
    const got = constant(r.stdout, "WORKFLOW_LIBRARY");
    assert.equal(got.length, 13);
    assert.deepEqual(got, BEFORE.workflows);
  });
  check("its 5 recipes are the ones base code carried, in the same order", () => assert.deepEqual(constant(r.stdout, "RECIPE_LIBRARY"), BEFORE.recipes));
  check("the generated module names its source", () => assert.deepEqual(constant(r.stdout, "LIBRARY_SOURCES"), ["account-delivery"]));
  check("the profile generator accepts the opt-in", () => {
    const g = spawnSync(process.execPath, ["scripts/gen-deployment-profile.mjs", "--print"], { cwd: ROOT, env: { ...process.env, PROFILES_DIR: dir }, encoding: "utf8" });
    assert.equal(g.status, 0, g.stderr);
    assert.deepEqual(JSON.parse(g.stdout).library.sources, { "account-delivery": "library/account-delivery" });
  });
  rmSync(dir, { recursive: true, force: true });
  const off = profiles({ "40-library-account-delivery.json": join(ROOT, "library/account-delivery/profile.json"), "60-no-library.json": { library: { sources: { "account-delivery": null } } } });
  check("a later profile turns the source off: empty again, and the merged profile lists none", () => {
    const b = build(off);
    assert.equal(b.status, 0, b.stderr);
    assert.deepEqual([constant(b.stdout, "WORKFLOW_LIBRARY").length, constant(b.stdout, "RECIPE_LIBRARY").length], [0, 0]);
    const g = spawnSync(process.execPath, ["scripts/gen-deployment-profile.mjs", "--print"], { cwd: ROOT, env: { ...process.env, PROFILES_DIR: off }, encoding: "utf8" });
    assert.equal(g.status, 0, g.stderr);
    assert.deepEqual(JSON.parse(g.stdout).library.sources, {});
  });
  rmSync(off, { recursive: true, force: true });
}

console.log("\n3. A source that cannot be used is refused, by name");
{
  for (const [what, value, pattern] of [
    ["a directory that is not there", "library/nowhere", /library\.sources\.mine: "library\/nowhere" is not a directory/],
    ["a path outside the repository", "../elsewhere", /must be a path inside the repository/],
    ["a directory with no library in it", "docs", /holds none of workflows\/\*\.workflow\.js, recipes\.json, apps\.json/],
    ["a value that is not a path", 7, /must be the path of a directory/],
  ]) {
    const dir = profiles({ "40-mine.json": { library: { sources: { mine: value } } } });
    check(`${what} fails the library build and the profile build`, () => {
      const b = build(dir);
      assert.equal(b.status, 1);
      assert.match(b.stderr, pattern);
      const g = spawnSync(process.execPath, ["scripts/gen-deployment-profile.mjs", "--check"], { cwd: ROOT, env: { ...process.env, PROFILES_DIR: dir }, encoding: "utf8" });
      assert.equal(g.status, 1);
      assert.match(g.stderr, pattern);
    });
    rmSync(dir, { recursive: true, force: true });
  }
  check("a bad source id is refused", () => assert.match(validateSource(ROOT, "Mine!", "library/account-delivery") ?? "", /must be lower-case/));
  const root = mkdtempSync(join(tmpdir(), "wf-library-root-"));
  const script = (name) => `export const meta = { name: "${name}", description: "d" };\nphase("One");\nreturn await agent("x");\n`;
  for (const id of ["a", "b"]) {
    mkdirSync(join(root, "library", id, "workflows"), { recursive: true });
    writeFileSync(join(root, "library", id, "workflows", "same.workflow.js"), script("same"));
    writeFileSync(join(root, "library", id, "recipes.json"), JSON.stringify({ recipes: [{ slug: `only-${id}`, title: "T" }] }));
  }
  check("two sources shipping the same workflow name are refused", () => assert.throws(() => readLibrary(root, { a: "library/a", b: "library/b" }), /the workflow "same" is shipped by both "a" and "b"/));
  check("one source reads: name, description, steps, script; recipes with their defaults", () => {
    const lib = readLibrary(root, { a: "library/a" });
    assert.deepEqual(lib.workflows.map((w) => [w.name, w.description, w.steps]), [["same", "d", ["One"]]]);
    assert.deepEqual(lib.recipes, [{ slug: "only-a", title: "T", summary: null, satisfiesCheck: null }]);
  });
  writeFileSync(join(root, "library/a/recipes.json"), JSON.stringify({ recipes: [{ slug: "x", title: "T", satisfiesCheck: "nothing" }] }));
  check("a recipe naming a health check that does not exist is refused", () => assert.throws(() => readLibrary(root, { a: "library/a" }), /satisfiesCheck must be one of/));
  mkdirSync(join(root, "profiles"));
  writeFileSync(join(root, "profiles/00-default.json"), JSON.stringify({ library: { sources: {} } }));
  writeFileSync(join(root, "profiles/50-pack.json"), JSON.stringify({ library: { sources: { b: "library/b" } } }));
  writeFileSync(join(root, "profiles/60-more.json"), JSON.stringify({ library: { sources: { a: "library/a", b: null } } }));
  check("profiles merge the map: a later file adds a source and turns another off", () => assert.deepEqual(librarySources(root), { a: "library/a" }));
  rmSync(root, { recursive: true, force: true });
}

const vocab = await import("../agent/lib/agent-vocabulary.ts");
const view = await import("../agent/lib/workflow-library-view.ts");
const avail = await import("../lib/workflow-availability.ts");
function relabelled() {
  const dir = profiles({ "50-relabelled.json": FIXTURE });
  const r = spawnSync(process.execPath, ["scripts/gen-deployment-profile.mjs", "--print"], { cwd: ROOT, env: { ...process.env, PROFILES_DIR: dir }, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  const profile = JSON.parse(r.stdout);
  return vocab.createVocabulary(profile, ["app-author", "browser", "workflow-author", "ledger-reader"]);
}
const V = relabelled();

console.log("\n4. Recipes are spoken like every other text");
check("this build's own catalog is empty", () => assert.deepEqual(view.deploymentRecipes(), []));
check("under the default profile a placeholder is filled", () => {
  const got = view.deploymentRecipes(vocab.VOCABULARY, BEFORE.recipes);
  assert.deepEqual(got.map((r) => r.title), BEFORE.recipes.map((r) => vocab.fill(r.title)));
  assert.equal(got.at(-1).title, "Onboard the first account");
  assert.deepEqual(got.map((r) => [r.slug, r.satisfiesCheck]), BEFORE.recipes.map((r) => [r.slug, r.satisfiesCheck]));
});
check("under the relabelled fixture it reads the profile's word", () => {
  const got = view.deploymentRecipes(V, BEFORE.recipes);
  assert.equal(got.at(-1).title, "Onboard the first company");
  assert.doesNotMatch(JSON.stringify(got), /\{account\}|customer account/);
});

console.log("\n5. A leftover that needs an excluded specialist cannot run, with or without a library to recognise it by");
{
  const assign = BEFORE.workflows.find((w) => w.name === "assign-account");
  const stored = view.speakLibraryWorkflow(V, assign);
  check("the fixture excludes the specialist the script delegates to", () => assert.ok(V.excludedSpecialists.includes("customer-context")));
  check("in a deployment with NO library: unavailable, the reason names no specialist", () => {
    const a = avail.workflowAvailability({ name: stored.name, script: stored.script, trigger: "manual" }, V, []);
    assert.equal(a.available, false);
    assert.deepEqual(a.needsExcluded, ["customer-context"]);
    assert.match(a.reason, /this workspace does not use, so it cannot run here/);
    assert.doesNotMatch(a.reason, /customer-context/);
  });
  check("in a deployment that names the library: unavailable as a library original", () => {
    const a = avail.workflowAvailability({ name: assign.name, script: assign.script }, V, BEFORE.workflows);
    assert.equal(a.available, false);
    assert.match(a.reason, /Part of the workflow library, which does not apply to this workspace/);
  });
  check("an excluded specialist's own row is unavailable; a kept one's is not", () => {
    assert.equal(avail.workflowAvailability({ name: "customer-context", script: null, trigger: "on delegation" }, V, []).available, false);
    assert.equal(avail.workflowAvailability({ name: "ledger-reader", script: null, trigger: "on delegation" }, V, []).available, true);
  });
  check("under the default profile nothing is unavailable", () => {
    for (const w of BEFORE.workflows) assert.deepEqual(avail.workflowAvailability(w, vocab.VOCABULARY, []), { available: true });
    assert.deepEqual(avail.workflowAvailability({ name: "customer-context", script: null, trigger: "on delegation" }, vocab.VOCABULARY, []), { available: true });
  });
  check("the run paths and the app refresh all ask", () => {
    for (const f of ["app/api/ops/run/route.ts", "app/api/ops/workflows/[id]/run/route.ts", "app/api/cron/run-cron-workflows/route.ts"]) assert.match(read(f), /workflowAvailability\(/, f);
    // The app refresh asks directly, or through the one decision about an app's source (which asks for every script).
    assert.match(read("lib/app-refresh.ts"), /workflowAvailability\(|workflowAppSource\(/);
  });
}

console.log("\n6. The cleanup's rules");
{
  const libraries = knownLibraries(ROOT);
  const ctx = { libraries, skeleton: scriptSkeleton, provisioned: { workflows: new Set(), recipes: new Set() }, excluded: ["customer-context"] };
  const t0 = new Date("2026-01-01T00:00:00Z");
  const wf = (name, over = {}) => ({ id: name, name, trigger: "manual", script: view.speakLibraryWorkflow(V, BEFORE.workflows.find((w) => w.name === name)).script, createdAt: t0, updatedAt: t0, ...over });
  check("the repository knows the account-delivery library, with a workflow it has since removed", () => {
    const lib = libraries.find((l) => l.id === "account-delivery");
    assert.ok(lib);
    assert.equal(lib.workflows.size, 14);
    assert.ok(lib.workflows.has("account-research"));
    assert.equal(lib.recipes.size, 5);
  });
  check("every former built-in is recognised by its code, in the default words and in another vocabulary", () => {
    const lib = libraries.find((l) => l.id === "account-delivery");
    for (const w of BEFORE.workflows) {
      assert.ok(lib.workflows.get(w.name).has(scriptSkeleton(w.script)), w.name);
      assert.ok(lib.workflows.get(w.name).has(scriptSkeleton(view.speakLibraryWorkflow(V, w).script)), `${w.name} (relabelled)`);
      assert.notEqual(view.speakLibraryWorkflow(V, w).script, w.script, `${w.name}: the fixture rewords it`);
    }
  });
  check("an untouched leftover is removable; each kind of evidence keeps one, and says which", () => {
    const rows = ["assign-account", "qbr-prep", "renewal-risk", "route-incident", "infra-sizing", "go-live-sprint"].map((n) => wf(n));
    const evidence = new Map([
      ["qbr-prep", { schedules: 2 }],
      ["renewal-risk", { crons: 1 }],
      ["route-incident", { versions: 3 }],
      ["infra-sizing", { workflowRuns: 4, automationRuns: 1 }],
      ["go-live-sprint", { apps: ["Board", "Digest"] }],
    ]);
    const { removable, kept } = classify({ workflows: rows, recipes: [], evidence }, ctx);
    assert.deepEqual(removable.map((r) => r.name), ["assign-account"]);
    const why = Object.fromEntries(kept.map((r) => [r.name, r.why.join("; ")]));
    assert.match(why["qbr-prep"], /built on: 2 schedule\(s\)/);
    assert.match(why["renewal-risk"], /built on: 1 system cron\(s\)/);
    assert.match(why["route-incident"], /edited: 3 saved version\(s\)/);
    assert.match(why["infra-sizing"], /ran: 4 workflow run\(s\); ran: 1 recorded run\(s\)/);
    assert.match(why["go-live-sprint"], /built on: app\(s\) "Board", "Digest"/);
  });
  check("edits on the row itself keep it: a later update, instructions, recipients, an account scope", () => {
    const later = new Date(t0.getTime() + 5000);
    const { removable, kept } = classify({
      workflows: [wf("qbr-prep", { updatedAt: later }), wf("renewal-risk", { instructions: "x" }), wf("route-incident", { notifyEmails: ["a@example.com"] }), wf("infra-sizing", { customerId: "acme" }), wf("go-live-sprint", { updatedAt: new Date(t0.getTime() + 500) })],
      recipes: [], evidence: new Map(),
    }, ctx);
    assert.deepEqual(removable.map((r) => r.name), ["go-live-sprint"], "half a second between the two timestamps is the insert, not an edit");
    assert.equal(kept.length, 4);
  });
  check("a library name over a script that is not the library's is somebody's own: kept, never removable", () => {
    const { removable, kept } = classify({ workflows: [wf("qbr-prep", { script: 'return await agent("our own");' })], recipes: [], evidence: new Map() }, ctx);
    assert.deepEqual(removable, []);
    assert.match(kept[0].why[0], /not that library's/);
  });
  check("a workflow that is nobody's leftover is not mentioned at all", () => {
    const { removable, kept } = classify({ workflows: [{ id: "x", name: "our-own", trigger: "manual", script: 'return 1;', createdAt: t0, updatedAt: t0 }, { id: "y", name: "ledger-reader", trigger: "on delegation", script: null, createdAt: t0, updatedAt: t0 }], recipes: [], evidence: new Map() }, ctx);
    assert.deepEqual([removable, kept], [[], []]);
  });
  check("an excluded specialist's scriptless row is a leftover; a scripted row of that name is not", () => {
    const row = { id: "s", name: "customer-context", trigger: "on delegation", script: null, createdAt: t0, updatedAt: t0 };
    assert.deepEqual(classify({ workflows: [row], recipes: [], evidence: new Map() }, ctx).removable.map((r) => r.name), ["customer-context"]);
    assert.deepEqual(classify({ workflows: [{ ...row, script: "return 1;", trigger: "manual" }], recipes: [], evidence: new Map() }, ctx).removable, []);
    assert.deepEqual(classify({ workflows: [row], recipes: [], evidence: new Map() }, { ...ctx, excluded: [] }).removable, []);
  });
  check("what this build's profile provisions is never a leftover", () => {
    const named = { ...ctx, provisioned: { workflows: new Set(["qbr-prep"]), recipes: new Set(["onboard-self"]) } };
    const out = classify({ workflows: [wf("qbr-prep")], recipes: [{ id: "r", slug: "onboard-self", createdAt: t0, updatedAt: t0 }], evidence: new Map() }, named);
    assert.deepEqual([out.removable, out.kept], [[], []]);
  });
  check("recipes: an untouched one is removable, one with a body or a later update is kept, another slug is not mentioned", () => {
    const out = classify({ workflows: [], evidence: new Map(), recipes: [
      { id: "1", slug: "onboard-self", createdAt: t0, updatedAt: t0 },
      { id: "2", slug: "import-roster", createdAt: t0, updatedAt: t0, body: "ours" },
      { id: "3", slug: "connect-sources", createdAt: t0, updatedAt: new Date(t0.getTime() + 60_000) },
      { id: "4", slug: "our-own-recipe", createdAt: t0, updatedAt: t0 },
    ] }, ctx);
    assert.deepEqual(out.removable.map((r) => r.name), ["onboard-self"]);
    assert.deepEqual(out.kept.map((r) => r.name), ["import-roster", "connect-sources"]);
  });
}

console.log("\n7. The code that seeds a workspace holds no list of its own");
check("provision-workspace.ts has no recipe list and reads both halves from the profile's library", () => {
  const src = read("agent/lib/provision-workspace.ts");
  assert.doesNotMatch(src, /BUILTIN_RECIPES\s*=/);
  assert.match(src, /source\.recipes \?\? deploymentRecipes\(\)/);
  assert.match(src, /source\.workflows \?\? deploymentWorkflowLibrary\(\)/);
  assert.match(src, /deploymentSpecialists\(\)/);
});
check("GET /api/ops/recipes falls back to the deployment's catalog, not a built-in one", () => {
  const src = read("app/api/ops/recipes/route.ts");
  assert.match(src, /deploymentRecipes\(\)/);
  assert.doesNotMatch(src, /BUILTIN/);
});
const prov = await import("../agent/lib/provision-workspace.ts");
check("deploymentSpecialists: the registry minus the excluded, with summaries", () => {
  assert.deepEqual(prov.deploymentSpecialists(["a", "b", "c"], ["b"], { a: "A", c: "C" }), [{ key: "a", summary: "A" }, { key: "c", summary: "C" }]);
});
check("operator:seed-workflows seeds the profile's library and deletes nothing", () => {
  const src = read("scripts/operator/seed-workflows.mjs");
  assert.match(src, /deploymentWorkflowLibrary\(\)/);
  assert.doesNotMatch(src, /\.delete\(/);
  assert.doesNotMatch(src, /readdirSync/);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/operator/seed-workflows.mjs"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /names no library source .* nothing to seed/);
});
check("operator:library-cleanup is a dry run unless --apply is given", () => {
  const src = read("scripts/operator/library-cleanup.mjs");
  assert.match(src, /const apply = hasFlag\("apply"\)/);
  assert.match(src, /apply \? await applyPlan\(/);
  assert.equal((src.match(/applyPlan\(/g) ?? []).length, 1, "one call, behind the flag");
});
check("no workflow script is left where base code used to read them (check:neutral-names holds every other place)", () => {
  assert.ok(!existsSync(join(ROOT, "scripts/operator/workflows")));
  assert.equal(readdirSync(join(ROOT, "library/account-delivery/workflows")).filter((f) => f.endsWith(".workflow.js")).length, 13);
});

console.log(`\nworkflow library: ${passed} check(s) passed${process.exitCode ? " — AND SOME FAILED" : ""}`);
