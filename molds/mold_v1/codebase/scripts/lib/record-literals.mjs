/**
 * THE RECORD-WORD AUDIT: no text the product writes outside the agent spells a record word.
 *
 * The base product's records have stored names (the account's, the two record areas', the second area's group:
 * RECORD_WORDS below). Identifiers keep them for good: a column, an API key, a route, a data-room folder, an enum
 * value. TEXT never does: a sentence takes the word from the deployment profile (`W` in lib/ui-words.ts, or a
 * `{account}` placeholder filled by agent/lib/agent-vocabulary.ts), so the default profile's neutral words and a
 * pack's own words both come out right.
 *
 * check:ui-vocabulary's source pass reads what its heuristics call visible (text with a space in it once trimmed, a
 * visible attribute or key) in app/, components/ and lib/. It did not see `Customer ${id} updated` (an audit event:
 * "Customer " has no inner space), ` deployments, ` (a prompt's totals line), text handed to speak() (translated only
 * under a relabelling profile, so the default deployment read the stored word), or anything a seeder writes. This
 * audit reads EVERY string literal, template piece and JSX text of those folders and of the seeders, whatever its
 * shape or destination, and sorts each one that carries a record word:
 *
 *   - PROSE: the literal has white space in it and a record word stands in it as a word (not inside a key, a path,
 *     a `code span`, a {placeholder} or a dotted name). It must be on an allow-list, with the reason a person never
 *     reads it as the product's own sentence.
 *   - A TOKEN: the literal is one run with no white space. It is a contract (a key, a code value, a route, a stored
 *     folder) and must be on an allow-list too, so a new label written as a bare word ("Customer") is noticed.
 *   - DEFAULT-WORD PROSE: the literal spells one of the DEFAULT profile's words for a record ("account", "delivery",
 *     "project", "plan") in a sentence, or is that word alone, capitalised (a label: "Accounts"). The default profile
 *     is a profile: where the word means the record the sentence takes it from `W`; where it is ordinary English (a
 *     Google account, plan mode, a code project, a message's delivery) the allow-list says so.
 *
 * The allow-lists are scripts/fixtures/ui-vocabulary/allow.json (the gate's own: code values, keys, routes, stored
 * names) and scripts/fixtures/ui-vocabulary/record-literals.allow.json (this audit's: what the gate never read
 * because it is server-side or a seeder). Same shape: { source, literal, why }.
 *
 * Pure but for reading files: scripts/test-ui-vocabulary.mjs calls it; `node scripts/lib/record-literals.mjs` prints
 * the count per file (and `--list` every literal with its class).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/** The stored names of the base product's records (singular, plural), by the key `W` in lib/ui-words.ts has for each. */
export const STORED_RECORDS = {
  account: ["customer", "customers"],
  deployment: ["deployment", "deployments"],
  implementation: ["implementation", "implementations"],
  rollout: ["rollout", "rollouts"],
};
/** The same, as whole tokens (lower case). */
export const RECORD_WORDS = new Set(Object.values(STORED_RECORDS).flat());

/** The folders whose every source file is read, and the seeders. */
export const UI_DIRS = ["app", "components", "lib"];
/** The agent's person-facing HTML reports (the same file check:ui-vocabulary reads). */
export const REPORTS = ["agent/lib/render-html.ts"];
export const SEEDERS = ["scripts/seed-dataroom-blob.mjs", "scripts/seed-dataroom.ts", "scripts/seed-inbox-samples.mjs", "scripts/seed-ops.mjs", "scripts/seed-postgres.ts"];

const HUMP = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;
/** Record words in a text, where `_`, `-`, `/`, `.` and a camelCase hump are boundaries too (the gate's rule). */
export function recordTokens(text) {
  const found = [];
  for (const m of String(text).matchAll(/[A-Za-z0-9]+/g)) for (const p of m[0].split(HUMP)) if (RECORD_WORDS.has(p.toLowerCase())) found.push(p);
  return found;
}

/**
 * Record words that stand in a sentence AS WORDS. What is code inside prose is put aside first: a `code span`, a
 * {placeholder}, a quoted "identifier", and any run glued by `_`, `/`, `.`, `:`, `(`, or a camelCase hump (a key, a
 * path, a dotted name, a call). A hyphen does not make code: "Customer-managed" is prose.
 */
