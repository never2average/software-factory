#!/usr/bin/env node
/**
 * THE AGENT-VOCABULARY GATE — a deployment that renames the base product's domains gets an agent that speaks
 * only its own words.
 *
 * `check:vocabulary` keeps the base role word out of the UI; `check:wire-names` keeps it out of the identifiers a coding
 * assistant is served. Neither looks at what the eve agent's MODEL reads, and that is where it survived: a
 * research deployment whose profile says Customers are "Companies", Deployments are "Coverage reports" and
 * Implementation is "Portfolios" had a live agent reasoning 'Given the deployment mapping: {folder:accounts}/ is shown
 * as "Companies". The data room has companies under {folder:accounts}/{customer_id}/filings/' — because the root
 * prompt was a customer-management persona, the tools were list_customers / customer_id, the paths were
 * {folder:accounts}/…, and the per-turn briefing TOLD it the identifiers do not change.
 *
 * This gate builds two throwaway copies of this checkout and renders the complete model-facing surface of each
 * with scripts/lib/model-surface.mjs (system prompts, the per-turn briefing, every tool's name, description
 * and parameters, the subagent roster and every subagent's prompt, skills and sandbox files, and the results
 * of real offline tool calls):
 *
 *   1. RELABELLED — profiles/00-default.json + scripts/fixtures/agent-vocabulary/50-relabelled.json (a copy of
 *      the hfc-research pack's profile). No base word may appear anywhere: customer(s), deployment(s),
 *      implementation(s), rollout(s), the member's legacy word. Matched as whole words case-insensitively, where `_`, `-`, `/`,
 *      `.` and a camelCase hump are word boundaries too — `customer_id`, `list_customers`, `deploymentId` and
 *      `{folder:accounts}/` are exactly the leaks this exists for, and a plain \b would pass every one of them.
 *   2. DEFAULT — profiles/00-default.json alone. The rendered prompts, tools and roster must be byte-identical
 *      to scripts/fixtures/agent-vocabulary/default-surface.txt (first taken BEFORE the vocabulary work, re-taken
 *      when the default profile's role words became neutral, and again when its record words did). A deployment
 *      that relabels nothing must not pay for the ones that do. And it reads the member's legacy word nowhere as a
 *      word (only inside a contract identifier such as a column name), no record word (customer, deployment,
 *      implementation, rollout) as prose, tool results and the workflow library included (identifiers, paths, code
 *      spans and stored values keep them: they are contracts), and no placeholder (`{member}`, `{account}`)
 *      unfilled.
 *
 *   npm run check:agent-vocabulary                    both
 *   npm run check:agent-vocabulary -- --update-baseline   re-snapshot the default surface (a deliberate prompt change)
 *   npm run check:agent-vocabulary -- --dump <file>       also write the relabelled surface to <file>, to read it
 *   AGENT_VOCABULARY_FIXTURE=<file.json>              render another relabelling profile instead
 *   npm run check:agent-vocabulary -- --pack <pack dir> [--allow <allow.json>]
 *       render a SUBAGENT PACK applied to this checkout (its files/** copied in, the way packs.py applies it,
 *       with ITS profiles/ instead of the fixture) and fail on any base word in what the model reads, pack text
 *       included. <allow.json> is a list of { "section": regex, "phrase": regex, "why": "…" }; an entry
 *       without a why is refused. The default-profile half is skipped in this mode.
 *
 * The one escape hatch is ALLOW below: a phrase, the section it may appear in, and why. Keep it empty.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_PRODUCT_WORD } from "./lib/agent-cli.mjs";
import { proseRecordWords, readRecordAllow } from "./lib/record-words.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const FIXTURES = join(ROOT, "scripts", "fixtures", "agent-vocabulary");
const FIXTURE = process.env.AGENT_VOCABULARY_FIXTURE || join(FIXTURES, "50-relabelled.json");
const BASELINE = join(FIXTURES, "default-surface.txt");
/**
 * The pin a deployment that already holds files adds to its profile (each domain stored under the name its folder
 * had while folder names were written into the code), and what the DEFAULT deployment's model read at the last
 * commit before they became a profile setting, kept verbatim. Under the pin the model must read exactly that.
 */
