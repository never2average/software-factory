// Run one of a host pack's operator scripts (mold_v0-039: the product's own commands live in its pack, never in the
// shell's package.json):
//   npm run pack:run -- <script> [args...]          e.g. npm run pack:run -- vault-sync
//   npm run pack:run -- <pack>/<script> [args...]   when two host packs have a script of that name
//   npm run pack:run                                 lists every host pack's scripts
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { hostPackDirs, hostScript } from "./lib/host-packs.js";

const [name, ...args] = process.argv.slice(2);
if (!name) {
  const packs = hostPackDirs();
  if (!packs.length) console.log("This build has no host pack, so no pack scripts.");
  for (const p of packs) console.log(`${p.id}: ${p.scripts ? readdirSync(p.scripts).filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3)).join(", ") : "(no scripts)"}`);
  process.exit(0);
}
const found = hostScript(name);
if (!found) { console.error(`No host pack of this build has a script ${JSON.stringify(name)} (npm run pack:run lists them).`); process.exit(2); }
const tsx = path.resolve(import.meta.dirname, "..", "node_modules", ".bin", "tsx");
const r = spawnSync(tsx, ["--env-file-if-exists=.env", found.file, ...args], { stdio: "inherit" });
process.exit(r.status ?? 1);
