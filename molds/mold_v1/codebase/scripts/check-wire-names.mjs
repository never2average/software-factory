#!/usr/bin/env node
/**
 * THE WIRE-NAME GATE — the base product's role name stays out of the identifiers
 * a stamped deployment speaks to the outside world.
 *
 * `check:ui-vocabulary` keeps the base product's words out of text a person READS in the app.
 * PR #46's own-name gate keeps it out of a published package's file names, bins,
 * README and config folder. Both deliberately exempted identifiers containing
 * `_`, and that exemption is exactly what left the old status tool — the single most
 * prominent identifier in the whole protocol, whose description begins "START
 * HERE… every other tool depends on it" — as the one tool of 59 named after a
 * role the buying desk has never heard of.
 *
 * That exemption is now spent. This gate covers the three categories it left:
 *
 *   1. ADVERTISED TOOL NAMES. Read by BUILDING the real tool list, the way
 *      lib/mcp-server.ts and the stdio package build it — not by grepping. A
 *      test that walks the checked-in tree has already certified an unfixed
 *      deployment green here once, because what actually ships is applied into
 *      the tree by a pack after the walk would have run.
 *   2. ENVIRONMENT VARIABLES a source file reads. A person types these into an
 *      MCP config by hand and then lives with them for months.
 *   3. BROWSER-STORAGE KEYS a source file reads or writes. One of these IS a
 *      signed-in analyst's session.
 *
 * THE ONLY ALLOWANCE is a declared backward-compatibility alias (scripts/lib/wire-names.mjs:
 * `aliases` on a tool definition; there are none today: the old names are no longer read).
 * Everything else fails: the old ones may stand, a new one
 * may not be born.
 *
 * The operator tooling (scripts/operator/, `npm run operator:*`) is walked like
 * the rest of scripts/: its own environment variables are the `WORKSPACE_*` names
 * (scripts/operator/lib/operator.mjs).
 */
import { advertisedToolNames, declaredAliases, servedTools, tableValues, walkSources } from "./lib/wire-names.mjs";
import { envNamesIn, identifierCarriesBaseWord, storageKeysIn, BASE_PRODUCT_WORD } from "./lib/agent-cli.mjs";

const problems = [];
const say = (where, what) => problems.push(`${where}: ${what}`);

const aliases = new Set(declaredAliases().map((a) => a.toLowerCase()));
const allowed = (name) => aliases.has(String(name).toLowerCase());

/* 1. What a connecting assistant is TOLD the tools are called. ------------- */
for (const name of advertisedToolNames()) {
  if (identifierCarriesBaseWord(name)) {
    say("setup/workspace-tools.mjs", `the tool "${name}" is advertised under the base product's role name ("${BASE_PRODUCT_WORD}"). Advertise a neutral name and keep the old one in \`aliases\`, which tools/call accepts and tools/list never shows.`);
  }
}

/* An alias must stay UNADVERTISED, or the migration has quietly become a rename
 * in both directions and new assistants start learning the old name again. */
const advertised = new Set(advertisedToolNames());
for (const tool of servedTools()) {
  for (const alias of tool.aliases ?? []) {
    if (advertised.has(alias)) say("setup/workspace-tools.mjs", `"${alias}" is both advertised and an alias of ${tool.name}; an alias exists to be accepted, never offered`);
  }
}

/* 3a. The canonical key table itself. Every call site goes through STORAGE_KEYS,
 * so a new key is born HERE — as a field name nothing below would recognise. */
for (const key of tableValues("lib/browser-storage.ts", "STORAGE_KEYS")) {
  if (identifierCarriesBaseWord(key)) say("lib/browser-storage.ts", `STORAGE_KEYS holds "${key}". A key a person's browser carries is named after what it stores, never after a role the deployment has never heard of.`);
}

/* 2 and 3b. Every environment variable read, and every storage key touched.
 *
 * `wire-name-ok: <reason>` on the line is the one escape hatch. It exists for scripts/test-wire-names.mjs,
 * which has to CONSTRUCT an offender of each kind to prove this gate catches one —
 * a gate whose failing case is never exercised is a gate that quietly stops working. */
for (const file of walkSources()) {
  const lines = file.text.split("\n");
  const lineOf = (index) => file.text.slice(0, index).split("\n").length;
  const deliberate = (index) => /wire-name-ok:/.test(lines[lineOf(index) - 1] ?? "");
  for (const hit of envNamesIn(file.text)) {
    if (!identifierCarriesBaseWord(hit.name) || allowed(hit.name) || deliberate(hit.index)) continue;
    say(`${file.path}:${lineOf(hit.index)}`, `reads the environment variable ${hit.name}. Read a neutral name (WORKSPACE_*).`);
  }
  for (const hit of storageKeysIn(file.text)) {
    if (!identifierCarriesBaseWord(hit.name) || allowed(hit.name) || deliberate(hit.index)) continue;
    say(`${file.path}:${lineOf(hit.index)}`, `uses the browser-storage key "${hit.name}". Name it after what it stores, in lib/browser-storage.ts STORAGE_KEYS.`);
  }
}

if (problems.length) {
  console.error(`check-wire-names: ${problems.length} identifier(s) on the wire carry the base product's role name "${BASE_PRODUCT_WORD}".`);
  console.error("A general-purpose base is stamped for verticals that have no such role. Name it after what it is (WORKSPACE_*, workspace-*, workspace_*).\n");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `check-wire-names: ${advertisedToolNames().length} advertised tool names, every environment variable and every storage key are use-case agnostic ` +
    `(${aliases.size} declared backward-compatibility alias${aliases.size === 1 ? "" : "es"} still honoured)`,
);
