import type { WorkflowStage } from "./types.ts";

const LEGACY_STATUSES = new Set(["backlog", "open", "in_progress", "blocked", "done", "cancelled"]);

export function normalizeStageKey(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** A state of the deployment's tasks (sent as `x-task-states`): its value, label, category and the status it stores. */
export interface TaskState {
  value: string;
  label: string;
  category: string;
  status: string;
}

/** The status each category stores (the app's agent/lib/record-areas.ts CATEGORY_STATUS). */
export const CATEGORY_STATUS: Readonly<Record<string, string>> = { backlog: "backlog", open: "open", active: "in_progress", blocked: "blocked", done: "done", cancelled: "cancelled" };

/**
 * The status a pipeline stage stores, by CATEGORY: the stage's own `category`; else the category of the deployment's
 * task state its label names (by value or label, `x-task-states`); else today's reading (legacyStatusForStage: one of
 * the six status names, a terminal stage named complete/finished/closed, else open). Under the default definition the
 * states are the six statuses, so every stage stores what it did before.
 */
export function statusForStage(stage: Pick<WorkflowStage, "label" | "transitions"> & { category?: string }, states?: readonly TaskState[] | null): string {
  if (stage.category && CATEGORY_STATUS[stage.category]) return CATEGORY_STATUS[stage.category];
  const key = normalizeStageKey(stage.label);
  const state = states?.find((s) => normalizeStageKey(s.value) === key || normalizeStageKey(s.label) === key);
  if (state && LEGACY_STATUSES.has(state.status)) return state.status;
  return legacyStatusForStage(stage);
}

/** The deployment's task states from the `x-task-states` header (URI-encoded JSON); null when absent or malformed. */
export function parseTaskStates(raw: string | null): TaskState[] | null {
  if (!raw) return null;
  try {
    const list: unknown = JSON.parse(decodeURIComponent(raw));
    if (!Array.isArray(list) || list.length > 100) return null;
    const ok = list.every((s) => s && typeof s === "object" && typeof s.value === "string" && typeof s.label === "string" && typeof s.category === "string" && typeof s.status === "string" && LEGACY_STATUSES.has(s.status));
    return ok ? (list as TaskState[]).map(({ value, label, category, status }) => ({ value, label, category, status })) : null;
  } catch {
    return null;
  }
}

export function legacyStatusForStage(stage: Pick<WorkflowStage, "label" | "transitions">): string {
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
