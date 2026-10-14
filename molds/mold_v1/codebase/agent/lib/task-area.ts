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
 *     status directly. Moves outside the lifecycle's transitions are reported (`warnings`), never refused here: that is
 *     the lifecycle's `enforce`, wired in a later change.
 *
 * Pure: no database, no fetch. `areas` is a parameter so a test or a preview can pass another profile's.
 */
import { RECORD_AREAS, type RecordRole } from "./record-areas.generated.ts";
import type { RecordAreas } from "./record-areas.ts";
import { validateRecordWrite } from "./record-validate.ts";

/** Keys of a task request that are not fields of a task: identities, audit labels, the request's own switches. */
export const TASK_PASS_THROUGH: readonly string[] = ["createdBy", "actor", "reason", "idempotencyKey", "archived", "stageId"];

export type TaskWrite = { ok: true; body: Record<string, unknown> | null; warnings: string[] } | { ok: false; errors: string[] };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Check a task create (`mode: "create"`) or update against the tasks area; what to send the service, or why not. */
export function prepareTaskWrite(
  mode: "create" | "update",
  body: Record<string, unknown>,
  who: { actor: string; role?: RecordRole; now?: Date },
  areas: RecordAreas = RECORD_AREAS,
): TaskWrite {
  const redefined = areas.tasks.redefined;
  // A due date given as a day is the morning of that day, as the forms send it (the service stores a timestamp).
  const patch = redefined && typeof body.dueAt === "string" && DATE_ONLY.test(body.dueAt) ? { ...body, dueAt: `${body.dueAt}T09:00:00.000Z` } : body;
  const r = validateRecordWrite("tasks", { mode, patch, actor: who.actor, role: who.role, now: who.now, passThrough: TASK_PASS_THROUGH }, areas);
  if (!r.ok) return { ok: false, errors: r.errors };
  if (!redefined) return { ok: true, body: null, warnings: r.warnings };
  const out: Record<string, unknown> = { ...r.columns };
  if (Object.keys(r.customDelta).length) out.custom = r.customDelta;
  if (r.derived.status) {
    out.status = r.derived.status;
    out.statusFrom = "category";
  }
  return { ok: true, body: out, warnings: r.warnings };
}

/** The tasks area's own fields' values on a task as the service returns it (`custom`), or {}. */
export function taskCustom(task: { custom?: unknown }): Record<string, unknown> {
  return task.custom && typeof task.custom === "object" && !Array.isArray(task.custom) ? (task.custom as Record<string, unknown>) : {};
}
