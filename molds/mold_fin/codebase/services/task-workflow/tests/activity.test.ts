import assert from "node:assert/strict";
import test from "node:test";
import { recordTaskChanges, type TaskActivityRow } from "../lib/task-activity.ts";

/**
 * The Tasks board's whole interaction is dragging a card between columns, which
 * is a STATUS change — and status was not among the fields the engine recorded.
 * Only `assignee` was, so a task's activity feed stayed empty through every
 * move, and the detail panel rendered a feed that nothing ever wrote to.
 *
 * These drive the differ against a stub `sql`, so they assert the SENTENCES a
 * person will read rather than that some insert happened.
 */

const ctx = { orgId: "org-test", actor: "sam@example.com" };

/** A tagged-template stub that records inserts and answers cycle lookups. */
function stubSql(cycles: Record<string, string> = {}) {
  const events: string[] = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("insert into entity_activity")) {
      events.push(String(values[3]));
      return Promise.resolve([]);
    }
    if (text.includes("from cycles")) {
      const ids = (values[1] as string[]) ?? [];
      return Promise.resolve(ids.filter((id) => cycles[id]).map((id) => ({ id, name: cycles[id] })));
    }
    return Promise.resolve([]);
  };
  return { sql: sql as never, events };
}

const base: TaskActivityRow = {
  title: "Ship the board", notes: null, status: "open", priority: "normal",
  due_at: null, container_label: null, assignee: null, cycle_id: null,
  archived_at: null,
};
const withRow = (patch: Partial<TaskActivityRow>): TaskActivityRow => ({ ...base, ...patch });

test("a status change is recorded — the drag-drop the board is built around", async () => {
  const { sql, events } = stubSql();
  await recordTaskChanges(sql, ctx, "t1", base, withRow({ status: "in_progress" }));
  assert.deepEqual(events, ["Status changed open → in_progress"]);
});

test("a patch that changes nothing records nothing", async () => {
  const { sql, events } = stubSql();
  await recordTaskChanges(sql, ctx, "t1", base, withRow({}));
  assert.deepEqual(events, []);
});

test("several fields in one patch produce one sentence each", async () => {
  const { sql, events } = stubSql();
  await recordTaskChanges(
    sql, ctx, "t1", base,
    withRow({ status: "blocked", priority: "high", assignee: "kim@example.com" }),
  );
  assert.deepEqual(events, [
    "Status changed open → blocked",
    "Priority changed normal → high",
    "Assignee changed — → kim@example.com",
  ]);
});

test("a sprint move names the sprints rather than their uuids", async () => {
  const { sql, events } = stubSql({ "c-1": "Sprint 4", "c-2": "Sprint 5" });
  await recordTaskChanges(sql, ctx, "t1", withRow({ cycle_id: "c-1" }), withRow({ cycle_id: "c-2" }));
  assert.deepEqual(events, ["Sprint changed Sprint 4 → Sprint 5"]);
});

test("notes say that they changed, not the whole new body", async () => {
  const { sql, events } = stubSql();
  await recordTaskChanges(sql, ctx, "t1", base, withRow({ notes: "a".repeat(4000) }));
  assert.deepEqual(events, ["Notes edited"]);
});

test("a due date reads as a date, not a timestamp", async () => {
  const { sql, events } = stubSql();
  await recordTaskChanges(sql, ctx, "t1", base, withRow({ due_at: new Date("2026-09-01T13:45:00Z") }));
  assert.deepEqual(events, ["Due date changed — → 2026-09-01"]);
});

test("archiving and restoring are both recorded", async () => {
  const archived = withRow({ archived_at: new Date("2026-08-19") });
  const a = stubSql();
  await recordTaskChanges(a.sql, ctx, "t1", base, archived);
  assert.deepEqual(a.events, ["Task archived"]);
  const b = stubSql();
  await recordTaskChanges(b.sql, ctx, "t1", archived, base);
  assert.deepEqual(b.events, ["Task restored"]);
});
