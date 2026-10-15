/**
 * RECORD AREAS, OFFLINE (docs/DEPLOYMENT_PROFILE.md "records"): the schema and compiler in the profile generator, the
 * lowering of the legacy forms, the build's refusals, the view model and the one write validator.
 *
 *   1. AN OLD PROFILE BUILDS IDENTICALLY. For the default profile, the record sections of both live subagent packs'
 *      profiles, the docs' research example, the relabelling fixture, both work-period fixtures and one that uses every
 *      legacy key, the profile the build emits (`--print`, what DEPLOYMENT_PROFILE holds) is byte for byte the one the
 *      generator emitted before record areas existed (fixtures/record-areas/golden/<set>.profile.json, written by
 *      upstream main at 24cf7ce). And the compiled areas are the reviewed ones (golden/<set>.areas.json).
 *   2. LOWERING: what each legacy key becomes in the compiled area, asserted by hand.
 *   3. THE RECORD-AREA FORM: the design's worked examples compile, and a profile written in it reaches today's readers
 *      through the legacy form the build derives from it.
 *   4. A BAD PROFILE FAILS THE BUILD with `profiles/<file>: records.areas.<area>.<path>: <reason>`, one per class.
 *   5. THE VIEW MODEL (agent/lib/record-areas.ts) under the default and a redefined task area.
 *   6. THE VALIDATOR (agent/lib/record-validate.ts): today's task writes pass untouched; a redefined area's are checked,
 *      normalised and their status derived from the state's category.
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-record-areas.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const FIX = join(ROOT, "scripts/fixtures/record-areas");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
let passed = 0;
const check = (what, fn) => {
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`FAIL ${what}\n${e.message}`);
    process.exitCode = 1;
  }
};

/** Run the generator over the checkout's default profile plus `extra` ([name, path | object]); never writes files. */
function gen(extra, flag = "--check") {
  const dir = mkdtempSync(join(tmpdir(), "record-areas-"));
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

// --- 1. an old profile builds identically ----------------------------------------------------------------------------
const SETS = {
  default: [],
  everything: [["50-x.json", join(FIX, "legacy/everything.json")]],
  "research-pack": [["50-x.json", join(FIX, "legacy/research-pack.json")]],
  "compliance-pack": [["50-x.json", join(FIX, "legacy/compliance-pack.json")]],
  "equity-research": [["50-x.json", join(ROOT, "docs/examples/profile-equity-research.json")]],
  relabelled: [["50-x.json", join(ROOT, "scripts/fixtures/agent-vocabulary/50-relabelled.json")]],
  "wp-individual": [["50-x.json", join(ROOT, "scripts/fixtures/work-periods/50-individual.json")]],
  "wp-off": [["50-x.json", join(ROOT, "scripts/fixtures/work-periods/50-off.json")]],
};
const compiled = {};
for (const [set, extra] of Object.entries(SETS)) {
  check(`${set}: the emitted profile is byte for byte the one before record areas`, () => {
    const r = gen(extra, "--print");
    assert.equal(r.rc, 0, r.err);
    assert.equal(r.out.trim(), JSON.stringify(read(join(FIX, `golden/${set}.profile.json`))), "DEPLOYMENT_PROFILE moved");
  });
  check(`${set}: the compiled areas are the reviewed ones`, () => {
    compiled[set] = areasOf(extra);
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(join(FIX, `golden/${set}.areas.json`), `${JSON.stringify(compiled[set], null, 1)}\n`);
    assert.deepEqual(compiled[set], read(join(FIX, `golden/${set}.areas.json`)));
  });
}
check("the checkout's own generated profile modules carry no record area (they are in agent/lib/record-areas.generated.ts)", () => {
  for (const f of ["lib/deployment-profile.generated.ts", "agent/lib/deployment-profile.generated.ts"]) assert.ok(!readFileSync(join(ROOT, f), "utf8").includes("RECORD_AREAS"), f);
});

check("the task enums the build reads (the agent's todo tools) are the task-workflow service's own", () => {
  const enumOf = (file, re) => [...readFileSync(join(ROOT, file), "utf8").match(re)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const agent = "agent/lib/todo-tools.ts";
  const service = "services/task-workflow/lib/types.ts";
  assert.deepEqual(enumOf(agent, /status: z\s*\.enum\(\[([^\]]*)\]\)/), enumOf(service, /const taskStatus = z\.enum\(\[([^\]]*)\]\)/));
  for (const re of [/priority: z\.enum\(\[([^\]]*)\]\)/, /const containerType = z\.enum\(\[([^\]]*)\]\)/, /const linkType = z\.enum\(\[([^\]]*)\]\)/]) assert.deepEqual(enumOf(agent, re), enumOf(service, re), String(re));
});

