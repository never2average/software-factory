// mold_v0-304: every key a pack may declare on a record page action (src/pack-api.ts DetailActionSchema) is a key of the
// console's type for it (web/src/features/records/detail-layout.ts DetailActionSpec). The build writes the pack's
// actions into a typed file (pack-nav.generated.ts), so a key the console's type lacks fails the app's own build
// (a start_program action's `program` did, on a deploy); this catches the drift without building an app.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DetailActionSchema } from "../src/pack-api.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(path.join(ROOT, "web", "src", "features", "records", "detail-layout.ts"), "utf8");
const body = /export interface DetailActionSpec \{([\s\S]*?)\n\}/.exec(src)?.[1];
assert.ok(body, "detail-layout.ts declares DetailActionSpec");
const typed = new Set([...body.replace(/\/\*\*[\s\S]*?\*\//g, "").matchAll(/([a-z_]+)\??:/g)].map((m) => m[1]));
const declared = Object.keys(DetailActionSchema.shape);
const missing = declared.filter((k) => !typed.has(k));
assert.deepEqual(missing, [], `DetailActionSpec lacks keys a pack may declare: ${missing.join(", ")}`);
console.log(`✓ the console's page action type has every key a pack may declare (${declared.length})`);
console.log("detail-action-keys: ok");
