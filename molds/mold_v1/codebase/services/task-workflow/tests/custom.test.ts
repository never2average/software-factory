import assert from "node:assert/strict";
import test from "node:test";
import { customDelta, directStatus, isRecursFromConflict } from "../lib/custom.ts";
import { errorResponse } from "../lib/http.ts";
import { taskCreateSchema, taskPatchSchema } from "../lib/types.ts";

// A task's own fields and a category-derived status (lib/custom.ts): what this service does with them, knowing no
// deployment profile. The app validated them against its definition before sending.

test("today's bodies parse exactly as before: no custom, no statusFrom", () => {
  const create = taskCreateSchema.parse({ title: "New task", createdBy: "ana@example.com" });
  assert.deepEqual(create, { title: "New task", createdBy: "ana@example.com", priority: "normal" });
  const patch = taskPatchSchema.parse({ status: "done", actor: "ana@example.com" });
  assert.deepEqual(patch, { status: "done", actor: "ana@example.com" });
});

test("custom is an object keyed by snake_case keys; null clears a key", () => {
  const p = taskPatchSchema.parse({ custom: { frequency: "Quarterly", reviewer: null } });
  assert.deepEqual(p.custom, { frequency: "Quarterly", reviewer: null });
  assert.equal(taskPatchSchema.safeParse({ custom: ["a"] }).success, false);
  assert.equal(taskPatchSchema.safeParse({ custom: { Frequency: "x" } }).success, false);
  assert.equal(taskPatchSchema.safeParse({ custom: { notes: "x".repeat(70_000) } }).success, false);
});

test("statusFrom: category needs the status, one of the six", () => {
  assert.equal(taskPatchSchema.safeParse({ statusFrom: "category" }).success, false);
  assert.equal(taskPatchSchema.safeParse({ statusFrom: "category", status: "waiting" }).success, false);
  assert.equal(taskPatchSchema.safeParse({ statusFrom: "stage", status: "open" }).success, false);
  assert.deepEqual(taskCreateSchema.parse({ title: "x", status: "open", statusFrom: "category", custom: { state: "not_started" } }).custom, { state: "not_started" });
});

test("the per-key delta: values set, nulls clear, nothing is nothing", () => {
  assert.deepEqual(customDelta({ a: 1, b: null, c: "x" }), { set: { a: 1, c: "x" }, clear: ["b"] });
  assert.equal(customDelta({}), undefined);
  assert.equal(customDelta(undefined), undefined);
});

test("a category-derived status: done follows it, and an earlier done time is kept", () => {
  const then = new Date("2026-10-01T00:00:00Z");
  const now = new Date("2026-10-14T00:00:00Z");
  assert.deepEqual(directStatus("done", { done: false, done_at: null }, now), { status: "done", done: true, done_at: now });
  assert.deepEqual(directStatus("done", { done: true, done_at: then }, now), { status: "done", done: true, done_at: then });
  assert.deepEqual(directStatus("in_progress", { done: true, done_at: then }, now), { status: "in_progress", done: false, done_at: null });
});

test("a second next occurrence of one task (todos_recurs_from_uidx) is a conflict, answered 409; other unique violations are not", async () => {
  assert.equal(isRecursFromConflict({ code: "23505", constraint_name: "todos_recurs_from_uidx" }), true);
  assert.equal(isRecursFromConflict({ code: "23505", constraint_name: "apps_org_starter_key_uq" }), false);
  assert.equal(isRecursFromConflict({ code: "23503", constraint_name: "todos_recurs_from_uidx" }), false);
  assert.equal(isRecursFromConflict(null), false);
  const res = errorResponse(new Error("Conflict: the task already has its next occurrence"));
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "the task already has its next occurrence" });
});
