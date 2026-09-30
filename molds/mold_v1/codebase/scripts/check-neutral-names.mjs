#!/usr/bin/env node
/**
 * check:neutral-names — the base product's role word appears only where
 * scripts/neutral-names.allow.json says it may (see scripts/lib/neutral-names.mjs
 * for the three kinds of allowance and why each exists).
 *
 *   node scripts/check-neutral-names.mjs                 the gate (CI)
 *   node scripts/check-neutral-names.mjs --report        bare-word count per file, for lowering ceilings
 *   node scripts/check-neutral-names.mjs --root <dir> --allow <file>   check another tree (the test uses this)
 */
import { join } from "node:path";
import { checkTree, readAllowList } from "./lib/neutral-names.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ROOT = opt("--root") ?? new URL("..", import.meta.url).pathname;
const ALLOW = opt("--allow") ?? join(ROOT, "scripts/neutral-names.allow.json");

const allow = readAllowList(ALLOW);
const { problems, seenContracts, baseCounts } = checkTree(ROOT, allow);

if (args.includes("--report")) {
  for (const [file, n] of [...baseCounts].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(4)}  ${file}`);
}
if (problems.length) {
  console.error(`check-neutral-names: ${problems.length} problem(s). The base product's role word is allowed only as a listed contract, under a file's ceiling, or under an exempt path.\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
const total = [...baseCounts.values()].reduce((a, b) => a + b, 0);
console.log(
  `check-neutral-names: every occurrence is accounted for: ${seenContracts.size} listed name(s) (contracts awaiting their migration, and examples), ` +
    `${total} bare-word occurrence(s) under ${baseCounts.size} file ceiling(s), ${allow.prefixes.length} exempt path(s).`,
);
