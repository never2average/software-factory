import assert from "node:assert/strict";
import test from "node:test";
import { parseTaskStates, statusForStage, legacyStatusForStage, type TaskState } from "../lib/stages.ts";
import { workflowStageSchema } from "../lib/types.ts";

// A pipeline stage stores the status of its CATEGORY (lib/stages.ts statusForStage): the stage's own, else that of the
// deployment's task state its label names (x-task-states), else today's reading of the label.

const stage = (label: string, extra: Record<string, unknown> = {}) => ({ id: label.toLowerCase().replace(/\W+/g, "_"), label, description: "", assign: { type: "none" as const }, transitions: [{ to: "x", migrate: { type: "manual" as const } }], ...extra });
const DEFAULT_STATES: TaskState[] = [
  { value: "backlog", label: "Backlog", category: "backlog", status: "backlog" },
  { value: "open", label: "Open", category: "open", status: "open" },
  { value: "in_progress", label: "In progress", category: "active", status: "in_progress" },
  { value: "blocked", label: "Blocked", category: "blocked", status: "blocked" },
  { value: "done", label: "Done", category: "done", status: "done" },
  { value: "cancelled", label: "Cancelled", category: "cancelled", status: "cancelled" },
];
const OBLIGATION_STATES: TaskState[] = [
  { value: "not_started", label: "Not started", category: "open", status: "open" },
  { value: "evidence_submitted", label: "Evidence submitted", category: "active", status: "in_progress" },
  { value: "under_review", label: "Under review", category: "active", status: "in_progress" },
  { value: "closed", label: "Complied", category: "done", status: "done" },
  { value: "not_applicable", label: "Not applicable", category: "cancelled", status: "cancelled" },
];

test("under the default states every stage stores what it did before (the six names, a closed terminal stage, else open)", () => {
  const labels = ["Backlog", "Open", "In progress", "Blocked", "Done", "Cancelled", "Review", "Shipped", "Waiting on customer"];
  for (const l of labels) assert.equal(statusForStage(stage(l), DEFAULT_STATES), legacyStatusForStage(stage(l)), l);
  const terminal = { ...stage("Completed"), transitions: [] };
  assert.equal(statusForStage(terminal, DEFAULT_STATES), "done");
  assert.equal(statusForStage(terminal, null), legacyStatusForStage(terminal));
});

test("a stage named for one of the deployment's states stores its category's status, not the label regex's", () => {
  assert.equal(legacyStatusForStage(stage("Under review")), "open", "today: an unknown label is open");
  assert.equal(statusForStage(stage("Under review"), OBLIGATION_STATES), "in_progress");
  assert.equal(statusForStage(stage("Complied"), OBLIGATION_STATES), "done", "by the state's label");
  assert.equal(statusForStage(stage("not_applicable"), OBLIGATION_STATES), "cancelled", "by the state's value");
  const closedButOngoing = { ...stage("Closed"), transitions: [] };
  assert.equal(statusForStage(closedButOngoing, [{ value: "closed", label: "Closed", category: "blocked", status: "blocked" }]), "blocked", "the category wins over the regex");
});

test("a stage's own category wins over its label", () => {
  assert.equal(statusForStage(stage("Waiting for sign-off", { category: "blocked" }), OBLIGATION_STATES), "blocked");
  assert.equal(statusForStage(stage("Open", { category: "done" }), DEFAULT_STATES), "done");
  assert.equal(workflowStageSchema.parse(stage("Sign-off", { category: "active" })).category, "active", "a stored definition may carry it");
  assert.equal(workflowStageSchema.safeParse(stage("Sign-off", { category: "finished" })).success, false, "only the six categories");
  assert.equal(workflowStageSchema.parse(stage("Sign-off")).category, undefined, "and it is optional: stored definitions parse as before");
});

test("x-task-states: parsed when well formed, ignored otherwise", () => {
  assert.deepEqual(parseTaskStates(encodeURIComponent(JSON.stringify(OBLIGATION_STATES))), OBLIGATION_STATES);
  assert.equal(parseTaskStates(null), null);
  assert.equal(parseTaskStates("%7Bnot json"), null);
  assert.equal(parseTaskStates(encodeURIComponent(JSON.stringify([{ value: "x", label: "X", category: "open", status: "shipped" }]))), null, "a status the service does not store");
  assert.deepEqual(parseTaskStates(encodeURIComponent(JSON.stringify([{ value: "x", label: "X", category: "open", status: "open", extra: 1 }]))), [{ value: "x", label: "X", category: "open", status: "open" }]);
});
