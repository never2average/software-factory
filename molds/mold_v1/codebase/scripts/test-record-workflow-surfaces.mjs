/**
 * A RECORD'S WORKFLOW ON ITS SURFACES, OFFLINE (lib/record-workflow-view.ts, the holder and due-date changes in
 * lib/record-workflow-runtime.ts, the agent's tools; docs/WORKFLOW_ENGINE.md phase 7 "Surfaces"). No database.
 *
 *   1. WHAT A PERSON READS: the next step, its holders and due date, every step, the timeline; names on the roster for a
 *      member (never an email), emails for an owner or an admin; the cards' line.
 *   2. WHO HOLDS A STEP: only a supervisor (an owner or an admin, the step rules' checkReassign) changes it; someone not
 *      in the workspace is refused; the holder named is pinned; the history says who changed it.
 *   3. A STEP'S DUE DATE: the one-time bounded extension on a step that declares it (forward, within the cap, once);
 *      an admin's correction never spends it; a step whose date is the workflow's own is refused for a member.
 *   4. NOTHING WITHOUT A WORKFLOW: the default profile registers none of the three tools, adds no `evidence` or
 *      `reason` to the record tools, answers 404 at the ops route, and draws nothing.
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-record-workflow-surfaces.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/record-workflows", name), "utf8"));
const PROFILE = fixture("review.json");
const DSL = PROFILE.records.workflows["maker-checker"];
for (const [id, extra] of Object.entries(fixture("surfaces.json").steps)) Object.assign(DSL.init.steps.find((s) => s.id === id), extra);

let passed = 0;
const check = async (what, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${what}`);
  } catch (e) {
    console.error(`  FAIL ${what}\n${e.stack ?? e.message}`);
    process.exitCode = 1;
  }
};
const section = (title) => console.log(`\n${title}`);

function compiled(extra) {
  const dir = mkdtempSync(join(tmpdir(), "record-workflow-surfaces-"));
  try {
    cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
    for (const [name, src] of extra) writeFileSync(join(dir, name), JSON.stringify(src, null, 2));
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(ROOT, "scripts/gen-deployment-profile.mjs"), "--print-areas"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, PROFILES_DIR: dir, NODE_NO_WARNINGS: "1" }, maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const runtime = await import("../lib/record-workflow-runtime.ts");
const view = await import("../lib/record-workflow-view.ts");
const { identitySnapshot } = await import("../agent/lib/people-directory.ts");

const ORG = "org-wf-a";
const OWNER = "a-owner@x.test";
const MAKER = "b-maker@x.test";
const CHECKER = "c-checker@x.test";
const ADMIN = "d-admin@x.test";
const LEAD = "e-lead@x.test";
const OTHER = "f-other@x.test";
const ROSTER = [
  { orgId: ORG, email: MAKER, name: "Mara Maker", attributes: { duty: "maker" } },
  { orgId: ORG, email: CHECKER, name: "Cy Checker", attributes: { duty: "checker" }, managerEmail: LEAD },
  { orgId: ORG, email: ADMIN, attributes: { duty: "checker" } },
  { orgId: ORG, email: LEAD, name: "Lee Lead" },
  { orgId: ORG, email: OTHER },
];
const MEMBERS = [
  { orgId: ORG, email: OWNER, role: "owner" },
  { orgId: ORG, email: MAKER, role: "member" },
  { orgId: ORG, email: CHECKER, role: "member" },
  { orgId: ORG, email: ADMIN, role: "admin" },
  { orgId: ORG, email: LEAD, role: "member" },
  { orgId: ORG, email: OTHER, role: "member" },
];
const DUTY = Object.fromEntries(ROSTER.filter((r) => r.attributes?.duty).map((r) => [r.email, r.attributes.duty]));
const SNAPSHOT = identitySnapshot(ORG, ROSTER, MEMBERS);
for (const u of SNAPSHOT.users) if (DUTY[u.id]) u.duty = DUTY[u.id];
const { directory, rbac } = runtime.engineDirectory(SNAPSHOT);
const AREAS = compiled([["50-review.json", PROFILE]]);
const binding = runtime.workflowBindingOf("deployments", AREAS, { "maker-checker": DSL });
const T0 = new Date("2026-05-04T09:00:00.000Z");
const seed = (state, now = T0) => runtime.seedInstance({ binding, orgId: ORG, entity: { type: "deployments", id: "acct-1/D-1" }, state, data: {}, directory, actor: MAKER, createdBy: MAKER, now });
const nameOf = (id) => directory.get(id, ORG)?.name ?? null;
const member = { privileged: false, nameOf, now: T0 };
const admin = { privileged: true, nameOf, now: T0 };
const day = (n, from = T0) => new Date(from.getTime() + n * 86_400_000).toISOString();
const submitted = async () => {
  const inst = seed("drafting");
  await runtime.applyStepMove({ dsl: DSL, instance: inst, directory, rbac, step: { id: "prepare", state: "completed" }, actor: MAKER, comment: "done", evidence: "doc://1", now: T0 });
  return inst;
};

// ── 1. what a person reads ──────────────────────────────────────────────────────────────────────────────────────────

section("1. What a person reads");

await check("the next step, its holders by name for a member, and its due date from the workflow's start", () => {
  const v = view.workflowView(seed("drafting"), member);
  assert.equal(v.next.title, "Prepare");
  assert.deepEqual(v.next.holders, [{ name: "Mara Maker" }]);
  assert.equal(v.next.due_on, day(3));
  assert.equal(v.next.overdue, false);
  assert.deepEqual(v.steps.map((s) => [s.id, s.active, s.due_on]), [["prepare", true, day(3)], ["review", false, day(5)]]);
  assert.equal(v.finished, false);
});

await check("a member never reads an email; an admin reads each holder's email, and a name where the roster has none", async () => {
  const inst = await submitted();
  const m = view.workflowView(inst, member);
  assert.deepEqual(m.next.holders, [{ name: "Cy Checker" }, { name: "someone with no name on the roster" }]);
  assert.ok(!JSON.stringify(m).includes("@"), "no email in a member's view");
  const a = view.workflowView(inst, admin);
  assert.deepEqual(a.next.holders, [{ id: CHECKER, name: "Cy Checker" }, { id: ADMIN, name: ADMIN }]);
});

await check("the timeline: who did what, oldest first; the rules' own changes as the workflow's", async () => {
  const inst = await submitted();
  const lines = view.workflowView(inst, member).timeline.map((t) => `${t.who}|${t.what}|${t.kind}`);
  assert.deepEqual(lines, [
    "Mara Maker|The workflow started|placed",
    "Mara Maker|Comment on Prepare: done|comment",
    "Mara Maker|Evidence on Prepare: doc://1|evidence",
    "Mara Maker|Prepare completed|decision",
    "the workflow|Review opened|rule",
  ]);
});

await check("overdue once the date has passed while the step is open; the cards' line says the same", async () => {
  const inst = await submitted();
  const late = { ...member, now: new Date(day(6)) };
  const v = view.workflowView(inst, late);
  assert.equal(v.next.overdue, true);
  assert.deepEqual(view.nextStepSummary(inst, late), { finished: false, step: "Review", holders: ["Cy Checker", "someone with no name on the roster"], due_on: day(5), overdue: true });
});

await check("a finished workflow: no next step, finished", async () => {
  const inst = await submitted();
  await runtime.applyStepMove({ dsl: DSL, instance: inst, directory, rbac, step: { id: "review", state: "completed" }, actor: CHECKER, comment: "fine", now: T0 });
  assert.deepEqual(view.nextStepSummary(inst, member), { finished: true, step: null, holders: [], due_on: null, overdue: false });
});

await check("the record key the screens send is the one the instance is stored under", () => {
  assert.equal(view.recordKeyOf("deployments", { id: "D 1", customerId: "acct/1" }), "acct%2F1/D%201");
  assert.equal(view.recordKeyOf("tasks", { id: "t-1" }), "t-1");
  assert.equal(view.areaRunsWorkflow(AREAS.deployments), true);
  assert.equal(view.areaRunsWorkflow({ lifecycle: { workflow: "maker-checker", enforce: "off" } }), false);
  assert.equal(view.areaRunsWorkflow({ lifecycle: {} }), false);
});

// ── 2. who holds a step ──────────────────────────────────────────────────────────────────────────────────────────────

section("2. Who holds a step: supervisors only");

const holders = (inst, actor, next, stepId = "review") => runtime.changeStepHolders({ dsl: DSL, instance: inst, directory, rbac, actor, stepId, holders: next, now: T0 });

await check("a member (a holder, or the holder's supervisor on the roster) may not: 403 with the rule's sentence, nothing changed", async () => {
  const inst = await submitted();
  const before = JSON.stringify(inst);
  for (const who of [CHECKER, LEAD, MAKER]) {
    const r = await holders(inst, who, [CHECKER]);
    assert.equal(r.ok, false, who);
    assert.equal(r.status, 403);
    assert.equal(r.code, "REASSIGN_NEEDS_SUPERVISOR");
    assert.match(r.message, /Ask someone who supervises this work, or an administrator/);
  }
  assert.equal(JSON.stringify(inst), before);
});

await check("an admin hands the review to one checker: pinned, a step_patched row by the admin, the timeline says so", async () => {
  const inst = await submitted();
  const r = await holders(inst, ADMIN, [CHECKER]);
  assert.deepEqual(r, { ok: true, changed: true });
  const review = inst.steps.find((s) => s.id === "review");
  assert.deepEqual(review.assignee, [CHECKER]);
  assert.equal(review.assignee_pinned, true);
  const row = inst.history.find((e) => e.type === "step_patched" && e.data?.assignee);
  assert.equal(row.actor, ADMIN);
  assert.deepEqual(row.data.assignee, { before: [CHECKER, ADMIN], after: [CHECKER] });
  assert.ok(view.workflowView(inst, member).timeline.some((t) => t.what === "Review now held by Cy Checker" && t.kind === "holder"));
});

await check("someone not in the workspace, or nobody, cannot hold a step; an unknown step is named", async () => {
  const inst = await submitted();
  assert.equal((await holders(inst, ADMIN, ["z@elsewhere.test"])).code, "ASSIGNEE_OUTSIDE_RULE");
  assert.equal((await holders(inst, ADMIN, [])).status, 422);
  assert.equal((await holders(inst, ADMIN, "x")).code, "INVALID_VALUE");
  assert.match((await holders(inst, ADMIN, [CHECKER], "sign")).message, /no step "sign"/);
});

await check("the same holders again changes nothing (no row)", async () => {
  const inst = await submitted();
  const n = inst.history.length;
  assert.deepEqual(await holders(inst, ADMIN, [ADMIN, CHECKER]), { ok: true, changed: false });
  assert.equal(inst.history.length, n);
});

await check("an admin is offered who the step's rule could pick (the checkers); a step with no rule, everyone", async () => {
  const inst = await submitted();
  assert.deepEqual(runtime.eligibleHolders({ dsl: DSL, instance: inst, directory, stepId: "review" }).sort(), [ADMIN, CHECKER].sort());
});

// ── 3. a step's due date ─────────────────────────────────────────────────────────────────────────────────────────────

section("3. A step's due date: the one-time extension");

const due = (inst, actor, dueOn, stepId = "review", now = T0) => runtime.changeStepDueDate({ dsl: DSL, instance: inst, directory, rbac, actor, stepId, dueOn, now });

await check("the holder extends the review once: forward, within its cap; a due_date_extended row beside the change", async () => {
  const inst = await submitted();
  const r = await due(inst, CHECKER, day(8));
  assert.deepEqual(r, { ok: true, changed: true });
  assert.equal(inst.steps.find((s) => s.id === "review").due_on, day(8));
  assert.ok(inst.history.some((e) => e.type === "due_date_extended" && e.actor === CHECKER));
  const again = await due(inst, CHECKER, day(9));
  assert.equal(again.code, "DUE_ON_ALREADY_EXTENDED");
});

await check("backwards and past the cap are refused; outside the window too", async () => {
  const inst = await submitted();
  assert.equal((await due(inst, CHECKER, day(4))).code, "DUE_ON_BACKDATE");
  assert.equal((await due(inst, CHECKER, day(13))).code, "DUE_ON_OVER_CAP");
  const early = await submitted();
  const far = runtime.changeStepDueDate({ dsl: { ...DSL, init: { ...DSL.init, steps: DSL.init.steps.map((s) => (s.id === "review" ? { ...s, due_on_extension: { max_days: 7, window_days: 1 } } : s)) } }, instance: early, directory, rbac, actor: CHECKER, stepId: "review", dueOn: day(8), now: T0 });
  assert.equal((await far).code, "DUE_ON_BEFORE_WINDOW");
});

await check("an admin corrects freely, and never spends the holder's extension", async () => {
  const inst = await submitted();
  assert.deepEqual(await due(inst, ADMIN, day(6)), { ok: true, changed: true });
  assert.equal(inst.history.filter((e) => e.type === "due_date_extended").length, 0);
  assert.deepEqual(await due(inst, CHECKER, day(9)), { ok: true, changed: true }, "the holder's one extension is still there");
  assert.equal(inst.history.filter((e) => e.type === "due_date_extended").length, 1);
  assert.deepEqual(await due(inst, ADMIN, day(1)), { ok: true, changed: true }, "an admin may also bring it forward");
});

await check("a step whose date is the workflow's own: a member is refused, naming who may; someone with no hold on it may not at all", async () => {
  const inst = await submitted();
  const own = await due(inst, MAKER, day(10), "prepare");
  assert.equal(own.status, 422);
  assert.match(own.message, /the workflow's own; ask an administrator/);
  const outsider = await due(inst, OTHER, day(8));
  assert.equal(outsider.status, 403);
});

// ── 4. nothing without a workflow ────────────────────────────────────────────────────────────────────────────────────

section("4. Nothing without a workflow");

await check("the default profile: none of the three tools is registered, the record tools take no `evidence`, the ops route answers 404", () => {
  const out = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server", "scripts/lib/record-workflow-default-probe.mjs"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  assert.equal(out.status, 0, out.stderr.slice(-2000));
  assert.deepEqual(JSON.parse(out.stdout.trim().split("\n").at(-1)), { tools: [true, true, true], evidence: [true, true], route: 404, areas: [] });
});

await check("every agent tool file of the three exports disableTool() when its tool is not registered", () => {
  for (const name of ["get_record_workflow", "reassign_step", "extend_step"]) {
    const src = readFileSync(join(ROOT, `agent/tools/${name}.ts`), "utf8");
    assert.match(src, /\?\? disableTool\(\);/, name);
  }
});

console.log(`\ntest-record-workflow-surfaces: ${passed} checks passed${process.exitCode ? ", SOME FAILED" : ""}`);
