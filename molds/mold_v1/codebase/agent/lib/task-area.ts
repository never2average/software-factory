/**
 * A TASK WRITE, CHECKED AGAINST THE DEPLOYMENT'S DEFINITION OF A TASK (records.areas.tasks) before anything reaches the
 * task-workflow service. The one place the ops API (lib/work-periods-server.ts guardTaskRequest; MCP goes through it)
 * and the agent's todo tools (agent/lib/todo-tools.ts) prepare a task create or update.
 *
 *   - The default definition is today's task: a valid body is sent on exactly as it came (`body: null`), and an invalid
 *     one is refused here with the reason in a sentence instead of by the service.
 *   - A redefined one (`redefined`) is checked field by field (agent/lib/record-validate.ts): its own fields go out as
 *     `custom` (a per-key delta the service merges), defaults and fixed values are filled on create, and when its
 *     states are its own the status their category maps to goes with them (`statusFrom: "category"`); nobody sets the
 *     status directly.
 *   - The lifecycle's rules (agent/lib/record-lifecycle.ts), when its `enforce` is "warn" or "strict" and the caller
 *     passes the stored task (`before`): a move that breaks them goes through and is reported (`lifecycle`, for the
 *     activity feed) under "warn", and is refused with `conflict` (the API's 409) under "strict". A move by `done` or
 *     by a pipeline stage (`stageState`, the state the caller mapped the stage to) is checked as the move it makes.
 *     The comment a transition may need is the request's `reason`. Under "off" (the default) none of this runs.
 *
 * Pure: no database, no fetch. `areas` is a parameter so a test or a preview can pass another profile's.
 */
import { RECORD_AREAS, type RecordRole } from "./record-areas.generated.ts";
import type { RecordAreas } from "./record-areas.ts";
import { validateRecordWrite } from "./record-validate.ts";
import { areaView, type AreaRow } from "./record-areas.ts";
import type { LifecycleConflict, MoveCheck, WorkflowGate } from "./record-lifecycle.ts";
import { createRefusal, updateRefusal } from "./record-permissions.ts";

/** Keys of a task request that are not fields of a task: identities, audit labels, the request's own switches. */
export const TASK_PASS_THROUGH: readonly string[] = ["createdBy", "actor", "reason", "idempotencyKey", "archived", "stageId"];

export type TaskWrite =
  | { ok: true; body: Record<string, unknown> | null; warnings: string[]; lifecycle?: MoveCheck }
  | { ok: false; errors: string[]; conflict?: LifecycleConflict; forbidden?: true };

/** Who writes, and what the lifecycle's rules read besides the body. */
export interface TaskWho {
  actor: string;
  role?: RecordRole;
  now?: Date;
  /** The stored task (as the database or the service holds it: columns by key, own fields under `custom`). */
  before?: AreaRow | null;
  /** Who moved the task into its stored state (lib/record-lifecycle-server.ts), for `not_by: "{entered_by}"`. */
  enteredBy?: string | null;
  /** The state a requested pipeline stage (`stageId`) stands for (record-lifecycle.ts stateForStage). */
  stageState?: string | null;
  /** The step rules, when the tasks' lifecycle runs a workflow (agent/lib/record-lifecycle.ts WorkflowGate). */
  workflow?: WorkflowGate;
  /** false: skip who-may (agent/lib/record-permissions.ts), for a screen's own pre-check that does not know the role. */
  checkPermissions?: boolean;
}

/** Is the tasks area's lifecycle enforced ("warn" or "strict")? Only then does a caller read the stored task. */
export function taskLifecycleEnforced(areas: RecordAreas = RECORD_AREAS): boolean {
  const lc = areaView("tasks", areas).lifecycle;
  return Boolean(lc && lc.enforce !== "off");
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Check a task create (`mode: "create"`) or update against the tasks area; what to send the service, or why not. */
export function prepareTaskWrite(
  mode: "create" | "update",
  body: Record<string, unknown>,
  who: TaskWho,
  areas: RecordAreas = RECORD_AREAS,
): TaskWrite {
  // Who may (records.areas.tasks.permissions): a refusal is `forbidden` (the API's 403). The stored task (`before`) is
  // what an `own` rule reads. Nothing is checked for an area that declares no permissions.
  if (who.checkPermissions !== false) {
    const refusal = mode === "create" ? createRefusal("tasks", who, body, areas) : updateRefusal("tasks", body, who.before, who, areas);
    if (refusal) return { ok: false, errors: [refusal], forbidden: true };
  }
  const redefined = areas.tasks.redefined;
  // A due date given as a day is the morning of that day, as the forms send it (the service stores a timestamp).
  let patch = redefined && typeof body.dueAt === "string" && DATE_ONLY.test(body.dueAt) ? { ...body, dueAt: `${body.dueAt}T09:00:00.000Z` } : body;
  const enforced = taskLifecycleEnforced(areas);
  const lc = enforced ? areaView("tasks", areas).lifecycle : null;
  // A move on the status column made by `done` or by a pipeline stage is checked as the status it lands on; that
  // status is the check's only (the body sent keeps the request's own words).
  let synthetic: string | null = null;
  if (lc && !lc.own && mode === "update" && !("status" in patch)) {
    const to = typeof who.stageState === "string" ? who.stageState : patch.done === true ? "done" : patch.done === false ? "open" : null;
    if (to) {
      synthetic = to;
      patch = { ...patch, status: to };
    }
  }
  const comment = typeof body.reason === "string" ? body.reason : null;
  const r = validateRecordWrite("tasks", { mode, patch, actor: who.actor, role: who.role, now: who.now, passThrough: TASK_PASS_THROUGH, before: enforced ? who.before ?? null : null, comment, enteredBy: who.enteredBy, ...(who.workflow ? { workflow: who.workflow } : {}) }, areas);
  if (!r.ok) return { ok: false, errors: r.errors, ...(r.conflict ? { conflict: r.conflict } : {}) };
  const moved = r.lifecycle ? { lifecycle: r.lifecycle } : {};
  if (!redefined) return { ok: true, body: null, warnings: r.warnings, ...moved };
  const out: Record<string, unknown> = { ...r.columns };
  if (synthetic !== null) delete out.status;
  if (Object.keys(r.customDelta).length) out.custom = r.customDelta;
  if (r.derived.status) {
    out.status = r.derived.status;
    out.statusFrom = "category";
  }
  return { ok: true, body: out, warnings: r.warnings, ...moved };
}

/** The tasks area's own fields' values on a task as the service returns it (`custom`), or {}. */
export function taskCustom(task: { custom?: unknown }): Record<string, unknown> {
  return task.custom && typeof task.custom === "object" && !Array.isArray(task.custom) ? (task.custom as Record<string, unknown>) : {};
}
