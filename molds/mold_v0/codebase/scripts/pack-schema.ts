// The JSON Schema of pack.json (mold_v0-057): written from src/pack-manifest.ts, the schema the build validates with.
//   npm run gen:pack-schema            write packs/pack.schema.json
//   npm run gen:pack-schema -- --check exit 1 when the file differs (npm run test:packs checks it too)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { packJsonSchema } from "../src/pack-manifest.js";

const FILE = path.resolve(import.meta.dirname, "..", "packs", "pack.schema.json");
const text = `${JSON.stringify(packJsonSchema(), null, 2)}\n`;
const now = existsSync(FILE) ? readFileSync(FILE, "utf8") : null;
if (process.argv.includes("--check")) {
  if (now !== text) { console.error("packs/pack.schema.json is stale: run npm run gen:pack-schema"); process.exit(1); }
  console.log("packs/pack.schema.json is current");
} else if (now !== text) { writeFileSync(FILE, text); console.log("wrote packs/pack.schema.json"); }
else console.log("packs/pack.schema.json is current");
