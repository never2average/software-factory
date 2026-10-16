/**
 * THE PERIODS AS A RECORD AREA (records.areas.periods stated in the record-area form, compiled with `declared: true`;
 * agent/lib/period-area.ts), OFFLINE. The record-areas plan's PR 6: a pack can model a bounded container (a "Regulatory
 * filing": obligations due together) with its own fields, its own states and its own screen.
 *
 *   1. AN UNDECLARED PROFILE IS UNCHANGED: the default, both live packs' legacy fixtures (hfc-research's work_periods
 *      mode individual among them) and the work-period fixtures compile with no `declared` on periods; their states are
 *      today's three, read literally; a period on the wire carries no `custom`; the cycles route's literal states stay.
 *   2. THE EXAMPLE COMPILES (golden/filing-period.areas.json, what /preview/record-areas?profile=period shows); a
 *      lifecycle on anything but the `state` column is refused at build with a sentence.
 *   3. DECLARED STATES BY CATEGORY: the states the system opens, starts and closes a period in, by the declared
 *      transitions where they lead there; what counts as finished; the pure next-period rule with them.
 *   4. EVERY WRITE THROUGH THE ONE VALIDATOR (preparePeriodWrite): a create in the initial state with own fields in
 *      their canonical form; a value outside a choice, an unknown own field and a required one cleared refused in
 *      sentences; a move under warn goes through with its warning, under strict is refused (409 body); who may (#180).
 *   5. THE SCREEN FROM THE DEFINITION (app/_components/ops/period-area-model.ts): words, views (calendar included),
 *      table columns, board columns and tones, filters, sorts, detail sections, create fields, metrics, completion of
 *      the contained tasks (#185), the calendar's month.
 *   6. THE MODEL'S TOOLS in the pack's words: under the example, upsert_cycle takes the state, the lead, the capacity,
 *      the goal and the own fields (with their labels and choices) and a move's `reason`, list_cycles returns them and
 *      filters by state; the default surface is byte for byte the recorded one.
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-period-area.mjs
 *        UPDATE_GOLDEN=1 rewrites golden/filing-period.areas.json from the build.
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
const NODE = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
let passed = 0;
let failed = 0;
const check = async (what, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${what}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${what}\n${e.message}`);
  }
};
/** The generator over the default profile plus `extra` ([name, path | object]); never writes files. */
function gen(extra, flag = "--print-areas") {
  const dir = mkdtempSync(join(tmpdir(), "period-area-"));
  try {
    cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
    for (const [name, src] of extra) {
      if (typeof src === "string") cpSync(src, join(dir, name));
      else writeFileSync(join(dir, name), JSON.stringify(src, null, 2));
    }
    const r = spawnSync(process.execPath, [...NODE, join(ROOT, "scripts/gen-deployment-profile.mjs"), flag], { cwd: ROOT, encoding: "utf8", env: { ...process.env, PROFILES_DIR: dir, NODE_NO_WARNINGS: "1" }, maxBuffer: 64 * 1024 * 1024 });
    return { rc: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const areasOf = (extra) => {
  const r = gen(extra);
  assert.equal(r.rc, 0, r.err);
  return JSON.parse(r.out);
};
const FILING = [["50-filing.json", join(EX, "filing-period.json")]];
const withPeriods = (over) => {
  const doc = read(join(EX, "filing-period.json"));
  doc.records.areas.periods = { ...doc.records.areas.periods, ...over };
  return [["50-filing.json", doc]];
};

const pa = await import("../agent/lib/period-area.ts");
const wp = await import("../agent/lib/work-periods.ts");
const { areaView } = await import("../agent/lib/record-areas.ts");

// --- 1. undeclared ---------------------------------------------------------------------------------------------------
console.log("1. An undeclared profile: today's periods, to the byte");
const LEGACY = {
  default: [],
  "research-pack (work_periods individual)": [["50-x.json", join(FIX, "legacy/research-pack.json")]],
  "compliance-pack": [["50-x.json", join(FIX, "legacy/compliance-pack.json")]],
  "wp-individual": [["50-x.json", join(ROOT, "scripts/fixtures/work-periods/50-individual.json")]],
  "wp-off": [["50-x.json", join(ROOT, "scripts/fixtures/work-periods/50-off.json")]],
  relabelled: [["50-x.json", join(ROOT, "scripts/fixtures/agent-vocabulary/50-relabelled.json")]],
};
for (const [set, extra] of Object.entries(LEGACY)) {
  await check(`${set}: periods are not declared; their states are today's three, read literally`, () => {
    const a = areasOf(extra);
    assert.equal("declared" in a.periods, false);
    assert.equal(pa.periodDeclared(a), false);
    const st = pa.periodStates(a);
    assert.deepEqual([st.values, st.initial, st.active, st.done], [["planning", "active", "closed"], "planning", "active", "closed"]);
    assert.deepEqual([st.isClosed("closed"), st.isClosed("active"), st.notStarted("planning"), st.notStarted("active")], [true, false, true, false]);
    assert.equal(pa.systemTarget("active", "done", a), "closed");
    assert.equal(pa.systemTarget("planning", "active", a), "active");
  });
}
await check("research-pack's live fixture is mode individual (the hfc-research shape), and stays undeclared", () => {
  const a = areasOf(LEGACY["research-pack (work_periods individual)"]);
  assert.equal(a.periods.period.mode, read(join(FIX, "legacy/research-pack.json")).work_periods.mode);
});
await check("a period on the wire under an undeclared profile carries no `custom` (the column is new; the answer is not)", () => {
  const row = { id: "c1", name: "Period 1", state: "active", custom: {} };
  assert.deepEqual(pa.periodOut(row), { id: "c1", name: "Period 1", state: "active" });
});
await check("the cycles route still names today's three states for an undeclared profile", () => {
  const src = readFileSync(join(ROOT, "app/api/ops/cycles/[id]/route.ts"), "utf8");
  assert.match(src, /state: z\.enum\(\["planning", "active", "closed"\]\)\.optional\(\)/);
  assert.match(src, /if \(DECLARED\) return patchDeclared\(/);
});

// --- 2. the example compiles ------------------------------------------------------------------------------------------
console.log("2. The example compiles, declared");
let A;
await check("filing-period: the compiled areas are golden/filing-period.areas.json, periods declared", () => {
  A = areasOf(FILING);
  const golden = join(FIX, "golden/filing-period.areas.json");
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(golden, `${JSON.stringify(A, null, 1)}\n`);
  assert.deepEqual(A, read(golden));
  assert.equal(A.periods.declared, true);
  assert.equal(pa.periodDeclared(A), true);
  for (const id of ["deployments", "implementations", "tasks"]) assert.equal("declared" in A[id], false, id);
});
await check("a period's lifecycle on another field is refused at build, with a sentence", () => {
  const r = gen(withPeriods({ fields: { ...read(join(EX, "filing-period.json")).records.areas.periods.fields, phase: { type: "pick_list", label: "Phase", options: [{ value: "a" }, { value: "b" }] } }, lifecycle: { field: "phase", categories: { a: "open", b: "done" } } }), "--check");
  assert.notEqual(r.rc, 0);
  assert.match(r.err, /records\.areas\.periods\.lifecycle\.field: a period's lifecycle is its "state" column/);
});
await check("a state without a category is refused at build", () => {
  const doc = read(join(EX, "filing-period.json")).records.areas.periods;
  const { missed: _drop, ...cats } = doc.lifecycle.categories;
  const r = gen(withPeriods({ lifecycle: { ...doc.lifecycle, categories: cats, transitions: doc.lifecycle.transitions.filter((t) => t.to !== "missed") } }), "--check");
  assert.notEqual(r.rc, 0);
  assert.match(r.err, /every state needs a category/);
});

// --- 3. states by category --------------------------------------------------------------------------------------------
console.log("3. Declared states, by category");
await check("the system's states: initial Draft, active In preparation, done Filed; Missed and Filed finish a period", () => {
  const st = pa.periodStates(A);
  assert.deepEqual(st.values, ["planning", "active", "review", "closed", "rejected", "missed"]);
  assert.deepEqual([st.initial, st.active, st.done], ["planning", "active", "closed"]);
  assert.deepEqual(["planning", "active", "review", "closed", "rejected", "missed"].map(st.isClosed), [false, false, false, true, false, true]);
  assert.deepEqual(["planning", "active", "review"].map(st.notStarted), [true, false, false]);
});
await check("the system closes by a declared transition where one leads to a done state (review -> Filed), else the first done", () => {
  assert.equal(pa.systemTarget("review", "done", A), "closed");
  assert.equal(pa.systemTarget("active", "done", A), "closed");
  assert.equal(pa.systemTarget("planning", "active", A), "active");
});
await check("the next period skips one in any finished state (Missed included), not only \"closed\"", () => {
  const st = pa.periodStates(A);
  const w = (id, s, e, state) => ({ id, name: id, startsAt: new Date(s), endsAt: new Date(e), state });
  const from = w("a", "2026-10-01", "2026-10-08", "active");
  const missed = w("b", "2026-10-08", "2026-10-15", "missed");
  const open = w("c", "2026-10-15", "2026-10-22", "planning");
  assert.equal(wp.nextPeriod([from, missed, open], from, st.isClosed)?.id, "c");
  assert.equal(wp.nextPeriod([from, missed, open], from)?.id, "b", "the default rule reads only \"closed\"");
});

// --- 4. writes ------------------------------------------------------------------------------------------------------
console.log("4. Every write through the one validator");
const ME = "ana@example.com";
await check("a create starts in the initial state, its own fields canonical (money a number, a day a day), dates as Dates", () => {
  const r = pa.preparePeriodWrite("create", { name: "RBI · ALM · Q2", startsAt: "2026-10-01", endsAt: "2026-10-31", lead: ME, custom: { regulator: "RBI", penalty_exposure: "250000", filed_on: "2026-10-30" }, createdBy: "web" }, { actor: ME }, A);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.columns.state, "planning");
  assert.ok(r.columns.endsAt instanceof Date && r.columns.endsAt.toISOString() === "2026-10-31T00:00:00.000Z");
  assert.deepEqual(r.custom, { regulator: "RBI", penalty_exposure: 250000, filed_on: "2026-10-30" });
  assert.equal("createdBy" in r.columns, false, "createdBy is the request's, never a field written");
});
await check("refusals in sentences: a choice outside the list, an unknown own field, a required name cleared, a state that does not exist", () => {
  const bad = pa.preparePeriodWrite("create", { name: "x", custom: { regulator: "FED" } }, { actor: ME }, A);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(" "), /"Regulator" \(regulator\) must be one of/);
  const unknown = pa.preparePeriodWrite("update", { custom: { colour: "red" } }, { actor: ME, before: { id: "c", name: "x", state: "planning", custom: {} } }, A);
  assert.match(unknown.errors.join(" "), /There is no own field "colour" here\. The own fields are: `regulator`, `filed_on`, `acknowledgement`, `penalty_exposure`\./);
  const cleared = pa.preparePeriodWrite("update", { name: "" }, { actor: ME, before: { id: "c", name: "x", state: "planning", custom: {} } }, A);
  assert.match(cleared.errors.join(" "), /"Filing" \(name\) is required, so it cannot be cleared\./);
  const state = pa.preparePeriodWrite("update", { state: "archived" }, { actor: ME, before: { id: "c", name: "x", state: "planning", custom: {} } }, A);
  assert.match(state.errors.join(" "), /"Filing status" \(state\) must be one of/);
});
await check("an own field cleared is a per-key delta (null clears it, the rest carried through)", () => {
  const before = { id: "c", name: "x", state: "active", custom: { regulator: "RBI", acknowledgement: "ACK-1" } };
  const r = pa.preparePeriodWrite("update", { custom: { acknowledgement: null, penalty_exposure: 10 } }, { actor: ME, before }, A);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.customDelta, { set: { penalty_exposure: 10 }, clear: ["acknowledgement"], append: {} });
  assert.deepEqual(r.customAfter, { regulator: "RBI", penalty_exposure: 10 });
});
await check("warn: a move its rules do not allow goes through, with the warning (Mark filed needs Filed on and the acknowledgement)", () => {
  const before = { id: "c", name: "x", state: "review", lead: ME, endsAt: "2026-10-31T00:00:00.000Z", custom: {} };
  const r = pa.preparePeriodWrite("update", { state: "closed" }, { actor: "ben@example.com", before, enteredBy: ME }, A);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0].message, /^Moving from "Awaiting sign-off" to "Filed" is not possible now: "Filed" \(Mark filed\): it needs "Filed on" and "Acknowledgement number"\./);
  assert.equal(r.lifecycle?.enforce, "warn");
});
await check("strict: the same move is refused with the 409 body naming the moves there are", () => {
  const S = structuredClone(A);
  S.periods.lifecycle.enforce = "strict";
  const before = { id: "c", name: "x", state: "review", custom: {} };
  const r = pa.preparePeriodWrite("update", { state: "closed" }, { actor: "ben@example.com", before, enteredBy: ME }, S);
  assert.equal(r.ok, false);
  assert.equal(r.conflict?.code, "lifecycle_refused");
  assert.match(r.errors[0], /From "Awaiting sign-off" you can move to/);
  const ok = pa.preparePeriodWrite("update", { state: "closed", custom: { filed_on: "2026-10-30", acknowledgement: "ACK-9" } }, { actor: "ben@example.com", before, enteredBy: ME }, S);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const self = pa.preparePeriodWrite("update", { state: "closed", custom: { filed_on: "2026-10-30", acknowledgement: "ACK-9" } }, { actor: ME, before, enteredBy: ME }, S);
  assert.equal(self.ok, false, "four eyes: who sent it for sign-off may not mark it filed");
});
await check("who may (#180): a period's permissions refuse a member's create, an owner's goes through", () => {
  const P = structuredClone(A);
  P.periods.permissions = { create: ["owner", "admin"] };
  const no = pa.preparePeriodWrite("create", { name: "x" }, { actor: ME, role: "member" }, P);
  assert.equal(no.ok, false);
  assert.equal(no.forbidden, true);
  assert.equal(pa.preparePeriodWrite("create", { name: "x" }, { actor: ME, role: "owner" }, P).ok, true);
});
await check("the activity lines name changed fields by the definition's labels, values as a person reads them", () => {
  const before = pa.periodRow({ id: "c", name: "x", state: "active", custom: {} });
  const after = pa.periodRow({ id: "c", name: "x", state: "review", custom: { regulator: "SEBI" } });
  assert.deepEqual(pa.periodChanges(before, after, ["state", "regulator"], A), [
    { label: "Filing status", before: "In preparation", after: "Awaiting sign-off" },
    { label: "Regulator", before: "", after: "SEBI" },
  ]);
});