export function recordProseWords(text, words = RECORD_WORDS) {
  const prose = String(text)
    .replace(/`{3,}/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\{[^{}\s]*\}/g, " ")
    .replace(/\\?"[A-Za-z0-9_.]+\\?"/g, " ")
    .split(/\s+/)
    .filter((run) => !/[_/:(=]/.test(run) && !/[A-Za-z0-9]\.[A-Za-z0-9]/.test(run) && !/[a-z0-9][A-Z]/.test(run));
  return prose.flatMap((run) => [...run.matchAll(/[A-Za-z0-9]+/g)].map((m) => m[0])).filter((w) => words.has(w.toLowerCase()));
}

/**
 * The DEFAULT profile's own words for the records (profiles/00-default.json: "account", "delivery", "project",
 * "plan"), lower case, less any that is a stored name. They are profile words like any pack's: a sentence that
 * spells one reads wrong in a deployment whose profile says "company", so it takes `W.account` too. They are also
 * ordinary English ("a Google account", "plan mode", "this project's environment"), which is what the allow-list
 * is for.
 */
export function defaultRecordWords(root) {
  const p = JSON.parse(readFileSync(join(root, "profiles/00-default.json"), "utf8"));
  const pairs = [p.vocabulary.account, p.domains.deployments.label, p.domains.implementations.label, p.domains.implementations.group_label];
  return new Set(pairs.flatMap((x) => [x.singular, x.plural]).map((w) => String(w).trim().toLowerCase()).filter((w) => w && !/\s/.test(w) && !RECORD_WORDS.has(w)));
}

function loadAllow(file) {
  const list = JSON.parse(readFileSync(file, "utf8"));
  return list.map((a, i) => {
    if (typeof a?.why !== "string" || a.why.trim().length < 12) throw new Error(`${file}[${i}]: every allowance says why`);
    if (typeof a.literal !== "string") throw new Error(`${file}[${i}]: "literal" (a regex over the text) is required`);
    return { source: new RegExp(a.source ?? ".*"), literal: new RegExp(a.literal), why: a.why, file, index: i, used: 0 };
  });
}

const sourceFiles = (root, target) => {
  const abs = join(root, target);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [abs];
  return readdirSync(abs).flatMap((n) => (n === "node_modules" ? [] : sourceFiles(root, join(target, n)))).filter((f) => /\.(tsx?|mts|mjs)$/.test(f) && !/\.d\.ts$/.test(f));
};

/**
 * Every literal of `targets` (folders or files under `root`) that carries a record word:
 * { source, line, text, kind: "prose" | "token", words, allowed }.
 * `own` is this audit's allow-list file; `shared` the gate's. Both are optional (a fixture is audited with neither).
 */
export function auditRecordLiterals(root, { targets = [...UI_DIRS, ...SEEDERS, ...REPORTS], shared = join(root, "scripts/fixtures/ui-vocabulary/allow.json"), own = join(root, "scripts/fixtures/ui-vocabulary/record-literals.allow.json"), defaultWords = true } = {}) {
  const ts = createRequire(join(root, "package.json"))("typescript");
  const allow = [...(own && existsSync(own) ? loadAllow(own) : []), ...(shared && existsSync(shared) ? loadAllow(shared) : [])];
  const defaults = defaultWords ? defaultRecordWords(root) : new Set();
  const out = [];
  const push = (rel, sf, n, text, kind, words, lists) => {
    const flat = text.replace(/\s+/g, " ");
    const a = lists.find((e) => e.source.test(rel) && (e.literal.test(text) || e.literal.test(flat) || e.literal.test(flat.trim())));
    if (a) a.used++;
    out.push({ source: rel, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: flat, kind, words, allowed: Boolean(a) });
  };
  for (const file of targets.flatMap((t) => sourceFiles(root, t))) {
    const rel = relative(root, file);
    // The profile's own words (the generated profile, the generated roster built from it) are the deployment's.
    if (rel.endsWith(".generated.ts")) continue;
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n) => {
      let text = null;
      if (ts.isJsxText(n)) text = n.text;
      else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
        const inImport = ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent) || (ts.isCallExpression(n.parent) && n.parent.expression.kind === ts.SyntaxKind.ImportKeyword);
        const isKey = (ts.isPropertyAssignment(n.parent) || ts.isPropertySignature(n.parent)) && n.parent.name === n;
        if (!inImport && !isKey && !ts.isLiteralTypeNode(n.parent)) text = n.text;
      }
      if (text && recordTokens(text).length) {
        const prose = /\s/.test(text);
        const words = prose ? recordProseWords(text) : recordTokens(text);
        if (words.length) push(rel, sf, n, text, prose ? "prose" : "token", words, allow);
      }
      // The default profile's words: in a sentence, or alone and capitalised (a label). Only this audit's own list
      // can excuse one: the gate's list was written when these words were nobody's.
      if (text && defaults.size) {
        const words = /\s/.test(text.trim()) ? recordProseWords(text, defaults) : /^[A-Z][a-z]+$/.test(text.trim()) && defaults.has(text.trim().toLowerCase()) ? [text.trim()] : [];
        if (words.length) push(rel, sf, n, text, "default", words, allow.filter((e) => e.file === own));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { literals: out, unused: allow.filter((e) => e.file === own && e.used === 0).map((e) => `${relative(root, e.file)}[${e.index}] /${e.literal.source}/`) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const { literals, unused } = auditRecordLiterals(root);
  const by = new Map();
  for (const l of literals) by.set(l.source, [...(by.get(l.source) ?? []), l]);
  for (const [source, list] of [...by].sort()) {
    const bad = list.filter((l) => !l.allowed);
    console.log(`${String(list.length).padStart(4)}  ${source}${bad.length ? `   (${bad.length} NOT ALLOWED)` : ""}`);
    if (process.argv.includes("--list") || bad.length) for (const l of process.argv.includes("--list") ? list : bad) console.log(`        ${l.allowed ? "ok " : "BAD"} ${l.kind.padEnd(7)} :${l.line} ${JSON.stringify(l.text.slice(0, 150))}`);
  }
  const bad = literals.filter((l) => !l.allowed);
  const stored = literals.filter((l) => l.kind !== "default");
  console.log(`\n${stored.length} literals carry a record's stored name in ${new Set(stored.map((l) => l.source)).size} files: ${stored.filter((l) => l.kind === "token").length} tokens (contracts), ${stored.filter((l) => l.kind === "prose").length} prose. ${literals.length - stored.length} spell a default-profile word as prose or as a label. ${bad.length} not allowed.`);
  if (unused.length) console.log(`unused allowances:\n  ${unused.join("\n  ")}`);
  process.exitCode = bad.length ? 1 : 0;
}
