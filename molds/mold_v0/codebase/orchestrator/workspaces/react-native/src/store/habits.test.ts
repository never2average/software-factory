import { test } from "node:test";
import assert from "node:assert/strict";
import { HabitStore } from "./habits";

test("adds and lists habits", () => {
  const s = new HabitStore();
  s.add("Read 20 pages");
  assert.equal(s.list().length, 1);
});

test("streak counts consecutive days", () => {
  const s = new HabitStore();
  const h = s.add("Run");
  s.toggle(h.id, "2026-10-09");
  s.toggle(h.id, "2026-10-10");
  assert.equal(s.streak(h.id, "2026-10-10"), 2);
  assert.equal(s.streak(h.id, "2026-10-11"), 2);
});
