// Discovers the subagents under agent/subagents/ and generates everything the rest of the codebase needs to know
// about them, so ADDING A SUBAGENT IS ADDING A DIRECTORY — no list anywhere is edited by hand:
//   app/_components/subagent-meta.generated.ts   keys, display names, summaries, skills, tool roster (the UI), in the
//                                                profile's words: the text and tool names the model reads for them
//   agent/lib/subagent-registry.generated.ts     keys, labels, extra data-room path templates (the agent + scripts)
// A subagent may carry an optional `subagent.json` next to its agent.ts:
//   { "name": "Display Name", "summary": "one line for the UI", "dataroomPaths": ["Customers/{customer_id}/filings/**"] }
// Without it the name is the title-cased key and the summary is the first sentence of the agent.ts description.
// See docs/SUBAGENT_PACKS.md. Re-run after changing any subagent:  npm run build:subagent-meta
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { excludedSpecialists } from "./lib/profile-specialists.mjs";
import { restoreHidden } from "./eve-build.mjs";

// A build that died while it had excluded specialists hidden (scripts/eve-build.mjs) left them out of the tree:
// put them back before discovering anything.
restoreHidden();

const ROOT = new URL("..", import.meta.url).pathname;
const SUB = join(ROOT, "agent/subagents");

/** First `description: "..."` string in a source text (handles the prettier
 *  line break after the key, escaped quotes inside, and the `speak("...")` a
 *  base specialist wraps its description in — see agent/lib/agent-vocabulary.ts). */
function extractDescription(src) {
  const m = src.match(/description:\s*\n?\s*(?:speak\(\s*)?"((?:[^"\\]|\\.)*)"/);
  return m ? JSON.parse(`"${m[1]}"`) : null;
}

/** Tool description: inline in the subagent's tool file, else resolved from
 *  the shared agent/tools/<name>.ts or the export it re-exports from lib. */
function toolDescription(subDir, name) {
  const local = join(subDir, "tools", `${name}.ts`);
  const localSrc = existsSync(local) ? readFileSync(local, "utf8") : "";
  const inline = extractDescription(localSrc);
  if (inline) return inline;
  const shared = join(ROOT, "agent/tools", `${name}.ts`);
  if (existsSync(shared)) {
    const d = extractDescription(readFileSync(shared, "utf8"));
    if (d) return d;
  }
  // Re-export like `export { webSearchTool as default } from "#lib/tools.js"`.
  const re = localSrc.match(/export\s*{\s*(\w+)\s+as\s+default\s*}/);
  if (re) {
    for (const lib of [
      "agent/lib/tools.ts",
      "agent/lib/dataroom-tools.ts",
      "agent/lib/artifact-render-tools.ts",
      "agent/lib/sync-tools.ts",
      "agent/lib/signoff-tools.ts",
    ].filter((f) => existsSync(join(ROOT, f)))) {
      const p = join(ROOT, lib);
      if (!existsSync(p)) continue;
      const src = readFileSync(p, "utf8");
      const at = src.indexOf(`export const ${re[1]}`);
      if (at !== -1) {
        const d = extractDescription(src.slice(at, at + 2000));
        if (d) return d;
      }
    }
  }
  return null;
}

/**
 * A directory name as a display name: "data-migration" -> "Data Migration". A word that is a record's stored name
 * (the directory of the customer-context and deployment specialists, which never moves) is written as that record's
 * placeholder, so the name a person reads is the profile's word for it under every profile: "{Account} Context",
 * "{Deployment}" (filled where the roster is spoken, scripts/lib/speak-subagent-meta.mjs).
 */