const FOLDER_FIXTURES = join(ROOT, "scripts", "fixtures", "dataroom-folders");
const LEGACY_FOLDERS_PIN = join(FOLDER_FIXTURES, "50-legacy-folders.json");
const SURFACE_BEFORE = join(FOLDER_FIXTURES, "surface-before-folders-were-a-setting.txt");
const UPDATE = process.argv.includes("--update-baseline");
/** --dump <file>: also write the relabelled surface there, to read what the model gets. */
const DUMP = process.argv.includes("--dump") ? process.argv[process.argv.indexOf("--dump") + 1] : null;
const argAfter = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
const PACK = argAfter("--pack");
const ALLOW_FILE = argAfter("--allow");

/** The base product's words, as whole tokens: the record words and the member's legacy word (BASE_PRODUCT_WORD). */
const BASE_WORDS = ["customer", "customers", "deployment", "deployments", "implementation", "implementations", "rollout", "rollouts", BASE_PRODUCT_WORD, `${BASE_PRODUCT_WORD}s`];
/** The member's legacy word standing as a WORD (not inside an identifier such as a column name). */
const LEGACY_AS_WORD = new RegExp(`(?<![A-Za-z0-9_\\-.])(${BASE_PRODUCT_WORD}s?)(?![A-Za-z0-9_\\-])`, "gi");
/**
 * STORED enum values that carry the legacy word (a ticket's `ownerTeam`, an account's `valueEvidenceStatus`,
 * agent/lib/customer-schema.ts). They are data the model writes back as stored, like a column name, and are moved
 * only by a data migration; a person reads them in the profile's member word (lib/ui-words.ts storedValueLabel).
 * A schema line that is exactly one of them is not a word the model is taught.
 */
