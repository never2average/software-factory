// mold_v0-300: a status chart is coloured by its values' badge tones (web/src/features/tabs/charts.tsx enumTones), the
// run statuses as their ToneBadge reads them, an area's enum by its header badges' colours; anything else (a field that
// no toned enum fits, two that fit and disagree) keeps the categorical palette. Run from the web folder's tsconfig:
//   npx tsx --tsconfig web/tsconfig.json scripts/chart-tones-test.ts
import assert from "node:assert/strict";
// Imported at run time so the scripts typecheck (no JSX there) never reads the console component.
const { enumTones } = (await import("../web/src/features/tabs/charts" + ".js")) as { enumTones: (keys: (string | null)[], areas?: unknown[]) => (string | null)[] | null };

const area = (name: string, colors: Record<string, string> | undefined, options = ["draft", "active", "closed"]) => ({
  name, label: name, fields: [{ name: "state", label: "State", type: "enum", options }], detail: { tabs: [], header: { badges: [{ field: "state", ...(colors ? { colors } : {}) }] } },
}) as never;

assert.deepEqual(enumTones(["queued", "running", "succeeded", "failed", "cancelled"], []), ["neutral", "info", "success", "danger", "warning"],
  "run statuses: as their badges (Succeeded green, Running blue, Failed red)");
assert.deepEqual(enumTones(["pass", "fail", "error"], []), ["success", "danger", "danger"], "result statuses");
assert.deepEqual(enumTones(["running", null], []), ["info", "neutral"], "the none group neutral");
assert.deepEqual(enumTones(["draft", "active", "closed"], [area("a", { active: "success", closed: "viz-7" })]), ["neutral", "success", "viz-7"],
  "an area's enum with badge colours (a value without one neutral, as its badge)");
assert.equal(enumTones(["draft", "active"], [area("a", undefined)]), null, "an enum without badge colours: the palette");
assert.equal(enumTones(["web", "api"], [area("a", { active: "success" })]), null, "values no toned enum has: the palette");
assert.equal(enumTones(["draft", "active"], [area("a", { active: "success" }), area("b", { active: "danger" })]), null, "two fitting enums that disagree: the palette");
assert.deepEqual(enumTones(["draft", "active"], [area("a", { active: "success" }), area("b", { active: "success" })]), ["neutral", "success"], "two that agree: their tones");
console.log("chart-tones-test: ok");