// --- 5. the screen ----------------------------------------------------------------------------------------------------
console.log("5. The screen, from the definition");
const m = await import("../app/_components/ops/period-area-model.ts");
await check("words, views (calendar included), the table, the board by state with its tones, sorts", () => {
  const ui = m.periodAreaUi(A);
  assert.deepEqual([ui.navLabel, ui.singular, ui.createLabel, ui.createTitle], ["Regulatory filings", "Regulatory filing", "Add filing", "New regulatory filing"]);
  assert.deepEqual(ui.modes, ["table", "kanban", "calendar", "timeline"]);
  assert.equal(ui.defaultMode, "table");
  assert.deepEqual(ui.columns.map((c) => c.label), ["Filing", "Regulator", "Filing status", "Due date", "Preparer", "Penalty exposure"]);
  assert.deepEqual(ui.board.columns.map((c) => [c.key, c.label, c.tone]), [["planning", "Draft", "bg-slate-400"], ["active", "In preparation", "bg-amber-500"], ["review", "Awaiting sign-off", "bg-sky-500"], ["closed", "Filed", "bg-emerald-500"], ["rejected", "Returned by regulator", "bg-orange-500"], ["missed", "Missed", "bg-red-500"]]);
  assert.deepEqual(ui.sorts.map((s) => s.label), ["Due date", "Filing", "Penalty exposure"]);
  assert.equal(ui.defaultSort, "endsAt:asc");
  assert.equal(ui.calendarDate, "endsAt");
});
await check("filters: the state's and regulator's choices, the due date's presets, the preparer's mine / unassigned", () => {
  const ui = m.periodAreaUi(A);
  assert.deepEqual(ui.facets.map((f) => [f.id, f.label, f.options.map((o) => o.label).join("|")]), [
    ["field:state", "Filing status", "Draft|In preparation|Awaiting sign-off|Filed|Returned by regulator|Missed"],
    ["field:regulator", "Regulator", "RBI|SEBI|NHB|MCA"],
    ["date:endsAt", "Due date", "Overdue|Due in 7 days|Due in 30 days"],
    ["people:lead", "Preparer", "Mine|Unassigned"],
  ]);
  const now = Date.parse("2026-10-15T12:00:00Z");
  const ctx = { now, me: ME, stateOf: ui.stateOf };
  const rows = [
    pa.periodRow({ id: "1", name: "RBI ALM", state: "active", endsAt: new Date("2026-10-10"), lead: ME, custom: { regulator: "RBI", penalty_exposure: 100 } }),
    pa.periodRow({ id: "2", name: "SEBI LODR", state: "closed", endsAt: new Date("2026-10-05"), lead: null, custom: { regulator: "SEBI" } }),
    pa.periodRow({ id: "3", name: "NHB return", state: "planning", endsAt: new Date("2026-10-20"), lead: "ben@example.com", custom: { regulator: "NHB", penalty_exposure: 50 } }),
  ];
  const ids = (picks, q = "") => m.filterPeriods(ui, rows, q, picks, ctx).map((r) => r.id);
  assert.deepEqual(ids({ "date:endsAt": ["overdue"] }), ["1"], "a filed one is not overdue");
  assert.deepEqual(ids({ "date:endsAt": ["due_7d"] }), ["3"]);
  assert.deepEqual(ids({ "field:regulator": ["SEBI", "NHB"] }), ["2", "3"]);
  assert.deepEqual(ids({ "people:lead": ["mine"] }), ["1"]);
  assert.deepEqual(ids({ "people:lead": ["unassigned"] }), ["2"]);
  assert.deepEqual(ids({}, "lodr"), ["2"]);
  assert.deepEqual(ids({}, "awaiting"), [], "the search reads the shown state too");
  assert.deepEqual(m.sortPeriods(ui, rows, "endsAt:asc").map((r) => r.id), ["2", "1", "3"]);
  assert.deepEqual(m.sortPeriods(ui, rows, "penalty_exposure:desc").map((r) => r.id), ["1", "3", "2"], "unset last");
  assert.deepEqual(m.sortPeriods(ui, rows, "state:asc").map((r) => r.id), ["3", "1", "2"], "a state sorts by its order");
  const metrics = m.periodMetrics(ui, rows, ctx);
  assert.deepEqual(metrics.map((x) => [x.id, x.text, x.attention]), [["open", "2", false], ["overdue", "1", true], ["exposure", "150 INR", false]]);
});
await check("the detail's sections, the create form, the contained tasks' completion by their categories", () => {
  const ui = m.periodAreaUi(A);
  assert.deepEqual(ui.sections.map((s) => [s.label, s.related, s.fields.map((f) => f.key).join(",")]), [
    ["Filing", null, "regulator,state,startsAt,endsAt"],
    ["Preparation", null, "lead,capacity,goal"],
    ["Submission", null, "filed_on,acknowledgement,penalty_exposure"],
    ["Obligations", "tasks", ""],
    [null, "activity", ""],
    [null, "comments", ""],
  ]);
  assert.deepEqual(ui.createFields.map((f) => f.key), ["name", "regulator", "startsAt", "endsAt", "lead"]);
  assert.deepEqual(ui.contains, { area: "tasks", completion: true });
  const tasks = [
    { id: "t1", cycleId: "1", status: "done", done: true },
    { id: "t2", cycleId: "1", status: "open", done: false },
    { id: "t3", cycleId: "1", status: "cancelled", done: false },
    { id: "t4", cycleId: "2", status: "done", done: true },
  ];
  const c = m.completionOf(tasks, A);
  assert.deepEqual([c.get("1"), c.get("2")], [{ total: 2, done: 1 }, { total: 1, done: 1 }]);
});
await check("the calendar: a month's weeks, Monday first, each period on its due day", () => {
  const grid = m.monthGrid(2026, 9);
  assert.equal(grid[0].indexOf("2026-10-01"), 3, "1 Oct 2026 is a Thursday");
  assert.equal(grid.flat().filter(Boolean).length, 31);
  const ui = m.periodAreaUi(A);
  const days = m.byDay(ui, [pa.periodRow({ id: "1", name: "a", endsAt: new Date("2026-10-31T00:00:00Z") }), pa.periodRow({ id: "2", name: "b", endsAt: null })]);
  assert.deepEqual([...days.keys()], ["2026-10-31"]);
});
await check("the default definition, were it drawn: today's three views and the state's three words (never reached: not declared)", () => {
  const d = areasOf([]);
  const ui = m.periodAreaUi(d);
  assert.deepEqual(ui.modes, ["kanban", "table", "timeline"]);
  assert.deepEqual(ui.board.columns.map((c) => c.label), ["Planning", "Active", "Closed"]);
});

