#!/usr/bin/env node
/**
 * THE WIRE NAMES — what a connected assistant, a person's MCP config and an analyst's browser meet, and whether the
 * gate stops a new name that carries the base product's old role word.
 *
 * The old names (a status tool, the `_OPS_URL`-style variables, the browser keys) were once migrated additively: the
 * new name advertised and written, the old one still accepted and read. That window is closed: no live deployment
 * sets an old variable, a browser key from before 2026-09-23 is a session that expired long ago, and the published
 * package is 0.13. So this proves the closed state, which is just as invisible in a diff as the open one:
 *   1. tools/list offers workspace_status, and the old name is an unknown tool;
 *   2. every variable is read by its WORKSPACE_* name only;
 *   3. every browser key is read, written and removed under its own name only;
 *   4. wireNameGate fails a new offender in each of its three categories;
 *   5. check:wire-names passes on this tree.
 *
 * The old names are BUILT here from the word's one definition (BASE_PRODUCT_WORD), so this file does not spell them.
 * Offline: no network, no database, no browser. The storage suite drives a fake `window.localStorage` that records
 * what was written under which key.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BASE_PRODUCT_WORD } from "./lib/agent-cli.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const w = BASE_PRODUCT_WORD;
const U = w.toUpperCase();

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};

/* ------------------------------------------------------------------ 1. tools */
console.log("\nthe tool name");

const { handleRpc, serverInstructions, envValue } = await import("../setup/workspace-tools.mjs");
const { advertisedToolNames, servedTools, declaredAliases } = await import("./lib/wire-names.mjs");

const tools = servedTools();
const names = advertisedToolNames();
const status = tools.find((t) => t.name === "workspace_status");

check("the orientation tool is advertised as workspace_status", Boolean(status));
check("it still carries the START HERE description every other tool depends on", status.description.startsWith("START HERE."));
check("no advertised tool name carries the base product's role word", !names.some((n) => n.toLowerCase().includes(w)));
check(`all ${names.length} tools are served, so the check is not looking at a subset`, names.length >= 59);
check("no tool keeps an alias any more", declaredAliases().length === 0 && tools.every((t) => !t.aliases?.length));

const rpc = { tools, serverInfo: { name: "t", version: "0" }, instructions: "" };
const listed = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, rpc)).result.tools;
check("tools/list offers workspace_status", listed.some((t) => t.name === "workspace_status"));
check("tools/list hands back no `aliases` field at all", listed.every((t) => !("aliases" in t)));

const call = (name) => handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } }, rpc);
check("workspace_status is answered", !(await call("workspace_status")).error);
check("the status tool's old name is an unknown tool now", (await call(`${w}_status`)).error?.code === -32602);

const instructions = serverInstructions({ productName: "X", opsUrl: "https://x.example.com", signInHint: "h" });
check("the server's own instructions tell a new assistant to call workspace_status", instructions.includes("`workspace_status` first"));
check("the server's own instructions never carry the word", !instructions.toLowerCase().includes(w));

/* --------------------------------------------------------------- 2. env vars */
console.log("\nenvironment variables: read by their WORKSPACE_* name only");

