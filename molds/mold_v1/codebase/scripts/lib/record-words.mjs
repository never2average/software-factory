/**
 * THE RECORD-WORD RATCHET: the base product's record words as PROSE in base text.
 *
 * The base was written for a delivery team that manages customers, their deployments and their
 * implementation rollouts. Storage keeps those names for ever (the `customers` table, `customer_id`,
 * `list_customers`, `deploymentId`): they are contracts. What a person or the model READS
 * is not a contract: base text writes a placeholder the deployment profile fills (`{account}`, `{deployment}`,
 * `{implementation}`, `{rollout}`, agent/lib/agent-vocabulary.ts), or takes the word from lib/ui-words.ts (`W`).
 *
 * This module counts every record word that still stands as a WORD in text base code hands to a reader:
 *
 *   - a string literal, a template literal's text or JSX text in a source file (comments, identifiers, import
 *     specifiers, tagged templates such as sql`…` and regular expressions are not text anyone reads);
 *   - a Markdown file (a prompt, a skill, a sandbox README);
 *   - a string value of a JSON file (the default profile); keys and `$comment`s are not read by anyone.
 *
 * and inside that text only where the word is prose, not a name:
 *
 *   - not part of an identifier or a path: `customer_id`, `customerId`, `list_customers`, a path segment,
 *     `/api/ops/customers`, `record.customer`, `customer.name`, `customers[]`, `customer:acme` (a memory scope),
 *     `customer=`, `=customers`, `customers(`, `--customer` (a command-line flag);
 *   - not written as code: inside a `code span`, or a whole quoted value ('customer', "deployments");
 *   - not a text that is ONE token (`"customers"`, `"deployment"`): a key, an enum value or a table name. A
 *     capitalised record word alone (`"Customer"`, `"Rollouts"`) IS counted: it is a label somebody reads, unless
 *     it is a listed value (names: `"\"Customer\""`, quoted);
 *   - not a listed NAME (scripts/neutral-names.allow.json `record_words.names`): a specialist's directory name
 *     (`customer-context`, `deployment`, written **deployment** or `deployment` where it is delegated to), an enum
 *     value with a hyphen (`customer-vpc`);
 *   - not inside a placeholder (`{customer}`, `{customer_id}`, `${customer}`).
 *
 * A data-room domain is never an exception. Its folder once carried a record word, and base text named the domain
 * by it ("across <the three folders>"); the folder's name is the deployment profile's now, so base text writes the
 * domain as a placeholder (`{domain:accounts}`, `{folder:accounts}/…`: agent/lib/dataroom-folders.ts) and a
 * capitalised record word in a sentence is the word, counted like any other. scripts/lib/stored-folders.mjs holds
 * the folder names themselves.
 *
 * A compound is prose: "customer-facing", "per-customer", "customer's".
 *
 * The allow-list gives every file that still carries one a CEILING, the exact count today, in a group that says
 * why. More fails (a new literal record word); fewer fails too, with the number to lower it to. A file with no
 * ceiling may carry none.
 *
 * Offline, no build. Source files are parsed with the TypeScript compiler (parse only).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { listFiles } from "./neutral-names.mjs";

const require = createRequire(import.meta.url);
let tsModule = null;
const ts = () => (tsModule ??= require("typescript"));

/** The record words, by stem. Each also matches its plural, in any case. */
export const RECORD_STEMS = ["customer", "deployment", "implementation", "rollout"];
const WORD = new RegExp(`(${RECORD_STEMS.join("|")})s?`, "gi");
const LABEL = new RegExp(`^(${RECORD_STEMS.map((s) => s[0].toUpperCase() + s.slice(1)).join("|")})s?$`);
const ONE_TOKEN = /^[A-Za-z0-9_\-./:$#@[\]{}<>*]+$/;

/**
 * Does the word at `at` open a sentence, a paragraph, a heading, a bullet or a table cell? A single newline is a
 * wrapped line (hard-wrapped Markdown), not a start.
 */
function startsSentence(text, at) {
  let i = at - 1;
  while (i >= 0 && (/[ \t*_"'(]/.test(text[i]) || (text[i] === "\n" && i > 0 && text[i - 1] !== "\n"))) i--;
  if (i < 0) return true;
  return /[\n.!?#>|:]/.test(text[i]) || ((text[i] === "-" || text[i] === "•") && (i === 0 || /[\n ]/.test(text[i - 1])));
}

/** Blank out (same length) every span a reader takes as code or as a placeholder, so offsets stay true. */
function withoutCode(text) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/`[^`\n]*`/g, blank)) // inside a fence only its own code spans
    .replace(/`[^`\n]+`/g, blank)
    .replace(/\$?\{[A-Za-z0-9_.:\- ]*\}/g, blank)
    .replace(/<[A-Za-z0-9_.:\-]+>/g, blank);
}

/**
 * The record words standing as prose in one text. `names` are whole names that are not prose where they stand
 * as a name: hyphenated ones anywhere (`customer-context`), single-word ones (`deployment`, a specialist) only
 * when written bold (`**deployment**`).
 */
export function proseRecordWords(text, names = new Set()) {
  const out = [];
  if (typeof text !== "string" || !text) return out;
  if (!/\s/.test(text.trim()) && ONE_TOKEN.test(text.trim())) {
    // One token: a key, a value, a path. Except a record word alone with a capital ("Customer", "Rollouts"): a
    // label somebody reads, unless it is a listed value.
    const one = text.trim();
    if (LABEL.test(one) && !names.has(`"${one}"`)) out.push({ word: one, index: text.indexOf(one), line: 1, text: one });
    return out;
  }
  // Listed names of more than one word ("Waiting on Customer", a stored enum value) are values wherever they stand.
  let t = withoutCode(text);
  for (const name of names) if (/\s/.test(name) && t.includes(name)) t = t.split(name).join(" ".repeat(name.length));
  for (const m of t.matchAll(WORD)) {
    const at = m.index;
    const end = at + m[0].length;
    // Neighbours are read from the text as written: a blanked placeholder is still what the word is joined to.
    const before = text[at - 1] ?? "";
    const before2 = text[at - 2] ?? "";
    const after = text[end] ?? "";
    const after2 = text[end + 1] ?? "";
    if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) continue; // part of a longer word or identifier
    if (before === "/" || after === "/") continue; // a path or a route
    if (before === "." && /[A-Za-z0-9_)\]]/.test(before2)) continue; // record.customer
    if (after === "." && /[A-Za-z_]/.test(after2)) continue; // customer.name
    if (after === "[" && after2 === "]") continue; // deployments[]
    if (after === ":" && after2 !== "" && !/\s/.test(after2)) continue; // customer:acme, customer:{id}
    if (after === "=" || after === "(" || before === "=") continue; // customer=…, customers(…), ?dataroom=customers
    if (before === "-" && before2 === "-") continue; // --customer, a command-line flag
    if ((before === '"' && after === '"') || (before === "'" && after === "'")) continue; // a quoted value
    if (before === "@" || before === "#" || before === "$") continue;
    // The whole hyphenated run this word sits in ("per-customer", "customer-context", "customer-vpc").
    let a = at;
    let b = end;
    while (a > 0 && /[A-Za-z0-9\-]/.test(text[a - 1])) a--;
    while (b < text.length && /[A-Za-z0-9\-]/.test(text[b])) b++;
    const run = text.slice(a, b).replace(/^-+|-+$/g, "");
    if (run !== m[0] && names.has(run)) continue;
    if (run === m[0] && names.has(run) && text.slice(at - 2, at) === "**" && text.slice(end, end + 2) === "**") continue;
    const line = text.lastIndexOf("\n", at - 1) + 1;
    const lineNo = text.slice(0, at).split("\n").length;
    const lineEnd = text.indexOf("\n", at);
    out.push({ word: m[0], index: at, line: lineNo, text: text.slice(line, lineEnd < 0 ? undefined : lineEnd).trim().slice(0, 160) });
  }
  return out;
}