// --- 2. lowering -----------------------------------------------------------------------------------------------------
check("default: no area is redefined; tasks carry today's words, statuses, priorities and sorts", () => {
  const a = compiled.default;
  for (const id of ["deployments", "implementations", "tasks", "periods"]) assert.equal(a[id].redefined, false, id);
  const t = a.tasks;
  assert.deepEqual(t.label, { singular: "task", plural: "tasks" });
  assert.deepEqual(t.fields.status.options.map((o) => [o.value, o.label]), [["backlog", "Backlog"], ["open", "Open"], ["in_progress", "In progress"], ["blocked", "Blocked"], ["done", "Done"], ["cancelled", "Cancelled"]]);
  assert.deepEqual(t.fields.priority.options.map((o) => o.value), ["low", "normal", "high"]);
  assert.deepEqual(t.views.sorts.map((s) => s.label), ["Newest", "Priority", "Due date", "Title"]);
  assert.deepEqual(t.lifecycle, { field: "status", initial: "open", enforce: "off", categories: { backlog: "backlog", open: "open", in_progress: "active", blocked: "blocked", done: "done", cancelled: "cancelled" } });
  assert.equal(t.fields.notes.max_length, 4000);
  assert.equal(t.fields.title.required, true, "a todo's title is NOT NULL without a default");
  assert.equal(a.periods.period.mode, "team");
  assert.equal(a.periods.period.workspace_can_set_length, true, "null resolved as the build resolves it");
  const routeStates = [...readFileSync(join(ROOT, "app/api/ops/cycles/[id]/route.ts"), "utf8").match(/state: z\.enum\(\[([^\]]*)\]\)/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(a.periods.fields.state.options.map((o) => o.value), routeStates, "the default's period states are the cycles route's");
});
check("a legacy domain: labels, relabelled choices, hidden + fixed, kinds, own fields, extra form fields, the group", () => {
  const d = compiled.everything.deployments;
  assert.deepEqual(d.label, { singular: "Shipment", plural: "Shipments" });
  assert.deepEqual(d.id, { field: "deploymentId", label: "Shipment id" });
  assert.equal(d.fields.deploymentId.placeholder, "SHP-001");
  assert.deepEqual([d.fields.environment.hidden, d.fields.environment.fixed], [true, "prod"]);
  const region = d.fields.region;
  assert.equal(region.label, "Depot");
  assert.deepEqual(region.options.find((o) => o.value === "eu-west-1"), { value: "eu-west-1", label: "West depot" });
  assert.deepEqual(region.options.find((o) => o.value === "us-east-1"), { value: "us-east-1" }, "a value the profile gives no word keeps none");
  assert.deepEqual(d.fields.runtime.options.map((o) => o.value), ["Parcel", "Pallet", "Container"], "kind_field + kinds -> that column's choices");
  assert.equal(d.fields.runtime.type, "pick_list");
  assert.deepEqual(Object.values(d.fields).filter((f) => !f.column).map((f) => [f.key, f.type]), [["weight_kg", "number"], ["fill_rate", "percent"], ["arrives_on", "date"], ["contact", "email"], ["tracking", "link"], ["carrier", "pick_list"], ["reference", "text"], ["handling", "long_text"]]);
  assert.equal(d.fields.weight_kg.required, true);
  assert.equal(d.fields.weight_kg.show_in_list, true);
  assert.ok(d.fields.weight_kg.order > Math.max(...Object.values(d.fields).filter((f) => f.column).map((f) => f.order)), "own fields after the columns, as the forms show them");
  assert.deepEqual(d.views.create, { fields: ["runtime", "lastDeployAt", "notes"], append: true });
  assert.deepEqual(d.views.detail, { sections: [{ fields: ["runtime", "lastDeployAt", "approvedByEmail", "notes"] }], append: true });
  const i = compiled.everything.implementations;
  assert.deepEqual(i.relations.group, { field: "rolloutId", label: { singular: "Network", plural: "Networks" } });
  const p = compiled.everything.periods;
  assert.deepEqual([p.enabled, p.label.singular, p.period.mode, p.period.length_days, p.period.list_label.singular, p.period.workspace_can_set_length], [true, "week", "individual", 7, "week", false]);
  assert.equal(compiled["wp-off"].periods.enabled, false, 'work_periods.mode "off" is a disabled periods area');
});
check("both live pack profiles: their reports and programmes, own fields and periods, as the area says them", () => {
  for (const set of ["research-pack", "compliance-pack"]) {
    const a = compiled[set];
    const legacy = read(join(FIX, `legacy/${set}.json`));
    for (const id of ["deployments", "implementations"]) {
      const d = legacy.domains[id];
      assert.deepEqual(a[id].label, d.label, `${set} ${id} label`);
      assert.deepEqual(Object.values(a[id].fields).filter((f) => !f.column).map((f) => f.key), d.custom_fields.map((c) => c.key), `${set} ${id} own fields in order`);
      for (const [k, spec] of Object.entries(d.fields)) {
        if (spec.label) assert.equal(a[id].fields[k].label, spec.label, `${set} ${id}.${k}`);
        if (spec.hidden) assert.equal(a[id].fields[k].hidden, true, `${set} ${id}.${k} hidden`);
      }
    }
    assert.equal(a.periods.period.mode, legacy.work_periods.mode);
    assert.deepEqual(a.periods.label, legacy.work_periods.label);
    assert.equal(a.tasks.redefined, false, "neither pack says anything about tasks");
  }
});

// --- 3. the record-area form -----------------------------------------------------------------------------------------
const EX = join(FIX, "examples");
check("the worked examples compile: a coverage report, a regulatory filing with weekly targets, an obligation", () => {
  for (const extra of [[["50-a.json", join(EX, "research.json")]], [["50-a.json", join(EX, "compliance.json")], ["51-b.json", join(EX, "obligation.json")]], [["50-a.json", join(EX, "obligation.json")]]]) {
    const r = gen(extra);
    assert.equal(r.rc, 0, r.err);
  }
});
check("the record-area form reaches today's readers: the build derives the legacy domains from it", () => {
  const r = gen([["50-a.json", join(EX, "research.json")]], "--print");
  assert.equal(r.rc, 0, r.err);
  const d = JSON.parse(r.out).domains.deployments;
  assert.equal(d.label.singular, "Coverage report");
  assert.equal(d.id_label, "Report id");
  assert.equal(d.kind_field, "runtime");
  assert.deepEqual(d.kinds, ["Initiation", "Quarterly results update", "Annual report review", "Event / rating update", "Sector note"]);
  assert.equal(d.fields.region.hidden, true, 'columns: "listed" hides what it does not name');
  assert.equal(d.fields.region.fixed, "ap-south-1");
  assert.equal(d.fields.releaseStatus.options["pending-approval"], "Awaiting review");
  const tp = d.custom_fields.find((c) => c.key === "target_price");
  assert.deepEqual(tp, { key: "target_price", label: "Target price", type: "number", help: "Per share. Leave blank for a debt-listed company.", show_in_list: true }, "money reaches the legacy form as a number");
  assert.equal(d.custom_fields.find((c) => c.key === "rating").show_in_list, true, "in views.table.columns -> shown in the list");
});
check("an obligation: its own states mapped to categories, the status hidden (it follows them), redefined", () => {
  const a = areasOf([["50-a.json", join(EX, "obligation.json")]]);
  const t = a.tasks;
  assert.equal(t.redefined, true);
  assert.equal(t.lifecycle.field, "state");
  assert.equal(t.lifecycle.enforce, "warn", "a pack's first lifecycle warns (the operator's default)");
  assert.deepEqual(Object.keys(t.lifecycle.categories), ["not_started", "in_progress", "evidence_submitted", "under_review", "closed", "not_applicable"], "the default's status categories are not merged into another field's lifecycle");
  assert.equal(t.fields.status.hidden, true);
  assert.equal(t.fields.state.column, false);
  assert.deepEqual(t.fields.priority.options.map((o) => o.label), ["Critical", "Standard", "Low"]);
  assert.equal(a.deployments.redefined, false);
});

// --- 4. a bad profile fails the build, with a clear message ----------------------------------------------------------
const tasks = (area) => ({ records: { areas: { tasks: area } } });
const own = (fields) => tasks({ fields });
const lifecycleOn = (states, lc) => tasks({ fields: { stage: { type: "pick_list", label: "Stage", options: states.map((value) => ({ value })) } }, lifecycle: { field: "stage", categories: Object.fromEntries(states.map((s, i) => [s, i === states.length - 1 ? "done" : "open"])), ...lc } });
const many = (n, extra = {}) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`own_${i}`, { type: "date", label: `Date ${i}`, ...extra }]));
const BAD = [
  ["a fifth kind of record", { records: { areas: { obligations: {} } } }, "records.areas.obligations: a profile may redefine only the four built-in record areas (deployments, implementations, tasks, periods)"],
  ["both forms in one file", { domains: { deployments: { label: { singular: "Filing", plural: "Filings" } } }, records: { areas: { deployments: { label: { singular: "Filing", plural: "Filings" } } } } }, "records.areas.deployments and domains.deployments both describe the deployments area. Keep one form"],
  ["periods in both forms", { work_periods: { mode: "off" }, records: { areas: { periods: { enabled: false } } } }, "records.areas.periods and work_periods both describe the periods area"],
  ["an unknown key in an area (schema)", tasks({ colour: "red" }), "records.areas.tasks.colour: unknown key"],
  ["a type that does not exist (schema)", own({ score: { type: "rating", label: "Score" } }), 'records.areas.tasks.fields.score.type: "rating" is not one of'],
  ["a tone outside the palette (schema)", own({ size: { type: "pick_list", label: "Size", options: [{ value: "S", tone: "pink" }] } }), 'records.areas.tasks.fields.size.options[0].tone: "pink" is not one of'],
  ["describe over the per-turn budget (schema)", tasks({ agent: { describe: "x".repeat(1201) } }), "records.areas.tasks.agent.describe: must be at most 1200 characters"],
  ["an own key that is not snake_case", own({ dueDate: { type: "date", label: "Due date" } }), "records.areas.tasks.fields.dueDate: an own field's key must be snake_case"],
  ["an own key that is a column in another spelling", own({ due_at: { type: "date", label: "Due on" } }), 'records.areas.tasks.fields.due_at: "due_at" is already a built-in field of the todos table in another spelling'],
  ["a column given a type it cannot hold", own({ priority: { type: "number" } }), 'records.areas.tasks.fields.priority.type: "priority" is a column with a fixed list of values, so it can be "pick_list", not "number"'],
  ["a column's choices outside its stored values", own({ status: { options: [{ value: "open" }, { value: "waiting" }] } }), 'records.areas.tasks.fields.status.options: "waiting" is not a value of status ("backlog", "open", "in_progress", "blocked", "done", "cancelled")'],
  ["an own field without a type", own({ frequency: { label: "Frequency" } }), "records.areas.tasks.fields.frequency.type: an own field needs a type"],
  ["an own field without a label", own({ frequency: { type: "text" } }), "records.areas.tasks.fields.frequency.label: an own field needs a label"],
  ["a pick_list without choices", own({ frequency: { type: "pick_list", label: "Frequency" } }), "records.areas.tasks.fields.frequency.options: a pick_list needs its choices"],
  ["a choice listed twice", own({ frequency: { type: "pick_list", label: "Frequency", options: [{ value: "Monthly" }, { value: "monthly" }] } }), 'records.areas.tasks.fields.frequency.options[1]: "monthly" is listed twice'],
  ["two choices with one label", own({ frequency: { type: "pick_list", label: "Frequency", options: [{ value: "m", label: "Monthly" }, { value: "q", label: "Monthly" }] } }), 'records.areas.tasks.fields.frequency.options[1].label: "Monthly" labels both "m" and "q"'],
  ["two fields with one label", own({ owner_note: { type: "text", label: "Notes" } }), 'records.areas.tasks.fields.owner_note.label: "Notes" is also the label of "notes"; two fields with one label cannot be told apart'],
  ["a hidden required column with no fixed value (columns: listed)", { records: { areas: { deployments: { columns: "listed", fields: { deployedVersion: { label: "Period" } } } } } }, 'records.areas.deployments.fields.environment: "environment" is required, so hiding it (columns: "listed" hides every column not named) needs a "fixed" value the forms submit (one of "prod", "staging", "uat", "sandbox", "dev")'],
  ["a fixed value outside the choices", { records: { areas: { deployments: { fields: { environment: { hidden: true, fixed: "production" } } } } } }, 'records.areas.deployments.fields.environment.fixed: "production" is not one of "prod", "staging", "uat", "sandbox", "dev"'],
  ["a default template of the wrong kind", own({ reviewer: { type: "person", label: "Reviewer", default: "{today}" } }), "records.areas.tasks.fields.reviewer.default: {today} is a date"],
  ["a file folder outside the data room's folders", own({ evidence: { type: "file", label: "Evidence", folder: "evidence/{id}/" } }), "records.areas.tasks.fields.evidence.folder: must start with a data-room folder placeholder"],
  ["a computed field computed from itself", own({ a_flag: { type: "pick_list", label: "A", options: [{ value: "x" }], computed: { when: [{ if: { b_flag: "x" }, then: "x" }] } }, b_flag: { type: "pick_list", label: "B", options: [{ value: "x" }], computed: { when: [{ if: { a_flag: "x" }, then: "x" }] } } }), "is computed from itself"],
  ["more own fields than an area takes", own(many(61)), "records.areas.tasks.fields: 61 own fields; an area may declare at most 60"],
  ["more indexed own fields than a table takes", own(many(7, { index: "sort" })), "records.areas.tasks.fields: 7 own fields ask for an index; a table takes at most 6"],
  ["a lifecycle on a field that is not a pick_list", tasks({ lifecycle: { field: "title", categories: {} } }), 'records.areas.tasks.lifecycle.field: "title" must be a pick_list'],
  ["a state with no category", lifecycleOn(["a", "b"], { categories: { b: "done" } }), 'records.areas.tasks.lifecycle.categories: every state needs a category (backlog, open, active, blocked, done, cancelled); "a" has none'],
  ["no state that is done", lifecycleOn(["a", "b"], { categories: { a: "open", b: "active" } }), 'records.areas.tasks.lifecycle.categories: at least one state must be "done"'],
  ["an initial state that is not a state", lifecycleOn(["a", "b"], { initial: "c" }), 'records.areas.tasks.lifecycle.initial: "c" is not a state of stage ("a", "b")'],
  ["a transition to a state that does not exist", lifecycleOn(["a", "b"], { transitions: [{ from: ["a"], to: "z" }] }), 'records.areas.tasks.lifecycle.transitions[0].to: "z" is not a state of stage'],
  ["a transition that requires a field the area does not have", lifecycleOn(["a", "b"], { transitions: [{ from: ["a"], to: "b", requires: ["evidence"] }] }), 'records.areas.tasks.lifecycle.transitions[0].requires: "evidence" is not a field of this area'],
  ["four eyes on a field that is not a person", lifecycleOn(["a", "b"], { transitions: [{ from: ["a"], to: "b", not_by: "title" }] }), 'records.areas.tasks.lifecycle.transitions[0].not_by: "title" must be a person field'],
  ["a strict lifecycle with a state nothing reaches", lifecycleOn(["a", "b", "c"], { initial: "a", enforce: "strict", transitions: [{ from: ["a"], to: "c" }] }), 'records.areas.tasks.lifecycle.transitions: under "strict", "b" can never be reached from "a"'],
  ["the status column given another meaning", tasks({ lifecycle: { field: "status", categories: { backlog: "backlog", open: "open", in_progress: "active", blocked: "blocked", done: "cancelled", cancelled: "done" } } }), 'records.areas.tasks.lifecycle.categories.done: the status "done" is the category "done"'],
  ["a board on a field that does not exist", tasks({ views: { board: { by: "stage" } } }), 'records.areas.tasks.views.board.by: "stage" is not a field of this area'],
  ["a sort on a field that cannot be sorted", own({ evidence: { type: "file", label: "Evidence", folder: "{folder:platform}/e/" }, x: { type: "text", label: "X" } }), null],
  ["a create form missing a required own field", tasks({ fields: { ref: { type: "text", label: "Reference", required: true } } }), 'records.areas.tasks.views.create.fields: "ref" is required and has no default, so the create form must ask for it'],
  ["a table column that is hidden", tasks({ fields: { notes: { hidden: true } } }), 'records.areas.tasks.views.table.columns'],
  ["a container that cannot hold tasks", tasks({ relations: { containers: ["periods"] } }), 'records.areas.tasks.relations.containers: "periods" cannot hold tasks'],
  ["an email reminder (off in this release)", tasks({ reminders: [{ id: "due", date: "dueAt", before_days: [1], notify: ["assignee"], channels: ["email"] }] }), 'records.areas.tasks.reminders[0].channels: email reminders are off in this release; use "inbox" or "push"'],
];
// The sort case, completed: a file field in the sorts.
BAD[BAD.findIndex((b) => b[0] === "a sort on a field that cannot be sorted")] = ["a sort on a field that cannot be sorted", tasks({ fields: { evidence: { type: "file", label: "Evidence", folder: "{folder:platform}/e/" } }, views: { sorts: [{ field: "evidence" }] } }), 'records.areas.tasks.views.sorts[0].field: a file field cannot be sorted'];
// The hidden table column, completed: the default's table lists notes? It lists title, status, priority, cycleId, dueAt, assignee.
BAD[BAD.findIndex((b) => b[0] === "a table column that is hidden")] = ["a table column that is hidden", tasks({ fields: { priority: { hidden: true } } }), 'records.areas.tasks.views.table.columns[2]: "priority" is hidden; a hidden field is not shown'];
for (const [what, profile, message] of BAD) {
  check(`refused: ${what}`, () => {
    const r = gen([["50-bad.json", profile]]);
    assert.equal(r.rc, 1, `the build passed: ${r.out}`);
    assert.ok(r.err.startsWith("profiles/50-bad.json: records.areas."), `the message names the file and the path: ${r.err}`);
    assert.ok(r.err.includes(message), `expected …${message}…\n     got ${r.err}`);
  });
}
check("refused: an area in the two forms across two files, naming both", () => {
  const r = gen([["50-a.json", { domains: { deployments: { label: { singular: "Filing", plural: "Filings" } } } }], ["51-b.json", { records: { areas: { deployments: { description: "Filings." } } } }]]);
  assert.equal(r.rc, 1);
  assert.ok(r.err.startsWith("profiles/51-b.json: records.areas.deployments: 50-a.json states this area in the legacy form (domains.deployments) and 51-b.json in the record-area form"), r.err);
});

