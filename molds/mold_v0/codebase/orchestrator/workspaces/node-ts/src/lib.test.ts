import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "./lib.js";

test("summarize", () => {
  assert.deepEqual(summarize([1, 2, 3]), { count: 3, min: 1, max: 3, mean: 2 });
});
