#!/usr/bin/env node
/**
 * THE UI-VOCABULARY GATE — a deployment that renames the base product's domains shows a PERSON only its own words.
 *
 * `check:agent-vocabulary` proves what the MODEL reads. This proves what a person reads: the web UI, the ops API's
 * messages, and every string the built client bundle ships. It exists because the gate before it
 * (`check-vocabulary.mjs`, now folded in here) looked for one word (the member's legacy word, agent/lib/legacy-member.ts)
 * in four source folders and skipped generated files, so a research deployment whose profile says companies /
 * analysts / coverage reports shipped a bundle that named the member and the owner by the legacy word in the
 * roster tool's and the owner workflow's descriptions, and said "Customer DMs": the subagent roster
 * (subagent-meta.generated.ts) and the whole workflow library (pulled into the client through one import) were
 * generated text it never read, and "customer" / "deployment" were never its words to look for.
 *
 * It renders a throwaway copy of this checkout under a RELABELLING profile (scripts/fixtures/agent-vocabulary/
 * 50-relabelled.json, the hfc-research pack's profile, which is what check:agent-vocabulary uses) and fails on any
 * base word — customer(s), deployment(s), implementation(s), rollout(s), the member's legacy word, forward-deployed — matched as
 * whole tokens where `_`, `-`, `/`, `.` and a camelCase hump are boundaries too:
 *
 *   1. SOURCE TEXT (static, the copy after `build:generated`): every piece of text a person can read in app/,
 *      components/ and lib/, and in the agent's person-facing HTML reports (agent/lib/render-html.ts) — JSX text; any string or template piece with a space in it; the value of a visible
 *      JSX attribute (title, placeholder, aria-label, alt, label, hint, …) or of a visible object key (label,
 *      header, description, error, …) — and every string of the generated subagent roster. Text handed to
 *      speak() / speakPrompt() / speakMessage() is translated at runtime by the agent's vocabulary and is not
 *      counted here (check:agent-vocabulary proves those functions). A CODE value that flows into text anyway
 *      (kept in an array or a ternary, joined into a template: "filed under a deployment/implementation") is
 *      followed and counted as text; the code-value allowances never excuse it.
 *   1b. ENUM VALUES: every value of every enum field a person can see, as domainView shows it, reads through the
 *      profile's label or spoken, never as a stored base word (`customer-vpc`). A pack that shows such a field
 *      without a label fails here.
 *   2. THE BUILT CLIENT BUNDLE: `next build` of the copy with browser source maps; every string literal and
 *      template piece in `.next/static/**` is mapped back to the file that wrote it (scripts/lib/client-literals.mjs).
 *      Any first-party one carrying a base word fails, whatever its shape, unless the allow-list says why a person
 *      never reads it (an API path, a storage key, a field key, a stored enum value…).
 *   3. PRERENDERED PAGES: the text and visible attributes of `.next/server/app/*.html`.
 *   5. RENDERED PAGES: `next start` of the copy, Chromium reads the visible DOM (text, title / placeholder /
 *      aria-label / alt, options, hover tooltips) of every page and tab, signed in with a local token and the ops API
 *      faked with one filled record per list (scripts/lib/rendered-text.mjs, no secret needed); it opens a record's
 *      detail and a "New …" dialog where a panel has them. Every page must show its own marker, throw no page error
 *      and not show the error screen, and a canary page broken on purpose must be caught. Only an allowance marked
 *      `"rendered": true` — text a person is meant to read as it is — excuses a line here.
 *   4. DEFAULT PROFILE (this checkout, when it carries profiles/00-default.json alone): every word lib/ui-words.ts
 *      hands the UI is the default profile's neutral word (the record words as before; "member", "Account owner"
 *      for the role), a stored key or value that carries the member's legacy word reads the profile's word, and
 *      the generated roster names no member by the legacy word. (Its bytes are held by check:generated.)
 *
 * The allow-list is scripts/fixtures/ui-vocabulary/allow.json: { "source": regex over the file path (a page is
 * `page:<path>`), "literal": regex over the text, "why": "…", "rendered"?: true }. An entry without a why is refused; an entry that matched nothing
 * is reported, so a stale one is noticed.
 *
 *   npm run check:ui-vocabulary                          all of them (needs Chromium: npx playwright install chromium)
 *   npm run check:ui-vocabulary -- --static              1, 1b and 4 only (seconds, no build; `npm run check:vocabulary`)
 *   npm run check:ui-vocabulary -- --no-render           everything but 5
 *   npm run check:ui-vocabulary -- --pack <pack dir> [--allow <allow.json>]
 *       a SUBAGENT PACK applied to this checkout (its files/** copied in, the way packs.py applies it, with ITS
 *       profiles/ instead of the fixture); <allow.json> adds entries of the same shape. 4 is skipped.
 *   npm run check:ui-vocabulary -- --keep                leave the built copy in .ui-vocabulary/ to inspect
 *   npm run check:ui-vocabulary -- --rescan              scan that kept copy again, without copying or building
 *   UI_VOCABULARY_FIXTURE=<file.json>                   render another relabelling profile instead
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { clientLiterals } from "./lib/client-literals.mjs";
import { CANARY, HIDDEN_MARK, PAGE_SPECS, PAGES, renderedText } from "./lib/rendered-text.mjs";
import { LEGACY_MEMBER, LEGACY_OWNER_KEY } from "../agent/lib/legacy-member.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const argAfter = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
const STATIC = process.argv.includes("--static");
/** --no-render: skip the rendered-DOM pass (no Chromium here). CI never passes it. */
const NO_RENDER = process.argv.includes("--no-render");
/** --rescan: scan the copy a previous --keep run left, without copying or building again (to iterate on the allow-list). */
const RESCAN = process.argv.includes("--rescan");
const KEEP = process.argv.includes("--keep") || RESCAN;
const PACK = argAfter("--pack");
const ALLOW_FILE = argAfter("--allow");
const FIXTURE = process.env.UI_VOCABULARY_FIXTURE || join(ROOT, "scripts/fixtures/agent-vocabulary/50-relabelled.json");
const ALLOW_BASE = join(ROOT, "scripts/fixtures/ui-vocabulary/allow.json");