// --- 5. the view model -----------------------------------------------------------------------------------------------
const { areaView, describeArea, describeField } = await import("../agent/lib/record-areas.ts");
const { RECORD_AREAS } = await import("../agent/lib/record-areas.generated.ts");
const obligationAreas = areasOf([["50-a.json", join(EX, "obligation.json")]]);
check("view model, default tasks: words, the board's columns, sorts, the lifecycle on status", () => {
  const v = areaView("tasks");
  assert.deepEqual([v.singular, v.plural, v.noun, v.nouns, v.redefined], ["Task", "Tasks", "task", "tasks", false]);
  assert.deepEqual(v.board.columns.map((c) => [c.key, c.label]), [["backlog", "Backlog"], ["open", "Open"], ["in_progress", "In progress"], ["blocked", "Blocked"], ["done", "Done"], ["cancelled", "Cancelled"]]);
  assert.deepEqual(v.sorts.map((s) => [s.field, s.label]), [["createdAt", "Newest"], ["priority", "Priority"], ["dueAt", "Due date"], ["title", "Title"]]);
  assert.equal(v.lifecycle.own, false);
  assert.equal(v.lifecycle.categoryOf("in_progress"), "active");
  assert.equal(v.categoryOfRow({ status: "done" }), "done");
  assert.equal(v.closed({ status: "cancelled" }), true);
  assert.deepEqual(v.lifecycle.movesFrom("open").map((m) => m.to), ["backlog", "in_progress", "blocked", "done", "cancelled"], "no transitions listed: every move");
  assert.equal(v.display("priority", "high"), "High");
  assert.equal(v.valueOf("status", "in progress"), "in_progress");
  assert.equal(v.submitLabel, "New task");
  assert.equal(describeArea("tasks"), null, "the default task area adds nothing to what the model reads");
  for (const id of ["deployments", "implementations", "periods"]) assert.equal(describeArea(id), null, id);
});
check("view model, an obligation: own state read from custom, its board, labels, moves and the model's card", () => {
  const v = areaView("tasks", obligationAreas);
  assert.deepEqual([v.singular, v.nouns, v.redefined], ["Obligation", "obligations", true]);
  const row = { title: "File ALM return", status: "in_progress", custom: { state: "evidence_submitted", frequency: "Quarterly" } };
  assert.equal(v.get(row, "state"), "evidence_submitted");
  assert.equal(v.get(row, "title"), "File ALM return");
  assert.equal(v.display("state", "evidence_submitted"), "Evidence submitted");
  assert.equal(v.tone("state", "closed"), "green");
  assert.deepEqual(v.board.columns.map((c) => c.label), ["Not started", "In progress", "Evidence submitted", "Under review", "Complied", "Not applicable"]);
  assert.equal(v.lifecycle.own, true);
  assert.equal(v.categoryOfRow(row), "active");
  assert.deepEqual(v.lifecycle.movesFrom("under_review", "member").map((m) => m.to), ["in_progress"], "Mark complied is owner/admin only");
  assert.deepEqual(v.lifecycle.movesFrom("under_review", "admin").map((m) => m.to), ["closed", "in_progress"]);
  assert.deepEqual(v.createFields().map((f) => f.key), ["title", "dueAt", "assignee", "frequency", "department", "obligation_ref", "clause"]);
  assert.equal(v.submitLabel, "Add obligation");
  assert.equal(v.inputFor("evidence"), "file");
  const card = describeArea("tasks", obligationAreas);
  assert.ok(card.startsWith("- An **obligation** (plural: obligations): Something the company must do"), card);
  // The lifecycle as its moves (agent/lib/record-areas.ts describeArea), never one line of states read as an order.
  assert.ok(card.includes("Its state is `custom.state`: "), card);
  assert.ok(!card.includes(" → "), "no arrow chain of states");
  assert.ok(card.includes('- From "Under review" you can go to "Complied" (Mark complied; owner or admin only; not by its owner), "In progress" (Ask for more evidence; needs a comment saying why (`reason`)).'), card);
  assert.ok(card.includes('"Evidence submitted" (Submit evidence; needs "Evidence" set)'), card);
  assert.ok(card.includes('"Under review" (Take for review; not by its owner; sets "Reviewer" to you)'), card);
  assert.ok(card.split(/\s+/).length < 400, "a short card");
  assert.equal(describeField(v.field("frequency")), '`frequency` ("Frequency", one of "One-time" | "Monthly" | "Quarterly" | "Half-yearly" | "Annual" | "Event-based")');
});
check("the checkout's compiled areas are the default's", () => assert.deepEqual(RECORD_AREAS, compiled.default));
check("the obligation preview's compiled areas (app/preview/record-tasks) are what the build compiles", () => assert.deepEqual(read(join(FIX, "golden/obligation.areas.json")), obligationAreas));