/** The texts a source file hands to a reader: string literals, template text, JSX text. With their line. */
export function sourceTexts(path, source) {
  const T = ts();
  const kind = /\.tsx$/.test(path) ? T.ScriptKind.TSX : /\.jsx$/.test(path) ? T.ScriptKind.JSX : /\.ts$/.test(path) ? T.ScriptKind.TS : T.ScriptKind.JS;
  const sf = T.createSourceFile(path, source, T.ScriptTarget.Latest, true, kind);
  const out = [];
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node, inTagged) => {
    if (T.isImportDeclaration(node) || T.isExportDeclaration(node)) return; // module specifiers
    if (T.isTaggedTemplateExpression(node)) {
      // sql`…`, db`…`: a statement, not a sentence. Its interpolations are ordinary code.
      T.forEachChild(node.template, (c) => visit(c, true));
      return;
    }
    if (T.isCallExpression(node) && (node.expression.kind === T.SyntaxKind.ImportKeyword || (T.isIdentifier(node.expression) && node.expression.text === "require"))) return;
    if (T.isPropertyAssignment(node) && (T.isStringLiteral(node.name) || T.isNoSubstitutionTemplateLiteral(node.name))) {
      visit(node.initializer, false); // a quoted key is a key
      return;
    }
    if (T.isStringLiteral(node) || T.isNoSubstitutionTemplateLiteral(node)) {
      if (!inTagged) out.push({ line: lineOf(node), text: node.text });
      return;
    }
    if (T.isTemplateExpression(node)) {
      if (inTagged) {
        for (const span of node.templateSpans) visit(span.expression, false);
        return;
      }
      // One text: the interpolations read as a value in the sentence.
      let text = node.head.text;
      for (const span of node.templateSpans) text += "${}" + span.literal.text;
      out.push({ line: lineOf(node), text });
      for (const span of node.templateSpans) visit(span.expression, false);
      return;
    }
    if (T.isJsxText(node)) {
      out.push({ line: lineOf(node), text: node.text });
      return;
    }
    if (T.isRegularExpressionLiteral(node)) return;
    T.forEachChild(node, (c) => visit(c, false));
  };
  visit(sf, false);
  return out;
}