// --- 6. the model's tools --------------------------------------------------------------------------------------------
console.log("6. The model's tools, in the pack's words");
const SURFACE = ["scripts/lib/model-surface.mjs", "--snapshot", "--no-results"];
await check("the default model surface is the recorded one, byte for byte", () => {
  const r = spawnSync(process.execPath, [...NODE, ...SURFACE], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  assert.ok(r.stdout === readFileSync(join(ROOT, "scripts/fixtures/agent-vocabulary/default-surface.txt"), "utf8"), "the default surface moved");
});
await check("under the example: upsert_cycle takes the state, the fields and the own fields in the definition's words; list_cycles returns them", () => {
  const copy = copyWithProfiles(ROOT, FILING);
  try {
    const secs = surfaceSections(copy.run(SURFACE).stdout);
    // The schema is JSON in the surface: its quotes read as the model reads them.
    const upsert = (secs.get("root :: tool :: upsert_cycle") ?? "").replaceAll('\\"', '"');
    const list = (secs.get("root :: tool :: list_cycles") ?? "").replaceAll('\\"', '"');
    assert.ok(upsert && list, [...secs.keys()].filter((k) => k.includes(":: tool ::")).join(", "));
    assert.match(upsert, /^Create OR update a regulatory filing \(a cycle\)\./m);
    assert.match(upsert, /"state"/);
    assert.match(upsert, /Filing status: planning \("Draft"\) \| active \("In preparation"\) \| review \("Awaiting sign-off"\) \| closed \("Filed"\) \| rejected \("Returned by regulator"\) \| missed \("Missed"\)/);
    assert.match(upsert, /"Regulator", one of "RBI" \| "SEBI" \| "NHB" \| "MCA"/);
    assert.match(upsert, /"Penalty exposure", amount in INR/);
    assert.match(upsert, /"Preparer", an email/);
    assert.match(upsert, /"reason"/);
    assert.match(upsert, /From "Awaiting sign-off" you can go to "In preparation" \(Send back; needs a comment saying why\), "Filed" \(Mark filed; not by whoever moved it into the state it leaves: a second person must; needs "Filed on" and "Acknowledgement number" set\)/);
    assert.match(list, /List the regulatory filings \(cycles\), newest first: each one's id, name, window \(startsAt, endsAt\), state, and its fields by key \(its own under `custom`\)\./);
    assert.match(list, /Each also returns `contains`/);
    assert.match(list, /"state"/);
  } finally {
    copy.remove();
  }
});

console.log(`\ntest-period-area: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
