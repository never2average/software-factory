import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrder, getOrder } from "./store.js";

test("createOrder computes the total", () => {
  const o = createOrder({ customerEmail: "a@example.com", items: [{ sku: "A1", quantity: 2, unitPrice: 5 }] });
  assert.equal(o.total, 10);
  assert.deepEqual(getOrder(o.id), o);
});
