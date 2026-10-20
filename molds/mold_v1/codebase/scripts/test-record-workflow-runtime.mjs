/**
 * A RECORD'S WORKFLOW ON ITS MOVES, OFFLINE (lib/record-workflow-runtime.ts, lib/record-workflow-moves.ts, the step
 * rules in agent/lib/record-lifecycle.ts checkMove; docs/WORKFLOW_ENGINE.md phase 5 "Runtime"). No database.
 *
 *   1. NOTHING RUNS WITHOUT ONE. The default profile binds no workflow (RECORD_WORKFLOWS is empty), no area is bound,
 *      and the write path's first step answers null for every area WITHOUT A STATEMENT; enforce "off" never calls the
 *      engine either; describeMoves says nothing more for a lifecycle that runs none.
 *   2. THE BINDING of the neutral fixture (scripts/fixtures/record-workflows/review.json: a maker-checker review on the
 *      deployments area's own state, renamed twice and with two legacy spellings; the tasks' own state, the periods'
 *      state column and the implementations' own state run it too), compiled by the profile generator.
 *   8. A RECORD MOVED ELSEWHERE: re-synced from workflow_states when found in another state; a move reserved for
 *      another service's write settled by the record's actual state; one key per record, the record's own.
 *   3. THE DIRECTORY from the workspace's people: owner and admin act on every step, a member on the step they hold,
 *      a supervisor (the roster's reporting line) on their reportee's.
 *   4. ATTACHING: a new record's instance, and one attached mid-lifecycle: the steps where the record's state says,
 *      the ones it is past completed through the engine's migrated-step support and dated from the feed, recorded as
 *      provisioning (never as a decision).
 *   5. THE STEP RULES IN checkMove: who holds the step (not_holder, naming the holder), a step not open yet
 *      (step_inactive), the workflow's step transitions (step_transition), its comment and evidence (step_comment,
 *      step_evidence); four eyes, by {entered_by} and as the step holder; strict refuses with the moves there are (each
 *      marked with who holds its step), warn lets the move through with the rules it broke.
 *   6. THE STEP CHANGE: through the step rules and the workflow's own rules (the review opens, a send-back reopens the
 *      preparation, the finish), an administrative change under warn says so, a definition that would queue an email
 *      is refused.
 *   7. LEGACY SPELLINGS AND RENAMED KEYS: a record stored under an earlier key and a legacy spelling attaches at the
 *      state it stands for and its move drives the step; the write names only the new key.
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-record-workflow-runtime.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const FIXTURE = join(ROOT, "scripts/fixtures/record-workflows/review.json");
const PROFILE = JSON.parse(readFileSync(FIXTURE, "utf8"));
const DSL = PROFILE.records.workflows["maker-checker"];

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

/** The compiled record areas of the default profile plus `extra` ([name, object]), from the generator; writes nothing. */
function compiled(extra) {
  const dir = mkdtempSync(join(tmpdir(), "record-workflow-runtime-"));
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
const moves = await import("../lib/record-workflow-moves.ts");
const { RECORD_WORKFLOWS } = await import("../lib/record-workflows.generated.ts");
const { RECORD_AREAS } = await import("../agent/lib/record-areas.generated.ts");
const { areaView, describeMoves } = await import("../agent/lib/record-areas.ts");
const { checkMove, conflictBody, storedStateOf } = await import("../agent/lib/record-lifecycle.ts");
const { validateRecordWrite } = await import("../agent/lib/record-validate.ts");
const { identitySnapshot } = await import("../agent/lib/people-directory.ts");

const AREAS = compiled([["50-review.json", PROFILE]]);
const STRICT = compiled([["50-review.json", PROFILE], ["51-strict.json", { records: { areas: { deployments: { lifecycle: { enforce: "strict" } } } } }]]);
const OFF = compiled([["50-review.json", PROFILE], ["51-off.json", { records: { areas: { deployments: { lifecycle: { enforce: "off" } } } } }]]);
const WORKFLOWS = { "maker-checker": DSL };

// The workspace's people: their workspace role, their duty (people.attributes) and one reporting line.
const ORG = "org-wf-a";
const OWNER = "a-owner@x.test";
const MAKER = "b-maker@x.test";
const CHECKER = "c-checker@x.test";
const ADMIN = "d-admin@x.test"; // an admin with the checker duty
const LEAD = "e-lead@x.test"; // the checker's supervisor
const OTHER = "f-other@x.test"; // a member with no duty
const ROSTER = [
  { orgId: ORG, email: MAKER, name: "Mara Maker", attributes: { duty: "maker" } },
  { orgId: ORG, email: CHECKER, name: "Cy Checker", attributes: { duty: "checker" }, managerEmail: LEAD },
  { orgId: ORG, email: ADMIN, attributes: { duty: "checker" } },
  { orgId: ORG, email: LEAD },
  { orgId: ORG, email: OTHER },
  { orgId: "org-wf-b", email: "z-elsewhere@y.test", attributes: { duty: "checker" } },
];
const MEMBERS = [
  { orgId: ORG, email: OWNER, role: "owner" },
  { orgId: ORG, email: MAKER, role: "member" },
  { orgId: ORG, email: CHECKER, role: "member" },
  { orgId: ORG, email: ADMIN, role: "admin" },
  { orgId: ORG, email: LEAD, role: "member" },
  { orgId: ORG, email: OTHER, role: "member" },
];
// The checkout's own profile declares no person attribute, so identitySnapshot carries none (people.attributes is the
// deployment's catalogue); the fixture declares `duty`, and a deployment built from it carries each person's value. The
// values are put on the snapshot here as that deployment's would carry them (the DB test builds the real one, in a copy).
const DUTY = Object.fromEntries(ROSTER.filter((r) => r.orgId === ORG && r.attributes?.duty).map((r) => [r.email, r.attributes.duty]));
const SNAPSHOT = identitySnapshot(ORG, ROSTER, MEMBERS);
for (const u of SNAPSHOT.users) if (DUTY[u.id]) u.duty = DUTY[u.id];
const { directory, rbac } = runtime.engineDirectory(SNAPSHOT);
const binding = runtime.workflowBindingOf("deployments", AREAS, WORKFLOWS);
const strictBinding = runtime.workflowBindingOf("deployments", STRICT, WORKFLOWS);
const V = areaView("deployments", AREAS);
const VS = areaView("deployments", STRICT);
const T0 = new Date("2026-05-04T09:00:00.000Z");
const ENTERED = "2026-05-01T08:30:00.000Z";
const transition = (v, label) => v.area.lifecycle.transitions.find((t) => t.label === label);
const seed = (state, b = binding) => runtime.seedInstance({ binding: b, orgId: ORG, entity: { type: "deployments", id: "rec-1" }, state, data: {}, directory, actor: OWNER, createdBy: MAKER, now: T0, enteredAt: ENTERED });
const gateFor = (instance, actor, { comment, evidence } = {}) => runtime.stepGate({ dsl: DSL, instance, directory, rbac, actor, comment, evidence });
const rules = (broken) => broken.map((b) => b.rule).sort();
const row = (state, extra = {}) => ({ deploymentId: "rec-1", customerId: "acct-1", custom: { review_state: state }, ...extra });

// ── 1. nothing runs without one ─────────────────────────────────────────────────────────────────────────────────────

section("1. Nothing runs without a workflow");

await check("the default profile binds no workflow: RECORD_WORKFLOWS is empty and no area is bound", () => {
  assert.deepEqual(RECORD_WORKFLOWS, {});
  for (const id of ["tasks", "periods", "deployments", "implementations"]) {
    assert.equal(moves.recordWorkflowBound(id), false, id);
    assert.equal(runtime.workflowBindingOf(id, RECORD_AREAS, RECORD_WORKFLOWS), null, id);
    assert.equal(RECORD_AREAS[id].lifecycle?.workflow, undefined, id);
  }
});

await check("the write path's first step answers null for every default area without a single statement", async () => {
  const touched = [];
  const tx = new Proxy({}, { get: (_t, k) => { touched.push(String(k)); throw new Error(`the transaction was used: ${String(k)}`); } });
  for (const id of ["tasks", "periods", "deployments", "implementations"]) {
    assert.equal(await moves.openRecordWorkflow(tx, ORG, id, { entityId: "x", before: { custom: {} }, actor: OWNER }), null, id);
    assert.equal(await moves.openRecordWorkflow(tx, ORG, id, { entityId: null, before: null, actor: OWNER }), null, id);
  }
  assert.deepEqual(touched, []);
});

await check('enforce "off" never runs the engine: no binding, and the write path reads nothing', async () => {
  assert.equal(runtime.workflowBindingOf("deployments", OFF, WORKFLOWS), null);
  assert.equal(moves.recordWorkflowBound("deployments", OFF, WORKFLOWS), false);
  const tx = new Proxy({}, { get: () => { throw new Error("the transaction was used"); } });
  assert.equal(await moves.openRecordWorkflow(tx, ORG, "deployments", { entityId: "rec-1", before: row("drafting"), actor: OWNER }, { areas: OFF, workflows: WORKFLOWS }), null);
});

await check("a lifecycle that runs no workflow is described as before: describeMoves names no step", () => {
  const without = compiled([["50-review.json", { ...PROFILE, records: { areas: { deployments: { ...PROFILE.records.areas.deployments, lifecycle: { ...PROFILE.records.areas.deployments.lifecycle, workflow: undefined, workflow_states: undefined, transitions: PROFILE.records.areas.deployments.lifecycle.transitions.map(({ step: _s, ...t }) => t) } } } } }]]);
  const plain = describeMoves("deployments", without).join("\n");
  assert.doesNotMatch(plain, /step/);
  const bound = describeMoves("deployments", AREAS).join("\n");
  assert.match(bound, /only by whoever holds the workflow's "prepare" step, which it marks completed/);
  // The bound card says only that, beside each move: remove those clauses and it is the plain one.
  assert.equal(bound.replace(/; only by whoever holds the workflow's "[a-z]+" step, which it marks [a-z]+/g, "").replace(/ \(only by whoever holds the workflow's "[a-z]+" step, which it marks [a-z]+\)/g, ""), plain);
});

await check("a gate is never consulted by a move whose transition names no step, and changes nothing it is not asked", () => {
  let asked = 0;
  const gate = { stepBroken: () => { asked++; return [{ rule: "not_holder", message: "x" }]; }, holders: () => [] };
  const without = compiled([["50-review.json", { ...PROFILE, records: { areas: { deployments: { ...PROFILE.records.areas.deployments, lifecycle: { ...PROFILE.records.areas.deployments.lifecycle, workflow: undefined, workflow_states: undefined, transitions: PROFILE.records.areas.deployments.lifecycle.transitions.map(({ step: _s, ...t }) => t) } } } } }]]);
  const v = areaView("deployments", without);
  const input = { from: "drafting", to: "in_review", row: row("in_review"), before: row("drafting"), actor: MAKER, role: "member" };
  const a = checkMove(v, input);
  const b = checkMove(v, { ...input, workflow: gate });
  assert.equal(asked, 0);
  assert.deepEqual(b, a);
});

// ── 2. the binding ───────────────────────────────────────────────────────────────────────────────────────────────────

section("2. The binding (scripts/fixtures/record-workflows/review.json)");

await check("the fixture's deployments area is bound to its workflow, warn and strict, with its mid-lifecycle states", () => {
  assert.equal(binding.workflowId, "maker-checker");
  assert.equal(binding.enforce, "warn");
  assert.equal(strictBinding.enforce, "strict");
  assert.deepEqual(binding.states.in_review, { prepare: "completed", review: "open" });
  assert.equal(moves.recordWorkflowBound("deployments", AREAS, WORKFLOWS), true);
  // The fixture's tasks (own state), periods (the state column) and implementations run the same workflow, strict.
  for (const id of ["tasks", "periods", "implementations"]) assert.equal(runtime.workflowBindingOf(id, AREAS, WORKFLOWS)?.enforce, "strict", id);
});

await check("a lifecycle naming a workflow the deployment does not carry is not bound (nothing to run, nothing invented)", () => {
  assert.equal(runtime.workflowBindingOf("deployments", AREAS, {}), null);
});

// ── 3. the directory ─────────────────────────────────────────────────────────────────────────────────────────────────

section("3. The directory from the workspace's people");

await check("people are this workspace's only, by email, with their duty and reporting line", () => {
  assert.ok(directory.get(MAKER, ORG));
  assert.equal(directory.get(MAKER, ORG).duty, "maker");
  assert.equal(directory.get("z-elsewhere@y.test", ORG), undefined, "another workspace's roster row is not carried");
  assert.deepEqual(rbac.managers(CHECKER, undefined, ORG), [LEAD]);
});

await check("owner and admin act on every step; a member on the step they hold; a supervisor on their reportee's", () => {
  const inst = seed("in_review");
  const review = inst.steps.find((s) => s.id === "review");
  assert.deepEqual(review.assignee, [CHECKER, ADMIN], "the review is held by the first two with the checker duty");
  const approve = transition(V, "Approve");
  for (const who of [OWNER, ADMIN, CHECKER, LEAD]) assert.deepEqual(rules(gateFor(inst, who, { comment: "fine" }).stepBroken(approve)), [], who);
  for (const who of [MAKER, OTHER, "stranger@x.test"]) assert.deepEqual(rules(gateFor(inst, who, { comment: "fine" }).stepBroken(approve)), ["not_holder"], who);
});

// ── 4. attaching ─────────────────────────────────────────────────────────────────────────────────────────────────────

section("4. Attaching an instance");

await check("a new record's instance: the template's own start, created by whoever made the record", () => {
  const inst = seed("drafting");
  assert.equal(inst.workflow_id, "maker-checker");
  assert.equal(inst.organization_id, ORG);
  assert.deepEqual(inst.object, { type: "deployments", id: "rec-1", data: {} });
  assert.equal(inst.created_by, MAKER);
  assert.deepEqual(inst.steps.map((s) => [s.id, s.state, s.status]), [["prepare", "open", true], ["review", "open", false]]);
  assert.deepEqual(inst.steps.find((s) => s.id === "prepare").assignee, [MAKER]);
  assert.deepEqual(inst.history.map((e) => e.type), ["instance_created"]);
  assert.equal(inst.terminal, false);
});

await check("attached mid-lifecycle: the steps it is past start completed, dated from the feed, as provisioning rows only", () => {
  const inst = seed("in_review");
  const prepare = inst.steps.find((s) => s.id === "prepare");
  const review = inst.steps.find((s) => s.id === "review");
  assert.equal(prepare.state, "completed");
  assert.equal(prepare.completed_at, ENTERED, "the engine's migrated-step completion date: when the record entered its state");
  assert.equal(review.state, "open");
  assert.equal(review.status, true, "the step the record is at is open");
  assert.deepEqual(inst.history.map((e) => [e.type, e.step_id ?? null, e.source]), [["instance_created", null, "user"], ["step_patched", "prepare", "provisioning"]]);
  assert.ok(!inst.history.some((e) => e.type === "state_changed"), "seeding is never a decision in the approval log");
  const done = seed("approved");
  assert.equal(done.terminal, true);
  assert.deepEqual(done.steps.map((s) => s.state), ["completed", "completed"]);
});

await check("a record the workflow's init.condition does not take gets no instance (the workflow is not its)", () => {
  const only = { ...binding, dsl: { ...DSL, init: { ...DSL.init, condition: { kind: "gated" } } } };
  assert.equal(runtime.seedInstance({ binding: only, orgId: ORG, entity: { type: "deployments", id: "r" }, state: "drafting", data: { kind: "other" }, directory, actor: OWNER, now: T0 }), null);
  assert.ok(runtime.seedInstance({ binding: only, orgId: ORG, entity: { type: "deployments", id: "r" }, state: "drafting", data: { kind: "gated" }, directory, actor: OWNER, now: T0 }));
});

// ── 5. the step rules in checkMove ───────────────────────────────────────────────────────────────────────────────────

section("5. The step rules in checkMove");

const moveIn = (v, from, to, actor, gate, extra = {}) => checkMove(v, { from, to, row: row(to), before: row(from), actor, role: extra.role ?? "member", comment: extra.comment, enteredBy: extra.enteredBy, workflow: gate });

await check("the holder submits with a comment and evidence: allowed", () => {
  const inst = seed("drafting");
  const c = moveIn(V, "drafting", "in_review", MAKER, gateFor(inst, MAKER, { comment: "done", evidence: "doc://1" }), { comment: "done" });
  assert.equal(c.allowed, true, c.sentence);
  assert.equal(c.transition.step.id, "prepare");
});

await check("not_holder: someone who does not hold the step, named with who does, in the move's sentence", () => {
  const inst = seed("drafting");
  const c = moveIn(V, "drafting", "in_review", OTHER, gateFor(inst, OTHER, { comment: "x", evidence: "doc://1" }), { comment: "x" });
  assert.equal(c.allowed, false);
  assert.deepEqual(rules(c.broken), ["not_holder"]);
  // A member reads the holder's name on the roster, never their email.
  assert.match(c.sentence, /"In review" \(Submit\): only whoever holds the step "Prepare" \(Mara Maker\) may make it\./);
  assert.doesNotMatch(c.sentence, /@/);
});

await check("step_comment and step_evidence: the step's own demands, with its criteria", () => {
  const inst = seed("drafting");
  const c = moveIn(V, "drafting", "in_review", MAKER, gateFor(inst, MAKER, { comment: "done" }), { comment: "done" });
  assert.deepEqual(rules(c.broken), ["step_evidence"]);
  assert.match(c.sentence, /the step "Prepare" needs evidence, a link or a document's id sent as `evidence` \(The material that shows it\)/);
  const d = moveIn(V, "drafting", "in_review", MAKER, gateFor(inst, MAKER, { evidence: "doc://1" }));
  assert.deepEqual(rules(d.broken), ["step_comment"]);
  assert.match(d.sentence, /the step "Prepare" needs a comment saying why \(What was done\)/);
});

await check("step_inactive and step_transition: a step not open yet, and a step move the workflow does not allow", () => {
  const draft = seed("drafting");
  const approve = transition(V, "Approve");
  assert.deepEqual(gateFor(draft, ADMIN, { comment: "ok" }).stepBroken(approve).map((b) => [b.rule, b.message]), [["step_inactive", 'the step "Review" is not open yet']]);
  const done = seed("approved");
  const sendBack = transition(V, "Send back");
  const broken = gateFor(done, ADMIN, { comment: "no" }).stepBroken(sendBack);
  assert.deepEqual(rules(broken), ["step_transition"]);
  assert.match(broken[0].message, /the step "Review" cannot go from "completed" to "rejected" \(from "completed" it may go to "open"\)/);
});

await check("four eyes by {entered_by}: the entrant cannot approve, even holding the step; another holder can", () => {
  const inst = seed("in_review");
  // The admin with the checker duty holds the review and moved the record into review: refused by not_by only.
  const own = moveIn(V, "in_review", "approved", ADMIN, gateFor(inst, ADMIN, { comment: "ok" }), { comment: "ok", enteredBy: ADMIN, role: "admin" });
  assert.equal(own.allowed, false);
  assert.deepEqual(rules(own.broken), ["not_by"], "as the step holder, only four eyes stops it");
  // The maker who submitted: neither the second person nor a holder.
  const maker = moveIn(V, "in_review", "approved", MAKER, gateFor(inst, MAKER, { comment: "ok" }), { comment: "ok", enteredBy: MAKER });
  assert.deepEqual(rules(maker.broken), ["not_by", "not_holder"]);
  // A second holder approves.
  const other = moveIn(V, "in_review", "approved", CHECKER, gateFor(inst, CHECKER, { comment: "ok" }), { comment: "ok", enteredBy: ADMIN });
  assert.equal(other.allowed, true, other.sentence);
});

await check("strict: the validator refuses with the 409 body, the step's rule among the broken, each move marked with who holds its step", () => {
  const inst = seed("drafting", strictBinding);
  const gate = gateFor(inst, OTHER, { comment: "x" });
  const r = validateRecordWrite("deployments", { mode: "update", before: row("drafting"), patch: { custom: { review_state: "in_review" } }, actor: OTHER, role: "member", comment: "x", workflow: gate }, STRICT);
  assert.equal(r.ok, false);
  assert.equal(r.conflict.code, "lifecycle_refused");
  assert.deepEqual(rules(r.conflict.broken), ["not_holder", "step_evidence"]);
  assert.deepEqual(r.conflict.allowed.map((m) => [m.to, m.held_by]), [["in_review", ["Mara Maker"]]]);
  assert.match(r.conflict.error, /From "Drafting" you can move to: "In review" \(Submit; held by Mara Maker\)\./);
});

await check("warn: the move goes through, its stamps and its warning carry the step's broken rules", () => {
  const inst = seed("drafting");
  const r = validateRecordWrite("deployments", { mode: "update", before: row("drafting"), patch: { custom: { review_state: "in_review" } }, actor: OTHER, role: "member", workflow: gateFor(inst, OTHER) }, AREAS);
  assert.equal(r.ok, true);
  assert.equal(r.lifecycle.allowed, false);
  // The step's demands are asked in the engine's order, the first missing one said (the comment, then the evidence).
  assert.deepEqual(rules(r.lifecycle.broken), ["not_holder", "step_comment"]);
  assert.deepEqual(r.customDelta, { review_state: "in_review" });
  assert.equal(r.warnings.length, 1);
});

await check("the allowed moves are marked only where a step is held by someone else, never otherwise", () => {
  const inst = seed("drafting");
  const c = moveIn(V, "drafting", "in_review", MAKER, gateFor(inst, MAKER, { comment: "x", evidence: "y" }), { comment: "x" });
  assert.ok(c.allowedMoves.every((m) => !("held_by" in m)));
  const plain = checkMove(V, { from: "drafting", to: "in_review", row: row("in_review"), before: row("drafting"), actor: OTHER, role: "member" });
  assert.ok(plain.allowedMoves.every((m) => !("held_by" in m)), "no gate, no mark");
  assert.deepEqual(conflictBody(plain).allowed, plain.allowedMoves);
});

await check("an owner or an admin reads each holder's email; anyone else their name, or that they have none on the roster", () => {
  const inst = seed("in_review");
  const approve = transition(V, "Approve");
  const sendBack = transition(V, "Send back");
  assert.deepEqual(gateFor(inst, OWNER).holders(approve), [CHECKER, ADMIN]);
  assert.deepEqual(gateFor(inst, OTHER).holders(approve), ["Cy Checker", "a person with no name on the roster"]);
  assert.match(gateFor(inst, MAKER, { comment: "x" }).stepBroken(sendBack)[0].message, /\(Cy Checker, a person with no name on the roster\)/);
});

await check("under warn, only the STEP rules a move broke make its step change administrative, and only they are named", async () => {
  const inst = seed("drafting");
  const broke = checkMove(V, { from: "drafting", to: "in_review", row: row("in_review"), before: row("drafting"), actor: OTHER, role: "member", workflow: gateFor(inst, OTHER) });
  const mixed = { ...broke, broken: [...broke.broken, { rule: "roles", message: "only owner may make it", transition: "Submit" }] };
  assert.deepEqual(runtime.administrativeOf(mixed).rules, ["not_holder", "step_comment"]);
  assert.doesNotMatch(runtime.administrativeOf(mixed).message, /only owner/);
  const lifecycleOnly = { ...broke, broken: [{ rule: "roles", message: "only owner may make it", transition: "Submit" }] };
  assert.equal(runtime.administrativeOf(lifecycleOnly), null, "a move whose step rules held changes its step as the holder's own");
  assert.equal(runtime.administrativeOf({ ...broke, allowed: true }), null);
});

// ── 6. the step change ───────────────────────────────────────────────────────────────────────────────────────────────

section("6. The step change, through the step rules and the workflow's own rules");

await check("submit: the preparation completes with its comment and evidence, the workflow opens the review", async () => {
  const inst = seed("drafting");
  const changed = await runtime.applyStepMove({ dsl: DSL, instance: inst, directory, rbac, step: { id: "prepare", state: "completed" }, actor: MAKER, comment: "done", evidence: "doc://1", now: T0 });
  assert.equal(changed, true);
  const [prepare, review] = inst.steps;
  assert.equal(prepare.state, "completed");
  assert.equal(prepare.completed_at, T0.toISOString(), "the workflow's own rule dates it");
  assert.deepEqual(prepare.comments.map((c) => [c.actor, c.text]), [[MAKER, "done"]]);
  assert.deepEqual(prepare.evidence.map((e) => e.ref), ["doc://1"]);
  assert.equal(review.status, true);
  assert.equal(review.state, "open");
  assert.deepEqual(inst.history.slice(0, 5).map((e) => e.type), ["instance_created", "comment_added", "evidence_added", "step_patched", "state_changed"]);
  assert.ok(inst.history.some((e) => e.type === "state_changed" && e.step_id === "prepare" && e.actor === MAKER && e.source === "user"));
  assert.ok(inst.history.some((e) => e.type === "diff_rule_fired"));
  assert.equal(inst.terminal, false);
});

await check("approve finishes the workflow; send back reopens the preparation and puts the review to sleep", async () => {
  const a = seed("in_review");
  await runtime.applyStepMove({ dsl: DSL, instance: a, directory, rbac, step: { id: "review", state: "completed" }, actor: CHECKER, comment: "fine", now: T0 });
  assert.equal(a.terminal, true);
  const b = seed("in_review");
  await runtime.applyStepMove({ dsl: DSL, instance: b, directory, rbac, step: { id: "review", state: "rejected" }, actor: CHECKER, comment: "missing", now: T0 });
  const [prepare, review] = b.steps;
  assert.equal(prepare.state, "open");
  assert.equal(prepare.completed_at, undefined);
  assert.equal(review.state, "rejected");
  assert.equal(review.status, false);
  assert.equal(b.terminal, false);
});

await check("under warn, a move that broke a rule changes its step as an administrative change naming the rules", async () => {
  const inst = seed("drafting");
  await runtime.applyStepMove({ dsl: DSL, instance: inst, directory, rbac, step: { id: "prepare", state: "completed" }, actor: OTHER, now: T0, administrative: { rules: ["not_holder", "step_evidence"], message: 'Submit: only whoever holds the step "Prepare" (b-maker@x.test) may make it' } });
  const patched = inst.history.find((e) => e.type === "step_patched" && e.source === "user");
  assert.equal(patched.data.administrative, true);
  assert.deepEqual(patched.data.rules, ["not_holder", "step_evidence"]);
  assert.match(patched.detail, /^administrative change under enforce "warn": Submit: only whoever holds/);
  assert.equal(inst.history.find((e) => e.type === "state_changed").data.administrative, true);
  assert.equal(inst.steps[1].status, true, "the workflow's own rules still run");
});

await check("a pinned definition whose email a model would write is refused, never queued and dropped (phase 6 runs the rest: scripts/test-record-workflow-actions.mjs)", async () => {
  const withEmail = structuredClone(DSL);
  withEmail.diff.push({ priority: 9, applicability: "all", selector: { rule: "forAll" }, condition: { "step$state": { $delta: { before: "", after: "completed" } } }, action: { external: { email: { recipients: { $or: { query: { duty: "checker" } } }, subject: { prompt: "Sum it up." } } } } });
  await assert.rejects(runtime.applyStepMove({ dsl: withEmail, instance: seed("drafting"), directory, rbac, step: { id: "prepare", state: "completed" }, actor: MAKER, comment: "c", evidence: "e", now: T0 }), runtime.RecordWorkflowRefused);
});

// ── 7. legacy spellings and renamed keys ─────────────────────────────────────────────────────────────────────────────

section("7. Legacy spellings and renamed keys");

await check("a record stored under an earlier key and a legacy spelling attaches at the state it stands for", () => {
  for (const custom of [{ approval_state: "pending" }, { review_status: "pending" }, { review_status: "in_review" }]) {
    const before = { deploymentId: "rec-1", customerId: "acct-1", custom };
    assert.equal(storedStateOf(V, before), "in_review", JSON.stringify(custom));
    const inst = runtime.seedInstance({ binding, orgId: ORG, entity: { type: "deployments", id: "rec-1" }, state: storedStateOf(V, before), data: runtime.recordData(V, before), directory, actor: OWNER, now: T0, enteredAt: ENTERED });
    assert.deepEqual(inst.steps.map((s) => s.state), ["completed", "open"]);
    assert.equal(inst.object.data.review_state, "pending" === custom.approval_state || "pending" === custom.review_status ? "pending" : "in_review", "the record's own value, read under whichever key it holds");
  }
});

await check("its move drives the step from the state it stands for, and the write names only the new key", () => {
  const before = { deploymentId: "rec-1", customerId: "acct-1", custom: { approval_state: "pending" } };
  const inst = runtime.seedInstance({ binding, orgId: ORG, entity: { type: "deployments", id: "rec-1" }, state: storedStateOf(V, before), data: {}, directory, actor: OWNER, now: T0 });
  const r = validateRecordWrite("deployments", { mode: "update", before, patch: { custom: { review_state: "approved" } }, actor: CHECKER, role: "member", comment: "fine", enteredBy: MAKER, workflow: gateFor(inst, CHECKER, { comment: "fine" }) }, AREAS);
  assert.equal(r.ok, true);
  assert.equal(r.lifecycle.from, "in_review");
  assert.equal(r.lifecycle.allowed, true, r.lifecycle.sentence);
  assert.deepEqual(r.lifecycle.transition.step, { id: "review", state: "completed" });
  assert.deepEqual(r.customDelta, { review_state: "approved" }, "the earlier key and its legacy spelling are not rewritten");
});

// ── 8. a record moved elsewhere ─────────────────────────────────────────────────────────────────────────────────

section("8. A record moved without the engine, and a move written by another service");

await check("re-sync: a record found in another state than its instance was brought in line with is re-synced, as provisioning", () => {
  const inst = seed("drafting");
  assert.equal(runtime.recordStateOf(inst), "drafting");
  const changed = runtime.resyncInstance({ binding, dsl: DSL, instance: inst, state: "in_review", actor: "system", now: T0 });
  assert.equal(changed, true);
  assert.deepEqual(inst.steps.map((s) => [s.id, s.state, s.status]), [["prepare", "completed", true], ["review", "open", true]]);
  assert.equal(runtime.recordStateOf(inst), "in_review");
  assert.ok(inst.history.some((e) => e.type === "step_patched" && e.source === "provisioning" && /re-synced: the record moved from "drafting" to "in_review" outside its workflow/.test(e.detail ?? "")));
  assert.ok(!inst.history.some((e) => e.type === "state_changed"), "a re-sync is never a decision");
  // So the next move is checked where the record is: the review is open, its holder may approve.
  assert.deepEqual(rules(gateFor(inst, CHECKER, { comment: "ok" }).stepBroken(transition(V, "Approve"))), []);
  assert.equal(runtime.resyncInstance({ binding, dsl: DSL, instance: inst, state: "in_review", actor: "system", now: T0 }), false, "nothing to do when they agree");
});

const reserved = (inst) => {
  runtime.setRecordMove(inst, { id: "m-1", from: "drafting", to: "in_review", step: { id: "prepare", state: "completed" }, actor: MAKER, comment: "done", evidence: "doc://1", administrative: null, at: T0.toISOString() });
  return inst;
};
await check("a reserved move is settled by the record's actual state: reached → the step moves as checked; stayed → released", async () => {
  const reached = reserved(seed("drafting"));
  assert.equal(await runtime.settleRecordMove({ binding, dsl: DSL, instance: reached, directory, rbac, state: "in_review", now: T0 }), "applied");
  assert.equal(reached.steps[0].state, "completed");
  assert.equal(reached.steps[0].evidence[0].ref, "doc://1");
  assert.equal(runtime.recordMoveOf(reached), undefined);
  assert.equal(runtime.recordStateOf(reached), "in_review");
  const stayed = reserved(seed("drafting"));
  assert.equal(await runtime.settleRecordMove({ binding, dsl: DSL, instance: stayed, directory, rbac, state: "drafting", now: T0 }), "released");
  assert.equal(stayed.steps[0].state, "open");
  assert.equal(runtime.recordMoveOf(stayed), undefined);
  const elsewhere = reserved(seed("drafting"));
  assert.equal(await runtime.settleRecordMove({ binding, dsl: DSL, instance: elsewhere, directory, rbac, state: "approved", now: T0 }), "resynced");
  assert.deepEqual(elsewhere.steps.map((s) => s.state), ["completed", "completed"]);
  assert.equal(await runtime.settleRecordMove({ binding, dsl: DSL, instance: seed("drafting"), directory, rbac, state: "drafting", now: T0 }), "none");
});

await check("the workflow's key is the record's own: a task's and a period's id, an implementation's id, a deployment's account and id", () => {
  assert.equal(moves.workflowRecordKey("tasks", { id: "t-1", entityId: "other" }), "t-1");
  assert.equal(moves.workflowRecordKey("periods", { id: "p-1" }), "p-1");
  assert.equal(moves.workflowRecordKey("implementations", { implementationId: "i-1", customerId: "acct", rolloutId: "r-9" }), "i-1");
  assert.equal(moves.workflowRecordKey("deployments", { customerId: "a/b", deploymentId: "D 1" }), "a%2Fb/D%201");
  assert.notEqual(moves.workflowRecordKey("deployments", { customerId: "a", deploymentId: "b/c" }), moves.workflowRecordKey("deployments", { customerId: "a/b", deploymentId: "c" }));
  assert.equal(moves.workflowRecordKey("tasks", null), null);
});

console.log(`\ntest-record-workflow-runtime: ${passed} checks passed${process.exitCode ? ", SOME FAILED" : ""}`);
