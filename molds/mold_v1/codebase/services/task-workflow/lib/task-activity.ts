/**
 * What a task edit WROTE, as sentences a person can read.
 *
 * Only `assignee` used to be recorded. The Tasks board's whole interaction is
 * dragging a card between columns — a STATUS change — so the activity feed on
 * the detail panel stayed empty through every move, and rendered a section
 * nothing ever wrote to. Priority, due date, title and period were equally
 * silent. (Workflow stage moves were recorded, but only for tasks with a
 * workflow instance attached, which most do not have.)
 *
 * A separate module from engine.ts on purpose: engine.ts imports through the
 * `@/lib` alias, which only the Next bundler resolves, so nothing in it can be
 * unit-tested under plain Node. Keeping the differ import-free makes the
 * sentences themselves testable — and the sentences are the whole product here.
 */

import type postgres from "postgres";

/** The row fields the feed describes. Structurally satisfied by engine's TaskRow. */
export interface TaskActivityRow {
  status: string;
  title: string;
  priority: string;
  assignee: string | null;
  cycle_id: string | null;
  due_at: Date | null;
  container_label: string | null;
  notes: string | null;
  archived_at: Date | null;
}

/**
 * The driver handle, straight from postgres.js.
 *
 * A hand-rolled structural type was tried first and cannot work: TransactionSql
 * is an overloaded callable (template tag AND helper builder), so any narrower
 * signature rejects the very handle every caller holds. This is a TYPE-only
 * import, erased by Node's type stripping, so the module still loads under a
 * plain `node --test` with no bundler.
 */
export type ActivitySql = postgres.TransactionSql;

export interface ActivityContext {
  orgId: string;
  actor: string;
  /** What the calling deployment calls a period (its profile's word). Absent: the neutral word below. */
  periodLabel?: string;
}

/** A period move when the caller did not say what its deployment calls one. */
const NEUTRAL_PERIOD_LABEL = "Period";

const TRACKED_FIELDS: [keyof TaskActivityRow, string][] = [
  ["status", "Status"],
  ["title", "Title"],
  ["priority", "Priority"],
  ["assignee", "Assignee"],
  ["cycle_id", NEUTRAL_PERIOD_LABEL],
  ["due_at", "Due date"],
  ["container_label", "Container"],
  ["notes", "Notes"],
];

async function insertActivity(
  sql: ActivitySql,
  ctx: ActivityContext,
  taskId: string,
  event: string,
): Promise<void> {
  await sql`insert into entity_activity (org_id, entity_type, entity_id, actor, event)
            values (${ctx.orgId}, 'task', ${taskId}, ${ctx.actor}, ${event})`;
}

/**
 * One sentence per field that actually changed.
 *
 * Diffed against the row as READ and the row as RETURNED, never against the
 * request body: a patch may be partial, coerced, or overridden by the workflow
 * branch in updateTask, and the feed should say what changed rather than what
 * was asked for.
 */
export async function recordTaskChanges(
  sql: ActivitySql,
  ctx: ActivityContext,
  taskId: string,
  before: TaskActivityRow,
  after: TaskActivityRow,
): Promise<void> {
  /**
   * A period is stored as a uuid and read by a person. "<Period> changed
   * 4f3c… → 91ab…" is a line nobody can act on, so the two ids in play are
   * resolved to names — one query, and only when the period actually moved.
   */
  const cycleNames = new Map<string, string>();
  if (before.cycle_id !== after.cycle_id) {
    const ids = [before.cycle_id, after.cycle_id].filter((v): v is string => Boolean(v));
    if (ids.length) {
      const rows = await sql<{ id: string; name: string }[]>`
        select id, name from cycles where org_id = ${ctx.orgId} and id = any(${ids})`;
      for (const row of rows) cycleNames.set(row.id, row.name);
    }
  }

  const show = (v: unknown): string => {
    if (v === null || v === undefined || v === "") return "—";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return cycleNames.get(String(v)) ?? String(v);
  };

  for (const [field, label] of TRACKED_FIELDS) {
    const from = show(before[field]);
    const to = show(after[field]);
    if (from === to) continue;
    // Notes are free text and often long; say that they changed, not what to.
    const shown = field === "cycle_id" ? (ctx.periodLabel ?? label) : label;
    const event = field === "notes" ? "Notes edited" : `${shown} changed ${from} → ${to}`;
    await insertActivity(sql, ctx, taskId, event);
  }

  if (before.archived_at === null && after.archived_at !== null) {
    await insertActivity(sql, ctx, taskId, "Task archived");
  } else if (before.archived_at !== null && after.archived_at === null) {
    await insertActivity(sql, ctx, taskId, "Task restored");
  }
}
