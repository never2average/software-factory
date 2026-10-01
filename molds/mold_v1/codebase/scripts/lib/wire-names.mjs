/**
 * The THREE wire identifiers a stamped deployment speaks, and the one place that
 * knows what they currently are: the tool names it advertises, the environment
 * variables it reads, and the keys it keeps in a person's browser.
 *
 * Why a module rather than a grep. The four specialists that actually run in a
 * deployment ship in a PACK, applied into `agent/subagents/` — a check that
 * walks the checked-in tree has already, once, certified an unfixed deployment
 * green because the thing it was checking was not in the tree it walked. So the
 * tool names here are read by CONSTRUCTING the real tool list, exactly as
 * `lib/mcp-server.ts` and the stdio package do, and the file walk below covers
 * `agent/subagents/` so an applied pack is inside it either way.
 *
 * Consumed by scripts/check-wire-names.mjs (the repo gate), by
 * scripts/build-agent-cli.mjs (the package gate) and by scripts/test-wire-names.mjs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as tools from "../../setup/workspace-tools.mjs";

const { availableTools, createTools } = tools;

export const ROOT = new URL("../..", import.meta.url).pathname;

/**
 * A tool context that satisfies `createTools` and reaches nothing.
 *
 * Every field is here because some tool's DEFINITION (not its handler) reads it
 * while the list is being built — `customFields` shapes two input schemas, and
 * `parseClaudeTranscript` decides whether the session tools are served at all.
 * Handlers are never called, so the api/blob stubs only have to exist.
 */
export const inertToolContext = () => ({
  api: async () => ({}),
  getOrg: () => null,
  setOrg: () => {},
  orgSelectedVia: "a test",
  identity: async () => null,
  signInHint: "(inert)",
  actor: "inert",
  opsUrl: "https://example.com",
  webOrigin: "https://example.com",
  readSpec: async () => "",
  customFields: undefined,
  blobStore: () => null,
  // Present so the session tools are INCLUDED: a gate that silently checks a
  // smaller tool list than the one served is worth nothing.
  parseClaudeTranscript: () => null,
  sessionToSyncItem: () => null,
});

/** The tool list both transports serve, built the way both transports build it. */
export function servedTools() {
  const ctx = inertToolContext();
  return availableTools(createTools(ctx), ctx);
}

/** Exactly what `tools/list` hands a connecting assistant: names, nothing else. */
export const advertisedToolNames = () => servedTools().map((t) => t.name);

/**
 * Every deliberate backward-compatibility alias in the whole system, derived
 * from the code that honours it. This is the gate's ONLY allowance, and a name
 * is on it only because something really still answers to it:
 *   - `aliases` on a tool definition (setup/workspace-tools.mjs) — accepted by
 *     tools/call, never advertised;
 *   - `LEGACY_ENV_NAMES` (setup/workspace-tools.mjs) — the package's old variables;
 *   - `LEGACY_APP_ENV_NAMES` (agent/lib/compat-env.ts) — the two the deployed
 *     app and agent read;
 *   - `LEGACY_STORAGE_KEYS` (lib/browser-storage.ts) — the browser keys.
 * The last two are TypeScript, so they are read as text rather than imported.
 * A table that is ABSENT contributes nothing — that is a tree from before the
 * migration, and the gate should report its offenders rather than crash on the
 * way to doing so. A table that EXISTS but parses empty throws, because a
 * silently blank allowlist is how a gate turns into false green.
 */
export function declaredAliases() {
  const out = [...servedTools().flatMap((t) => t.aliases ?? []), ...Object.values(tools.LEGACY_ENV_NAMES ?? {})];
  out.push(...tableValues("agent/lib/compat-env.ts", "LEGACY_APP_ENV_NAMES"));
  out.push(...tableValues("lib/browser-storage.ts", "LEGACY_STORAGE_KEYS"));
  return out;
}

/**
 * The string values of an object literal `export const <name> … = { … }` in a .ts file.
 *
 * The declaration is matched with a left boundary that rejects `_`, because
 * `LEGACY_STORAGE_KEYS` ENDS with `STORAGE_KEYS` and a plain substring search
 * silently read the wrong table — it reported the legacy keys as if they were
 * the current ones, which is the precise inversion of what this gate is for. The
 * closing brace is found by counting, not by looking for `};`, because these
 * tables end `} as const;` and `}` on its own.
 */
export function tableValues(relPath, tableName) {
  const full = join(ROOT, relPath);
  if (!existsSync(full)) return [];
  const text = readFileSync(full, "utf8");
  const decl = new RegExp(`(?<![A-Za-z0-9_])${tableName}\\s*(?::[^=]*)?=`).exec(text);
  if (!decl) return [];
  const open = text.indexOf("{", decl.index);
  if (open < 0) throw new Error(`wire-names: could not read ${tableName} in ${relPath}`);
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) { close = i; break; }
  }
  if (close < 0) throw new Error(`wire-names: ${tableName} in ${relPath} is not a closed object literal`);
  const values = [...text.slice(open, close).matchAll(/:\s*["']([^"']+)["']/g)].map((m) => m[1]);
  if (!values.length) throw new Error(`wire-names: ${tableName} in ${relPath} parsed as empty; refusing a blank allowlist`);
  return values;
}

/**
 * The source the gate walks.
 *
 * The operator tooling (scripts/operator/) is walked with the rest of scripts/
 * since it moved there with neutral names. `docs/**` is out because it is prose,
 * and prose has to be ABLE to say what the old name was.
 */
export const WALK_DIRS = ["app", "agent", "components", "lib", "setup", "scripts"];
export const WALK_SKIP = new Set(["node_modules", ".git", ".next", "dist", "fixtures"]);
const SOURCE = /\.(ts|tsx|mjs|js|jsx)$/;

/** Every source file the gate reads, as { path (repo-relative), text }. */
export function walkSources(dirs = WALK_DIRS) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (WALK_SKIP.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (SOURCE.test(entry) && !entry.endsWith(".generated.ts")) out.push({ path: relative(ROOT, full), text: readFileSync(full, "utf8") });
    }
  };
  for (const d of dirs) walk(join(ROOT, d));
  return out;
}