/** The string values of a JSON document (never a key, never a `$comment`), with their path. */
export function jsonTexts(source) {
  const out = [];
  const walk = (x, path) => {
    if (typeof x === "string") out.push({ line: 0, text: x, path });
    else if (Array.isArray(x)) x.forEach((e, i) => walk(e, `${path}[${i}]`));
    else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) if (!k.startsWith("$")) walk(v, path ? `${path}.${k}` : k);
  };
  walk(JSON.parse(source), "");
  return out;
}

/** Every prose record word in one file, by what kind of file it is. */
export function recordWordsInFile(path, source, names = new Set()) {
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) {
    return sourceTexts(path, source).flatMap((t) => proseRecordWords(t.text, names).map((h) => ({ ...h, line: t.line + h.line - 1 })));
  }
  if (/\.json$/.test(path)) return jsonTexts(source).flatMap((t) => proseRecordWords(t.text, names).map((h) => ({ ...h, line: 0, at: t.path })));
  return proseRecordWords(source, names);
}

const globToRegExp = (glob) =>
  new RegExp(
    "^" +
      glob
        .split(/(\*\*\/|\*\*|\*)/)
        .map((p) => (p === "**/" ? "(?:.*/)?" : p === "**" ? ".*" : p === "*" ? "[^/]*" : p.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
        .join("") +
      "$",
  );

/** The `record_words` section of the allow-list, validated. */
export function readRecordAllow(raw) {
  const r = raw.record_words;
  if (!r || typeof r !== "object") throw new Error('neutral-names: the allow-list has no "record_words" section');
  const list = (key) => {
    const body = r[key];
    if (!body || typeof body !== "object") throw new Error(`neutral-names: record_words.${key} is missing`);
    const entries = Object.entries(body).filter(([k]) => !k.startsWith("$"));
    for (const [k, why] of entries) if (typeof why !== "string" || !why.trim()) throw new Error(`neutral-names: record_words.${key}["${k}"] needs a reason`);
    return entries.map(([k]) => k);
  };
  const scan = list("scan");
  const skip = list("skip");
  const names = new Set(list("names"));
  if (!scan.length) throw new Error("neutral-names: record_words.scan parsed as empty; refusing to check nothing");
  const ceilings = new Map();
  for (const [group, body] of Object.entries(r.ceilings ?? {})) {
    if (group.startsWith("$")) continue;
    if (typeof body?.why !== "string" || !body.why.trim() || typeof body.files !== "object") throw new Error(`neutral-names: record_words.ceilings["${group}"] needs a "why" and "files"`);
    for (const [file, count] of Object.entries(body.files)) {
      if (!Number.isInteger(count) || count < 1) throw new Error(`neutral-names: record_words.ceilings["${group}"].files["${file}"] must be a positive integer`);
      if (ceilings.has(file)) throw new Error(`neutral-names: ${file} has a record-word ceiling in two groups`);
      ceilings.set(file, { count, group });
    }
  }
  return { scan: scan.map(globToRegExp), skip: skip.map(globToRegExp), names, ceilings };
}

/** Walk the tree: the prose record words per scanned file, and every way the allow-list is out of step. */
export function checkRecordWords(root, allow) {
  const problems = [];
  const counts = new Map();
  const hits = new Map();
  for (const path of listFiles(root)) {
    if (!allow.scan.some((re) => re.test(path)) || allow.skip.some((re) => re.test(path))) continue;
    let source;
    try {
      const bytes = readFileSync(join(root, path));
      if (bytes.includes(0)) continue;
      source = bytes.toString("utf8");
    } catch {
      continue;
    }
    if (!new RegExp(WORD.source, "i").test(source)) continue;
    let found;
    try {
      found = recordWordsInFile(path, source, allow.names);
    } catch (error) {
      problems.push(`${path}: could not be read for record words (${error instanceof Error ? error.message : error})`);
      continue;
    }
    if (!found.length) continue;
    counts.set(path, found.length);
    hits.set(path, found);
    const ceiling = allow.ceilings.get(path);
    if (!ceiling) {
      const first = found.slice(0, 4).map((h) => `${h.line || h.at}: "${h.word}" in "${h.text.slice(0, 90)}"`).join("; ");
      problems.push(`${path}: ${found.length} record word(s) written as prose in a file with no ceiling (${first}). Write a placeholder the profile fills ({account}, {deployment}, {implementation}, {rollout}; agent/lib/agent-vocabulary.ts) or take the word from lib/ui-words.ts (W.account, …).`);
    } else if (found.length > ceiling.count) {
      const lines = found.map((h) => h.line || h.at).join(",");
      problems.push(`${path}: ${found.length} record word(s) written as prose, over its ceiling of ${ceiling.count} (lines ${lines}). A new one is a placeholder ({account}, {deployment}, …) or a word from lib/ui-words.ts.`);
    } else if (found.length < ceiling.count) {
      problems.push(`${path}: ${found.length} record word(s) written as prose, under its ceiling of ${ceiling.count}: lower record_words.ceilings["${ceiling.group}"].files["${path}"] to ${found.length}`);
    }
  }
  for (const [file, { group }] of allow.ceilings) {
    if (!counts.has(file)) problems.push(`${file}: has a record-word ceiling but carries none now: remove it from record_words.ceilings["${group}"].files`);
  }
  return { problems, counts, hits };
}
