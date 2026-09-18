#!/usr/bin/env node
// Copies each shared helper family (scripts/subagent-shared/<family>/) into the seeded sandbox workspace of every
// subagent its targets.json names. See scripts/subagent-shared/README.md. `--check` exits 1 on drift.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = join(root, "scripts/subagent-shared");
const check = process.argv.includes("--check");
const skip = (p) => p.includes("__pycache__") || p.endsWith(".pyc") || p.endsWith("targets.json");

function files(dir, base = dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (skip(p)) return [];
    return statSync(p).isDirectory() ? files(p, base) : [relative(base, p)];
  }).sort();
}

const families = existsSync(SHARED)
  ? readdirSync(SHARED).filter((n) => statSync(join(SHARED, n)).isDirectory())
  : [];
let problems = 0;
for (const family of families) {
  const src = join(SHARED, family);
  let targets;
  try {
    targets = JSON.parse(readFileSync(join(src, "targets.json"), "utf8")).subagents;
    if (!Array.isArray(targets) || targets.some((t) => typeof t !== "string")) throw new Error('"subagents" must be a list of keys');
  } catch (error) {
    console.error(`scripts/subagent-shared/${family}/targets.json: ${error.message}`);
    problems++;
    continue;
  }
  for (const key of targets) {
    if (!existsSync(join(root, "agent/subagents", key, "agent.ts"))) {
      console.error(`${family}: target subagent "${key}" does not exist under agent/subagents/`);
      problems++;
      continue;
    }
    const dest = join(root, "agent/subagents", key, "sandbox/workspace/scripts", family);
    if (check) {
      const want = files(src), have = existsSync(dest) ? files(dest) : [];
      const bad = want
        .filter((f) => !have.includes(f) || readFileSync(join(src, f), "utf8") !== readFileSync(join(dest, f), "utf8"))
        .concat(have.filter((f) => !want.includes(f)));
      if (bad.length) {
        problems++;
        console.error(`${key}: ${family} differs from scripts/subagent-shared/${family} (${bad.join(", ")}) — run: npm run sync:subagent-shared`);
      }
      continue;
    }
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true, filter: (p) => !skip(p) });
    console.log(`synced ${family} -> agent/subagents/${key}/sandbox/workspace/scripts/${family}`);
  }
}
if (problems) process.exit(1);
if (check) console.log(`subagent-shared: ${families.length} famil${families.length === 1 ? "y" : "ies"}, every copy matches`);