// --- 6. the validator ------------------------------------------------------------------------------------------------
const { validateRecordWrite, coerceFieldValue } = await import("../agent/lib/record-validate.ts");
const PASS = ["createdBy", "actor", "reason", "idempotencyKey", "archived", "stageId", "done", "parentId", "containerId", "containerLabel", "linkId", "linkLabel", "cycleId"];
const write = (mode, patch, extra = {}, areas = RECORD_AREAS) => validateRecordWrite("tasks", { mode, patch, actor: "ana@example.com", role: "member", passThrough: PASS, now: new Date("2026-10-14T08:00:00Z"), ...extra }, areas);
check("today's task writes pass the default definition untouched", () => {
  const bodies = [
    ["create", { title: "New task", createdBy: "ana@example.com" }],
    ["create", { title: "Chase the invoice", notes: "Call first", status: "open", priority: "high", dueAt: "2026-10-20T09:00:00.000Z", assignee: "bo@example.com", linkType: "ticket", linkId: "T-1", linkLabel: "T-1", containerType: "implementation", containerId: "acme", createdBy: "mcp" }],
    ["update", { status: "in_progress", actor: "ana@example.com" }],
    ["update", { done: true }],
    ["update", { priority: "low" }],
    ["update", { dueAt: null }],
    ["update", { assignee: null }],
    ["update", { cycleId: "00000000-0000-4000-8000-000000000001" }],
    ["update", { containerType: null, containerId: null, containerLabel: null }],
    ["update", { archived: true }],
    ["update", { title: "Renamed", reason: "typo", idempotencyKey: "k1" }],
  ];
  for (const [mode, body] of bodies) {
    const r = write(mode, body);
    assert.equal(r.ok, true, `${JSON.stringify(body)}: ${r.errors?.join(" ")}`);
    assert.deepEqual(r.customDelta, {}, "nothing own to write");
    assert.deepEqual(Object.keys(r.columns).sort(), Object.keys(body).sort(), "every key goes on as it came");
    for (const [k, x] of Object.entries(body)) if (x !== null && k !== "status" && k !== "priority") assert.deepEqual(r.columns[k], x, k);
  }
});
check("the default definition refuses what the task service refuses, in a sentence", () => {
  const r = write("update", { status: "waiting" });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0], '"Status" (status) must be one of: "Backlog" ("backlog"), "Open" ("open"), "In progress" ("in_progress"), "Blocked" ("blocked"), "Done" ("done"), "Cancelled" ("cancelled").');
  assert.match(write("create", { notes: "x" }).errors[0], /"Task" \(title\) is required\./);
  assert.match(write("update", { title: "x".repeat(301) }).errors[0], /too long: keep it under 300/);
  assert.match(write("update", { custom: { frequency: "Monthly" } }).errors[0], /There is no own field "frequency" here: this kind of record declares none\./);
  assert.match(write("update", { colour: "red" }).errors[0], /There is no field "colour" here\. Its fields are: /);
});
const ob = (mode, patch, extra = {}) => write(mode, patch, extra, obligationAreas);
check("an obligation: required and defaulted on create, canonical own values, the initial state and its status", () => {
  const r = ob("create", { title: "Quarterly ALM return", dueAt: "2026-10-31T09:00:00.000Z", custom: { frequency: "quarterly", department: "Finance", obligation_ref: "OBL-0042", clause: "https://example.com/circular#4" }, createdBy: "ana@example.com" });
  assert.equal(r.ok, true, r.errors?.join(" "));
  assert.equal(r.columns.assignee, "ana@example.com", "{me}");
  assert.deepEqual(r.customDelta, { frequency: "Quarterly", department: "Finance", obligation_ref: "OBL-0042", clause: "https://example.com/circular#4", state: "not_started" });
  assert.deepEqual(r.derived, { category: "open", status: "open", done: false });
  const missing = ob("create", { title: "x" });
  assert.deepEqual(missing.errors, ['"Due" (dueAt) is required.']);
});
check("an obligation: invalid own values, unknown keys and a direct status are refused with the choices named", () => {
  const r = ob("update", { custom: { frequency: "Weekly", obligation_ref: "42", reviewer: "not-an-email", nope: 1 } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, [
    '"Frequency" (frequency) must be one of: "One-time", "Monthly", "Quarterly", "Half-yearly", "Annual", "Event-based".',
    '"Obligation id" (obligation_ref) is not in the expected form (^OBL-[0-9]{4,}$).',
    '"Reviewer" (reviewer) must be an email address, for example name@company.com.',
    'There is no own field "nope" here. The own fields are: `state`, `frequency`, `obligation_ref`, `clause`, `department`, `evidence`, `reviewer`.',
  ]);
  assert.match(ob("update", { status: "done" }).errors[0], /`status` follows `custom.state` here; set the state instead/);
  assert.match(ob("update", { custom: { state: "approved" } }).errors[0], /"Status" \(state\) must be one of: "Not started" \("not_started"\)/);
  assert.equal(ob("update", { custom: { state: "complied" } }).customDelta.state, "closed", "a state's label maps back to its value");
});
check("an obligation: a move derives the status from the category; a move outside the transitions warns", () => {
  const before = { title: "x", status: "in_progress", assignee: "ana@example.com", custom: { state: "under_review", legacy_key: "kept" } };
  const done = ob("update", { custom: { state: "closed" } }, { before, role: "admin", actor: "boss@example.com" });
  assert.equal(done.ok, true);
  assert.deepEqual(done.derived, { category: "done", status: "done", done: true });
  assert.equal(done.transition.allowed, true);
  assert.deepEqual(done.custom, { state: "closed", legacy_key: "kept" }, "a stored key the profile does not declare is carried through");
  const self = ob("update", { custom: { state: "closed" } }, { before, role: "admin", actor: "ana@example.com" });
  assert.equal(self.ok, true, "warn: the move goes through");
  assert.equal(self.transition.allowed, false);
  assert.match(self.warnings[0], /^Moving from "Under review" to "Complied" is not possible now: "Complied" \(Mark complied\): not by the owner\. From "Under review" you can move to: "Complied" \(Mark complied; not by you: a second person must\), "In progress" \(Ask for more evidence; needs a comment\)\.$/, "each move names what it needs (record-lifecycle.ts)");
  const member = ob("update", { custom: { state: "closed" } }, { before, role: "member", actor: "boss@example.com" });
  assert.match(member.warnings[0], /only owner or admin may make it/);
  const needs = ob("update", { custom: { state: "evidence_submitted" } }, { before: { ...before, custom: { state: "in_progress" } } });
  assert.match(needs.warnings[0], /it needs "Evidence"/);
  const strict = structuredClone(obligationAreas);
  strict.tasks.lifecycle.enforce = "strict";
  const refused = write("update", { custom: { state: "closed" } }, { before, role: "member", enforceTransitions: true }, strict);
  assert.equal(refused.ok, false, "strict + enforced: refused");
  const cleared = ob("update", { custom: { reviewer: null, legacy_key: "" } }, { before });
  assert.deepEqual(cleared.customDelta, { reviewer: null, legacy_key: null }, "null clears; a stored undeclared key may be cleared");
});
check("a computed field and a fixed hidden one are never written", () => {
  const areas = areasOf([["50-a.json", join(EX, "compliance.json")], ["51-b.json", join(EX, "obligation.json")]]);
  const r = validateRecordWrite("deployments", { mode: "update", patch: { custom: { timeliness: "On time" }, environment: "staging" }, actor: "a@example.com" }, areas);
  assert.deepEqual(r.errors, ['"Timeliness" (timeliness) is computed from the record\'s other fields; it is never set.', '"Environment" (environment) is not used here; it always holds "prod".']);
});
check("coerceFieldValue: one rule per type", () => {
  const f = (type, extra = {}) => ({ key: "k", label: "K", type, ...extra });
  assert.deepEqual(coerceFieldValue(f("money", { min: 0 }), "1,250.50"), { value: 1250.5 });
  assert.match(coerceFieldValue(f("money", { min: 0 }), -1).error, /at least 0/);
  assert.deepEqual(coerceFieldValue(f("integer"), "12"), { value: 12 });
  assert.match(coerceFieldValue(f("integer"), "1.5").error, /whole number/);
  assert.deepEqual(coerceFieldValue(f("boolean"), "yes"), { value: true });
  assert.deepEqual(coerceFieldValue(f("datetime"), "2026-07-31T09:00:00+05:30"), { value: "2026-07-31T03:30:00.000Z" });
  assert.deepEqual(coerceFieldValue(f("multi_pick", { options: [{ value: "RBI" }, { value: "SEBI" }] }), ["sebi", "RBI", "SEBI"]), { value: ["SEBI", "RBI"] });
  assert.deepEqual(coerceFieldValue(f("file", { many: true }), ["evidence/a.pdf"]), { value: ["evidence/a.pdf"] });
  assert.match(coerceFieldValue(f("file"), "../etc/passwd").error, /data-room path/);
  assert.deepEqual(coerceFieldValue(f("person"), "Ana@Example.com"), { value: "ana@example.com" });
  assert.deepEqual(coerceFieldValue(f("pick_list", { options: [{ value: "high", label: "Critical" }], legacy_values: { urgent: "high" } }), "urgent"), { value: "high" });
  assert.deepEqual(coerceFieldValue(f("pick_list", { options: [{ value: "high", label: "Critical" }] }), "critical"), { value: "high" }, "a label maps back to its value");
});

// --- the JSON Schema checker itself ----------------------------------------------------------------------------------
const { validate, assertSupported } = await import("./lib/json-schema.mjs");
check("json-schema: refuses an unsupported keyword and reports paths", () => {
  assert.throws(() => assertSupported({ type: "object", properties: { a: { format: "email" } } }), /"format" is not supported/);
  const schema = read(join(ROOT, "scripts/schemas/record-area.schema.json"));
  assertSupported(schema);
  assert.deepEqual(validate(schema, { fields: { x: { type: "text", options: [{ value: 1 }] } } }), [{ path: "fields.x.options[0].value", message: "must be a string (it is 1)" }]);
  assert.deepEqual(validate(schema, { lifecycle: { field: "s", transitions: [{ from: "any", to: "b" }] } })[0].path, "lifecycle.transitions[0].from");
});

console.log(process.exitCode ? `test-record-areas: FAILED (${passed} passed)` : `test-record-areas: all ${passed} checks passed`);
