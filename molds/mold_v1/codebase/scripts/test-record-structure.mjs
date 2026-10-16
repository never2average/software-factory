/**
 * WHAT EACH RECORD AREA IS (docs/DEPLOYMENT_PROFILE.md "Choosing the area for a domain concept"), OFFLINE.
 *
 * The four area ids are the base product's software words; what a pack maps a domain concept onto is the area's
 * STRUCTURE: a unit of work (tasks), a bounded container measured by the units in it (periods), a change rolled out
 * to an account (deployments), a long-running programme per account (implementations).
 *
 *   1. THE STRUCTURE IS DECLARED in the mold (scripts/lib/record-areas.mjs STRUCTURE) and compiled into
 *      agent/lib/record-areas.generated.ts (RECORD_AREA_STRUCTURE): role, what one record is, time, relations, and the
 *      built-in column carrying each role (every one a real column of the area's table).
 *   2. THE RELATION IS DECLARABLE: a period contains tasks (relations.contains), the targets that measure them count
 *      the ones filed into it (measure.scope "contained"), and every misuse fails the build with a sentence.
 *   3. THE BUILD SAYS IT: the profile generator's note puts each area's role beside the pack's label, and warns,
 *      conservatively, where a definition contradicts its area (a deployment that falls due).
 *   4. THE MODEL AND A CODING AGENT READ IT, in the pack's words: the cards, the briefing, list_cycles (with a period's
 *      completion), MCP's tools. The default surface (and a legacy form's) is byte for byte what it was.
 *   5. THE DOCS carry the decision table and the worked mappings (compliance, equity research, software delivery, sales).
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-record-structure.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyWithProfiles, surfaceSections } from "./lib/profile-copy.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FIX = join(ROOT, "scripts/fixtures/record-areas");
const EX = join(FIX, "examples");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
let passed = 0;
const check = async (what, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${what}`);
  } catch (e) {
    console.error(`  FAIL ${what}\n${e.message}`);
    process.exitCode = 1;
  }
};

/** Run the generator over the default profile plus `extra` ([name, path | object]); never writes files. */
function gen(extra, flag = "--check") {
  const dir = mkdtempSync(join(tmpdir(), "record-structure-"));
  try {
    cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
    for (const [name, src] of extra) {
      if (typeof src === "string") cpSync(src, join(dir, name));
      else writeFileSync(join(dir, name), JSON.stringify(src, null, 2));
    }
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(ROOT, "scripts/gen-deployment-profile.mjs"), flag], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, PROFILES_DIR: dir, NODE_NO_WARNINGS: "1" }, maxBuffer: 64 * 1024 * 1024,
    });
    return { rc: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const areasOf = (extra) => {
  const r = gen(extra, "--print-areas");
  assert.equal(r.rc, 0, r.err);
  return JSON.parse(r.out);
};
const COS = [["50-compliance-os.json", join(EX, "compliance-os.json")]];
/** The wrong mapping the operator saw: a regulatory filing as a deployment, with a due date. */
const WRONG = [["50-a.json", join(EX, "compliance.json")], ["51-b.json", join(EX, "obligation.json")]];
/** A ComplianceOS profile with one change to its periods area. */
const cosWith = (periods, extra = {}) => {
  const doc = read(join(EX, "compliance-os.json"));
  doc.records.areas.periods = { ...doc.records.areas.periods, ...periods };
  for (const [id, a] of Object.entries(extra)) doc.records.areas[id] = { ...doc.records.areas[id], ...a };
  return [["50-x.json", doc]];
};

const lib = await import("./lib/record-areas.mjs");

// --- 1. declared, compiled --------------------------------------------------------------------------------------------
console.log("1. Each area's structure, declared in the mold and compiled");
const defaults = areasOf([]);
await check("STRUCTURE names the four areas: a unit, a container, a change, a programme, each with what it is, its time and its relations", () => {
  const S = lib.STRUCTURE;
  assert.ok(S, "scripts/lib/record-areas.mjs exports no STRUCTURE");
  assert.deepEqual(Object.keys(S).sort(), [...lib.AREA_IDS].sort());
  assert.deepEqual(Object.fromEntries(lib.AREA_IDS.map((id) => [id, S[id].role])), { deployments: "change", implementations: "programme", tasks: "unit", periods: "container" });
  assert.deepEqual(Object.fromEntries(lib.AREA_IDS.map((id) => [id, S[id].time])), { deployments: "instant", implementations: "ongoing", tasks: "instant", periods: "window" });
  assert.equal(S.periods.relations.contains, "tasks");
  assert.equal(S.deployments.relations.targets, "account");
  assert.equal(S.implementations.relations.targets, "account");
  assert.equal(S.implementations.relations.groups, "tasks");
  assert.deepEqual(S.tasks.relations.in, ["periods", "deployments", "implementations"]);
  for (const id of lib.AREA_IDS) for (const k of ["is", "choose"]) assert.ok(typeof S[id][k] === "string" && S[id][k].length > 20, `${id}.${k}`);
});
await check("every role column is a real column of the area's table (or the account it hangs off), and state/owner are named for every area", () => {
  for (const id of lib.AREA_IDS) {
    for (const [role, key] of Object.entries(lib.STRUCTURE[id].columns)) {
      assert.ok(key === "account" ? defaults[id].kind === "record" : defaults[id].fields[key]?.column === true, `${id}.columns.${role}: ${key}`);
    }
    for (const role of ["state", "owner"]) assert.ok(lib.STRUCTURE[id].columns[role], `${id} has no ${role} column`);
  }
  assert.equal(lib.STRUCTURE.tasks.columns.due, "dueAt");
  assert.equal(lib.STRUCTURE.deployments.columns.health, "healthStatus");
  assert.equal(lib.STRUCTURE.deployments.columns.target, "account");
  assert.equal(lib.STRUCTURE.periods.columns.due, "endsAt");
});
await check("the compiled module carries it (RECORD_AREA_STRUCTURE), and the compiled areas of the default are unchanged by it", async () => {
  const gen = await import("../agent/lib/record-areas.generated.ts");
  assert.ok(gen.RECORD_AREA_STRUCTURE && lib.STRUCTURE, "agent/lib/record-areas.generated.ts exports no RECORD_AREA_STRUCTURE");
  assert.deepEqual(gen.RECORD_AREA_STRUCTURE, lib.STRUCTURE);
  assert.deepEqual(defaults, read(join(FIX, "golden/default.areas.json")));
  assert.equal(defaults.periods.relations, undefined, "the default period declares no relation");
});
await check("the record-area schema documents it, and a profile that states a structure is refused with the decision table to read", () => {
  const schema = read(join(ROOT, "scripts/schemas/record-area.schema.json"));
  assert.match(schema.properties.structure.$comment, /fixed by the table/);
  const r = gen(cosWith({ structure: { role: "change" } }));
  assert.equal(r.rc, 1);
  assert.match(r.err, /records\.areas\.periods\.structure: what the periods area IS \(a bounded container[^)]*\) is fixed by the table it is stored in;.*"Choosing the area for a domain concept"/);
});

