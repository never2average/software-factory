// The data-flow and residency statement as Markdown (mold_v0-050; src/data-map.ts): DATA-MAP.md at the codebase root,
// from this build's packs and the deploy facts the factory wrote (deploy-facts.json, through scripts/gen-packs.mjs). The
// factory's generators run it in the build copy after gen-packs (molds/mold_v0/mold.json packs.generators), and its
// checks with --check.
//   npx tsx scripts/data-map.ts           write DATA-MAP.md   (npm run gen:data-map)
//   npx tsx scripts/data-map.ts --check   exit 1 when DATA-MAP.md differs from the build   (npm run check:data-map)
//   --out <file>                          another file (tests)
import "../src/hosts.js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataMap, dataMapMarkdown } from "../src/data-map.js";

const argv = process.argv.slice(2);
const at = argv.indexOf("--out");
const OUT = path.resolve(at >= 0 ? argv[at + 1]! : path.join(import.meta.dirname, "..", "DATA-MAP.md"));
const text = dataMapMarkdown(dataMap());
if (argv.includes("--check")) {
  const now = (() => { try { return readFileSync(OUT, "utf8"); } catch { return null; } })();
  console.log(now === text ? "DATA-MAP.md is current" : "DATA-MAP.md is stale: run npm run gen:data-map");
  process.exit(now === text ? 0 : 1);
}
writeFileSync(OUT, text);
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
process.exit(0);
