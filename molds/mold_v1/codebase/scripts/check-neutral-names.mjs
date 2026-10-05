#!/usr/bin/env node
/**
 * check:neutral-names — the base product's role word appears only where
 * scripts/neutral-names.allow.json says it may (see scripts/lib/neutral-names.mjs
 * for the three kinds of allowance and why each exists), and its record words
 * (customer, deployment, implementation, rollout) are written as prose in base
 * text only under a per-file ceiling (scripts/lib/record-words.mjs), and no data-room
 * folder name is spelled in base code at all: the names are the deployment
 * profile's (scripts/lib/stored-folders.mjs). And base code ships no workflow and no recipe of its own: a workspace's
 * library is the deployment profile's (scripts/lib/builtin-library.mjs).
 *
 *   node scripts/check-neutral-names.mjs                 the gate (CI)
 *   node scripts/check-neutral-names.mjs --report        bare-word count per file, for lowering ceilings
 *   node scripts/check-neutral-names.mjs --records [prefix] [--lines]
 *                                                        the record words still written as prose, per file (and line)
 *   node scripts/check-neutral-names.mjs --folders [prefix] [--lines]
 *                                                        the stored folder names spelled in base code, per file (and line)
 *   node scripts/check-neutral-names.mjs --root <dir> --allow <file>   check another tree (the test uses this)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkTree, readAllowList } from "./lib/neutral-names.mjs";
import { checkRecordWords, readRecordAllow } from "./lib/record-words.mjs";
import { checkStoredFolders, readFolderAllow, storedFolderNames } from "./lib/stored-folders.mjs";
import { checkBuiltinLibrary, readLibraryAllow } from "./lib/builtin-library.mjs";

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

// The data-room folder names (the former ones and the default profile's) spelled anywhere in base code.
const folderNames = storedFolderNames(ROOT);
const folders = checkStoredFolders(ROOT, readFolderAllow(JSON.parse(readFileSync(ALLOW, "utf8"))), folderNames);

// A workflow or recipe library in base code, and every file that writes one into a workspace.
const library = checkBuiltinLibrary(ROOT, readLibraryAllow(JSON.parse(readFileSync(ALLOW, "utf8"))));

if (args.includes("--folders")) {
  const only = opt("--folders");
  for (const [file, hits] of [...folders.hits].sort((a, b) => b[1].length - a[1].length)) {
    if (only && !only.startsWith("--") && !file.startsWith(only)) continue;
    console.log(`${String(hits.length).padStart(4)}  ${file}`);
    if (args.includes("--lines")) for (const h of hits) console.log(`        ${h.line || h.at}: [${h.kind} ${h.name}] ${h.text}`);
  }
}
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
if (folders.problems.length) {
  console.error(`${problems.length || records.problems.length ? "\n" : ""}check-neutral-names: ${folders.problems.length} stored-folder problem(s). A data-room folder's name is the deployment profile's (dataroom.domains.<id>.folder): base code builds a path from FOLDER.<id> and base text writes {folder:<id>}, so a deployment that pins the names it already has keeps every file where it is. What remains is held by a per-file ceiling (stored_folders in scripts/neutral-names.allow.json).\n`);
  for (const p of folders.problems) console.error(`  - ${p}`);
}
if (library.problems.length) {
  console.error(`${problems.length || records.problems.length || folders.problems.length ? "\n" : ""}check-neutral-names: ${library.problems.length} built-in-library problem(s). Base code ships no workflow and no recipe of its own: what a workspace is provisioned with is the deployment profile's (library.sources in profiles/*.json), so a deployment for another line of work is never handed the first product's content.\n`);
  for (const p of library.problems) console.error(`  - ${p}`);
}
if (problems.length || records.problems.length || folders.problems.length || library.problems.length) process.exit(1);
const total = [...baseCounts.values()].reduce((a, b) => a + b, 0);
const recordTotal = [...records.counts.values()].reduce((a, b) => a + b, 0);
console.log(
  `check-neutral-names: every occurrence is accounted for: ${seenContracts.size} listed name(s) (contracts awaiting their migration, and examples), ` +
    `${total} bare-word occurrence(s) under ${baseCounts.size} file ceiling(s), ${allow.prefixes.length} exempt path(s).`,
);
console.log(`check-neutral-names: record words as prose in base text: ${recordTotal} under ${records.counts.size} file ceiling(s); every other scanned file carries none.`);
const folderTotal = [...folders.counts.values()].reduce((a, b) => a + b, 0);
console.log(`check-neutral-names: stored folder names (${folderNames.length} known: the former ones and the default profile's) spelled in base code: ${folderTotal} under ${folders.counts.size} file ceiling(s); every other scanned file spells none.`);
console.log(`check-neutral-names: no workflow or recipe library in base code: the default profile names no library source, no workflow script outside a library directory, no recipe literal, ${library.writers} listed writer(s) of the workflows and recipes tables.`);
