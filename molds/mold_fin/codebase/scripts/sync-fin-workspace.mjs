#!/usr/bin/env node
// Copies the shared Python helpers (scripts/fin-workspace/finlib) into every finance subagent's seeded sandbox
// workspace. eve scopes a sandbox per subagent and has no shared-workspace mechanism, so each subagent carries
// its own copy; this script is the only writer of those copies. `--check` exits 1 when a copy has drifted.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "scripts/fin-workspace/finlib");
export const FIN_SUBAGENTS = ["hfc-kpi-extraction", "lodr-filings", "investor-presentations", "annual-report-format"];
const check = process.argv.includes("--check");

function files(dir, base = dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "__pycache__" || n.endsWith(".pyc")) return [];
    return statSync(p).isDirectory() ? files(p, base) : [relative(base, p)];
  }).sort();
}

let drift = 0;
for (const key of FIN_SUBAGENTS) {
  const dest = join(root, "agent/subagents", key, "sandbox/workspace/scripts/finlib");
  if (check) {
    const want = files(SRC), have = existsSync(dest) ? files(dest) : [];
    const bad = want.filter((f) => !have.includes(f) || readFileSync(join(SRC, f), "utf8") !== readFileSync(join(dest, f), "utf8"))
      .concat(have.filter((f) => !want.includes(f)));
    if (bad.length) { drift++; console.error(`${key}: finlib differs from scripts/fin-workspace/finlib (${bad.join(", ")}) — run: npm run sync:fin-workspace`); }
    continue;
  }
  rmSync(dest, { recursive: true, force: true });
  cpSync(SRC, dest, { recursive: true, filter: (p) => !p.includes("__pycache__") && !p.endsWith(".pyc") });
  console.log(`synced finlib -> agent/subagents/${key}/sandbox/workspace/scripts/finlib`);
}
if (check) { if (drift) process.exit(1); console.log("fin-workspace: every copy matches"); }
