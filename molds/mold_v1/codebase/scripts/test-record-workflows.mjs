/**
 * RECORD WORKFLOWS, AT BUILD TIME (docs/DEPLOYMENT_PROFILE.md "records.workflows"; docs/WORKFLOW_ENGINE.md, phase 2):
 * a profile's workflow documents and an area's binding to one, checked by the profile generator. Offline; no database.
 *
 *   1. NOTHING MOVES WITHOUT ONE. The default declares no workflow, its compiled areas carry no binding, and a binding
 *      adds only the lifecycle's own keys: the emitted profile (DEPLOYMENT_PROFILE) is the one without it.
 *   2. A NEUTRAL EXAMPLE COMPILES: the workflow fixtures of phase 1 (scripts/fixtures/workflows/) that this phase can run,
 *      all declared at once; the two-person review (its escalation email left out) bound to the deployments area's own
 *      lifecycle, with each move's step and the states for records already mid-lifecycle; a later file's workflow
 *      replaces an earlier one with the same id whole.
 *   3. EVERY REFUSAL, with its exact sentence: `profiles/<file>: records.workflows.<id>.<path>: <reason>` (the engine's
 *      spec.json, its validator, what this phase cannot run: email and agent actions, prompt branches) and
 *      `profiles/<file>: records.areas.<area>.lifecycle…: <reason>` (an unknown workflow, step or step state, a step or
 *      workflow_states with no workflow, a record state that is not one or is a legacy spelling).
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-record-workflows.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATER, pathOf, STEP_STATES } from "./lib/record-workflows.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const WF = join(ROOT, "scripts/fixtures/workflows");
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

/** Run the generator over the checkout's default profile plus `extra` ([name, object]); never writes files. */
function gen(extra, flag = "--check") {
  const dir = mkdtempSync(join(tmpdir(), "record-workflows-"));
  try {
    cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
    for (const [name, src] of extra) writeFileSync(join(dir, name), JSON.stringify(src, null, 2));
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(ROOT, "scripts/gen-deployment-profile.mjs"), flag], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, PROFILES_DIR: dir, NODE_NO_WARNINGS: "1" }, maxBuffer: 64 * 1024 * 1024,
    });
    return { rc: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const ok = (extra, flag) => {
  const r = gen(extra, flag);
  assert.equal(r.rc, 0, r.err);
  return flag && flag !== "--check" ? JSON.parse(r.out) : r;
};
const lastLine = (s) => s.trim().split("\n").at(-1);

// The phase-1 fixtures, and the ones the app can run (no prompt branch: an agent action's own `prompt` is its
// instructions, not a branch; no attachments).
const FIXTURES = Object.fromEntries(readdirSync(WF).filter((f) => f.endsWith(".json") && f !== "people.json").map((f) => [f.replace(/\.json$/, ""), read(join(WF, f))]));
const runnable = (doc) => {
  const branches = structuredClone(doc);
  for (const r of branches.diff) if (r.action?.external?.agent) delete r.action.external.agent;
  return !JSON.stringify(branches).includes('"prompt"') && !JSON.stringify(branches).includes('"attachments"');
};
/** The two-person review without its escalation email: the rule whose only action is external is left out. */
const review = (() => {
  const doc = structuredClone(FIXTURES["two-person-review"]);
  doc.diff = doc.diff.filter((r) => !("external" in r.action));
  return doc;
})();

/** A deployments area whose lifecycle is an own pick_list field, optionally bound to a workflow. */
const STATES = ["drafting", "in_review", "approved", "sent_back"];
const reviewArea = (lifecycle = {}) => ({
  fields: {
    review_state: {
      type: "pick_list",
      label: "Review state",
      options: STATES.map((value) => ({ value })),
      legacy_values: { draft: "drafting" },
    },
  },
  lifecycle: {
    field: "review_state",
    initial: "drafting",
    enforce: "warn",
    categories: { drafting: "open", in_review: "active", approved: "done", sent_back: "open" },
    transitions: [
      { from: ["drafting", "sent_back"], to: "in_review", label: "Submit", step: { id: "prepare", state: "completed" } },
      { from: ["in_review"], to: "approved", label: "Approve", not_by: "{entered_by}", step: { id: "review", state: "completed" } },
      { from: ["in_review"], to: "sent_back", label: "Send back", requires_comment: true, step: { id: "review", state: "rejected" } },
    ],
    ...lifecycle,
  },
});
const BOUND = {
  workflow: "two-person-review",
  workflow_states: {
    drafting: { prepare: "open" },
    in_review: { prepare: "completed", review: "open" },
    approved: { prepare: "completed", review: "completed" },
    sent_back: { prepare: "open", review: "rejected" },
  },
};
const bound = (lifecycle = {}, workflows = { "two-person-review": review }) => ({ records: { workflows, areas: { deployments: reviewArea({ ...BOUND, ...lifecycle }) } } });

// --- 1. nothing moves without one ------------------------------------------------------------------------------------
check("the default declares no workflow, and no compiled area carries a binding", () => {
  assert.deepEqual(Object.keys(read(join(ROOT, "profiles/00-default.json")).records.workflows).filter((k) => k !== "$comment"), []);
  const areas = ok([], "--print-areas");
  for (const [id, a] of Object.entries(areas)) {
    for (const k of ["workflow", "workflow_states"]) assert.ok(!(k in (a.lifecycle ?? {})), `${id}.lifecycle.${k}`);
    for (const t of a.lifecycle?.transitions ?? []) assert.ok(!("step" in t), `${id}: a transition with a step`);
  }
});
check("the engine's step states are the ones the generated types and the messages name", () => {
  assert.deepEqual([...STEP_STATES], ["open", "completed", "rejected", "escalated"]);
  const generated = readFileSync(join(ROOT, "agent/lib/record-areas.generated.ts"), "utf8");
  assert.ok(generated.includes('export type RecordWorkflowStepState = "open" | "completed" | "rejected" | "escalated";'), "RecordWorkflowStepState");
});
check("a binding adds only the lifecycle's own keys: the emitted profile is the one without it", () => {
  const without = { records: { areas: { deployments: reviewArea({ transitions: reviewArea().lifecycle.transitions.map(({ step, ...t }) => t) }) } } };
  assert.equal(gen([["50-x.json", bound()]], "--print").out, gen([["50-x.json", without]], "--print").out);
  assert.equal(gen([["50-x.json", bound()]], "--print-hub").out, gen([["50-x.json", without]], "--print-hub").out);
  const a = ok([["50-x.json", bound()]], "--print-areas");
  const b = ok([["50-x.json", without]], "--print-areas");
  const { workflow, workflow_states, transitions, ...rest } = a.deployments.lifecycle;
  const { transitions: plain, ...restB } = b.deployments.lifecycle;
  assert.deepEqual(rest, restB);
  assert.deepEqual(transitions.map(({ step, ...t }) => t), plain);
  for (const id of ["implementations", "tasks", "periods"]) assert.deepEqual(a[id], b[id], id);
});

// --- 2. a neutral example compiles -----------------------------------------------------------------------------------
check("every phase-1 fixture the app can run is a valid records.workflows entry, all at once (email actions included)", () => {
  const ids = Object.keys(FIXTURES).filter((id) => runnable(FIXTURES[id]));
  assert.deepEqual(ids, ["anchored-down", "cohort-wait", "due-extension-once", "escalate-up-one-level", "five-step-chain", "migrated-step", "multi-holder-chain", "quorum-two-of-three", "self-and-supervisor-reassign", "two-person-review"]);
  ok([["50-x.json", { records: { workflows: Object.fromEntries(ids.map((id) => [id, FIXTURES[id]])) } }]]);
});
check("the two-person review bound to the deployments area compiles, with its steps and mid-lifecycle states", () => {
  const areas = ok([["50-x.json", bound()]], "--print-areas");
  const lc = areas.deployments.lifecycle;
  assert.equal(lc.workflow, "two-person-review");
  assert.deepEqual(lc.transitions.map((t) => t.step), [{ id: "prepare", state: "completed" }, { id: "review", state: "completed" }, { id: "review", state: "rejected" }]);
  assert.deepEqual(lc.workflow_states, BOUND.workflow_states);
  assert.equal(areas.deployments.declared, true);
});
check("a workflow in one file binds an area in another, and a later file's workflow replaces it whole", () => {
  ok([["50-a.json", { records: { workflows: { "two-person-review": review } } }], ["51-b.json", { records: { areas: { deployments: reviewArea(BOUND) } } }]]);
  // 51 replaces the review with a one-step workflow: a move naming the review step is now refused (no merge of steps),
  // reported against the file that states the area.
  const single = { init: { start_id: "prepare", steps: [{ id: "prepare", title: "Prepare" }] }, diff: [] };
  const r = gen([["50-a.json", bound()], ["51-b.json", { records: { workflows: { "two-person-review": single } } }]]);
  assert.equal(r.rc, 1, r.out);
  assert.equal(lastLine(r.err), 'profiles/50-a.json: records.areas.deployments.lifecycle.transitions[1].step.id: "review" is not a step of the workflow "two-person-review" (its steps: "prepare")');
});
check("a binding on the tasks area's status lifecycle compiles", () => {
  const five = FIXTURES["five-step-chain"];
  const tasks = read(join(ROOT, "profiles/00-default.json")).records.areas.tasks;
  ok([["50-x.json", { records: { workflows: { chain: five }, areas: { tasks: { lifecycle: { ...tasks.lifecycle, workflow: "chain", workflow_states: { done: Object.fromEntries(five.init.steps.map((s) => [s.id, "completed"])) } } } } } }]]);
});
check("pathOf turns an instance path into the profile's", () => {
  assert.equal(pathOf("/init/steps/0/assignee/condition/$or"), "init.steps[0].assignee.condition.$or");
  assert.equal(pathOf("/diff/2/action/internal/set/a~1b"), "diff[2].action.internal.set.a/b");
  assert.equal(pathOf(""), "");
});

// --- 3. every refusal, with its exact sentence -----------------------------------------------------------------------
const W = (id, doc) => ({ records: { workflows: { [id]: doc } } });
const minimal = (step = {}, rule) => ({ init: { start_id: "a", steps: [{ id: "a", title: "A", ...step }] }, diff: rule ? [rule] : [] });
const RULE = { priority: 0, applicability: "all", selector: { rule: "forAll" }, condition: { "step$state": { $delta: { before: "", after: "completed" } } }, action: { internal: { scope: "self", set: { status: { value: false } } } } };
const BAD = [
  // The document: its id, the engine's spec.json, the engine's validator.
  ["records.workflows not a map", { records: { workflows: ["x"] } }, "records.workflows must be an object keyed by workflow id"],
  ["a workflow id that is not lowercase words", W("Two_Review", review), 'records.workflows.Two_Review: a workflow id is lowercase letters and digits, words joined by "-" or "_", starting with a letter, at most 64 characters (for example "two-person-review")'],
  ["a workflow that is not an object", W("w", "steps"), 'records.workflows.w: must be an object: a workflow document with an "init" and a "diff" (docs/WORKFLOW_ENGINE.md)'],
  ["spec.json: a step without a title", W("w", { init: { start_id: "a", steps: [{ id: "a" }] }, diff: [] }), "records.workflows.w.init.steps[0]: must have required property 'title'"],
  ["spec.json: an unknown key", W("w", { ...minimal(), owner: "x" }), 'records.workflows.w: must NOT have additional properties ("owner")'],
  ["spec.json: a step state outside the engine's", W("w", minimal({ state: { default: "done" } })), 'records.workflows.w.init.steps[0].state.default: must be equal to one of the allowed values ("open", "completed", "rejected", "escalated")'],
  ["validator: a start step that does not exist", W("w", { ...minimal(), init: { start_id: "nope", steps: [{ id: "a", title: "A" }] } }), 'records.workflows.w.init.start_id: start_id "nope" is not a step id'],
  ["validator: an unsupported query operator", W("w", minimal({ assignee: { condition: { $or: { query: { role: { $size: 2 } } } } } })), 'records.workflows.w.init.steps[0].assignee.condition.$or.query.role.$size: unsupported query operator "$size" (engine supports: $eq $ne $gt $gte $lt $lte $in $nin $exists $regex $and $or $not $nor)'],
  // What the app cannot run: prompt branches (each named by its path), an email's recipients, subject or body left to a
  // model, its attachments. (Email and agent actions themselves build: below.)
  ["an email whose recipients a model picks", W("w", minimal({}, { ...RULE, action: { external: { email: { recipients: { $or: { prompt: "Whoever should know." } } } } } })), `records.workflows.w.diff[0].action.external.email.recipients.$or.prompt: ${LATER.prompt}`],
  ["an email's recipients, a prompt beside a query (still refused)", W("w", minimal({}, { ...RULE, action: { external: { email: { recipients: { $or: { query: { role: "lead" }, prompt: "A lead." } } } } } })), `records.workflows.w.diff[0].action.external.email.recipients.$or.prompt: ${LATER.prompt}`],
  ["an email whose subject a model writes", W("w", minimal({}, { ...RULE, action: { external: { email: { recipients: { $or: { query: { role: "lead" } } }, subject: { prompt: "Sum it up." } } } } })), `records.workflows.w.diff[0].action.external.email.subject.prompt: ${LATER.prompt}`],
  ["an email whose body a model writes, beside a value (still refused)", W("w", minimal({}, { ...RULE, action: { external: { email: { recipients: { $or: { query: { role: "lead" } } }, body: { value: "b", prompt: "Explain." } } } } })), `records.workflows.w.diff[0].action.external.email.body.prompt: ${LATER.prompt}`],
  ["an email with attachments", W("w", minimal({}, { ...RULE, action: { external: { email: { recipients: { $or: { query: { role: "lead" } } }, attachments: { $search: "the latest report" } } } } })), `records.workflows.w.diff[0].action.external.email.attachments: ${LATER.attachments}`],
  ["a prompt deciding whether a rule applies (the phase-1 gateway branch, unchanged)", W("gateway", FIXTURES["gateway-branch"]), `records.workflows.gateway.diff[2].applicability_query.prompt: ${LATER.prompt}`],
  ["a prompt choosing who holds a step", W("w", minimal({ assignee: { condition: { $or: { prompt: "Whoever knows it best." } } } })), `records.workflows.w.init.steps[0].assignee.condition.$or.prompt: ${LATER.prompt}`],
  ["a prompt beside a query (the query would win; still refused)", W("w", minimal({ assignee: { condition: { $or: { query: { role: "lead" }, prompt: "A lead." } } } })), `records.workflows.w.init.steps[0].assignee.condition.$or.prompt: ${LATER.prompt}`],
  ["a prompt deciding whether evidence is needed", W("w", minimal({ evidence_required: { default: false, condition: { $or: { prompt: "Is it material?" } } } })), `records.workflows.w.init.steps[0].evidence_required.condition.$or.prompt: ${LATER.prompt}`],
  ["a prompt deciding whether a comment is needed", W("w", minimal({ comments_required: { default: false, condition: { $or: { prompt: "Is it unusual?" } } } })), `records.workflows.w.init.steps[0].comments_required.condition.$or.prompt: ${LATER.prompt}`],
  ["a prompt setting a step property", W("w", minimal({}, { ...RULE, action: { internal: { scope: "self", set: { due_on: { prompt: "When should it be due?" } } } } })), `records.workflows.w.diff[0].action.internal.set.due_on.prompt: ${LATER.prompt}`],
  // The binding.
  ["a lifecycle running a workflow the profile does not declare", bound({ workflow: "four-eyes" }), 'records.areas.deployments.lifecycle.workflow: "four-eyes" is not a workflow of this profile (records.workflows: "two-person-review")'],
  ["a lifecycle running a workflow when none is declared", { records: { areas: { deployments: reviewArea(BOUND) } } }, 'records.areas.deployments.lifecycle.workflow: "two-person-review" is not a workflow of this profile (records.workflows declares none)'],
  ["a move changing a step the workflow does not have", bound({ transitions: [{ from: ["drafting"], to: "in_review", step: { id: "submit", state: "completed" } }] }), 'records.areas.deployments.lifecycle.transitions[0].step.id: "submit" is not a step of the workflow "two-person-review" (its steps: "prepare", "review")'],
  ["a move putting a step in a state the engine does not have", bound({ transitions: [{ from: ["drafting"], to: "in_review", step: { id: "prepare", state: "done" } }] }), 'records.areas.deployments.lifecycle.transitions[0].step.state: "done" is not a step state of the workflow engine ("open", "completed", "rejected", "escalated")'],
  ["a move's step without its state (schema)", bound({ transitions: [{ from: ["drafting"], to: "in_review", step: { id: "prepare" } }] }), 'records.areas.deployments.lifecycle.transitions[0].step: needs "state"'],
  ["a move's step with no workflow on the lifecycle", { records: { workflows: { "two-person-review": review }, areas: { deployments: reviewArea() } } }, "records.areas.deployments.lifecycle.transitions[0].step: a transition's step names a step of the lifecycle's workflow, and this lifecycle has none; name it with lifecycle.workflow"],
  ["workflow_states with no workflow on the lifecycle", { records: { areas: { deployments: reviewArea({ transitions: [], workflow_states: BOUND.workflow_states }) } } }, "records.areas.deployments.lifecycle.workflow_states: workflow_states names a step of the lifecycle's workflow, and this lifecycle has none; name it with lifecycle.workflow"],
  ["workflow_states keyed by a state the lifecycle does not have", bound({ workflow_states: { closed: { review: "completed" } } }), 'records.areas.deployments.lifecycle.workflow_states.closed: "closed" is not a state of review_state ("drafting", "in_review", "approved", "sent_back")'],
  ["workflow_states keyed by a legacy spelling", bound({ workflow_states: { draft: { prepare: "open" } } }), 'records.areas.deployments.lifecycle.workflow_states.draft: "draft" is a stored legacy spelling of "drafting"; key workflow_states by the state itself, "drafting"'],
  ["workflow_states naming a step the workflow does not have", bound({ workflow_states: { approved: { sign_off: "completed" } } }), 'records.areas.deployments.lifecycle.workflow_states.approved.sign_off: "sign_off" is not a step of the workflow "two-person-review" (its steps: "prepare", "review")'],
  ["workflow_states giving a step a state the engine does not have", bound({ workflow_states: { approved: { review: "approved" } } }), 'records.areas.deployments.lifecycle.workflow_states.approved.review: "approved" is not a step state of the workflow engine ("open", "completed", "rejected", "escalated")'],
];
for (const [what, profile, message] of BAD) {
  check(`refused: ${what}`, () => {
    const r = gen([["50-bad.json", profile]]);
    assert.equal(r.rc, 1, `the build passed: ${r.out}`);
    assert.equal(lastLine(r.err), `profiles/50-bad.json: ${message}`);
  });
}
check("a refusal names the file that states the workflow, not the last file", () => {
  const r = gen([["50-a.json", W("gateway", FIXTURES["gateway-branch"])], ["51-b.json", { product: { tagline: "Another line." } }]]);
  assert.equal(r.rc, 1);
  assert.equal(lastLine(r.err), `profiles/50-a.json: records.workflows.gateway.diff[2].applicability_query.prompt: ${LATER.prompt}`);
});

// Phase 6: email and agent actions build (the app turns them into its own notifications and tasks for the assistant).
for (const [what, profile] of [
  ["an email action (the phase-1 two-person review)", W("two-person-review", FIXTURES["two-person-review"])],
  ["an email beside an internal action (the phase-1 quorum)", W("quorum", FIXTURES["quorum-two-of-three"])],
  ["an agent action", W("w", minimal({}, { ...RULE, action: { external: { agent: [{ _id: "x", name: "x", prompt: "Look at it." }] } } }))],
]) {
  check(`built: ${what}`, () => {
    const r = gen([["50-ok.json", profile]]);
    assert.equal(r.rc, 0, r.err);
  });
}

console.log(`${process.exitCode ? "FAILED" : "ok"}: ${passed} record-workflow checks passed`);
