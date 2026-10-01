#!/usr/bin/env node
/**
 * check:neutral-names — the base product's role word appears only where
 * scripts/neutral-names.allow.json says it may (see scripts/lib/neutral-names.mjs
 * for the three kinds of allowance and why each exists), and its record words
 * (customer, deployment, implementation, rollout) are written as prose in base
 * text only under a per-file ceiling (scripts/lib/record-words.mjs).
 *
 *   node scripts/check-neutral-names.mjs                 the gate (CI)
 *   node scripts/check-neutral-names.mjs --report        bare-word count per file, for lowering ceilings
 *   node scripts/check-neutral-names.mjs --records [prefix] [--lines]
 *                                                        the record words still written as prose, per file (and line)
 *   node scripts/check-neutral-names.mjs --root <dir> --allow <file>   check another tree (the test uses this)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkTree, readAllowList } from "./lib/neutral-names.mjs";
import { checkRecordWords, readRecordAllow } from "./lib/record-words.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ROOT = opt("--root") ?? new URL("..", import.meta.url).pathname;
const ALLOW = opt("--allow") ?? join(ROOT, "scripts/neutral-names.allow.json");

const allow = readAllowList(ALLOW);
const { problems, seenContracts, baseCounts } = checkTree(ROOT, allow);

// The record words (customer, deployment, implementation, rollout) written as prose in base text.
const recordAllow = readRecordAllow(JSON.parse(readFileSync(ALLOW, "utf8")));
const records = checkRecordWords(ROOT, recordAllow);

if (args.includes("--report")) {
  for (const [file, n] of [...baseCounts].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(4)}  ${file}`);
}
if (args.includes("--records")) {
  // Every prose record word, by file: what to turn into a placeholder (or a word from lib/ui-words.ts) next.
  const only = opt("--records");
  for (const [file, hits] of [...records.hits].sort((a, b) => b[1].length - a[1].length)) {
    if (only && !only.startsWith("--") && !file.startsWith(only)) continue;
    console.log(`${String(hits.length).padStart(4)}  ${file}`);
    if (args.includes("--lines")) for (const h of hits) console.log(`        ${h.line || h.at}: [${h.word}] ${h.text}`);
  }
}
if (problems.length) {
  console.error(`check-neutral-names: ${problems.length} problem(s). The base product's role word is allowed only as a listed contract, under a file's ceiling, or under an exempt path.\n`);
  for (const p of problems) console.error(`  - ${p}`);
}
if (records.problems.length) {
  console.error(`${problems.length ? "\n" : ""}check-neutral-names: ${records.problems.length} record-word problem(s). Base text writes a placeholder the deployment profile fills, never a record word (customer, deployment, implementation, rollout); what remains is held by a per-file ceiling (record_words in scripts/neutral-names.allow.json).\n`);
  for (const p of records.problems) console.error(`  - ${p}`);
}
if (problems.length || records.problems.length) process.exit(1);
const total = [...baseCounts.values()].reduce((a, b) => a + b, 0);
const recordTotal = [...records.counts.values()].reduce((a, b) => a + b, 0);
console.log(
  `check-neutral-names: every occurrence is accounted for: ${seenContracts.size} listed name(s) (contracts awaiting their migration, and examples), ` +
    `${total} bare-word occurrence(s) under ${baseCounts.size} file ceiling(s), ${allow.prefixes.length} exempt path(s).`,
);
console.log(`check-neutral-names: record words as prose in base text: ${recordTotal} under ${records.counts.size} file ceiling(s); every other scanned file carries none.`);
