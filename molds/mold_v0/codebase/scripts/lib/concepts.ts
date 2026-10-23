// The concept-word ratchet (mold_v0-100; scripts/check-vocabulary.ts runs it, scripts/vocabulary-test.ts proves it):
// the first product's CONCEPTS (simulation, scenario, pick rate ...: scripts/vocabulary.json `concepts.words`) as
// PROSE in the shell's base text. Base text writes a placeholder the build's words fill ({run}, {Runs}: src/words.ts,
// src/vocabulary.ts, web/src/lib/vocabulary.ts) or leaves the concept to the host pack that has it.
//
// Text is what code hands to a reader: a string literal, a template literal's text or JSX text of a source file
// (comments, identifiers, imports and regular expressions are not). Inside that text a word counts only as prose:
//   - not part of an identifier or a path (`simulation_id`, `run_simulation`, `simulationId`, `/simulations/`,
//     `simulations.created_by`, `simulations(`);
//   - not in SQL (a text with an upper-case SQL keyword or a `/* tenant:` note): table and column names are storage;
//   - not inside a `code span` or a placeholder (`{run}`);
//   - not a one-token lower-case text ("simulation": a kind, a key or a table name); a capitalised one ("Simulations")
//     is a label and counts.
// Each file that still carries one has a CEILING in a group that says why it remains and how it goes (`migration`).
// More fails; fewer fails too, with the number to lower it to; a ceiling on a file that carries none fails.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { globRe, listFiles } from "./vocabulary.js";

export interface CeilingGroup { why: string; migration: string; files: Record<string, number> }
export interface Concepts { $comment?: string; words: string[]; scan: string[]; skip: Record<string, string>; ceilings: Record<string, CeilingGroup> }
export interface ConceptHit { file: string; line: number; word: string; text: string }
export interface ConceptReport { hits: ConceptHit[]; problems: string[]; counts: Record<string, number>; scanned: number }

/**
 * The TypeScript compiler (parse only): the console's copy (web/node_modules; the root has the native compiler, which
 * has no API and no types for one, hence the loose type).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ts = any;
type TsNode = Ts;
function loadTs(root: string): Ts {
  for (const from of [path.join(root, "web", "package.json"), path.join(root, "package.json")]) {
    try { const ts = createRequire(from)("typescript"); if (typeof ts.createSourceFile === "function") return ts; } catch { /* next */ }
  }
  throw new Error("the concept check parses with the TypeScript compiler API: run npm --prefix web ci");
}

const SQL = /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|WITH|FROM|JOIN|WHERE|GROUP BY|ORDER BY|RETURNING|CASE|WHEN|THEN)\b|\/\* tenant:/;
const ONE_TOKEN = /^[A-Za-z0-9_\-./:$#@[\]{}<>*]+$/;

/** The concept words found as prose in one piece of text. */
export function proseHits(text: string, words: string[]): string[] {
  if (!text.trim() || SQL.test(text)) return [];
  const t = text.trim();
  if (ONE_TOKEN.test(t) && !/^[A-Z]/.test(t)) return [];
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  const clean = text.replace(/`[^`\n]+`/g, blank).replace(/\$?\{[A-Za-z0-9_.:\- ]*\}/g, blank);
  const out: string[] = [];
  for (const w of words) {
    const stem = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[ -]");
    // An acronym (APO) is matched in its own capitals only; a word in any case.
    const re = new RegExp(`(?<![A-Za-z0-9_./:&\\\\-])(${stem})(?:s|es)?(?![A-Za-z0-9_/(=]|[.:-][A-Za-z0-9_])`, /^[A-Z]{2,}$/.test(w) ? "g" : "gi");
    for (const m of clean.matchAll(re)) {
      // camelCase or snake_case around it is an identifier: simulationId, Simulation_id
      if (/[a-z][A-Z]/.test(clean.slice(Math.max(0, m.index! - 1), m.index! + m[0].length + 1))) continue;
      out.push(w);
    }
  }
  return out;
}

/** Every concept word written as prose in the scanned files, and how the counts meet the ceilings. */
export function checkConcepts(root: string, c: Concepts, only?: (rel: string) => boolean): ConceptReport {
  const ts = loadTs(root);
  const scan = c.scan.map(globRe), skip = Object.keys(c.skip).map(globRe);
  const hits: ConceptHit[] = [];
  let scanned = 0;
  for (const rel of listFiles(root)) {
    if (!scan.some((r) => r.test(rel)) || skip.some((r) => r.test(rel)) || (only && !only(rel))) continue;
    scanned++;
    const src = readFileSync(path.join(root, rel), "utf8");
    const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const add = (node: TsNode, text: string) => {
      for (const word of proseHits(text, c.words))
        hits.push({ file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, word, text: text.trim().replace(/\s+/g, " ").slice(0, 140) });
    };
    const visit = (node: TsNode): void => {
      if (ts.isTaggedTemplateExpression(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isRegularExpressionLiteral(node)) return;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        // a module specifier, a property key or an enum-like comparison is a name, not text
        const p = node.parent;
        if (!(p && (ts.isPropertyAssignment(p) && p.name === node || ts.isLiteralTypeNode(p) || ts.isExternalModuleReference(p)))) add(node, node.text);
      } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) add(node, node.text);
      else if (ts.isJsxText(node)) add(node, node.text);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const counts: Record<string, number> = {};
  for (const h of hits) counts[h.file] = (counts[h.file] ?? 0) + 1;
  const ceiling = new Map<string, number>();
  for (const g of Object.values(c.ceilings)) for (const [f, n] of Object.entries(g.files)) ceiling.set(f, n);
  const problems: string[] = [];
  for (const [f, n] of Object.entries(counts)) {
    const max = ceiling.get(f) ?? 0;
    if (n > max) problems.push(`${f}: ${n} concept word(s) as prose, ceiling ${max}: write a placeholder ({run}, {Runs}: src/words.ts) or leave the concept to its host pack\n    ${hits.filter((h) => h.file === f).map((h) => `${h.line}: ${h.word}: ${h.text}`).join("\n    ")}`);
    else if (n < max) problems.push(`${f}: ${n} concept word(s) as prose, below its ceiling ${max}: lower the ceiling in scripts/vocabulary.json to ${n}`);
  }
  for (const [f, max] of ceiling) if (!counts[f] && (!only || only(f))) problems.push(`${f}: carries no concept word any more: remove its ceiling (${max}) from scripts/vocabulary.json`);
  return { hits, problems, counts, scanned };
}
