import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedManualTransition,
  findRequestedStage,
  legacyStatusForStage,
  normalizeStageKey,
} from "../lib/stages.ts";
import type { WorkflowStage } from "../lib/types.ts";

const stages: WorkflowStage[] = [
  {
    id: "triage",
    label: "Needs Triage",
    description: "",
    assign: { type: "none" },
    transitions: [{ to: "working", migrate: { type: "manual" } }],
  },
  {
    id: "working",
    label: "In progress",
    description: "",
    assign: { type: "team", value: "Engineering" },
    transitions: [{ to: "complete", migrate: { type: "rule", value: "all checks pass" } }],
  },
  {
    id: "complete",
    label: "Complete",
    description: "",
    assign: { type: "none" },
    transitions: [],
  },
];

test("normalizes stage labels for legacy clients", () => {
  assert.equal(normalizeStageKey("  In Progress! "), "in_progress");
});

test("resolves stages by id or normalized label", () => {
  assert.equal(findRequestedStage(stages, "working")?.id, "working");
  assert.equal(findRequestedStage(stages, "In Progress")?.id, "working");
  assert.equal(findRequestedStage(stages, "missing"), null);
});

test("only manual edges accept user-driven transitions", () => {
  assert.equal(allowedManualTransition(stages[0], stages[1]), true);
  assert.equal(allowedManualTransition(stages[1], stages[2]), false);
});

test("maps workflow stages onto the existing task status contract", () => {
  assert.equal(legacyStatusForStage(stages[1]), "in_progress");
  assert.equal(legacyStatusForStage(stages[2]), "done");
  assert.equal(legacyStatusForStage(stages[0]), "open");
});