{
  check("a set variable is read, trimmed", envValue({ WORKSPACE_OPS_URL: " https://new.example.com " }, "WORKSPACE_OPS_URL") === "https://new.example.com");
  check("a variable set nowhere is undefined, exactly as process.env.X would be", envValue({}, "WORKSPACE_ORG") === undefined);
  check("the old name of a variable is not read", envValue({ [`${U}_OPS_URL`]: "https://old.example.com" }, "WORKSPACE_OPS_URL") === undefined);

  // The deployed half: the Google audiences the app admits read WORKSPACE_CLI_CLIENT_ID only.
  const { cliClientIds } = await import("../agent/lib/google-audiences.ts");
  const saved = { ...process.env };
  try {
    delete process.env.WORKSPACE_CLI_CLIENT_ID;
    delete process.env.WORKSPACE_OAUTH_CLIENT_ID;
    process.env[`${U}_CLI_CLIENT_ID`] = "old-client.apps.googleusercontent.com";
    check("a project set only with the old name admits no CLI client", cliClientIds().length === 0);
    process.env.WORKSPACE_CLI_CLIENT_ID = "new-client.apps.googleusercontent.com";
    check("the WORKSPACE_* name admits it", cliClientIds().join() === "new-client.apps.googleusercontent.com");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

/* ---------------------------------------------------------- 3. browser keys */
console.log("\nbrowser storage: one key per value, under its own name");

{
  const makeStore = (seed = {}) => {
    const data = { ...seed };
    return {
      data,
      getItem: (k) => (k in data ? data[k] : null),
      setItem: (k, v) => { data[k] = String(v); },
      removeItem: (k) => { delete data[k]; },
    };
  };
  const oldToken = `${w}-google-token`;
  const local = makeStore({ [oldToken]: "a-session-from-before-the-rename" });
  globalThis.window = { localStorage: local, sessionStorage: makeStore() };

  const browser = await import("../lib/browser-storage.ts");
  const { STORAGE_KEYS, readStored, writeStored, removeStored } = browser;

  check("no key carries the base product's role word", Object.values(STORAGE_KEYS).every((k) => !k.toLowerCase().includes(w)));
  check("there is no legacy table any more", !("LEGACY_STORAGE_KEYS" in browser) && !("legacyKeyFor" in browser));
  check("a value stored under an old key is not read", readStored(STORAGE_KEYS.token) === null);

  writeStored(STORAGE_KEYS.token, "fresh");
  check("a write lands under the key", local.data[STORAGE_KEYS.token] === "fresh");
  check("and is what is read back", readStored(STORAGE_KEYS.token) === "fresh");
  removeStored(STORAGE_KEYS.token);
  check("signing out clears it", !(STORAGE_KEYS.token in local.data) && readStored(STORAGE_KEYS.token) === null);

  /* A browser with site data blocked THROWS on access; the app must render. */
  const hostile = { get localStorage() { throw new Error("site data blocked"); }, get sessionStorage() { throw new Error("blocked"); } };
  globalThis.window = hostile;
  check("a browser that blocks site data reads null rather than crashing the app", readStored(STORAGE_KEYS.token) === null);
  writeStored(STORAGE_KEYS.token, "x");
  removeStored(STORAGE_KEYS.token);
  check("and a write or a sign-out there is a no-op, not an exception", true);
  delete globalThis.window;

  const { startupScript } = await import("../lib/startup-fetch.ts");
  const { readFileSync } = await import("node:fs");
  check("the first-paint script reads only the current keys", !startupScript().toLowerCase().includes(w));
  check("and so does the theme script in the layout", !readFileSync(join(ROOT, "app/layout.tsx"), "utf8").toLowerCase().includes(w));
}

/* ------------------------------------------------------------------ 4. gate */
console.log("\nthe gate: a NEW offender fails in each category");

{
  const { wireNameGate, identifierCarriesBaseWord } = await import("./lib/agent-cli.mjs");
  const file = (path, body) => ({ path, bytes: Buffer.from(body, "utf8") });

  check("a name is an offender when a part of it IS the word", identifierCarriesBaseWord(`${w}_status`) && identifierCarriesBaseWord(`${U}_OPS_URL`) && identifierCarriesBaseWord(`${w}-google-token`));
  check("and not when it is not", !identifierCarriesBaseWord("workspace_status"));

  const clean = [
    file("x-tools.mjs", '    name: "workspace_status",\n'),
    file("x-mcp.mjs", "const a = process.env.WORKSPACE_OPS_URL;\n"),
    file("app.js", 'localStorage.getItem("workspace-google-token");\n'),
  ];
  check("today's shape passes", wireNameGate(clean).length === 0);

  const toolOffender = wireNameGate([file("x-tools.mjs", `    name: "${w}_reindex",\n`)]);
  check("a tool named after the role fails", toolOffender.length === 1 && toolOffender[0].includes("advertised tool name"));

  const envOffender = wireNameGate([file("x-mcp.mjs", `const v = process.env.${U}_NEW_THING;\n`)]);
  check("an environment variable named after the role fails", envOffender.length === 1 && envOffender[0].includes("environment variable"));

  const keyOffender = wireNameGate([file("app.js", `localStorage.setItem("${w}-new-thing", v);\n`)]);
  check("a storage key named after the role fails", keyOffender.length === 1 && keyOffender[0].includes("browser-storage key"));

  const indirect = wireNameGate([file("app.js", `const SOMETHING_KEY = "${w}-sneaky";\nlocalStorage.setItem(SOMETHING_KEY, v);\n`)]);
  check("including one hidden behind a constant, which is how every one of them is written", indirect.length === 1);

  const declared = wireNameGate([file("x-mcp.mjs", `process.env.${U}_OPS_URL;\n`)], { aliases: [`${U}_OPS_URL`] });
  check("a name a future migration declares as an alias is not an offender", declared.length === 0);
}

/* ------------------------------------------------------------- 5. the repo */
console.log("\nthe repo gate, over the surface that ships");

{
  const out = execFileSync(process.execPath, [join(ROOT, "scripts/check-wire-names.mjs")], { encoding: "utf8" });
  check("check:wire-names passes on this tree", out.includes("use-case agnostic"));
  check("with no alias left to honour", /\(0 declared backward-compatibility aliases still honoured\)/.test(out));
}

console.log(`\nwire names: ${passed}/${passed} checks passed`);
