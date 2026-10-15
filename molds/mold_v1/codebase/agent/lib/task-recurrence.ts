/**
 * RECURRENCE (profiles `records.areas.tasks.recurrence`): when a task whose definition recurs moves into a state of
 * the DONE category, the next occurrence is created, server-side, in the write path (the ops API's task routes and the
 * agent's upsert_todo), by whoever made the move. No email, no notice: a new task.
 *
 *   recurrence: { field: "frequency", on: "done", anchor: "dueAt",
 *                 every: { "Monthly": "+1M", "Quarterly": "+3M", "Annual": "+1y" }, copy: ["title", "notes", ...] }
 *
 *   - which interval: `every[<the task's value of field>]`; a value with none ("One-time") does not recur;
 *   - the next one carries the `copy` fields (columns at the top, own fields under `custom`), starts in the
 *     lifecycle's initial state, and is due one interval after the anchor's value (else after the day it was done);
 *   - it links back: `custom.recurs_from` holds the previous task's id (a system key, written by nothing else);
 *   - IDEMPOTENT: a task has at most one next occurrence. Before creating one the caller looks for a task in the
 *     workspace whose `custom.recurs_from` is this task (agent/lib/record-lifecycle-store.ts occurrenceOf), so a
 *     repeated move (done, reopened, done again; a retried request) never makes a second.
 *
 * Pure: no database, no fetch. The caller reads the stored task before the write and creates the next one after it.
 */
import { RECORD_AREAS } from "./record-areas.generated.ts";
import { areaView, type AreaRow, type AreaView, type RecordAreas } from "./record-areas.ts";
import { prepareTaskWrite } from "./task-area.ts";

/** The own-field key the next occurrence links back to the previous one by. */
export const RECURS_FROM = "recurs_from";

/** Does the tasks area recur on done? */
export function recursOnDone(areas: RecordAreas = RECORD_AREAS): boolean {
  const r = areas.tasks.recurrence;
  return Boolean(areas.tasks.enabled && r && (r.on ?? "done") === "done" && r.field && r.every && Object.keys(r.every).length);
}

/** Did this write complete the task: from a state not in the done category into one that is? */
export function completes(v: AreaView, before: AreaRow | null, after: AreaRow): boolean {
  if (!before || !v.lifecycle) return false;
  return v.categoryOfRow(before) !== "done" && v.categoryOfRow(after) === "done";
}

/** `iso` moved by an interval ("+1M", "+3M", "+1y", "+2w", "+10d"), in UTC; a month end stays within its month. */
export function addInterval(iso: string, interval: string): string | null {
  const m = /^\+(\d+)([dwMy])$/.exec(interval);
  const d = new Date(iso);
  if (!m || Number.isNaN(d.getTime())) return null;
  const n = Number(m[1]);
  if (m[2] === "d" || m[2] === "w") return new Date(d.getTime() + n * (m[2] === "w" ? 7 : 1) * 86_400_000).toISOString();
  const months = m[2] === "y" ? n * 12 : n;
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const out = new Date(d);
  out.setUTCFullYear(y, mo, Math.min(d.getUTCDate(), last));
  return out.toISOString();
}

/**
 * The body that creates the next occurrence of `prev` (the task as the service answered the write: columns by key,
 * own fields under `custom`), checked against the definition, or null when it does not recur (no interval for its
 * value) or the body would not be valid.
 */
export function nextOccurrence(prev: AreaRow & { id?: unknown }, actor: string, now: Date = new Date(), areas: RecordAreas = RECORD_AREAS): Record<string, unknown> | null {
  const v = areaView("tasks", areas);
  const rc = v.area.recurrence;
  if (!rc?.field || !rc.every || typeof prev.id !== "string") return null;
  const interval = rc.every[String(v.get(prev, rc.field) ?? "")];
  if (!interval) return null;
  const lc = v.lifecycle;
  const body: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  const copy = rc.copy ?? v.fields.filter((f) => !f.hidden && !f.computed).map((f) => f.key);
  for (const key of copy) {
    const f = v.field(key);
    if (!f || f.computed || (lc && f.key === lc.field) || ["doneAt", "createdBy", "createdAt", "updatedAt", "done", "status"].includes(f.key)) continue;
    const value = v.get(prev, f.key);
    if (value === null || value === undefined || value === "") continue;
    if (f.column) body[f.key] = value instanceof Date ? value.toISOString() : value;
    else custom[f.key] = value;
  }
  if (typeof body.title !== "string") body.title = String(prev.title ?? "");
  const anchorKey = rc.anchor ?? "dueAt";
  const anchor = v.get(prev, anchorKey);
  const from = anchor instanceof Date ? anchor.toISOString() : typeof anchor === "string" && anchor ? anchor : now.toISOString();
  const due = addInterval(from, interval);
  if (!due) return null;
  if (v.field(anchorKey)?.column) body[anchorKey] = due;
  else custom[anchorKey] = due.slice(0, 10);
  if (Object.keys(custom).length) body.custom = custom;
  // The next occurrence follows from a completion the caller was let make: who may create a task is not asked again.
  const prepared = prepareTaskWrite("create", body, { actor, now, checkPermissions: false }, areas);
  if (!prepared.ok) return null;
  const out = prepared.body ?? body;
  return { ...out, createdBy: actor, custom: { ...((out.custom as Record<string, unknown>) ?? {}), [RECURS_FROM]: prev.id } };
}
