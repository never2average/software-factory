#!/usr/bin/env node
/**
 * THE AGENT-VOCABULARY GATE — a deployment that renames the base product's domains gets an agent that speaks
 * only its own words.
 *
 * `check:vocabulary` keeps "FDE" out of the UI; `check:wire-names` keeps it out of the identifiers a coding
 * assistant is served. Neither looks at what the eve agent's MODEL reads, and that is where it survived: a
 * research deployment whose profile says Customers are "Companies", Deployments are "Coverage reports" and
 * Implementation is "Portfolios" had a live agent reasoning 'Given the deployment mapping: Customers/ is shown
 * as "Companies". The data room has companies under Customers/{customer_id}/filings/' — because the root
 * prompt was a customer-management persona, the tools were list_customers / customer_id, the paths were
 * Customers/…, and the per-turn briefing TOLD it the identifiers do not change.
 *
 * This gate builds two throwaway copies of this checkout and renders the complete model-facing surface of each
 * with scripts/lib/model-surface.mjs (system prompts, the per-turn briefing, every tool's name, description
 * and parameters, the subagent roster and every subagent's prompt, skills and sandbox files, and the results
 * of real offline tool calls):
 *
 *   1. RELABELLED — profiles/00-default.json + scripts/fixtures/agent-vocabulary/50-relabelled.json (a copy of
 *      the hfc-research pack's profile). No base word may appear anywhere: customer(s), deployment(s),
 *      implementation(s), rollout(s), FDE(s). Matched as whole words case-insensitively, where `_`, `-`, `/`,
 *      `.` and a camelCase hump are word boundaries too — `customer_id`, `list_customers`, `deploymentId` and
 *      `Customers/` are exactly the leaks this exists for, and a plain \b would pass every one of them.
 *   2. DEFAULT — profiles/00-default.json alone. The rendered prompts, tools and roster must be byte-identical
 *      to scripts/fixtures/agent-vocabulary/default-surface.txt, the snapshot taken BEFORE the vocabulary work.
 *      A deployment that relabels nothing must not pay for the ones that do.
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

const ROOT = new URL("..", import.meta.url).pathname;
const FIXTURES = join(ROOT, "scripts", "fixtures", "agent-vocabulary");
const FIXTURE = process.env.AGENT_VOCABULARY_FIXTURE || join(FIXTURES, "50-relabelled.json");
const BASELINE = join(FIXTURES, "default-surface.txt");
const UPDATE = process.argv.includes("--update-baseline");
/** --dump <file>: also write the relabelled surface there, to read what the model gets. */
const DUMP = process.argv.includes("--dump") ? process.argv[process.argv.indexOf("--dump") + 1] : null;
const argAfter = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
const PACK = argAfter("--pack");
const ALLOW_FILE = argAfter("--allow");

/** The base product's words, as whole tokens. */
const BASE_WORDS = ["customer", "customers", "deployment", "deployments", "implementation", "implementations", "rollout", "rollouts", "fde", "fdes"];

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
  for (const entry of ["agent", "lib", "data", "scripts", "dm.md", "package.json", "docs"]) {
    if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true, filter: (src) => !src.includes("__pycache__") });
  }
  mkdirSync(join(dir, "profiles"), { recursive: true });
  // gen-subagent-meta.mjs also writes the UI's copy of the registry.
  mkdirSync(join(dir, "app", "_components"), { recursive: true });
  cpSync(join(ROOT, "profiles", "00-default.json"), join(dir, "profiles", "00-default.json"));
  for (const [name, file] of extraProfiles) cpSync(file, join(dir, "profiles", name));
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
  console.log(`check-agent-vocabulary: ${PACK ? `pack ${PACK} under its own profile` : "relabelled profile"} — ${sections.length} model-facing sections (${toolCount} tool definitions across the root and ${subagentCount} subagents, prompts, skills, sandbox files, briefing, tool results) carry no base word`);
}

/* 2. DEFAULT --------------------------------------------------------------------------------------------- */
const snapshot = PACK ? null : render([], ["--snapshot", "--no-results"]);
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

process.exit(failed ? 1 : 0);
