/**
 * LIFECYCLES ENFORCED, OFFLINE (agent/lib/record-lifecycle.ts; docs/DEPLOYMENT_PROFILE.md "Lifecycle rules, enforced").
 *
 *   1. "OFF" CHANGES NOTHING: every task write of scripts/lib/record-lifecycle-off-cases.mjs (creates, every
 *      transition, every rule, each role, comments, four eyes, the done flag, a stage) under `enforce: "off"` answers
 *      exactly what upstream main answered at fc2ea3e (fixtures/record-lifecycle/off-baseline.json): the body sent to
 *      the task service, the refusals, the warnings, the validator's columns, own fields and derived status.
 *   2. EVERY RULE IN EACH MODE, on the pipeline fixture (the task status with transitions) and the obligation example:
 *      a move the transitions do not list, roles, a required field, a required comment, `not_by` (a person field, and
 *      "{entered_by}": four eyes), stamps; under "warn" each goes through and is reported, under "strict" each is
 *      refused with the 409 body; a create outside the initial state; a move by the done flag or by a stage.
 *   3. THE WORDS: the refusal sentence the agent's tool throws, the 409 body, the activity lines, the model's card.
 *   4. STAGE PIPELINES map to states by category (stateForStage), and the header the service is told.
 *   5. THE BUILD accepts "{entered_by}" and still refuses a `not_by` that is not a person.
 *   6. The answer's warnings, MCP's task text, recurrence. 7. PERIODS: the same rules, and the {now} stamp.
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-record-lifecycle.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const FIX = join(ROOT, "scripts/fixtures/record-lifecycle");
const EX = join(ROOT, "scripts/fixtures/record-areas/examples");
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

/** The compiled areas of the default profile plus `extra` ([name, path | object]), as the build compiles them. */
function compile(extra) {
  const dir = mkdtempSync(join(tmpdir(), "record-lifecycle-"));
  try {
    cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
    for (const [name, src] of extra) typeof src === "string" ? cpSync(src, join(dir, name)) : writeFileSync(join(dir, name), JSON.stringify(src));
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(ROOT, "scripts/gen-deployment-profile.mjs"), "--print-areas"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, PROFILES_DIR: dir, NODE_NO_WARNINGS: "1" }, maxBuffer: 64 * 1024 * 1024,
    });
    return { rc: r.status, areas: r.status === 0 ? JSON.parse(r.stdout) : null, err: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const enforce = (mode) => ["52-enforce.json", { records: { areas: { tasks: { lifecycle: { enforce: mode } } } } }];
const PIPELINE = ["50-pipeline.json", join(FIX, "pipeline.json")];
const OBLIGATION = ["50-obligation.json", join(EX, "obligation.json")];
const areasFor = (base, mode) => {
  const r = compile([base, enforce(mode)]);
  assert.equal(r.rc, 0, r.err);
  return r.areas;
};
const pipe = { off: areasFor(PIPELINE, "off"), warn: areasFor(PIPELINE, "warn"), strict: areasFor(PIPELINE, "strict") };
const obl = { off: areasFor(OBLIGATION, "off"), warn: areasFor(OBLIGATION, "warn"), strict: areasFor(OBLIGATION, "strict") };

const { prepareTaskWrite } = await import("../agent/lib/task-area.ts");
const { validateRecordWrite } = await import("../agent/lib/record-validate.ts");
const L = await import("../agent/lib/record-lifecycle.ts");
const { areaView, describeArea } = await import("../agent/lib/record-areas.ts");
const { RECORD_AREAS } = await import("../agent/lib/record-areas.generated.ts");

const ANA = "ana@example.com";
const BO = "bo@example.com";
const CATE = "cat@example.com";
const NOW = new Date("2026-10-14T08:00:00Z");
const task = (status, extra = {}) => ({ title: "Chase the invoice", status, done: status === "done", assignee: ANA, createdBy: ANA, dueAt: "2026-10-20T09:00:00.000Z", custom: {}, ...extra });
const ob = (state, extra = {}) => ({ title: "ALM return", status: "in_progress", assignee: ANA, createdBy: ANA, dueAt: "2026-10-31T09:00:00.000Z", custom: { state, frequency: "Quarterly", evidence: ["x/a.pdf"] }, ...extra });
const write = (areas, mode, body, who) => prepareTaskWrite(mode, body, { now: NOW, ...who }, areas);

/* ------------------------------------------------------------------------------------------------ 1. off */
console.log("1. \"off\" changes nothing (against upstream main at fc2ea3e)");
const { runOffCases } = await import("./lib/record-lifecycle-off-cases.mjs");
await check("every case answers byte for byte what main answered, and carries no lifecycle", async () => {
  const now = await runOffCases(ROOT, { pipeline: pipe.off, obligation: obl.off });
  const baseline = JSON.parse(readFileSync(join(FIX, "off-baseline.json"), "utf8"));
  for (const set of Object.keys(baseline)) {
    assert.equal(now[set].length, baseline[set].length, set);
    for (const [i, c] of baseline[set].entries()) {
      assert.equal(JSON.stringify(now[set][i]), JSON.stringify(c), `${set} #${i} ${c.label} (${JSON.stringify(c.who)})`);
      assert.equal(now[set][i].lifecycle, undefined, "no move is checked under off");
      assert.equal(now[set][i].prepared.lifecycle, undefined);
    }
  }
  assert.ok(baseline.pipeline.length >= 100 && baseline.obligation.length >= 70, "the cases cover the matrix");
});
await check("…and the same cases under warn and strict do NOT all answer so (the cases reach the rules)", async () => {
  const baseline = JSON.parse(readFileSync(join(FIX, "off-baseline.json"), "utf8"));
  for (const mode of ["warn", "strict"]) {
    const now = await runOffCases(ROOT, { pipeline: pipe[mode], obligation: obl[mode] });
    const moved = baseline.pipeline.filter((c, i) => JSON.stringify(now.pipeline[i].prepared) !== JSON.stringify(c.prepared)).length;
    assert.ok(moved > 20, `${mode}: ${moved} pipeline answers differ`);
  }
});
await check("the default profile's tasks lifecycle is off, so a default deployment checks no move", () => {
  assert.equal(RECORD_AREAS.tasks.lifecycle.enforce, "off");
  for (const id of ["deployments", "implementations", "periods"]) assert.ok(!RECORD_AREAS[id].lifecycle || RECORD_AREAS[id].lifecycle.enforce === "off", id);
  const r = write(RECORD_AREAS, "update", { status: "done" }, { actor: ANA, role: "member", before: task("open") });
  assert.deepEqual(r, { ok: true, body: null, warnings: [] });
});

/* ------------------------------------------------------------------------------------------------ 2. every rule, each mode */
console.log("2. Every rule in each mode");
const RULES = [
  // [what, areas set, mode, body, who, the rule broken (null: allowed)]
  ["a move the transitions do not list (open -> done)", pipe, "update", { status: "done" }, { actor: BO, role: "admin", before: task("open") }, "transition"],
  ["roles: cancelling is owner/admin only", pipe, "update", { status: "cancelled", reason: "duplicate" }, { actor: BO, role: "member", before: task("open") }, "roles"],
  ["roles: an admin may cancel", pipe, "update", { status: "cancelled", reason: "duplicate" }, { actor: BO, role: "admin", before: task("open") }, null],
  ["roles: no role known is no role", pipe, "update", { status: "cancelled", reason: "duplicate" }, { actor: BO, before: task("open") }, "roles"],
  ["requires: signing off needs a due date", pipe, "update", { status: "done" }, { actor: BO, role: "member", before: task("in_progress", { dueAt: null }) }, "requires"],
  // Sign off is also four eyes: a real caller has looked up who entered the state (here someone else), as every door does.
  ["requires: …given in the same write, it may", pipe, "update", { status: "done", dueAt: "2026-10-30T09:00:00.000Z" }, { actor: BO, role: "member", before: task("in_progress", { dueAt: null }), enteredBy: ANA }, null],
  ["requires_comment: blocking needs a comment", pipe, "update", { status: "blocked" }, { actor: BO, role: "member", before: task("in_progress") }, "requires_comment"],
  ["requires_comment: a blank one is none", pipe, "update", { status: "blocked", reason: "  " }, { actor: BO, role: "member", before: task("in_progress") }, "requires_comment"],
  ["requires_comment: with a reason, it may", pipe, "update", { status: "blocked", reason: "waiting on the bank" }, { actor: BO, role: "member", before: task("in_progress") }, null],
  ["not_by {entered_by}: who started it may not sign it off", pipe, "update", { status: "done" }, { actor: ANA, role: "admin", before: task("in_progress"), enteredBy: "Ana@Example.com" }, "not_by"],
  ["not_by {entered_by}: a second person may", pipe, "update", { status: "done" }, { actor: BO, role: "member", before: task("in_progress"), enteredBy: ANA }, null],
  ["not_by {entered_by}: nobody known to have entered it bars nobody", pipe, "update", { status: "done" }, { actor: ANA, role: "member", before: task("in_progress"), enteredBy: null }, null],
  ["not_by {entered_by}: never looked up for a stored record is not known, so refused (never let through)", pipe, "update", { status: "done" }, { actor: ANA, role: "member", before: task("in_progress") }, "not_by"],
  ["not_by a person field: the owner may not mark it complied", obl, "update", { custom: { state: "closed" } }, { actor: ANA, role: "admin", before: ob("under_review") }, "not_by"],
  ["not_by a person field: …nor by handing it to someone else in the same write", obl, "update", { custom: { state: "closed" }, assignee: BO }, { actor: ANA, role: "admin", before: ob("under_review") }, "not_by"],
  ["not_by a person field: an admin who is not the owner may", obl, "update", { custom: { state: "closed" } }, { actor: BO, role: "admin", before: ob("under_review") }, null],
  ["a move by the done flag is the move to done", pipe, "update", { done: true }, { actor: BO, role: "admin", before: task("open") }, "transition"],
  ["a move by a stage is the move to its state", pipe, "update", { stageId: "stage-done" }, { actor: BO, role: "admin", before: task("open"), stageState: "done" }, "transition"],
  ["a create outside the initial state is a move from nothing", pipe, "create", { title: "Done already", status: "done" }, { actor: BO, role: "admin" }, "transition"],
  ["a create in the initial state checks nothing", pipe, "create", { title: "New" }, { actor: BO, role: "member" }, null],
];
for (const [what, set, mode, body, who, rule] of RULES) {
  await check(`${what}: warn lets it through${rule ? " and reports it" : ""}, strict ${rule ? "refuses it (409 body)" : "lets it through"}`, () => {
    const w = write(set.warn, mode, body, who);
    assert.equal(w.ok, true, w.errors?.join(" "));
    if (rule) {
      assert.equal(w.lifecycle?.allowed, false);
      assert.ok(w.lifecycle.broken.some((b) => b.rule === rule), JSON.stringify(w.lifecycle.broken));
      assert.equal(w.warnings.length, 1);
      assert.equal(w.warnings[0], w.lifecycle.sentence);
    } else {
      assert.ok(!w.lifecycle || w.lifecycle.allowed, JSON.stringify(w.lifecycle));
      assert.deepEqual(w.warnings, []);
    }
    const s = write(set.strict, mode, body, who);
    if (rule) {
      assert.equal(s.ok, false);
      assert.equal(s.conflict.code, "lifecycle_refused");
      assert.ok(s.conflict.broken.some((b) => b.rule === rule), JSON.stringify(s.conflict.broken));
      assert.deepEqual(s.errors, [s.conflict.error]);
    } else assert.equal(s.ok, true, s.errors?.join(" "));
    const o = write(set.off, mode, body, who);
    assert.equal(o.ok, true, "off: through");
    assert.equal(o.lifecycle, undefined, "off: nothing checked");
    assert.deepEqual(o.warnings, []);
  });
}
await check("stamps: starting a task makes the caller its assignee (warn and strict), never under off", () => {
  for (const mode of ["warn", "strict"]) {
    const r = write(pipe[mode], "update", { status: "in_progress" }, { actor: "Bo@Example.com", role: "member", before: task("open") });
    assert.deepEqual(r.body, { status: "in_progress", assignee: "bo@example.com" }, mode);
    assert.deepEqual(r.lifecycle.stamp, { assignee: "bo@example.com" });
  }
  assert.deepEqual(write(pipe.off, "update", { status: "in_progress" }, { actor: BO, role: "member", before: task("open") }).body, { status: "in_progress" });
  const review = write(obl.warn, "update", { custom: { state: "under_review" } }, { actor: BO, role: "member", before: ob("evidence_submitted") });
  assert.deepEqual(review.body.custom, { state: "under_review", reviewer: BO }, "an own field stamped with the move");
});
await check("a stamp from a move that broke a rule still lands under warn (the move went through)", () => {
  const r = write(obl.warn, "update", { custom: { state: "under_review" } }, { actor: ANA, role: "member", before: ob("evidence_submitted") });
  assert.equal(r.lifecycle.allowed, false);
  assert.equal(r.body.custom.reviewer, ANA);
});
await check("a move by the done flag or a stage sends the request's own words, not the status it was checked as", () => {
  assert.deepEqual(write(pipe.warn, "update", { done: true }, { actor: BO, role: "admin", before: task("open") }).body, { done: true });
  assert.deepEqual(write(pipe.warn, "update", { stageId: "stage-done" }, { actor: BO, role: "admin", before: task("open"), stageState: "done" }).body, { stageId: "stage-done" });
});
await check("without the stored row (a caller that read none) a move is not checked: the write is today's", () => {
  const r = write(pipe.strict, "update", { status: "done" }, { actor: BO, role: "admin" });
  assert.equal(r.ok, true);
  assert.equal(r.lifecycle, undefined);
});
await check("the same rules for every area: a deployment's lifecycle (the compliance example) through validateRecordWrite", () => {
  const r = compile([["50-c.json", join(EX, "compliance.json")], ["51-o.json", join(EX, "obligation.json")], ["52-strict.json", { records: { areas: { deployments: { lifecycle: { enforce: "strict" } } } } }]]);
  assert.equal(r.rc, 0, r.err);
  const v = areaView("deployments", r.areas);
  const before = { releaseStatus: "pending-approval", deployOwnerEmail: ANA, custom: {} };
  const refused = validateRecordWrite("deployments", { mode: "update", before, patch: { releaseStatus: "deployed" }, actor: BO, role: "member", now: NOW }, r.areas);
  assert.equal(refused.ok, false);
  assert.equal(refused.conflict.code, "lifecycle_refused");
  assert.match(refused.conflict.error, /only owner or admin may make it/);
  assert.equal(v.lifecycle.enforce, "strict");
});

/* ------------------------------------------------------------------------------------------------ 3. the words */
console.log("3. The words: refusal, 409 body, activity lines, the model's card");
await check("the agent's refusal names the move, what is wrong, and the moves there are with what each needs", () => {
  const r = write(pipe.strict, "update", { status: "done" }, { actor: ANA, role: "member", before: task("in_progress"), enteredBy: ANA });
  assert.equal(r.errors[0], 'Moving from "In progress" to "Done" is not possible now: "Done" (Sign off): not by the person who moved it to "In progress"; a second person must. From "In progress" you can move to: "Blocked" (Block; needs a comment), "Done" (Sign off; not by you: a second person must; needs "Due").');
  const skip = write(pipe.strict, "update", { status: "done" }, { actor: BO, role: "admin", before: task("open") });
  assert.equal(skip.errors[0], '"Open" cannot move to "Done". From "Open" you can move to: "Backlog" (Park), "In progress" (Start), "Cancelled" (Cancel; needs a comment).');
  const created = write(pipe.strict, "create", { title: "x", status: "done" }, { actor: BO, role: "admin" });
  assert.equal(created.errors[0], 'A new task cannot start in "Done": it starts in "Open".');
  const obligation = write(obl.strict, "update", { custom: { state: "closed" } }, { actor: BO, role: "member", before: ob("under_review") });
  assert.equal(obligation.errors[0], 'Moving from "Under review" to "Complied" is not possible now: "Complied" (Mark complied): only owner or admin may make it. From "Under review" you can move to: "In progress" (Ask for more evidence; needs a comment).');
});
await check("the 409 body: the sentence, the code, the move, the broken rules and the allowed moves", () => {
  const r = write(pipe.strict, "update", { status: "cancelled" }, { actor: BO, role: "member", before: task("open") });
  assert.deepEqual(r.conflict, {
    error: r.errors[0],
    errors: r.errors,
    code: "lifecycle_refused",
    field: "status",
    from: "open",
    to: "cancelled",
    broken: [
      { rule: "roles", message: "only owner or admin may make it", transition: "Cancel" },
      { rule: "requires_comment", message: "it needs a comment saying why", transition: "Cancel" },
    ],
    allowed: [
      { to: "backlog", label: "Backlog", action: "Park" },
      { to: "in_progress", label: "In progress", action: "Start" },
    ],
  });
});
await check("the activity lines: the move (with its comment and the marker) and, under warn, the broken rule", () => {
  const v = areaView("tasks", pipe.warn);
  const w = write(pipe.warn, "update", { status: "cancelled", reason: "filed twice" }, { actor: BO, role: "member", before: task("open") });
  const { outcomeEvents } = { outcomeEvents: (c, comment) => [L.moveEvent(v, c, comment), ...(c.allowed ? [] : [L.warnEvent(c)])] };
  assert.deepEqual(outcomeEvents(w.lifecycle, "filed twice"), [
    'Status moved "Open" → "Cancelled": filed twice [status: open → cancelled]',
    "Lifecycle rule not followed (roles): Cancel: only owner or admin may make it. The move went through (enforce: warn).",
  ]);
  const ok = write(pipe.warn, "update", { status: "in_progress" }, { actor: BO, role: "member", before: task("open") });
  assert.equal(L.moveEvent(v, ok.lifecycle, null), 'Status moved "Open" → "In progress" (Start) [status: open → in_progress]');
  const created = write(pipe.warn, "create", { title: "x", status: "in_progress" }, { actor: BO, role: "member" });
  assert.equal(L.moveEvent(v, created.lifecycle), 'Task created in "In progress" [status:  → in_progress]');
  assert.ok(L.moveEvent(v, ok.lifecycle).endsWith(L.enteredSuffix("in_progress")), "the next move finds who entered the state by this suffix");
});
await check("the model's card: the lifecycle as its moves from each state, with roles, four eyes, fields, comments, stamps, and the mode", () => {
  assert.equal(describeArea("tasks"), null, "the default: no card");
  const strict = describeArea("tasks", pipe.strict);
  assert.ok(!/"[A-Za-z ]+" → "/.test(strict), "no chain of states read as an order");
  for (const line of [
    '  Its state is `status`: "backlog" ("Backlog"), "open" ("Open"), "in_progress" ("In progress"), "blocked" ("Blocked"), "done" ("Done"), "cancelled" ("Cancelled"); a new one starts in "Open".',
    '  - From "Open" you can go to "Backlog" (Park), "In progress" (Start; sets "Assignee" to you).',
    '  - From "In progress" you can go to "Blocked" (Block; needs a comment saying why (`reason`)), "Done" (Sign off; not by whoever moved it into the state it leaves: a second person must; needs "Due" set).',
    '  - From any state you can go to "Cancelled" (Cancel; owner or admin only; needs a comment saying why (`reason`)).',
    '  - "Cancelled": no move out.',
    "  A move not listed here, or that breaks its rule, is refused, and the refusal names the moves you can make.",
  ]) assert.ok(strict.split("\n").includes(line), `${line}\n---\n${strict}`);
  assert.match(describeArea("tasks", obl.warn), /let through but noted in the activity feed/);
  assert.match(describeArea("tasks", obl.warn), /- From "Under review" you can go to "Complied" \(Mark complied; owner or admin only; not by its owner\)/);
  assert.doesNotMatch(describeArea("tasks", obl.off), /refused|noted in the activity feed/, "off: the card says nothing of enforcement");
});

/* ------------------------------------------------------------------------------------------------ 4. stage pipelines */
console.log("4. Stage pipelines map to states by category");
await check("a stage's category, else the state its label names; else null (the caller keeps today's reading)", () => {
  const v = areaView("tasks", obl.warn);
  assert.equal(L.stateForStage(v, { id: "s1", label: "Under review" }), "under_review");
  assert.equal(L.stateForStage(v, { id: "s2", label: "complied" }), "closed", "by the state's label");
  assert.equal(L.stateForStage(v, { id: "s3", label: "Sign-off", category: "done" }), "closed", "by its category");
  assert.equal(L.stateForStage(v, { id: "s4", label: "Waiting" }), null);
  const d = areaView("tasks");
  for (const s of ["backlog", "open", "in_progress", "blocked", "done", "cancelled"]) assert.equal(L.stateForStage(d, { id: s, label: d.display("status", s) }), s, s);
});
await check("the header the task service maps stages by: every state, its category and the status it stores", () => {
  const h = L.taskStatesHeader(areaView("tasks", obl.warn));
  const states = JSON.parse(decodeURIComponent(h["x-task-states"]));
  assert.deepEqual(states.find((s) => s.value === "under_review"), { value: "under_review", label: "Under review", category: "active", status: "in_progress" });
  const d = JSON.parse(decodeURIComponent(L.taskStatesHeader(areaView("tasks"))["x-task-states"]));
  assert.deepEqual(d.map((s) => [s.value, s.status]), [["backlog", "backlog"], ["open", "open"], ["in_progress", "in_progress"], ["blocked", "blocked"], ["done", "done"], ["cancelled", "cancelled"]], "the default: each status is its own");
});

/* ------------------------------------------------------------------------------------------------ 5. the build */
console.log("5. The build");
await check('the build accepts not_by "{entered_by}" and still refuses a not_by that is not a person field', () => {
  assert.equal(compile([PIPELINE]).rc, 0);
  const bad = compile([["50-bad.json", { records: { areas: { tasks: { lifecycle: { field: "status", transitions: [{ from: ["open"], to: "done", not_by: "title" }] } } } } }]]);
  assert.notEqual(bad.rc, 0);
  assert.match(bad.err, /not_by: "title" must be a person field/);
});

/* ------------------------------------------------------------------------------------------------ 6. warnings, MCP, recurrence */
console.log("6. The answer's warnings, MCP's task text, recurrence");
await check("a warn-mode move is answered with a WriteWarning (the shape the UI shows as a toast); strict and allowed moves with none", () => {
  const w = write(pipe.warn, "update", { status: "cancelled" }, { actor: BO, role: "member", before: task("open") });
  assert.deepEqual(L.warningOf(w.lifecycle), {
    code: "lifecycle_rule_broken",
    message: w.warnings[0],
    field: "status",
    from: "open",
    to: "cancelled",
    broken: [
      { rule: "roles", message: "only owner or admin may make it", transition: "Cancel" },
      { rule: "requires_comment", message: "it needs a comment saying why", transition: "Cancel" },
    ],
    allowed: [{ to: "backlog", label: "Backlog", action: "Park" }, { to: "in_progress", label: "In progress", action: "Start" }],
  });
  const src = readFileSync(join(ROOT, "lib/record-lifecycle-server.ts"), "utf8");
  assert.match(src, /enforce === "warn" && !outcome\.check\.allowed \? \{ warnings: \[warningOf\(outcome\.check\)\] \}/, "the routes' after-step puts it in the answer");
});
await check("MCP's task_update: under a redefined task with transitions its text lists the moves, and it takes `reason` when a move needs a comment", async () => {
  const { createTools } = await import("../setup/workspace-tools.mjs");
  const { FOLDER } = await import("../agent/lib/dataroom-folders.ts");
  const { describeMoves } = await import("../agent/lib/record-areas.ts");
  const v = areaView("tasks", obl.strict);
  const tasks = { noun: v.noun, nouns: v.nouns, stateField: "state", states: v.lifecycle.states.map((x) => ({ value: x.value, label: x.label })), priorities: v.options("priority"), ownFields: [], takesComment: true, moves: describeMoves("tasks", obl.strict).map((l) => l.trim()).join("\n") };
  const tools = createTools({ api: async () => ({}), folders: FOLDER, actor: ANA, tasks, blobStore: () => null });
  const update = tools.find((t) => t.name === "task_update");
  assert.match(update.description, /\n- From "Under review" you can go to "Complied" \(Mark complied; owner or admin only; not by its owner\)/);
  assert.match(update.description, /A move not listed here, or that breaks its rule, is refused/);
  assert.equal(update.inputSchema.properties.reason.type, "string");
  const plain = createTools({ api: async () => ({}), folders: FOLDER, actor: ANA, blobStore: () => null }).find((t) => t.name === "task_update");
  assert.equal(plain.inputSchema.properties.reason, undefined, "the default task_update is unchanged");
  assert.doesNotMatch(plain.description, /you can go to/);
});
const R = await import("../agent/lib/task-recurrence.ts");
await check("recurrence: which areas recur, what completes a task, the intervals (a month end stays in its month)", () => {
  assert.equal(R.recursOnDone(RECORD_AREAS), false, "the default task does not recur");
  assert.equal(R.recursOnDone(obl.off), true, "the obligation does, whatever enforce says");
  const v = areaView("tasks", obl.off);
  assert.equal(R.completes(v, ob("under_review"), ob("closed")), true);
  assert.equal(R.completes(v, ob("closed"), ob("closed")), false, "already done");
  assert.equal(R.completes(v, ob("under_review"), ob("not_applicable")), false, "cancelled is not done");
  assert.equal(R.completes(v, null, ob("closed")), false, "no stored row: nothing to compare");
  assert.equal(R.addInterval("2026-10-31T09:00:00.000Z", "+3M"), "2027-01-31T09:00:00.000Z");
  assert.equal(R.addInterval("2026-01-31T09:00:00.000Z", "+1M"), "2026-02-28T09:00:00.000Z");
  assert.equal(R.addInterval("2028-02-29T09:00:00.000Z", "+1y"), "2029-02-28T09:00:00.000Z");
  assert.equal(R.addInterval("2026-10-14T09:00:00.000Z", "+2w"), "2026-10-28T09:00:00.000Z");
  assert.equal(R.addInterval("2026-10-14T09:00:00.000Z", "+6M"), "2027-04-14T09:00:00.000Z");
  assert.equal(R.addInterval("2026-10-14T09:00:00.000Z", "monthly"), null);
});
await check("recurrence: the next occurrence copies the listed fields, starts in the initial state, is due one interval on, and links back", () => {
  const prev = { id: "11111111-1111-4111-8111-111111111111", title: "ALM return", notes: "Form A", status: "done", done: true, priority: "high", assignee: ANA, dueAt: "2026-10-31T09:00:00.000Z", containerType: "implementation", containerId: "acme", containerLabel: "Acme", custom: { state: "closed", frequency: "Quarterly", obligation_ref: "OBL-0042", department: "Finance", evidence: ["x/a.pdf"], reviewer: BO } };
  const body = R.nextOccurrence(prev, CATE, NOW, obl.warn);
  assert.deepEqual(body, {
    title: "ALM return", notes: "Form A", priority: "high", assignee: ANA, dueAt: "2027-01-31T09:00:00.000Z", containerType: "implementation", containerId: "acme", containerLabel: "Acme",
    custom: { frequency: "Quarterly", obligation_ref: "OBL-0042", department: "Finance", state: "not_started", recurs_from: prev.id },
    status: "open", statusFrom: "category", createdBy: CATE,
  });
  assert.equal(R.nextOccurrence({ ...prev, custom: { ...prev.custom, frequency: "One-time" } }, CATE, NOW, obl.warn), null, "no interval: no next one");
  assert.equal(R.nextOccurrence({ ...prev, dueAt: null }, CATE, NOW, obl.warn)?.dueAt, "2027-01-14T08:00:00.000Z", "no due date: one interval after the day it was done");
  assert.equal(R.nextOccurrence(prev, CATE, NOW, RECORD_AREAS), null, "the default task does not recur");
});

await check("recurrence's link is the system's: the build refuses an own field called recurs_from, and the generated column is no field", () => {
  const bad = compile([["50-bad.json", { records: { areas: { tasks: { fields: { recurs_from: { type: "text", label: "Recurs from" } } } } } }]]);
  assert.notEqual(bad.rc, 0);
  assert.match(bad.err, /records\.areas\.tasks\.fields\.recurs_from: /);
  assert.equal(RECORD_AREAS.tasks.fields.recursFrom, undefined);
  assert.equal(compile([OBLIGATION]).areas.tasks.fields.recursFrom, undefined);
});

/* ------------------------------------------------------------------------------------------------ 7. periods */
console.log("7. Periods: the same rules for the cycles routes");
const PERIODS_FIX = ["50-periods.json", join(FIX, "periods.json")];
const periodsFor = (mode) => {
  const r = compile([PERIODS_FIX, ["52-enforce.json", { records: { areas: { periods: { lifecycle: { enforce: mode } } } } }]]);
  assert.equal(r.rc, 0, r.err);
  return r.areas;
};
await check('the build accepts a "{now}" stamp on a date or time field, and refuses it on another', () => {
  assert.equal(compile([PERIODS_FIX]).rc, 0);
  const bad = compile([["50-bad.json", { records: { areas: { periods: { lifecycle: { field: "state", transitions: [{ from: ["planning"], to: "active", set: { goal: "{now}" } }] } } } } }]]);
  assert.notEqual(bad.rc, 0);
  assert.match(bad.err, /set\.goal: \{now\} is a time, and "goal" is text/);
});
await check("a period's move: roles, four eyes, a comment, the {now} stamp; strict refuses, warn reports, off checks nothing", () => {
  const p = { strict: periodsFor("strict"), warn: periodsFor("warn"), off: periodsFor("off") };
  const before = { name: "Week 42", state: "planning", createdBy: ANA, startsAt: null };
  const go = (areas, patch, who, b = before) => validateRecordWrite("periods", { mode: "update", before: b, patch, actor: who.actor, role: who.role, now: NOW, ...who.extra }, areas);
  const member = go(p.strict, { state: "active" }, { actor: ANA, role: "member" });
  assert.equal(member.ok, false);
  assert.equal(member.conflict.broken[0].rule, "roles");
  const admin = go(p.strict, { state: "active" }, { actor: CATE, role: "admin" });
  assert.equal(admin.ok, true);
  assert.equal(admin.columns.startsAt, NOW.toISOString(), "Start stamps the start");
  const active = { ...before, state: "active" };
  assert.equal(go(p.strict, { state: "closed" }, { actor: CATE, role: "admin", extra: { enteredBy: CATE } }, active).conflict.broken[0].rule, "not_by");
  assert.equal(go(p.strict, { state: "closed" }, { actor: BO, role: "member", extra: { enteredBy: CATE } }, active).ok, true);
  assert.equal(go(p.strict, { state: "planning" }, { actor: BO, role: "member" }, active).conflict.broken[0].rule, "requires_comment");
  assert.equal(go(p.strict, { state: "planning" }, { actor: BO, role: "member", extra: { comment: "scope changed" } }, active).ok, true);
  const warned = go(p.warn, { state: "active" }, { actor: ANA, role: "member" });
  assert.equal(warned.ok, true);
  assert.equal(L.warningOf(warned.lifecycle).broken[0].rule, "roles");
  const off = go(p.off, { state: "closed" }, { actor: ANA, role: "member" });
  assert.equal(off.ok, true);
  assert.equal(off.lifecycle, null);
  assert.deepEqual(off.columns, { state: "closed" }, "off: no stamp");
});

/* ------------------------------------------------------------------------------------------------ 8. a legacy spelling */
console.log("8. Four eyes on a record that stores its state in a legacy spelling (legacy_values), in every area");
// The validator reads a stored legacy spelling as the state it stands for; whoever asks who entered that state must ask
// about the same state, or the four-eyes lookup is skipped and the person who entered it signs it off (PR #192 review).
const legacyTasks = compile([PIPELINE, enforce("strict"), ["53-legacy.json", { records: { areas: { tasks: { fields: { status: { legacy_values: { doing: "in_progress" } } } } } } }]]);
const legacyPeriods = compile([PERIODS_FIX, ["53-legacy.json", { records: { areas: { periods: { fields: { state: { legacy_values: { running: "active" } } } } } } }]]);
const legacyItems = compile([["50-own-state.json", join(EX, "own-state.json")], ["53-four-eyes.json", { records: { areas: { deployments: { fields: { stage: { renamed_from: ["old_stage", "first_stage"] } }, lifecycle: { enforce: "strict", transitions: [{ from: ["queued"], to: "working", label: "Start", not_by: "{entered_by}" }, { from: ["working"], to: "finished", label: "Finish" }] } } } } }]]);
await check("the three fixtures compile (a legacy spelling on each lifecycle field; the work item's state renamed twice)", () => {
  for (const r of [legacyTasks, legacyPeriods, legacyItems]) assert.equal(r.rc, 0, r.err);
});
const { prepareRecordWrite } = await import("../agent/lib/record-area-write.ts");
const { preparePeriodWrite } = await import("../agent/lib/period-area.ts");
const PATHS = [
  // [area, view, the stored row in a legacy spelling, the state it stands for, the legacy spelling, the move, write(who)]
  ["tasks", areaView("tasks", legacyTasks.areas ?? undefined), task("doing"), "in_progress", "doing",
    (who) => prepareTaskWrite("update", { status: "done" }, { now: NOW, role: "member", before: task("doing"), ...who }, legacyTasks.areas)],
  ["periods", areaView("periods", legacyPeriods.areas ?? undefined), { name: "Week 42", state: "running", createdBy: ANA, startsAt: null }, "active", "running",
    (who) => preparePeriodWrite("update", { state: "closed" }, { now: NOW, role: "member", before: { name: "Week 42", state: "running", createdBy: ANA, startsAt: null }, ...who }, legacyPeriods.areas)],
  ["deployments", areaView("deployments", legacyItems.areas ?? undefined), { customerId: "acme", deploymentId: "item-1", deployedVersion: "First", releaseStatus: "in-progress", region: "on-prem", environment: "prod", healthStatus: "unknown", custom: { first_stage: "todo" } }, "queued", "todo",
    (who) => prepareRecordWrite("deployments", "update", { deploymentId: "item-1", custom: { stage: "working" } }, { now: NOW, role: "member", before: { customerId: "acme", deploymentId: "item-1", deployedVersion: "First", releaseStatus: "in-progress", region: "on-prem", environment: "prod", healthStatus: "unknown", custom: { first_stage: "todo" } }, ...who }, legacyItems.areas)],
];
const refusedBy = (r) => (r.ok ? null : r.conflict?.broken?.map((b) => b.rule).join(",") ?? r.errors?.join(" "));
for (const [area, v, row, state, spelling, move] of PATHS) {
  await check(`${area}: the stored "${spelling}" is the state "${state}" for four eyes: looked up, and found in the feed under either spelling`, () => {
    assert.equal(L.storedStateOf(v, row), state);
    assert.equal(L.needsEnteredBy(v, L.storedStateOf(v, row)), true, "the lookup is not skipped");
    assert.equal(L.needsEnteredBy(v, spelling), true, "nor when asked with the stored spelling");
    assert.deepEqual(L.spellingsOf(v, state), [state, spelling], "the feed's move line may name either");
    assert.deepEqual(L.spellingsOf(v, spelling), [state, spelling]);
  });
  await check(`${area}: who entered "${spelling}" cannot sign it off; someone else can; not known (never looked up) is refused`, () => {
    assert.equal(refusedBy(move({ actor: ANA, enteredBy: ANA })), "not_by");
    assert.equal(refusedBy(move({ actor: ANA, enteredBy: "Ana@Example.com" })), "not_by", "the same person in another case");
    assert.equal(refusedBy(move({ actor: BO, enteredBy: ANA })), null);
    assert.equal(refusedBy(move({ actor: ANA })), "not_by");
    assert.equal(refusedBy(move({ actor: ANA, enteredBy: null })), null, "a lookup that found nobody bars nobody (docs/DEPLOYMENT_PROFILE.md)");
  });
}
await check("clearing a renamed lifecycle field judges what will be stored: no earlier key stands in for it", () => {
  const v = areaView("deployments", legacyItems.areas);
  const before = { customerId: "acme", deploymentId: "item-1", deployedVersion: "First", releaseStatus: "in-progress", region: "on-prem", environment: "prod", healthStatus: "unknown", custom: { old_stage: "working", first_stage: "todo" } };
  const r = validateRecordWrite("deployments", { mode: "update", before, patch: { custom: { stage: null } }, actor: BO, role: "member", now: NOW }, legacyItems.areas);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal("old_stage" in r.custom || "first_stage" in r.custom, false, JSON.stringify(r.custom));
  assert.equal(v.get({ custom: r.custom }, "stage"), undefined, "the record holds no state once cleared");
  assert.equal(r.derived.category, undefined, "no category is derived from a stale earlier key");
});

console.log(process.exitCode ? `test-record-lifecycle: FAILED (${passed} passed)` : `test-record-lifecycle: all ${passed} checks passed`);