// --- 2. the relation ---------------------------------------------------------------------------------------------------
console.log("2. A period contains tasks, and is measured by them");
// Compiled once; a build that refuses the profile fails every check that reads it, not the whole file.
let cos = null;
await check("ComplianceOS (scripts/fixtures/record-areas/examples/compliance-os.json) builds", () => { cos = areasOf(COS); });
await check("ComplianceOS compiles: obligations, regulatory filings that contain them, initiatives, frameworks", () => {
  assert.equal(cos.tasks.label.plural, "obligations");
  assert.equal(cos.periods.label.plural, "regulatory filings");
  assert.equal(cos.deployments.label.plural, "Change-management initiatives");
  assert.equal(cos.implementations.label.plural, "Compliance frameworks");
  assert.deepEqual(cos.periods.relations.contains, { completion: true, area: "tasks" });
});
await check("a target measuring the contained obligations with no date counts the ones filed into the filing (scope contained)", () => {
  assert.equal(cos.periods.targets[0].measure.scope, "contained");
  const dated = areasOf(cosWith({ targets: [{ key: "due_in_window", label: "Due in the window", measure: { area: "tasks", date: "dueAt" } }] }));
  assert.equal(dated.periods.targets[0].measure.scope, "window");
});
const refused = [
  ["contains on another area", cosWith({}, { deployments: { relations: { contains: { area: "tasks" } } } }), /records\.areas\.deployments\.relations\.contains: only a period contains another area's records .*the deployments area is a change: a change rolled out/],
  ["a period containing something other than tasks", cosWith({ relations: { contains: { area: "deployments" } } }), /records\.areas\.periods\.relations\.contains\.area: a period can contain "tasks" \(the records that carry a period's id\), not "deployments"/],
  ["contains when tasks are never filed into a period", cosWith({}, { tasks: { relations: { periods: false } } }), /relations\.contains\.area: the tasks area says its records are never filed into a period/],
  ["scope contained on an area the period does not contain", cosWith({ relations: {}, targets: [{ key: "t", label: "T", measure: { area: "tasks", scope: "contained" } }] }), /records\.areas\.periods\.targets\[0\]\.measure\.scope: "contained" counts the tasks records filed into a period, and this period does not contain tasks/],
  ["scope window with no date", cosWith({ targets: [{ key: "t", label: "T", measure: { area: "tasks", scope: "window" } }] }), /targets\[0\]\.measure\.scope: "window" counts the records dated inside the period; name the date field/],
  ["contains with a misspelt key", cosWith({ relations: { contains: { area: "tasks", complete: true } } }), /records\.areas\.periods\.relations\.contains/],
];
for (const [what, extra, re] of refused) {
  await check(`refused: ${what}`, () => {
    const r = gen(extra);
    assert.equal(r.rc, 1, `built: ${r.err}`);
    assert.match(r.err, re);
  });
}

// --- 3. the build's note -----------------------------------------------------------------------------------------------
console.log("3. The build says each area's role beside the pack's label");
await check("ComplianceOS: each area's role next to its label, the filing containing the obligations, no warning", () => {
  const r = gen(COS);
  assert.equal(r.rc, 0, r.err);
  assert.match(r.err, /note: the record areas, by what each IS:/);
  assert.match(r.err, /  tasks \[unit\], shown as "obligations": a unit of work/);
  assert.match(r.err, /  periods \[container\], shown as "regulatory filings": a bounded container: .*; contains "obligations", measured by them/);
  assert.match(r.err, /  deployments \[change\], shown as "Change-management initiatives": a change rolled out to a target/);
  assert.match(r.err, /  implementations \[programme\], shown as "Compliance frameworks": a long-running programme/);
  assert.doesNotMatch(r.err, /warning/);
});
await check("the wrong mapping (a regulatory filing as a deployment, with a due date) builds, with a warning that names the right areas", () => {
  const r = gen(WRONG);
  assert.equal(r.rc, 0, r.err);
  assert.match(r.err, /  deployments \[change\], shown as "Regulatory filings"/);
  assert.match(r.err, /warning: the deployments area \("Regulatory filings"\) has a date it falls due on \("due_date"\).*it has no due date\. A record that falls due is a unit of work \(tasks\), or, when it is a set of units due together, a period that contains them/);
});
await check("the warning reads the legacy form too (the live compliance pack's fixture), and is quiet for the research pack's", () => {
  assert.match(gen([["50-a.json", join(FIX, "legacy/compliance-pack.json")]]).err, /warning: the deployments area \("Regulatory filings"\) has a date it falls due on/);
  const research = gen([["50-a.json", join(FIX, "legacy/research-pack.json")]]);
  assert.match(research.err, /deployments \[change\], shown as "Coverage reports"/);
  assert.doesNotMatch(research.err, /warning: the deployments area/);
});
await check("a deployments area that hides both its release state and its health is warned about", () => {
  const r = gen(cosWith({}, { deployments: { fields: { ...read(join(EX, "compliance-os.json")).records.areas.deployments.fields, releaseStatus: { hidden: true, fixed: "deployed" }, healthStatus: { hidden: true, fixed: "healthy" } } } }));
  assert.equal(r.rc, 0, r.err);
  assert.match(r.err, /warning: the deployments area \("Change-management initiatives"\) hides both columns that carry what a deployment is \("releaseStatus", "healthStatus"/);
});
await check("the default build says nothing new", () => {
  const r = gen([]);
  assert.equal(r.rc, 0, r.err);
  assert.equal(r.err.trim(), "");
});

// --- 4. what the model and a coding agent read -------------------------------------------------------------------------
console.log("4. The model and a coding agent read each area's structure in the pack's words");
const ra = await import("../agent/lib/record-areas.ts");
await check("the default: no structure is said for any area, and no card", () => {
  for (const id of lib.AREA_IDS) {
    assert.equal(ra.describeStructure(id), null, id);
    assert.equal(ra.describeArea(id), null, id);
  }
});
await check("ComplianceOS: one sentence per area, in its words", () => {
  assert.equal(ra.describeStructure("periods", cos, "regulated entity"), 'Regulatory filings: each groups obligations due together in one window ("Period from", `startsAt` to "Filing due", `endsAt`) and is complete when they are all done; an obligation is in one when filed with its id (`cycleId`).');
  assert.equal(ra.describeStructure("tasks", cos, "regulated entity"), 'Obligations: each is one unit of work that someone owns ("Owner", `assignee`), falling due on a day ("Due", `dueAt`), moved through its states until it is done. Obligations due together are grouped into a regulatory filing (`cycleId`), which is complete when they are done. One may be filed under a compliance framework or a change-management initiative (containerType + containerId).');
  assert.equal(ra.describeStructure("deployments", cos, "regulated entity"), 'Change-management initiatives: each is a change rolled out to one regulated entity (its target), with its release state ("Rollout status", `releaseStatus`) and its health ("Control health", `healthStatus`). Obligations may be filed under one.');
  assert.match(ra.describeStructure("implementations", cos, "regulated entity"), /^Compliance frameworks: each is a long-running programme run for one regulated entity, moving through stages, with its stage \("Adoption stage", `implementationStage`\)/);
  assert.match(ra.describeArea("tasks", cos), /^- An \*\*obligation\*\* \(plural: obligations\): [^\n]*\n  Obligations: each is one unit of work/);
});
await check("the wrong mapping says nothing it should not: a period that declares no contents gets no sentence", () => {
  const wrong = areasOf(WRONG);
  assert.equal(ra.describeStructure("periods", wrong), null);
  assert.doesNotMatch(ra.describeStructure("tasks", wrong), /grouped into/);
});
await check("a period's completion: of the obligations filed into it (cancelled aside), how many, how many done, by their state's category", () => {
  const rows = [
    { cycleId: "f1", custom: { state: "closed" } },
    { cycleId: "f1", custom: { state: "under_review" } },
    { cycleId: "f1", custom: { state: "not_applicable" } },
    { cycleId: "f1", custom: { state: "in_progress" }, archivedAt: new Date() },
    { cycleId: "f2", custom: { state: "closed" } },
    { cycleId: null, custom: { state: "closed" } },
  ];
  const cats = cos.tasks.lifecycle.categories;
  assert.equal(cats.not_applicable, "cancelled", "the fixture's not-applicable state is cancelled");
  assert.deepEqual(Object.fromEntries(ra.periodCompletion(rows, cos)), { f1: { total: 2, done: 1 }, f2: { total: 1, done: 1 } });
  assert.equal(ra.periodCompletion(rows).size, 0, "the default period contains nothing");
  assert.equal(ra.periodContains(), null);
});

const FOLDERS = { accounts: "A", platform: "P", deliveries: "D", solutions: "S", projects: "J", tickets: "T", people: "E", uploads: "U" };
const { createTools } = await import("../setup/workspace-tools.mjs");
const mcp = (extra = {}) => Object.fromEntries(createTools({ api: async () => ({}), getOrg: () => null, setOrg() {}, identity: async () => null, folders: FOLDERS, ...extra }).map((t) => [t.name, t.description]));
await check("MCP: given each area's sentence, that area's tools carry it; given none, every description is today's", () => {
  const plain = mcp();
  const structure = Object.fromEntries(lib.AREA_IDS.map((id) => [id, ra.describeStructure(id, cos, "regulated entity")]));
  const tasks = { noun: "obligation", nouns: "obligations", stateField: "state", states: [{ value: "closed", label: "Complied" }], priorities: [], ownFields: [] };
  const said = mcp({ structure, tasks });
  for (const [tool, id] of [["sprint_list", "periods"], ["sprint_create", "periods"], ["deployment_upsert", "deployments"], ["deployment_list", "deployments"], ["implementation_upsert", "implementations"], ["implementation_list", "implementations"], ["task_list", "tasks"], ["task_create", "tasks"]]) {
    assert.ok(said[tool].endsWith(` ${structure[id]}`), `${tool}: ${said[tool]}`);
  }
  assert.ok(said.sprint_list.includes("Regulatory filings: each groups obligations due together"));
  for (const [tool, text] of Object.entries(mcp({ structure: {} }))) assert.equal(text, plain[tool], tool);
});
await check("MCP: the coding agent's task tools with no structure are upstream main's byte for byte", () => {
  const before = read(join(FIX, "mcp-task-tools-before.json"));
  const tools = Object.fromEntries(createTools({ api: async () => ({}), getOrg: () => null, setOrg() {}, identity: async () => null, folders: FOLDERS }).filter((t) => t.name.startsWith("task_")).map((t) => [t.name, { description: t.description, inputSchema: t.inputSchema }]));
  assert.equal(JSON.stringify(tools), JSON.stringify(before["host-default"]));
});

const SURFACE = ["scripts/lib/model-surface.mjs", "--snapshot", "--no-results"];
await check("the default model surface is the recorded one, byte for byte", () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", ...SURFACE], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  assert.ok(r.stdout === readFileSync(join(ROOT, "scripts/fixtures/agent-vocabulary/default-surface.txt"), "utf8"), "the default surface moved");
});
await check("under ComplianceOS (a copy): the briefing and list_cycles say what a filing is, and what moved is only what the profile defines", () => {
  const copy = copyWithProfiles(ROOT, COS);
  let secs;
  try {
    secs = surfaceSections(copy.run(SURFACE).stdout);
  } finally {
    copy.remove();
  }
  const briefing = secs.get("root :: per-turn briefing") ?? "";
  assert.match(briefing, /- Regulatory filings: each groups obligations due together in one window .* Listed with list_cycles \(with how many each holds and how many are done\), written with upsert_cycle; file one in with upsert_todo \(cycleId\)\./);
  assert.match(briefing, /\n  Obligations: each is one unit of work .*grouped into a regulatory filing/);
  assert.match(briefing, /- Change-management initiatives: each is a change rolled out to one account \(its target\)/);
  assert.match(briefing, /- Compliance frameworks: each is a long-running programme run for one account/);
  // The profile relabels the area, so the model's tools spell its columns in its words: the line names them the same way.
  assert.match(briefing, /- Compliance frameworks: [^\n]*\("Adoption stage", `complianceFrameworkStage`\)/);
  assert.match(briefing, /`complianceFrameworkStage`="Adoption stage"/, "the field line beside it uses the same spelling");
  const cycles = secs.get("root :: tool :: list_cycles") ?? "";
  assert.match(cycles, /Regulatory filings: each groups obligations due together in one window/);
  assert.match(cycles, /Each also returns `contains`: how many obligations are filed into it \(cancelled ones aside\) and how many of them are done; it is complete when the two are equal\./);
  assert.match(secs.get("root :: tool :: upsert_todo") ?? "", /Obligations: each is one unit of work/);
});

// --- 5. the docs --------------------------------------------------------------------------------------------------------
console.log("5. The decision table and the worked mappings");
await check('docs/DEPLOYMENT_PROFILE.md: "Choosing the area for a domain concept", its table, and four domains mapped', () => {
  const doc = readFileSync(join(ROOT, "docs/DEPLOYMENT_PROFILE.md"), "utf8");
  const at = doc.indexOf("### Choosing the area for a domain concept");
  assert.ok(at > 0, "no section");
  const sec = doc.slice(at, doc.indexOf("\n## ", at));
  for (const id of lib.AREA_IDS) assert.match(sec, new RegExp(`^\\| \`${id}\` \\| ${lib.STRUCTURE[id].role} \\|`, "m"), id);
  assert.match(sec, /^\| Compliance \(ComplianceOS\) \| obligation \| regulatory filing \(contains its obligations\) \| change-management initiative \| compliance framework \|$/m);
  for (const d of ["Equity research", "Software delivery", "Sales"]) assert.match(sec, new RegExp(`^\\| ${d}`, "m"), d);
  assert.match(sec, /relations\.contains/);
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