const RECORD_PLACEHOLDER = { customer: "{Account}", customers: "{Accounts}", deployment: "{Deployment}", deployments: "{Deployments}", implementation: "{Implementation}", implementations: "{Implementations}", rollout: "{Rollout}", rollouts: "{Rollouts}" };
const titleCase = (key) => key.split("-").map((w) => (Object.hasOwn(RECORD_PLACEHOLDER, w) ? RECORD_PLACEHOLDER[w] : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
const firstSentence = (text) => (text.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? text).replace(/\s+/g, " ").trim();
const TEMPLATE_OK = /^[A-Za-z][A-Za-z0-9_-]*(\/(\{[a-z_]+\}|[A-Za-z0-9_.{}-]+))*\/(\*\*|[A-Za-z0-9_.{}-]+)$/;

// The generator must refuse what the data room would refuse: compileTemplate() in agent/lib/dataroom-store.ts
// throws at MODULE LOAD on an unknown domain or token, so one bad template in one subagent.json would take down
// every data-room tool. The domains and tokens are read from the source files, so they cannot drift.
function listBetween(file, startMarker, endMarker, pattern) {
  const src = readFileSync(join(ROOT, file), "utf8");
  const at = src.indexOf(startMarker);
  if (at === -1) return null;
  const body = src.slice(at, src.indexOf(endMarker, at));
  return [...body.matchAll(pattern)].map((m) => m[1]);
}
const DOMAINS = listBetween("agent/lib/dataroom-schema.ts", "export const dataroomDomainSchema = z.enum([", "]);", /^\s*"([A-Za-z]+)",/gm);
const TOKENS = listBetween("agent/lib/dataroom-store.ts", "const TOKEN_PATTERNS", "\n};", /^\s*([a-z_]+):/gm);
function templateProblem(t) {
  if (typeof t !== "string" || !TEMPLATE_OK.test(t) || t.includes("..")) return "is not a data-room path template";
  const segments = t.split("/");
  if (DOMAINS && !DOMAINS.includes(segments[0])) return `starts with "${segments[0]}", which is not a data-room domain (${DOMAINS.join(", ")})`;
  if (segments.slice(0, -1).includes("**")) return "uses ** before the final segment";
  for (const m of t.matchAll(/\{([a-z_]+)\}/g)) {
    if (TOKENS && !TOKENS.includes(m[1])) return `uses unknown token {${m[1]}} (known: ${TOKENS.join(", ")})`;
  }
  return null;
}

const meta = {};
const extraTemplates = [];
// A profile's specialists.exclude: the directory stays, the specialist is left out of everything generated from
// here (UI lists, labels, the workflow author's list, data-room templates) and out of the eve build
// (scripts/eve-build.mjs). The default profile excludes nothing.
const EXCLUDED = new Set(excludedSpecialists(ROOT));
for (const name of readdirSync(SUB).sort()) {
  const dir = join(SUB, name);
  // A directory is a subagent only if it declares one; stray folders are not registered.
  if (!existsSync(join(dir, "agent.ts"))) continue;
  if (EXCLUDED.has(name)) continue;
  let decl = {};
  if (existsSync(join(dir, "subagent.json"))) {
    try {
      decl = JSON.parse(readFileSync(join(dir, "subagent.json"), "utf8"));
    } catch (error) {
      console.error(`agent/subagents/${name}/subagent.json is not valid JSON: ${error.message}`);
      process.exit(1);
    }
  }
  for (const t of decl.dataroomPaths ?? []) {
    const problem = templateProblem(t);
    if (problem) {
      console.error(`agent/subagents/${name}/subagent.json: dataroomPaths entry ${JSON.stringify(t)} ${problem}`);
      process.exit(1);
    }
    if (!extraTemplates.includes(t)) extraTemplates.push(t);
  }
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim() : "");
  // Skills: a one-paragraph summary plus the named SKILL.md procedures —
  // the dialog doesn't render the full doc.
  const skillsDir = join(dir, "skills");
  const skillNames = existsSync(skillsDir)
    ? readdirSync(skillsDir).filter((f) => existsSync(join(skillsDir, f, "SKILL.md")))
    : [];
  const skillsSummary = (read("skills/README.md") || "")
    .replace(/^#.*$/gm, "")
    .trim()
    .split(/\n\s*\n/)[0]
    ?.replace(/\s+/g, " ")
    .trim() ?? "";
  const tools = existsSync(join(dir, "tools"))
    ? readdirSync(join(dir, "tools"))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => f.replace(/\.ts$/, ""))
        .sort()
        .map((t) => ({ name: t, description: toolDescription(dir, t) }))
    : [];
  const description = extractDescription(read("agent.ts")) ?? "";
  meta[name] = {
    name: typeof decl.name === "string" && decl.name.trim() ? decl.name.trim() : titleCase(name),
    summary: typeof decl.summary === "string" && decl.summary.trim() ? decl.summary.trim() : firstSentence(description),
    description,
    skillNames,
    skillsSummary,
    tools,
  };
}

// What the UI shows is spoken in the deployment's words, the way the model reads it (scripts/lib/speak-subagent-meta.mjs).
// The registry below keeps the base text: agent code speaks it where the model reads it.
function spokenMeta() {
  const run = (args, input) => spawnSync(process.execPath, args, { cwd: ROOT, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  const printed = run([join(ROOT, "scripts/gen-deployment-profile.mjs"), "--print"]);
  if (printed.status !== 0) {
    console.error(`gen-subagent-meta: the deployment profile does not merge, so the UI roster cannot be spoken in its words:\n${printed.stderr || printed.stdout}`);
    process.exit(1);
  }
  const profile = JSON.parse(printed.stdout.trim().split("\n").pop());
  const spoken = run(
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(ROOT, "scripts/lib/speak-subagent-meta.mjs")],
    JSON.stringify({ profile, specialists: Object.keys(meta), meta }),
  );
  if (spoken.status !== 0) {
    console.error(`gen-subagent-meta: speaking the UI roster in the profile's words failed:\n${spoken.stderr || spoken.stdout}`);
    process.exit(1);
  }
  return JSON.parse(spoken.stdout);
}

const registry = `// AUTO-GENERATED by scripts/gen-subagent-meta.mjs — do not edit by hand.
// The agent-side view of the declared subagents. Plain data, no imports, so scripts can load it too.

/** Every declared subagent, discovered from agent/subagents/<key>/agent.ts. */
export const SUBAGENT_KEYS: readonly string[] = ${JSON.stringify(Object.keys(meta), null, 2)};

/** Display label per subagent key. */
export const SUBAGENT_LABELS: Record<string, string> = ${JSON.stringify(
  Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v.name])),
  null,
  2,
)};

/** One-line summary per subagent key. */
export const SUBAGENT_SUMMARIES: Record<string, string> = ${JSON.stringify(
  Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v.summary])),
  null,
  2,
)};

/** Data-room path templates contributed by subagents (subagent.json "dataroomPaths"), appended to dm.md's own. */
export const EXTRA_DATAROOM_PATH_TEMPLATES: readonly string[] = ${JSON.stringify(extraTemplates, null, 2)};
`;
writeFileSync(join(ROOT, "agent/lib/subagent-registry.generated.ts"), registry);

const uiMeta = spokenMeta();
const out = `// AUTO-GENERATED by scripts/gen-subagent-meta.mjs — do not edit by hand.
// Re-run after changing agent/subagents/*: node scripts/gen-subagent-meta.mjs

export interface SubagentToolMeta {
  readonly name: string;
  readonly description: string | null;
}

export interface SubagentMeta {
  /** Display name: subagent.json "name", else the title-cased key. */
  readonly name: string;
  /** One line for lists: subagent.json "summary", else the first sentence of the description. */
  readonly summary: string;
  readonly description: string;
  readonly skillNames: readonly string[];
  readonly skillsSummary: string;
  readonly tools: readonly SubagentToolMeta[];
}

export const SUBAGENT_META: Record<string, SubagentMeta> = ${JSON.stringify(uiMeta, null, 2)};

/** Every declared subagent, discovered from agent/subagents/<key>/agent.ts. */
export const SUBAGENT_KEYS: readonly string[] = Object.keys(SUBAGENT_META);
`;
writeFileSync(join(ROOT, "app/_components/subagent-meta.generated.ts"), out);
console.log(
  "generated:",
  Object.entries(meta)
    .map(([k, v]) => `${k}(${v.tools.length} tools, ${v.skillNames.length} skills)`)
    .join(", "),
);
