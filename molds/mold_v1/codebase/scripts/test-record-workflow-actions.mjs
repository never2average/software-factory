/**
 * A RECORD'S WORKFLOW STEP ACTIONS, OFFLINE (lib/record-workflow-runtime.ts takeStepActions, lib/record-workflow-actions.ts;
 * docs/WORKFLOW_ENGINE.md phase 6 "Step actions"). No database.
 *
 *   1. THEY BUILD. The neutral maker-checker review with an email and an agent action added
 *      (scripts/fixtures/record-workflows/actions.json) compiles; a model-resolved email (its recipients, subject or
 *      body) and attachments are still refused, at build (scripts/test-record-workflows.mjs) and on a pinned
 *      definition before a move.
 *   2. FIRED WITH THE STEP CHANGE, ONCE PER ENTRY. A move that completes the preparation fires both actions, saved on
 *      the instance with their delivery pending and the fired-once ledger (`fired_actions`); a later change while the
 *      preparation stays done matches its email rule again and fires nothing; a send-back and a second submit (a new
 *      entry of the step) fire once more. An email goes to the step's holders and the people its query names.
 *   3. WHAT THEY SAY, in the profile's words: the notification (the action's own subject and body, else a line naming
 *      the step and the record by the profile's noun; nothing of either with previews off) and the task for the
 *      assistant (its name, its instructions, the step's holder, the delivery id that makes it findable again).
 *   4. NOTHING SENDS AN EMAIL. The deliverer reaches people only through the app's notifications and the task path:
 *      it imports no mail module, and its production notifier is the desktop push channel.
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-record-workflow-actions.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const REVIEW = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/record-workflows/review.json"), "utf8"));
const ACTIONS = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/record-workflows/actions.json"), "utf8"));
const PROFILE = structuredClone(REVIEW);
PROFILE.records.workflows["maker-checker"].diff.push(...ACTIONS.rules);
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

/** The compiled record areas of the default profile plus `extra`, from the generator; writes nothing. */
function compiled(extra) {
  const dir = mkdtempSync(join(tmpdir(), "record-workflow-actions-"));
  try {
    cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
    for (const [name, src] of extra) writeFileSync(join(dir, name), JSON.stringify(src, null, 2));
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(ROOT, "scripts/gen-deployment-profile.mjs"), "--print-areas"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, PROFILES_DIR: dir, NODE_NO_WARNINGS: "1" }, maxBuffer: 64 * 1024 * 1024,
    });
    return { rc: r.status, err: r.stderr, areas: r.status === 0 ? JSON.parse(r.stdout) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const runtime = await import("../lib/record-workflow-runtime.ts");
const actions = await import("../lib/record-workflow-actions.ts");
const { identitySnapshot } = await import("../agent/lib/people-directory.ts");

const ORG = "org-wf-a";
const OWNER = "a-owner@x.test";
const MAKER = "b-maker@x.test";
const CHECKER = "c-checker@x.test";
const ADMIN = "d-admin@x.test";
const ROSTER = [
  { orgId: ORG, email: MAKER, name: "Mara Maker", attributes: { duty: "maker" } },
  { orgId: ORG, email: CHECKER, name: "Cy Checker", attributes: { duty: "checker" } },
  { orgId: ORG, email: ADMIN, attributes: { duty: "checker" } },
  { orgId: "org-wf-b", email: "z-elsewhere@y.test", attributes: { duty: "checker" } },
];
const MEMBERS = [
  { orgId: ORG, email: OWNER, role: "owner" },
  { orgId: ORG, email: MAKER, role: "member" },
  { orgId: ORG, email: CHECKER, role: "member" },
  { orgId: ORG, email: ADMIN, role: "admin" },
];
const DUTY = Object.fromEntries(ROSTER.filter((r) => r.orgId === ORG).map((r) => [r.email, r.attributes.duty]));
const SNAPSHOT = identitySnapshot(ORG, ROSTER, MEMBERS);
for (const u of SNAPSHOT.users) if (DUTY[u.id]) u.duty = DUTY[u.id];
const { directory, rbac } = runtime.engineDirectory(SNAPSHOT);
const T0 = new Date("2026-05-04T09:00:00.000Z");

// ── 1. they build ───────────────────────────────────────────────────────────────────────────────────────────────────

section("1. Email and agent actions build; what a model would decide does not");

const BUILT = compiled([["50-review.json", PROFILE]]);
const AREAS = BUILT.areas;
const binding = AREAS ? runtime.workflowBindingOf("deployments", AREAS, { "maker-checker": DSL }) : null;
const seed = (state) => runtime.seedInstance({ binding, orgId: ORG, entity: { type: "deployments", id: "acct-1/D-1" }, state, data: {}, directory, actor: OWNER, createdBy: MAKER, now: T0 });
const step = (inst, id, state, actor, extra = {}) => runtime.applyStepMove({ dsl: DSL, instance: inst, directory, rbac, step: { id, state }, actor, now: T0, ...extra });

await check("the maker-checker review with an email and an agent action compiles, bound to the deployments", () => {
  assert.equal(BUILT.rc, 0, BUILT.err);
  assert.equal(AREAS.deployments.lifecycle.workflow, "maker-checker");
  assert.ok(binding, "the deployments run it");
});

await check("a pinned definition that leaves an email to a model is refused before the move, never queued and dropped", async () => {
  for (const email of [
    { recipients: { $or: { prompt: "Whoever should know." } } },
    { recipients: { $or: { query: { duty: "checker" }, prompt: "Also them." } } },
    { recipients: { $or: { query: { duty: "checker" } } }, subject: { prompt: "Sum it up." } },
    { recipients: { $or: { query: { duty: "checker" } } }, body: { value: "b", prompt: "Explain." } },
    { recipients: { $or: { query: { duty: "checker" } } }, attachments: { $search: "the report" } },
  ]) {
    const dsl = structuredClone(DSL);
    dsl.diff.push({ priority: 9, applicability: "all", selector: { rule: "forAll" }, condition: { "step$state": { $delta: { before: "", after: "completed" } } }, action: { external: { email } } });
    const inst = seed("drafting");
    const before = JSON.stringify(inst.steps);
    await assert.rejects(runtime.applyStepMove({ dsl, instance: inst, directory, rbac, step: { id: "prepare", state: "completed" }, actor: MAKER, comment: "c", evidence: "e", now: T0 }), runtime.RecordWorkflowRefused, JSON.stringify(email));
    assert.equal(JSON.stringify(inst.steps), before, "nothing changed");
  }
});

// ── 2. fired with the step change, once per entry ───────────────────────────────────────────────────────────────────

section("2. Fired with the step change, once per entry of its step");

await check("the submit fires both: an email to the preparation's holder and the checkers, a task for the assistant held by the maker", async () => {
  const inst = seed("drafting");
  await step(inst, "prepare", "completed", MAKER, { comment: "done", evidence: "doc://1" });
  const fired = runtime.stepActionsOf(inst);
  assert.deepEqual(fired.map((a) => a.kind), ["email", "agent"]);
  const [email, agent] = fired;
  assert.deepEqual([...email.recipients].sort(), [MAKER, CHECKER, ADMIN].sort(), "the step's holder and the people the action names, all in this workspace");
  assert.equal(email.subject, "Ready for review");
  assert.equal(email.delivery.status, "pending");
  assert.equal(email.step, "Prepare");
  assert.deepEqual(email.record, { area: "deployments", id: "acct-1/D-1", label: "D-1" });
  assert.equal(email.actor, MAKER);
  assert.equal(agent.name, "Summarise the material");
  assert.deepEqual(agent.holders, [MAKER]);
  assert.match(agent.key, /^5:prepare:1:agent:summarise$/);
  assert.match(email.key, /^4:prepare:1:email$/);
  assert.deepEqual(runtime.firedActionsOf(inst).sort(), [agent.key, email.key].sort(), "the fired-once ledger, on the instance");
  assert.deepEqual(inst.history.filter((e) => e.type === "external_queued").map((e) => `${e.step_id}:${e.detail}`), ["prepare:email", "prepare:agent:Summarise the material"]);
});

await check("a later change while the preparation stays done matches its email rule again and fires nothing; the approval's own email fires once", async () => {
  const inst = seed("drafting");
  await step(inst, "prepare", "completed", MAKER, { comment: "done", evidence: "doc://1" });
  await step(inst, "review", "completed", CHECKER, { comment: "fine" });
  const kinds = runtime.stepActionsOf(inst).map((a) => `${a.step_id}:${a.kind}`);
  assert.deepEqual(kinds, ["prepare:email", "prepare:agent", "review:email"]);
  assert.equal(inst.history.filter((e) => e.type === "external_queued" && e.step_id === "prepare" && e.detail === "email").length, 1, "its queued row taken back with it");
  const review = runtime.stepActionsOf(inst).at(-1);
  assert.deepEqual([...review.recipients].sort(), [CHECKER, ADMIN].sort());
});

await check("a send-back and a second submit: a new entry of the preparation fires both again, once", async () => {
  const inst = seed("drafting");
  await step(inst, "prepare", "completed", MAKER, { comment: "done", evidence: "doc://1" });
  await step(inst, "review", "rejected", CHECKER, { comment: "missing a page" });
  assert.equal(inst.steps[0].state, "open", "the preparation is reopened by the workflow's rule");
  await step(inst, "prepare", "completed", MAKER, { comment: "added", evidence: "doc://2" });
  const prepare = runtime.stepActionsOf(inst).filter((a) => a.step_id === "prepare");
  assert.equal(prepare.length, 4, "two actions, two entries");
  assert.equal(new Set(prepare.map((a) => a.key)).size, 4);
  assert.equal(new Set(prepare.map((a) => a.delivery.id)).size, 4);
});

await check("a move that changes nothing runs no rule and fires nothing", async () => {
  const inst = seed("drafting");
  await step(inst, "prepare", "completed", MAKER, { comment: "done", evidence: "doc://1" });
  const n = runtime.stepActionsOf(inst).length;
  const changed = await step(inst, "prepare", "completed", MAKER, { comment: "again", evidence: "doc://1" });
  assert.equal(changed, false);
  assert.equal(runtime.stepActionsOf(inst).length, n);
});

await check("an entry by a re-sync (a system move) counts: the next change fires the rule for it, once", async () => {
  const inst = seed("drafting");
  await step(inst, "prepare", "completed", MAKER, { comment: "done", evidence: "doc://1" });
  runtime.setRecordState(inst, "in_review"); // as commitRecordWorkflow leaves it after the move
  runtime.resyncInstance({ binding, dsl: DSL, instance: inst, state: "drafting", actor: "system", now: T0 });
  assert.equal(inst.steps[0].state, "open");
  runtime.resyncInstance({ binding, dsl: DSL, instance: inst, state: "in_review", actor: "system", now: T0 });
  assert.equal(inst.steps[0].state, "completed");
  assert.equal(runtime.stepEntryOf(inst, "prepare"), 3, "completed by the maker, then re-synced twice");
  await step(inst, "review", "completed", CHECKER, { comment: "fine" });
  assert.equal(runtime.stepActionsOf(inst).filter((a) => a.step_id === "prepare" && a.kind === "email").length, 2, "the re-synced entry's email, once");
});

// ── 3. what they say ────────────────────────────────────────────────────────────────────────────────────────────────

section("3. What they say, in the profile's words");

const RENAMED = compiled([["50-review.json", PROFILE], ["51-words.json", { records: { areas: { deployments: { label: { singular: "release", plural: "releases" } } } } }]]);

await check("the notification: the action's subject and body; else the step and the record by the profile's noun; nothing of them with previews off", async () => {
  assert.equal(RENAMED.rc, 0, RENAMED.err);
  const inst = seed("drafting");
  await step(inst, "prepare", "completed", MAKER, { comment: "done", evidence: "doc://1" });
  await step(inst, "review", "completed", CHECKER, { comment: "fine" });
  const [email, , approved] = runtime.stepActionsOf(inst);
  const on = actions.stepNoticeOf(email, ORG, true, RENAMED.areas, "Workbench");
  assert.deepEqual([on.title, on.body], ["Ready for review", "The material is in; the review can start."]);
  assert.equal(on.tag, `step-action:${email.delivery.id}`);
  assert.equal(on.url, `/?org=${ORG}`);
  const plain = actions.stepNoticeOf(approved, ORG, true, RENAMED.areas, "Workbench");
  assert.deepEqual([plain.title, plain.body], ["Approved", 'The step "Review" of the release "D-1".']);
  const off = actions.stepNoticeOf(approved, ORG, false, RENAMED.areas, "Workbench");
  assert.equal(off.body, undefined);
  assert.equal(off.title, "Workbench: a step is waiting for you");
});

await check("the task for the assistant: its name, its instructions, the step's holder, the delivery id it is found by", async () => {
  const inst = seed("drafting");
  await step(inst, "prepare", "completed", MAKER, { comment: "done", evidence: "doc://1" });
  const agent = runtime.stepActionsOf(inst).find((a) => a.kind === "agent");
  const body = actions.stepTaskOf(agent, RENAMED.areas);
  assert.deepEqual(body, {
    title: "Summarise the material",
    notes: 'For the assistant: Read the material and write a short summary for the review.\n\nFrom the step "Prepare" of the release "D-1".',
    assignee: MAKER,
    custom: { [actions.WORKFLOW_ACTION_KEY]: agent.delivery.id },
  });
});

await check("a holder who can no longer act is not made the assignee (the deliverer passes null): the task has none", async () => {
  const inst = seed("drafting");
  await step(inst, "prepare", "completed", MAKER, { comment: "done", evidence: "doc://1" });
  const agent = runtime.stepActionsOf(inst).find((a) => a.kind === "agent");
  const body = actions.stepTaskOf(agent, RENAMED.areas, null);
  assert.equal("assignee" in body, false);
  assert.equal(body.custom[actions.WORKFLOW_ACTION_KEY], agent.delivery.id);
});

// ── 3b. delivery beside moves, and the sweep ─────────────────────────────────────────────────────────────────────────

section("3b. Delivery never refuses a move; the sweep shares a tick across workspaces");

await check("what a move depends on (moveBasisOf) is unchanged by a delivery's claim and finish, and changed by any step change", async () => {
  const inst = seed("drafting");
  await step(inst, "prepare", "completed", MAKER, { comment: "done", evidence: "doc://1" });
  inst.revision = 3;
  const basis = runtime.moveBasisOf(inst);
  // The claim: every pending action processing, the revision moved on.
  const claimed = structuredClone(inst);
  for (const a of runtime.stepActionsOf(claimed)) a.delivery = { ...a.delivery, status: "processing", claimed_at: T0.toISOString(), attempts: 1 };
  claimed.revision = 4;
  assert.equal(runtime.moveBasisOf(claimed), basis, "a claim");
  // The finish: one delivered (out of the outbox, a delivered row), one failed (pending again, its error).
  const finished = structuredClone(claimed);
  const [first, second] = runtime.stepActionsOf(finished);
  finished.outbox = finished.outbox.filter((e) => e !== first);
  second.delivery = { ...second.delivery, status: "pending", last_error: "down" };
  finished.history.push({ at: T0.toISOString(), type: "external_delivered", step_id: "prepare", detail: "email", data: {}, actor: MAKER, source: "rule" });
  finished.history.push({ at: T0.toISOString(), type: "external_dead_lettered", step_id: "prepare", detail: "agent:x", data: {}, actor: MAKER, source: "rule" });
  finished.updated_at = new Date(T0.getTime() + 1000).toISOString();
  finished.revision = 5;
  assert.equal(runtime.moveBasisOf(finished), basis, "a finish");
  // A step change, a reservation, a re-sync: each changes it.
  const moved = structuredClone(inst);
  await step(moved, "review", "completed", CHECKER, { comment: "fine" });
  assert.notEqual(runtime.moveBasisOf(moved), basis, "a step change");
  const reserved = structuredClone(inst);
  runtime.setRecordMove(reserved, { id: "m1", from: "in_review", to: "approved", step: { id: "review", state: "completed" }, actor: CHECKER, comment: null, evidence: null, administrative: null, at: T0.toISOString() });
  assert.notEqual(runtime.moveBasisOf(reserved), basis, "a reservation");
  const synced = structuredClone(inst);
  runtime.setRecordState(synced, "in_review");
  runtime.resyncInstance({ binding, dsl: DSL, instance: synced, state: "drafting", actor: "system", now: T0 });
  assert.notEqual(runtime.moveBasisOf(synced), basis, "a re-sync");
});

await check("the sweep's tick is shared one record of each workspace in turn, so one workspace's backlog never starves another", () => {
  const a = Array.from({ length: 25 }, (_, i) => `a${i}`);
  const b = ["b0", "b1"];
  const c = ["c0"];
  assert.deepEqual(actions.fairShare([a, b, c], 6), ["a0", "b0", "c0", "a1", "b1", "a2"]);
  const all = actions.fairShare([a, b, c], 20);
  assert.equal(all.length, 20);
  assert.ok(["b0", "b1", "c0"].every((x) => all.includes(x)), "every workspace's due records are in the tick");
  assert.deepEqual(actions.fairShare([[], ["x"]], 20), ["x"]);
  assert.deepEqual(actions.fairShare([], 20), []);
});

// ── 4. nothing sends an email ───────────────────────────────────────────────────────────────────────────────────────

section("4. Nothing sends an email");

await check("the deliverer imports no mail module and reaches people only through notifications and the task path", () => {
  const src = readFileSync(join(ROOT, "lib/record-workflow-actions.ts"), "utf8");
  const imports = [...src.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, [
    "../agent/lib/db/schema.ts",
    "../agent/lib/db/schema.ts",
    "../agent/lib/push-notify.ts",
    "../agent/lib/record-areas.generated.ts",
    "../agent/lib/record-areas.ts",
    "../agent/lib/task-workflow-service.ts",
    "../agent/lib/web-push.ts",
    "./record-workflow-runtime.ts",
    "./record-workflow-store.ts",
    "./record-workflows.generated.ts",
    "drizzle-orm",
  ]);
  for (const mail of ["email", "platform-notify", "createDraft", "nodemailer", "smtp", "imap"]) assert.ok(!imports.some((i) => i.includes(mail)), mail);
});

await check("the default profile binds no workflow: nothing fires, and the deliverer is never started", async () => {
  const { RECORD_WORKFLOWS } = await import("../lib/record-workflows.generated.ts");
  assert.deepEqual(RECORD_WORKFLOWS, {});
  await actions.settleStepActionDeliveries();
});

console.log(`\ntest-record-workflow-actions: ${passed} checks passed${process.exitCode ? ", SOME FAILED" : ""}`);