const LEGACY_STORED_VALUES = new Set([BASE_PRODUCT_WORD.toUpperCase(), `${BASE_PRODUCT_WORD.toUpperCase()} Verified`]);
const isStoredValueLine = (line) => LEGACY_STORED_VALUES.has(line.trim().replace(/^"|",?$|"$/g, ""));
/** A role or record placeholder base text writes, which every boundary must fill from the profile. */
const UNFILLED = /(?<!\$)\{(members?|Members?|owner|Owner|accounts?|Accounts?|deployments?|Deployments?|implementations?|Implementations?|rollouts?|Rollouts?|period_items?|Period_items?|periods?|Periods?|(?:folder|domain):[a-z]+)\}/g;
/** Names that are not prose where they stand (a specialist's directory name, a stored enum value): the ratchet's own list. */
const RECORD_NAMES = readRecordAllow(JSON.parse(readFileSync(join(ROOT, "scripts", "neutral-names.allow.json"), "utf8"))).names;
/**
 * The record words (customer, deployment, implementation, rollout) the model reads as PROSE in a surface, by the
 * same rule the source ratchet applies (scripts/lib/record-words.mjs): never inside an identifier, a path, a code
 * span or a quoted value. A tool's input schema is JSON, where every key and enum value is quoted: only its
 * description strings are prose, and those are read as text.
 */
function recordProse(surface) {
  const out = [];
  for (const s of surface.split(/^(?==== )/m)) {
    const title = s.slice(4, s.indexOf("\n"));
    let body = s.slice(s.indexOf("\n") + 1);
    // A roster entry is `<directory name>: <description>`: the name is the specialist's, a contract.
    if (/ :: roster entry$/.test(title)) body = body.replace(/^[a-z0-9-]+: /, "");
    // A tool result is printed as JSON, and a thrown validation error is JSON inside it: read the quotes and
    // line breaks as the model does, so a quoted value (`\"Customer\"`) is seen as one.
    if (/ :: result :: /.test(title)) body = body.replace(/\\+"/g, '"').replace(/\\+n/g, "\n");
    // A line that is one lower-case token (a specialist's name among a workflow's literals, a key) is a name.
    body = body.split("\n").map((line) => (/^\s*[a-z0-9_\-./:]+\s*$/.test(line) ? "" : line)).join("\n");
    for (const h of proseRecordWords(body, RECORD_NAMES)) out.push(`[${title}] "${h.word}": ${h.text}`);
  }
  return out;
}
/** Lines of a surface that carry `re`, with their section, for a report. */
function linesWith(surface, re) {
  const out = [];
  let section = "(start)";
  for (const line of surface.split("\n")) {
    if (line.startsWith("=== ")) section = line.slice(4);
    else if (new RegExp(re.source, re.flags.replace("g", "")).test(line) && !(re === LEGACY_AS_WORD && / :: tool :: /.test(section) && isStoredValueLine(line))) out.push(`[${section}] ${line.trim().slice(0, 200)}`);
  }
  return out;
}

/**
 * Deliberate exceptions: { section: RegExp, phrase: RegExp, why: string }. A hit is allowed only when both
 * match. Every entry must say why the model has to read the base word there.
 */
const ALLOW = [];
if (ALLOW_FILE) {
  const extra = JSON.parse(readFileSync(ALLOW_FILE, "utf8"));
  if (!Array.isArray(extra)) throw new Error(`${ALLOW_FILE}: expected a list of { section, phrase, why }`);
  for (const [i, a] of extra.entries()) {
    if (typeof a?.why !== "string" || !a.why.trim()) throw new Error(`${ALLOW_FILE}[${i}]: every allowance says why the model has to read the base word there`);
    ALLOW.push({ section: new RegExp(a.section ?? ".*"), phrase: new RegExp(a.phrase, "i"), why: a.why });
  }
}

/** Tokens of a text, splitting identifiers the way a reader does: snake_case, kebab-case, paths, camelCase. */
function hits(text) {
  const found = [];
  const re = /[A-Za-z0-9]+/g;
  let m;
  while ((m = re.exec(text))) {
    const parts = m[0].split(/(?<=[a-z0-9])(?=[A-Z])/);
    let offset = m.index;
    for (const p of parts) {
      if (BASE_WORDS.includes(p.toLowerCase())) found.push({ index: offset, word: p });
      offset += p.length;
    }
  }
  return found;
}

function copyCheckout(extraProfiles, pack = null) {
  const dir = mkdtempSync(join(tmpdir(), "agent-vocabulary-"));
  for (const entry of ["agent", "lib", "data", "scripts", "library", "dm.md", "package.json", "docs"]) {
    if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true, filter: (src) => !src.includes("__pycache__") });
  }
  mkdirSync(join(dir, "profiles"), { recursive: true });
  // gen-subagent-meta.mjs also writes the UI's copy of the registry.
  mkdirSync(join(dir, "app", "_components"), { recursive: true });
  cpSync(join(ROOT, "profiles", "00-default.json"), join(dir, "profiles", "00-default.json"));
  for (const [name, file] of extraProfiles) cpSync(file, join(dir, "profiles", name));
  // Base code ships no workflow library: a deployment opts into one through its profile. The copy opts into the one
  // in this repository, so the text a library sends to a model is still checked under the relabelling profile. A
  // pack names its own (or none) in its own profile.
  if (!pack) cpSync(join(ROOT, "library", "account-delivery", "profile.json"), join(dir, "profiles", "40-library-account-delivery.json"));
  // A pack is applied the way .claude/scripts/packs.py applies one: its files/** copied over the tree.
  if (pack) cpSync(join(pack, "files"), dir, { recursive: true, filter: (src) => !src.includes("__pycache__") });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  return dir;
}

function run(dir, args, what) {
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  if (r.status !== 0) {
    console.error(`check-agent-vocabulary: ${what} failed in a copy of the checkout:\n${(r.stderr || r.stdout).slice(-4000)}`);
    process.exit(2);
  }
  return r.stdout;
}

/** Render a checkout copy under the given profiles: the way packs.py stamps a build (copy, profile, generate). */
function render(extraProfiles, flags, pack = null) {
  const dir = copyCheckout(extraProfiles, pack);
  try {
    // The stamping sequence: shared helpers synced, registry (honouring specialists.exclude), profile, prompts.
    if (pack && existsSync(join(dir, "scripts/sync-subagent-shared.mjs"))) run(dir, ["scripts/sync-subagent-shared.mjs"], "npm run sync:subagent-shared");
    run(dir, ["scripts/gen-subagent-meta.mjs"], "npm run build:subagent-meta");
    run(dir, ["scripts/gen-deployment-profile.mjs"], "npm run build:deployment-profile");
    run(dir, ["scripts/gen-prompts.mjs"], "npm run build:prompts");
    if (existsSync(join(dir, "scripts/build-workflow-library.mjs"))) run(dir, ["scripts/build-workflow-library.mjs"], "npm run build:workflow-library");
    return run(dir, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/lib/model-surface.mjs", ...flags], "rendering the model-facing surface");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let failed = false;

/* 1. RELABELLED ------------------------------------------------------------------------------------------ */
const text = PACK ? render([], [], PACK) : render([["50-relabelled.json", FIXTURE]], []);
if (DUMP) writeFileSync(DUMP, text);
const sections = text.split(/^(?==== )/m);
const problems = [];
const perKind = new Map();
for (const s of sections) {
  const title = s.slice(4, s.indexOf("\n"));
  const body = s.slice(s.indexOf("\n") + 1);
  for (const h of hits(body)) {
    const line = body.slice(body.lastIndexOf("\n", h.index) + 1, body.indexOf("\n", h.index) < 0 ? undefined : body.indexOf("\n", h.index));
    if (ALLOW.some((a) => a.section.test(title) && a.phrase.test(line))) continue;
    problems.push({ title, word: h.word, line: line.trim().slice(0, 200) });
    const kind = title.split(" :: ")[1] ?? title;
    perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
  }
}
const toolCount = sections.filter((s) => / :: tool :: /.test(s.slice(0, 200))).length;
const subagentCount = sections.filter((s) => / :: roster entry/.test(s.slice(0, 200))).length;
if (problems.length) {
  failed = true;
  console.error(`check-agent-vocabulary: RELABELLED profile — ${problems.length} base word(s) in what the model reads (${[...perKind].map(([k, n]) => `${k}: ${n}`).join(", ")}).`);
  console.error("A deployment whose profile renames the domains must get an agent that speaks only the profile's words. Translate at the boundary (agent/lib/agent-vocabulary.ts); never rename what is stored.\n");
  const shown = new Map();
  for (const p of problems) {
    const key = `${p.title}\u0000${p.line}`;
    if (shown.has(key)) continue;
    shown.set(key, true);
    if (shown.size <= 400) console.error(`  - [${p.title}] "${p.word}": ${p.line}`);
  }
  if (shown.size > 400) console.error(`  … and ${shown.size - 400} more line(s)`);
} else {
  const unfilledR = linesWith(text, UNFILLED);
  if (unfilledR.length) {
    failed = true;
    console.error(`check-agent-vocabulary: ${unfilledR.length} role placeholder(s) reached the model unfilled:\n${unfilledR.slice(0, 40).map((l) => `  - ${l}`).join("\n")}`);
  }
  // …and the profile's own words are what stands there: each record word the profile declares is read by the model,
  // in the prompts and in the tool descriptions (the two places base text writes a record placeholder).
  if (!PACK) {
    const declared = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const words = [
      declared.vocabulary?.account?.singular, declared.vocabulary?.account?.plural,
      declared.domains?.deployments?.label?.singular, declared.domains?.deployments?.label?.plural,
      declared.domains?.implementations?.label?.singular, declared.domains?.implementations?.group_label?.singular,
    ].filter((w) => typeof w === "string" && w.trim()).map((w) => w.trim().toLowerCase());
    const read = (kind) => sections.filter((s) => new RegExp(` :: ${kind}( ::|$)`, "m").test(s.slice(0, s.indexOf("\n")))).join("\n").toLowerCase();
    const prompts = read("prompt");
    const tools = read("tool");
    const missing = [...new Set(words)].filter((w) => !prompts.includes(w) && !tools.includes(w));
    const unspoken = [declared.vocabulary?.account?.plural].filter((w) => typeof w === "string" && (!prompts.includes(w.toLowerCase()) || !tools.includes(w.toLowerCase())));
    if (missing.length || unspoken.length) {
      failed = true;
      console.error(`check-agent-vocabulary: RELABELLED profile — the profile's own words are missing from what the model reads: ${[...missing, ...unspoken].map((w) => `"${w}"`).join(", ")}. A record placeholder ({account}, {deployment}, {implementation}, {rollout}) must be filled with the profile's word.`);
    } else {
      console.log(`check-agent-vocabulary: relabelled profile — the profile's record words (${[...new Set(words)].join(", ")}) are what the model reads in the prompts and the tool descriptions`);
    }
  }
  console.log(`check-agent-vocabulary: ${PACK ? `pack ${PACK} under its own profile` : "relabelled profile"} — ${sections.length} model-facing sections (${toolCount} tool definitions across the root and ${subagentCount} subagents, prompts, skills, sandbox files, briefing, tool results) carry no base word`);
}

/* 2. DEFAULT --------------------------------------------------------------------------------------------- */
const snapshot = PACK ? null : render([], ["--snapshot", "--no-results"]);
if (!PACK) {
  // Everything the default deployment's model reads, tool results and the provisioned workflow library included
  // (the snapshot above has neither): no record word as prose, and no placeholder unfilled.
  const full = render([], []);
  const prose = recordProse(full);
  const unfilledFull = linesWith(full, UNFILLED);
  if (prose.length || unfilledFull.length) {
    failed = true;
    if (prose.length) console.error(`check-agent-vocabulary: DEFAULT profile — the model reads a record word as prose in ${prose.length} place(s). Base text writes a placeholder the profile fills ({account}, {deployment}, {implementation}, {rollout}); the default profile's words are neutral:\n${[...new Set(prose)].slice(0, 60).map((l) => `  - ${l}`).join("\n")}`);
    if (unfilledFull.length) console.error(`check-agent-vocabulary: DEFAULT profile — ${unfilledFull.length} placeholder(s) reached the model unfilled (tool results and the workflow library included):\n${unfilledFull.slice(0, 40).map((l) => `  - ${l}`).join("\n")}`);
  } else {
    console.log(`check-agent-vocabulary: default profile — no record word (customer, deployment, implementation, rollout) is read as prose in ${full.split(/^(?==== )/m).length} model-facing sections (prompts, tools, roster, briefing, workflow library, tool results), and every placeholder is filled`);
  }
  const legacy = linesWith(snapshot, LEGACY_AS_WORD);
  const unfilled = linesWith(snapshot, UNFILLED);
  if (legacy.length || unfilled.length) {
    failed = true;
    if (legacy.length) console.error(`check-agent-vocabulary: DEFAULT profile — the model reads the member's legacy word as a word in ${legacy.length} line(s). Write a role placeholder ({member}, {owner}) the profile fills:\n${legacy.slice(0, 40).map((l) => `  - ${l}`).join("\n")}`);
    if (unfilled.length) console.error(`check-agent-vocabulary: DEFAULT profile — ${unfilled.length} role placeholder(s) reached the model unfilled:\n${unfilled.slice(0, 40).map((l) => `  - ${l}`).join("\n")}`);
  } else {
    console.log("check-agent-vocabulary: default profile — the member's legacy word appears in no model-facing text (only inside contract identifiers), and every role placeholder is filled");
  }
}
if (PACK) {
  console.log(`check-agent-vocabulary: pack mode (${PACK}) — the default-profile snapshot is not compared`);
} else if (UPDATE) {
  writeFileSync(BASELINE, snapshot);
  console.log(`check-agent-vocabulary: default surface re-snapshotted to ${BASELINE.slice(ROOT.length)}`);
} else if (!existsSync(BASELINE)) {
  failed = true;
  console.error(`check-agent-vocabulary: no baseline at ${BASELINE.slice(ROOT.length)}; run with --update-baseline`);
} else {
  const want = readFileSync(BASELINE, "utf8");
  if (want === snapshot) {
    console.log(`check-agent-vocabulary: default profile — rendered prompts, tools and roster are byte-identical to the baseline (${snapshot.length} bytes)`);
  } else {
    failed = true;
    const a = want.split("\n"), b = snapshot.split("\n");
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    const section = [...a.slice(0, i + 1)].reverse().find((l) => l.startsWith("=== ")) ?? "(start)";
    console.error(`check-agent-vocabulary: DEFAULT profile — the model-facing surface changed (first difference at line ${i + 1}, in ${section}):`);
    console.error(`  baseline: ${JSON.stringify(a[i] ?? "<end>").slice(0, 300)}`);
    console.error(`  now:      ${JSON.stringify(b[i] ?? "<end>").slice(0, 300)}`);
    console.error("A deployment that relabels nothing must read exactly what it read before. If the change is deliberate, re-snapshot with --update-baseline and say why in the PR.");
  }
}

/* 3. PINNED FOLDERS -------------------------------------------------------------------------------------- */
// A deployment whose data room was filled before the folder names were a profile setting pins the names it has.
// Its model must read what it read then, to the byte: every prompt, every tool description, every path.
// The before-image is never re-snapshotted. It has been edited by hand once, on three lines that have nothing to do
// with folders: the examples in trigger_workflow's and run_app's descriptions named workflows and an app of one
// line of work's library ('route-incident', 'qbr-prep', 'sbi-qbr'), which every deployment's model then read. The
// same three lines changed in default-surface.txt; no path, folder or any other line differs. And once more
// (mold_v1-184), on root-prompt wording only: the "Fan out" bullet in delegate-rules says specialists called in one
// step return together, and five passages of prompt-core.md were tightened to keep the stable prompt under its word
// budget (the publish rules, the missing-library rule, memory, browsers, "ask before expanding"). The same line edits
// are in default-surface.txt, applied as one diff to both; no path, folder or any other line moved. And once more
// (mold_v1-184, per-result delegation): that sentence keeps #121's advice (specialists called together MAY return
// together; get the person's answer first or run that one alone) and adds how a "reports later" result arrives; the
// same lines in both files. And once more (mold_v1-184, live rig 2026-10-06): "get that first" became "ask for that
// first, in a step of its own", because a model read it as asking in the same step as the other specialist call; the
// same lines in both files.
if (!PACK) {
  const pinned = render([["50-legacy-folders.json", LEGACY_FOLDERS_PIN]], ["--snapshot", "--no-results"]);
  const before = readFileSync(SURFACE_BEFORE, "utf8");
  if (pinned === before) {
    console.log(`check-agent-vocabulary: pinned folders — a profile that pins the former folder names reads byte for byte what the default deployment read before folder names became a profile setting (${pinned.length} bytes)`);
  } else {
    failed = true;
    const a = before.split("\n"), b = pinned.split("\n");
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    const section = [...a.slice(0, i + 1)].reverse().find((l) => l.startsWith("=== ")) ?? "(start)";
    console.error(`check-agent-vocabulary: PINNED FOLDERS — a deployment that pins its stored folder names no longer reads what it read before (first difference at line ${i + 1}, in ${section}):`);
    console.error(`  before: ${JSON.stringify(a[i] ?? "<end>").slice(0, 300)}`);
    console.error(`  now:    ${JSON.stringify(b[i] ?? "<end>").slice(0, 300)}`);
    console.error("A deployment that already holds files keeps its folder names by pinning them, and nothing its model reads may change. This fixture is a before-image and is never re-snapshotted: a deliberate change to a prompt is made so that it fills to the same text under the pin.");
  }
}

process.exit(failed ? 1 : 0);
