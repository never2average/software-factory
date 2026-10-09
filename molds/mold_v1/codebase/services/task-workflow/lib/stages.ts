import type { WorkflowStage } from "./types.ts";

const LEGACY_STATUSES = new Set(["backlog", "open", "in_progress", "blocked", "done", "cancelled"]);

export function normalizeStageKey(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function legacyStatusForStage(stage: WorkflowStage): string {
  const normalized = normalizeStageKey(stage.label);
  if (LEGACY_STATUSES.has(normalized)) return normalized;
  if (stage.transitions.length === 0 && /complete|finished|closed/i.test(stage.label)) return "done";
  return "open";
}

export function findRequestedStage(stages: WorkflowStage[], requested: string): WorkflowStage | null {
  const normalized = normalizeStageKey(requested);
  return stages.find((stage) => stage.id === requested || normalizeStageKey(stage.label) === normalized) ?? null;
}

export function allowedManualTransition(from: WorkflowStage, to: WorkflowStage): boolean {
  return from.transitions.some((transition) => transition.to === to.id && transition.migrate.type === "manual");
}
