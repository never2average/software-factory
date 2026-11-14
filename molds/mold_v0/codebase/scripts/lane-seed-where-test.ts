// mold_v0-300: the lane world's seed (molds/mold_v0/testing/console/seed.mts) names, in a reference with a `where`,
// only a record that `where` keeps (the server's own test, conditionHolds), and leaves an optional one empty when none does.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { conditionHolds } from "../src/pack-api.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const seed = await import(pathToFileURL(path.join(ROOT, "..", "testing", "console", "seed.mts")).href);

const rows: Record<string, Record<string, unknown>> = {
  "items-1": { kind: "alpha" }, "items-2": { kind: "beta" }, "items-3": { kind: "alpha" }, "items-4": { kind: "beta" },
};
const keysOf = (area: string, where?: unknown) =>
  area !== "items" ? [] : Object.keys(rows).filter((k) => !where || conditionHolds(where as never, rows[k]!));
const ref = { name: "item", type: "reference", to: "items", required: true, where: { field: "kind", equals: "beta" } };
for (let n = 0; n < 6; n++) {
  const v = seed.valueOf(ref, n, 0, keysOf, () => null, "orders");
  assert.equal(rows[v as string]?.kind, "beta", `sample ${n}: a reference limited to one kind names a record of that kind (got ${v})`);
}
assert.equal(seed.valueOf({ ...ref, where: { field: "kind", equals: "gamma" } }, 0, 0, keysOf, () => null, "orders"), undefined,
  "a where that keeps no record leaves the field empty (seedWorkspace then skips the area when it is required)");
assert.ok(["items-1", "items-2", "items-3", "items-4"].includes(seed.valueOf({ ...ref, where: undefined }, 1, 0, keysOf, () => null, "orders") as string),
  "no where: any record");
// A link field has no where: it is passed none.
let seen: unknown = "unset";
seed.valueOf({ name: "items", type: "link", to: "items", where: { field: "kind", equals: "beta" } }, 0, 0, (_a: string, w?: unknown) => { seen = w; return ["items-1"]; }, () => null);
assert.equal(seen, undefined, "a link field is not filtered");
console.log("lane-seed-where-test: ok");