/** The base product's words, as whole tokens (lower case). "forward-deployed" splits into forward + deployed. */
const BASE_WORDS = new Set(["customer", "customers", "deployment", "deployments", "implementation", "implementations", "rollout", "rollouts", LEGACY_MEMBER.singular.toLowerCase(), LEGACY_MEMBER.plural.toLowerCase()]);

/** Base words in a text: tokens split at non-alphanumerics and camelCase humps, plus "forward-deployed". */
export function baseWords(text) {
  const found = [];
  for (const m of text.matchAll(/[A-Za-z0-9]+/g)) {
    for (const p of m[0].split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) if (BASE_WORDS.has(p.toLowerCase())) found.push(p);
  }
  if (/forward[\s-]deployed/i.test(text)) found.push("forward-deployed");
  return found;
}

/* ------------------------------------------------------------------------------------------- allow-list */

function loadAllow(file) {
  const list = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(list)) throw new Error(`${file}: expected a list of { source, literal, why }`);
  return list.map((a, i) => {
    if (typeof a?.why !== "string" || a.why.trim().length < 12) throw new Error(`${file}[${i}]: every allowance says why a person never reads the base word there`);
    if (typeof a.literal !== "string") throw new Error(`${file}[${i}]: "literal" (a regex over the text) is required`);
    return { source: new RegExp(a.source ?? ".*"), literal: new RegExp(a.literal), why: a.why, rendered: a.rendered === true, file, index: i, used: 0 };
  });
}
const ALLOW = [...loadAllow(ALLOW_BASE), ...(ALLOW_FILE ? loadAllow(ALLOW_FILE) : [])];
/** `strict`: text a person reads (a code value that flows into a sentence, a rendered page): only an entry that says
 *  `"rendered": true` — a word a person is MEANT to read as it is — can excuse it, never a code-value allowance. */
const allowed = (source, text, strict = false) => {
  const a = ALLOW.find((e) => (!strict || e.rendered) && e.source.test(source ?? "") && e.literal.test(text));
  if (a) a.used++;
  return Boolean(a);
};

/* ---------------------------------------------------------------------------------------------- the copy */

const run = (cwd, cmd, args, what, env = {}) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1", ...env } });
  if (r.status !== 0) {
    console.error(`check-ui-vocabulary: ${what} failed in the copy:\n${(r.stderr || "") + (r.stdout || "")}`.slice(-6000));
    process.exit(2);
  }
  return r.stdout;
};

