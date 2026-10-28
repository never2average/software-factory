// The shell's vocabulary check (mold_v0-045, 100). Fails when a product word (scripts/vocabulary.json `words`) is in a
// file of the shell, in its text or its path, outside the allow list (each entry an exact spelling, the files it may be
// in, and what holds it), or when an allow entry covers nothing. A pack's own files are not read, nor, in a build with
// packs, the files generated from them. In the factory's checkout (../MOLD.md beside the codebase) it also checks the
// generated table of env names (old -> new) in MOLD.md, and fails on a placeholder written with its article inside the
// braces (the words engine fills a bare key, with the article before it: "an {account}"; mold_v0-171). Then the concept-word ratchet (mold_v0-100, scripts/lib/concepts.ts):
// the first product's concepts (vocabulary.json `concepts.words`) as prose in base text, against each file's ceiling.
//   npm run check:vocabulary              check
//   npm run check:vocabulary -- --write   rewrite MOLD.md's table, then check
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ENV_PREFIX, LEGACY_ENV_PREFIX } from "../src/env-names.js";
import { aliasTable, checkPlaceholders, checkVocabulary, shellEnvNames, withTable, type Vocabulary } from "./lib/vocabulary.js";
import { checkConcepts, type Concepts } from "./lib/concepts.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const v = JSON.parse(readFileSync(path.join(ROOT, "scripts", "vocabulary.json"), "utf8")) as Vocabulary & { concepts: Concepts };
const r = checkVocabulary(ROOT, v);
let bad = 0;
for (const f of r.findings) { bad++; console.error(`${f.file}${f.line ? `:${f.line}` : ""}: a product word: ${f.text}`); }
for (const u of r.unused) { bad++; console.error(`scripts/vocabulary.json: ${u} covers nothing any more: remove it`); }
// A placeholder with its article inside the braces is never filled: the article goes before it (mold_v0-171).
const broken = checkPlaceholders(ROOT);
for (const f of broken) { bad++; console.error(`${f.file}:${f.line}: ${f.text} is never filled: write the article before the placeholder, outside the braces`); }

const MOLD_MD = path.join(ROOT, "..", "MOLD.md");
let table = "MOLD.md: not beside this codebase (a build copy), not checked";
if (existsSync(MOLD_MD)) {
  const md = readFileSync(MOLD_MD, "utf8");
  const names = shellEnvNames(ROOT);
  const want = withTable(md, aliasTable(names, LEGACY_ENV_PREFIX, ENV_PREFIX));
  if (want === null) { bad++; console.error("MOLD.md has no env-names table markers"); }
  else if (want !== md) {
    if (process.argv.includes("--write")) { writeFileSync(MOLD_MD, want); table = `MOLD.md: env-names table written (${names.length} names)`; }
    else { bad++; console.error("MOLD.md: the env-names table is stale: npm run check:vocabulary -- --write"); }
  } else table = `MOLD.md: env-names table current (${names.length} names)`;
}
const c = checkConcepts(ROOT, v.concepts);
for (const p of c.problems) { bad++; console.error(p); }
const carried = Object.values(c.counts).reduce((a, b) => a + b, 0);
if (bad) { console.error(`check:vocabulary: ${bad} problem(s)`); process.exit(1); }
console.log(`check:vocabulary: no product word in ${r.scanned} files outside the allow list (${v.allow.length} entries, all in use); ${table}; concept words: ${carried} as prose in ${Object.keys(c.counts).length} files, each at its ceiling (${c.scanned} files read); no placeholder with its article inside the braces`);