/** The files of this checkout: git's view when there is one (tracked + untracked, not ignored), else a walk. */
function checkoutFiles() {
  const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0) return r.stdout.split("\0").filter((f) => f && existsSync(join(ROOT, f)));
  const skip = new Set(["node_modules", ".next", ".git", ".ui-vocabulary", "test-results", ".eve", ".vercel"]);
  const walk = (d) => readdirSync(join(ROOT, d)).flatMap((n) => (skip.has(n) ? [] : statSync(join(ROOT, d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  return walk("");
}

/**
 * A copy under ROOT/.ui-vocabulary/<name>: inside the checkout so the copy resolves this checkout's node_modules by
 * walking up (Turbopack refuses a node_modules symlink that leaves the project root), with the copy's
 * next.config.ts wrapping the real one to turn on browser source maps and point Turbopack's root at the checkout.
 */
function makeCopy(name) {
  const dir = join(ROOT, ".ui-vocabulary", name);
  rmSync(dir, { recursive: true, force: true });
  for (const f of checkoutFiles()) {
    if (f.startsWith(".ui-vocabulary/")) continue;
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(ROOT, f), join(dir, f));
  }
  if (PACK) {
    // A pack is applied the way .claude/scripts/packs.py applies one: its files/** copied over the tree.
    cpSync(join(PACK, "files"), dir, { recursive: true, filter: (src) => !src.includes("__pycache__") });
  } else {
    cpSync(FIXTURE, join(dir, "profiles", "50-relabelled.json"));
  }
  return dir;
}

/* ------------------------------------------------------------------------------------ 1. source text */

const VISIBLE_ATTRS = new Set(["title", "placeholder", "aria-label", "aria-description", "alt", "label", "hint", "description", "subtitle", "heading", "emptyText", "empty", "noun", "blurb", "summary", "help", "tooltip", "caption", "message"]);
const VISIBLE_KEYS = new Set(["label", "header", "title", "description", "placeholder", "hint", "summary", "help", "blurb", "empty", "heading", "detail", "error", "message", "reason", "tooltip", "subtitle", "caption", "purpose", "note"]);
const SPOKEN_CALLS = new Set(["speak", "speakPrompt", "speakMessage", "speakWith", "speakPromptWith", "speakMessageWith"]);

/** Agent files whose text a PERSON reads (not the model): the HTML reports the agent publishes as artifacts. */
const PERSON_FACING_AGENT = ["agent/lib/render-html.ts"];

function sourceText(dir, only = null) {
  const ts = createRequire(join(ROOT, "package.json"))("typescript");
  const out = [];
  const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === "node_modules" ? [] : walk(p)) : /\.(tsx?|mts)$/.test(n) && !/\.d\.ts$/.test(n) ? [p] : []; }) : []);
  for (const file of only ?? ["app", "components", "lib"].flatMap((d) => walk(join(dir, d))).concat(PERSON_FACING_AGENT.map((f) => join(dir, f)).filter(existsSync))) {
    const rel = relative(dir, file);
    const generated = rel.endsWith(".generated.ts");
    // The profile's own words (and the default domains it is compared with) are the deployment's: not scanned.
    if (generated && !rel.endsWith("subagent-meta.generated.ts")) continue;
    const src = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    /** Handed to speak() (translated at runtime, for the model), or to console.* (a log line nobody reads in the UI). */
    const spoken = (n) => {
      for (let p = n.parent; p; p = p.parent) {
        if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && SPOKEN_CALLS.has(p.expression.text)) return true;
        if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && ts.isIdentifier(p.expression.expression) && p.expression.expression.text === "console") return true;
        if (ts.isBlock(p) || ts.isSourceFile(p)) return false;
      }
      return false;
    };
    /** Does this value end up where a person reads it: JSX children, a visible attribute, a visible key? A value
     *  compared (`view === "deployments"`) or tested (a condition) is code, not text. */
    const visibleSlot = (n) => {
      let c = n;
      let p = n.parent;
      const T = ts.SyntaxKind;
      for (;;) {
        if (!p) return false;
        if (ts.isTemplateExpression(p) || ts.isTemplateSpan(p) || ts.isJsxExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p)) { c = p; p = p.parent; continue; }
        if (ts.isConditionalExpression(p) && p.condition !== c) { c = p; p = p.parent; continue; }
        if (ts.isBinaryExpression(p) && ([T.PlusToken, T.QuestionQuestionToken, T.BarBarToken].includes(p.operatorToken.kind) || (p.operatorToken.kind === T.AmpersandAmpersandToken && p.right === c))) { c = p; p = p.parent; continue; }
        break;
      }
      if (ts.isJsxAttribute(p)) return VISIBLE_ATTRS.has(p.name.getText());
      if (ts.isPropertyAssignment(p)) return VISIBLE_KEYS.has(p.name.getText().replace(/["']/g, ""));
      if (ts.isJsxElement(p) || ts.isJsxFragment(p)) return true;
      return false;
    };
    /**
     * A CODE value (`"deployment"`) that ends up in text anyway: stored in an array or a ternary, joined, and put in
     * a template — "filed under a ${TODO_CONTAINERS.join("/")}" rendered "filed under a deployment/implementation"
     * while every piece looked like a code value. Follows the value up through arrays, ternary branches, `??`/`||`,
     * and `.filter()` / `.join()` / `.map()`-style calls to the expression it is part of; that expression, or any
     * reference to the const it initialises, is rendered when it lands in a template, JSX, a visible attribute or
     * key, or a string concatenation. The code-value allowances never excuse such a value.
     */
    const T = ts.SyntaxKind;
    const CARRY = new Set(["filter", "slice", "concat", "join", "toLowerCase", "toUpperCase", "trim", "flat", "sort"]);
    const climb = (c) => {
      for (;;) {
        const p = c.parent;
        if (!p) return c;
        if (ts.isArrayLiteralExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(p))) { c = p; continue; }
        if (ts.isConditionalExpression(p) && p.condition !== c) { c = p; continue; }
        if (ts.isBinaryExpression(p) && [T.QuestionQuestionToken, T.BarBarToken].includes(p.operatorToken.kind)) { c = p; continue; }
        if (ts.isPropertyAccessExpression(p) && p.expression === c && CARRY.has(p.name.text) && p.parent && ts.isCallExpression(p.parent) && p.parent.expression === p) { c = p.parent; continue; }
        return c;
      }
    };
    const renderedAt = (c) => {
      const p = c.parent;
      if (!p) return false;
      // A template is text when its own words have a space in them ("filed under a …"), not a URL or a key.
      if (ts.isTemplateSpan(p) && p.expression === c) {
        const t = p.parent;
        return [t.head.text, ...t.templateSpans.map((x) => x.literal.text)].some((x) => /\s/.test(x.trim()) || /\w\s|\s\w/.test(x));
      }
      if (ts.isJsxExpression(p)) return ts.isJsxElement(p.parent) || ts.isJsxFragment(p.parent) || (ts.isJsxAttribute(p.parent) && VISIBLE_ATTRS.has(p.parent.name.getText()));
      if (ts.isPropertyAssignment(p) && p.initializer === c) return VISIBLE_KEYS.has(p.name.getText().replace(/["']/g, ""));
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === T.PlusToken) {
        const other = p.left === c ? p.right : p.left;
        return ts.isStringLiteral(other) || ts.isTemplateExpression(other) || ts.isNoSubstitutionTemplateLiteral(other);
      }
      return false;
    };
    const flowsIntoText = (lit) => {
      const top = climb(lit);
      if (top !== lit && renderedAt(top)) return true;
      const decl = top.parent;
      if (!decl || !ts.isVariableDeclaration(decl) || decl.initializer !== top || !ts.isIdentifier(decl.name)) return false;
      const name = decl.name.text;
      let hit = false;
      const find = (m) => {
        if (hit) return;
        if (ts.isIdentifier(m) && m.text === name && m !== decl.name && !(ts.isPropertyAccessExpression(m.parent) && m.parent.name === m)) {
          if (renderedAt(climb(m))) hit = true;
        }
        ts.forEachChild(m, find);
      };
      find(sf);
      return hit;
    };
    const visit = (n) => {
      let text = null;
      let kind = null;
      if (ts.isJsxText(n)) { text = n.text.trim(); kind = "jsx text"; }
      else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
        text = n.text;
        const inImport = ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent) || (ts.isCallExpression(n.parent) && n.parent.expression.kind === ts.SyntaxKind.ImportKeyword);
        const isKey = ts.isPropertyAssignment(n.parent) && n.parent.name === n;
        if (inImport || isKey || ts.isLiteralTypeNode(n.parent)) text = null;
        else if (generated) kind = "generated roster";
        else if (/\s/.test(text.trim()) || /^[A-Z][A-Za-z]*:$/.test(text.trim())) kind = "text";
        else if (visibleSlot(n)) kind = "label";
        else if (baseWords(text).length && flowsIntoText(n)) kind = "rendered code value";
        else text = null;
      }
      if (text && baseWords(text).length && !spoken(n)) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        out.push({ source: rel, line, kind, text, words: baseWords(text), strict: kind === "rendered code value" });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/* ------------------------------------------------------------------------------ 1b. enum value labels */

/**
 * Every value of every enum field a person can see (the two record areas, fields the profile does not hide, areas
 * whose data-room domain is shown), as the UI shows it: domainView(area).display(key, value) and .options(key). A
 * stored value that carries a base word (`customer-vpc`, `customer_cloud`, blockerOwner `Customer`) must reach a
 * person through the profile's label, or spoken the way the model is told it — never as stored. Catches a pack that
 * shows such a field without labelling it.
 */
async function enumLabels(dir) {
  const { domainView } = await import(pathToFileURL(join(dir, "lib/profile-domains.ts")).href);
  const { DOMAIN_FIELDS, DEPLOYMENT_PROFILE } = await import(pathToFileURL(join(dir, "lib/deployment-profile.generated.ts")).href);
  const out = [];
  for (const [area, domain] of [["deployments", "Deployments"], ["implementations", "Implementation"]]) {
    if (DEPLOYMENT_PROFILE.dataroom.domains[domain]?.visible === false) continue;
    const view = domainView(area);
    for (const [key, meta] of Object.entries(DOMAIN_FIELDS[area])) {
      if (meta.type !== "enum" || view.hidden(key)) continue;
      const shown = [...(meta.values ?? []).map((v) => [v, view.display(key, v)]), ...view.options(key).map((o) => [o.value, o.label])];
      for (const [value, label] of shown) {
        if (baseWords(label).length) out.push({ source: `enum ${area}.${key}`, text: `${value} -> ${label}`, words: baseWords(label), strict: true });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ 5b. data room fields */

/**
 * The rendered data room against the profile's field rules. The workbook mock (scripts/lib/rendered-text.mjs) gives
 * every hideable field a value marked HIDDEN-FIELD-<key>. A HIDDEN field (account_fields.hidden; an area's
 * `fields.<key>.hidden`) must show neither its marked value nor its column on any data-room page; an own field the
 * profile lists (`custom_fields[].show_in_list`) must show as a column, in its label, on its area's sheet.
 */
async function dataroomFields(copy, seen) {
  const { DEPLOYMENT_PROFILE: P } = await import(pathToFileURL(join(copy, "lib/deployment-profile.generated.ts")).href);
  const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");
  const hiddenOf = (fields) => Object.entries(fields ?? {}).filter(([, f]) => f?.hidden).map(([k]) => k);
  const hidden = [
    ...(P.account_fields?.hidden ?? []).filter((k) => !["platform", "solutions", "tickets", "id", "name"].includes(k)),
    ...hiddenOf(P.domains.deployments?.fields),
    ...hiddenOf(P.domains.implementations?.fields),
  ];
  const room = seen.filter((l) => l.page.startsWith("/?dataroom="));
  const cells = (page) => new Set(room.filter((l) => l.page === page).flatMap((l) => l.text.split("\t")).map((c) => c.trim()));
  const problems = [];
  for (const k of hidden) {
    const leak = room.find((l) => l.text.includes(`${HIDDEN_MARK}${k}`));
    if (leak) problems.push(`hidden field "${k}" shows its value on ${leak.page}`);
    for (const page of new Set(room.map((l) => l.page))) {
      if ([...cells(page)].some((c) => norm(c) === norm(k))) problems.push(`hidden field "${k}" shows as a column on ${page}`);
    }
  }
  const AREA_PAGE = { account: "/?dataroom=customers", deployments: "/?dataroom=deployments", implementations: "/?dataroom=implementation" };
  let listed = 0;
  for (const [area, page] of Object.entries(AREA_PAGE)) {
    const specs = (area === "account" ? P.account_fields?.custom_fields : P.domains[area]?.custom_fields) ?? [];
    for (const f of specs.filter((x) => x.show_in_list)) {
      if (!PAGES.includes(page) || !room.some((l) => l.page === page)) continue;
      listed++;
      if (!cells(page).has(f.label)) problems.push(`listed own field "${f.key}" (${area}) does not show as a column "${f.label}" on ${page}`);
    }
  }
  return { problems, hidden: hidden.length, listed };
}

/* ---------------------------------------------------------------------------- 3. prerendered pages */

function prerenderedText(dir) {
  const app = join(dir, ".next", "server", "app");
  if (!existsSync(app)) return [];
  const out = [];
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : n.endsWith(".html") ? [p] : []; });
  for (const f of walk(app)) {
    const html = readFileSync(f, "utf8").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ");
    const attrs = [...html.matchAll(/\s(?:title|placeholder|aria-label|alt|content)="([^"]*)"/g)].map((m) => m[1]);
    for (const t of [...html.replace(/<[^>]+>/g, "\n").split("\n"), ...attrs]) {
      const text = t.replace(/\s+/g, " ").trim();
      if (text && baseWords(text).length) out.push({ source: relative(dir, f), text, words: baseWords(text) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------ 4. default words */

async function defaultWords() {
  const profiles = readdirSync(join(ROOT, "profiles")).filter((f) => /^\d{2}-[a-z0-9-]+\.json$/.test(f));
  if (profiles.length !== 1) return { skipped: `this checkout carries ${profiles.join(", ")}` };
  if (!existsSync(join(ROOT, "lib/ui-words.ts"))) return { wrong: ["lib/ui-words.ts is missing: the UI has no profile words to take"] };
  const { W, an } = await import(pathToFileURL(join(ROOT, "lib/ui-words.ts")).href);
  const want = {
    // The default profile's words are neutral (profiles/00-default.json): an account, a delivery, a project and
    // its plan. The identifiers keep the stored words (speakKey below is still the identity).
    account: "account", accounts: "accounts", Account: "Account", Accounts: "Accounts",
    member: "member", members: "members", Member: "Member", Members: "Members", owner: "Account owner", secondaryOwner: "Secondary owner",
    deployment: "delivery", deployments: "deliveries", Deployment: "Delivery", Deployments: "Deliveries",
    implementation: "project", implementations: "projects", Implementation: "Project", Implementations: "Projects",
    rollout: "plan", rollouts: "plans", Rollout: "Plan", Rollouts: "Plans",
    accountIdExample: "account-id", install: "workspace",
  };
  const wrong = Object.entries(want).filter(([k, v]) => W[k] !== v).map(([k, v]) => `W.${k} is ${JSON.stringify(W[k])}, the default profile says ${JSON.stringify(v)}`);
  if (Object.keys(W).some((k) => !(k in want))) wrong.push(`lib/ui-words.ts has words this check does not pin: ${Object.keys(W).filter((k) => !(k in want)).join(", ")}`);
  for (const [w, a] of [["customer", "a"], ["member", "a"], [LEGACY_MEMBER.singular, "an"], ["deployment", "a"], ["implementation", "an"], ["analyst", "an"], ["company", "a"]]) if (an(w) !== a) wrong.push(`an("${w}") is "${an(w)}", not "${a}"`);
  const { speakKey, humanizeKey } = await import(pathToFileURL(join(ROOT, "lib/ui-keys.ts")).href);
  for (const k of ["customer_id", "customerId", "fdeOwner", "fde_owner", "deploymentId", "implementation"]) {
    if (speakKey(k) !== k) wrong.push(`speakKey("${k}") is "${speakKey(k)}" under the default profile`);
  }
  // The owner key keeps its stored name, and a person reads the profile's owner label for it, the default included.
  for (const k of ["fdeOwner", "fde_owner"]) if (!LEGACY_OWNER_KEY.test(k) || humanizeKey(k) !== "Account owner") wrong.push(`humanizeKey("${k}") is "${humanizeKey(k)}", not the default owner label "Account owner"`);
  for (const k of ["accountOwner", "account_owner"]) if (humanizeKey(k) !== "Account owner") wrong.push(`humanizeKey("${k}") is "${humanizeKey(k)}", not the default owner label "Account owner"`);
  // The second owner's key, under its original name and the neutral one beside it, reads the profile's label for it.
  for (const k of ["aeOwner", "ae_owner", "secondaryOwner", "secondary_owner"]) if (humanizeKey(k) !== "Secondary owner") wrong.push(`humanizeKey("${k}") is "${humanizeKey(k)}", not the default second-owner label "Secondary owner"`);
  for (const k of ["solutionFdeOwner", "solution_fde_owner", "solutionOwner", "solution_owner"]) if (humanizeKey(k) !== "Solution account owner") wrong.push(`humanizeKey("${k}") is "${humanizeKey(k)}", not "Solution account owner"`);
  if (humanizeKey("customerId") !== "Customer Id") wrong.push("humanizeKey changed the default export labels");
  // Stored values that carry the legacy member word keep it in the row and read the profile's member word.
  const { storedValueLabel } = await import(pathToFileURL(join(ROOT, "lib/ui-words.ts")).href);
  const legacyVerified = `${LEGACY_MEMBER.singular} Verified`;
  if (storedValueLabel("ownerTeam", LEGACY_MEMBER.singular) !== "Member") wrong.push(`the stored ownerTeam "${LEGACY_MEMBER.singular}" reads "${storedValueLabel("ownerTeam", LEGACY_MEMBER.singular)}", not "Member"`);
  if (storedValueLabel("valueEvidenceStatus", legacyVerified) !== "Member Verified") wrong.push(`the stored valueEvidenceStatus "${legacyVerified}" reads "${storedValueLabel("valueEvidenceStatus", legacyVerified)}"`);
  if (storedValueLabel("summary", legacyVerified) !== legacyVerified) wrong.push("storedValueLabel touched a field it does not own");
  // The default deployment's own generated text (the roster a person reads) carries no legacy member word as a word.
  const roster = readFileSync(join(ROOT, "app/_components/subagent-meta.generated.ts"), "utf8");
  const legacyWord = new RegExp(`(?<![A-Za-z0-9_-])(${LEGACY_MEMBER.singular}|${LEGACY_MEMBER.plural})(?![A-Za-z0-9_-])`, "i");
  const hit = roster.split("\n").find((l) => legacyWord.test(l));
  if (hit) wrong.push(`the default roster (subagent-meta.generated.ts) still names the member by its legacy word: ${hit.trim().slice(0, 140)}`);
  return { wrong };
}

/* ------------------------------------------------------------------------------------------------- run */

let failed = false;
const report = (title, items, fmt) => {
  const bad = items.filter((i) => !allowed(i.source, i.text, i.strict));
  if (!bad.length) return 0;
  failed = true;
  const bySource = new Map();
  for (const b of bad) bySource.set(b.source, [...(bySource.get(b.source) ?? []), b]);
  console.error(`\ncheck-ui-vocabulary: ${title} — ${bad.length} piece(s) of text carry a base word, in ${bySource.size} file(s):`);
  for (const [source, list] of bySource) {
    console.error(`  ${source}`);
    const seen = new Set();
    for (const b of list) {
      const line = fmt(b);
      if (seen.has(line)) continue;
      seen.add(line);
      console.error(`    ${line}`);
    }
  }
  return bad.length;
};

/**
 * --scan-file <file.tsx>: the source pass over ONE file, as JSON on stdout, and exit. For scripts/test-ui-vocabulary.mjs,
 * which holds the dataflow rule to its fixtures (scripts/fixtures/ui-vocabulary/known-miss/): what it catches, and the
 * routes it is known not to follow yet.
 */
const SCAN_FILE = argAfter("--scan-file");
if (SCAN_FILE) {
  const file = SCAN_FILE.startsWith("/") ? SCAN_FILE : join(process.cwd(), SCAN_FILE);
  console.log(JSON.stringify(sourceText(dirname(file), [file]).map(({ line, kind, text }) => ({ line, kind, text }))));
  process.exit(0);
}

const label = PACK ? `pack ${PACK} under its own profile` : `relabelled profile (${relative(ROOT, FIXTURE)})`;
const copyName = PACK ? "pack" : "relabelled";
const rescan = RESCAN && existsSync(join(ROOT, ".ui-vocabulary", copyName, ".next"));
const copy = rescan ? join(ROOT, ".ui-vocabulary", copyName) : makeCopy(copyName);
try {
  if (!rescan && PACK && existsSync(join(copy, "scripts/sync-subagent-shared.mjs"))) run(copy, process.execPath, ["scripts/sync-subagent-shared.mjs"], "npm run sync:subagent-shared");
  if (!rescan) run(copy, "npm", ["run", "-s", "build:generated"], "npm run build:generated");

  const src = sourceText(copy);
  const srcBad = report(`${label}, SOURCE TEXT a person reads`, src, (b) => `${b.line}: [${b.kind}] "${b.words.join('", "')}" in ${JSON.stringify(b.text.replace(/\s+/g, " ").slice(0, 160))}`);
  if (!srcBad) console.log(`check-ui-vocabulary: ${label} — source text a person reads (app/, components/, lib/, the agent's HTML reports, the subagent roster) carries no base word`);

  const enums = await enumLabels(copy);
  if (!report(`${label}, ENUM VALUES as a person reads them`, enums, (b) => `"${b.words.join('", "')}" in ${JSON.stringify(b.text)}`)) {
    console.log(`check-ui-vocabulary: ${label} — every visible enum value reads through the profile's label (or spoken), none as a base word`);
  }

  if (!STATIC && !rescan) {
    // The copy's config: the real one, plus browser source maps (to map each literal to its file) and Turbopack's
    // root at the checkout (the copy has no node_modules of its own).
    const cfg = readFileSync(join(copy, "next.config.ts"), "utf8");
    writeFileSync(join(copy, "next.config.base.ts"), cfg);
    writeFileSync(join(copy, "next.config.ts"), `import base from "./next.config.base.ts";\nexport default { ...base, productionBrowserSourceMaps: true, turbopack: { ...(base as { turbopack?: object }).turbopack, root: ${JSON.stringify(ROOT)} } };\n`);
    // (build:pdfjs-assets is skipped: it copies runtime files into public/, which the build does not read.)
    run(copy, process.execPath, [join(ROOT, "node_modules/next/dist/bin/next"), "build"], "next build", { NEXT_TELEMETRY_DISABLED: "1" });
  }
  if (!STATIC) {
    // Sources are named from Turbopack's root (this checkout): the copy's own files carry the copy's prefix.
    const prefix = `${relative(ROOT, copy)}/`;
    const literals = clientLiterals(copy).map((l) => ({ ...l, source: l.source?.startsWith(prefix) ? l.source.slice(prefix.length) : l.source }));
    const firstParty = literals.filter((l) => !l.source?.startsWith("node_modules/") && !l.source?.startsWith("turbopack:///[turbopack]"));
    const seen = new Set();
    const hits = [];
    for (const l of firstParty) {
      const words = baseWords(l.value);
      if (!words.length) continue;
      const key = `${l.source}\u0000${l.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ source: l.source ?? "(unmapped)", text: l.value, words });
    }
    const bundleBad = report(`${label}, BUILT CLIENT BUNDLE`, hits, (b) => `"${b.words.join('", "')}" in ${JSON.stringify(b.text.replace(/\s+/g, " ").slice(0, 160))}`);
    const allowedCount = hits.length - bundleBad;
    if (!bundleBad) console.log(`check-ui-vocabulary: ${label} — built client bundle: ${literals.length} strings (${firstParty.length} first-party), ${allowedCount} carrying a base word, every one allow-listed as never read (scripts/fixtures/ui-vocabulary/allow.json)`);

    const pages = prerenderedText(copy);
    if (!report(`${label}, PRERENDERED PAGES`, pages, (b) => `"${b.words.join('", "')}" in ${JSON.stringify(b.text.slice(0, 160))}`)) {
      console.log(`check-ui-vocabulary: ${label} — prerendered pages carry no base word`);
    }

    // 5. What a person SEES: every page and tab, rendered by Chromium against `next start`, the ops API faked.
    if (!NO_RENDER) {
      // The canary first: a page the pass cannot read must fail it (render errors, the error screen, no marker).
      const started = Date.now();
      const { lines: seen, failures } = await renderedText({ dir: copy, root: ROOT, specs: [CANARY, ...PAGE_SPECS] });
      const unread = failures.filter((f) => !f.canary);
      if (!failures.some((f) => f.canary)) {
        failed = true;
        console.error(`\ncheck-ui-vocabulary: ${label}, RENDERED PAGES — the canary (${CANARY.path} with a broken answer) was read as rendered: the pass cannot tell a crashed page from a clean one.`);
      }
      if (unread.length) {
        failed = true;
        console.error(`\ncheck-ui-vocabulary: ${label}, RENDERED PAGES — ${unread.length} page(s) could not be read (each must show its marker, with no page error and no error screen):`);
        for (const f of unread) console.error(`  ${f.page}: ${f.why}`);
      }
      const shown = seen.filter((l) => baseWords(l.text).length).map((l) => ({ source: `page:${l.page}`, text: l.text, words: baseWords(l.text), strict: true }));
      const secs = Math.round((Date.now() - started) / 1000);
      if (!report(`${label}, RENDERED PAGES (the visible DOM of ${PAGES.length} pages and tabs)`, shown, (b) => `"${b.words.join('", "')}" in ${JSON.stringify(b.text.slice(0, 160))}`) && !unread.length) {
        console.log(`check-ui-vocabulary: ${label} — rendered pages: ${seen.length} visible lines across ${PAGES.length} pages and tabs (details and dialogs opened, canary caught, ${secs}s) carry no base word`);
      }
      // 5b. The data room shows what the profile SHOWS: no field it hides (account_fields.hidden, an area's hidden
      //     fields), as a column or a value, and every own field it lists (show_in_list) as a column in its label.
      const fields = await dataroomFields(copy, seen);
      if (fields.problems.length) {
        failed = true;
        console.error(`\ncheck-ui-vocabulary: ${label}, DATA ROOM FIELDS — the Master.xlsx previews do not follow the profile's fields:`);
        for (const p of fields.problems) console.error(`  ${p}`);
      } else {
        console.log(`check-ui-vocabulary: ${label} — data room: none of ${fields.hidden} hidden fields shows (column or value), and ${fields.listed} listed own fields show as columns`);
      }
    } else console.log("check-ui-vocabulary: --no-render: the rendered-DOM pass was skipped");
  }
} finally {
  if (!KEEP) rmSync(copy, { recursive: true, force: true });
  else console.log(`check-ui-vocabulary: the copy is kept at ${relative(ROOT, copy)}`);
  if (!KEEP && existsSync(join(ROOT, ".ui-vocabulary")) && !readdirSync(join(ROOT, ".ui-vocabulary")).length) rmSync(join(ROOT, ".ui-vocabulary"), { recursive: true, force: true });
}

if (!PACK) {
  const d = await defaultWords();
  if (d.skipped) console.log(`check-ui-vocabulary: default-profile words not compared (${d.skipped})`);
  else if (d.wrong.length) {
    failed = true;
    console.error(`\ncheck-ui-vocabulary: DEFAULT profile — the UI's words are not the ones it had before:\n  ${d.wrong.join("\n  ")}`);
  } else console.log("check-ui-vocabulary: default profile — every word lib/ui-words.ts hands the UI is the profile's neutral default, and the legacy member word reaches no label, stored value or roster line");
}

if (!STATIC && !failed) {
  const unused = ALLOW.filter((a) => !a.used && a.file === ALLOW_BASE && !PACK);
  for (const a of unused) console.log(`check-ui-vocabulary: note — allow-list entry ${a.index} (${a.literal}) matched nothing; drop it if it is stale`);
}
if (failed) {
  console.error("\nA deployment whose profile renames the domains must show a person only the profile's words. Take the word from lib/ui-words.ts (W.account, W.Deployment, W.owner, …) or the profile, speak a key with lib/ui-keys.ts, or generate the text in the profile's words (scripts/gen-subagent-meta.mjs). Never rename what is stored. A string a person never reads goes in scripts/fixtures/ui-vocabulary/allow.json with its why.");
}
process.exit(failed ? 1 : 0);
