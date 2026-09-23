#!/usr/bin/env node
/**
 * THE MIGRATION ITSELF — does an already-connected assistant and an already
 * signed-in analyst survive the rename, and does the gate stop the next one?
 *
 * Renaming `fde_status` to `workspace_status`, `FDE_*` to `WORKSPACE_*` and
 * `fde-google-token` to `workspace-google-token` is only safe because each is
 * ADDITIVE: the new name is what is advertised and written, the old one is still
 * accepted and read. Every one of those three claims is a behaviour, and every
 * one of them is invisible in a diff — a dropped fallback reads exactly like a
 * completed rename until an analyst is signed out or an assistant answers
 * `unknown tool` mid-conversation. So they are executed here.
 *
 * Each of the five suites below FAILS on the commit before this one, and for the
 * right reason:
 *   1. tools/list advertised `fde_status` and there was no alias to accept.
 *   2. compatEnv did not exist (both copies), so `WORKSPACE_*` read as unset.
 *   3. lib/browser-storage.ts did not exist; every key was a bare literal.
 *   4. wireNameGate did not exist, so a new offender in any of the three
 *      categories was not merely allowed, it was documented as exempt.
 *   5. check:wire-names reported 18 offenders on that commit (run it there).
 *
 * Offline: no network, no database, no browser. The storage suite drives a fake
 * `window.localStorage` that records what was written under which key, because
 * "the old value is left in place" is a claim about the store, not about a
 * return value.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};

/* ------------------------------------------------------------------ 1. tools */
console.log("\nthe tool name, and the alias that keeps a live conversation alive");

const { handleRpc, serverInstructions, compatEnv: pkgCompatEnv, LEGACY_ENV_NAMES } = await import("../setup/fde-tools.mjs");
const { advertisedToolNames, servedTools } = await import("./lib/wire-names.mjs");

const tools = servedTools();
const names = advertisedToolNames();
const status = tools.find((t) => t.name === "workspace_status");

check("the orientation tool is advertised as workspace_status", Boolean(status));
check("it still carries the START HERE description every other tool depends on", status.description.startsWith("START HERE."));
check("no advertised tool name carries the base product's role word", !names.some((n) => n.split("_").includes("fde")));
check(`all ${names.length} tools are served, so the check is not looking at a subset`, names.length >= 59);

const rpc = { tools, serverInfo: { name: "t", version: "0" }, instructions: "" };
const listed = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, rpc)).result.tools;
check("tools/list offers workspace_status", listed.some((t) => t.name === "workspace_status"));
check("tools/list NEVER offers the alias, so nothing new learns the old name", !listed.some((t) => t.name === "fde_status"));
check("tools/list hands back no `aliases` field at all", listed.every((t) => !("aliases" in t)));

/**
 * The whole point of the alias: an assistant that read tools/list an hour ago
 * still holds `fde_status`. A tool list is fetched once per connection, not per
 * call, so a hard rename answers that assistant with -32602 and ends the
 * session. Both names must reach the SAME handler.
 */
const call = (name) => handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } }, rpc);
const viaNew = await call("workspace_status");
const viaOld = await call("fde_status");
check("an assistant that already learned fde_status is still answered", !viaOld.error);
check("the alias reaches the same handler as the advertised name", JSON.stringify(viaOld.result) === JSON.stringify(viaNew.result));
const bogus = await call("fde_nonsense");
check("a name that is neither is still an unknown-tool error", bogus.error?.code === -32602);

const instructions = serverInstructions({ productName: "X", opsUrl: "https://x.example.com", signInHint: "h" });
check("the server's own instructions tell a new assistant to call workspace_status", instructions.includes("`workspace_status` first"));
check("the server's own instructions never mention the old name", !instructions.includes("fde_status"));

/* --------------------------------------------------------------- 2. env vars */
console.log("\nenvironment variables: the new name wins, the old one still answers, once loudly");

{
  const env = { WORKSPACE_OPS_URL: "https://new.example.com", FDE_OPS_URL: "https://old.example.com" };
  check("the new name wins when both are set", pkgCompatEnv(env, "WORKSPACE_OPS_URL") === "https://new.example.com");
  check("an unrelated variable is returned untouched", pkgCompatEnv({ WEB_ORIGIN: "x" }, "WEB_ORIGIN") === "x");
  check("a variable set nowhere is undefined, exactly as process.env.X would be", pkgCompatEnv({}, "WORKSPACE_ORG") === undefined);

  const warnings = [];
  const old = { FDE_ACTOR: "someone" };
  check("the old name still supplies the value", pkgCompatEnv(old, "WORKSPACE_ACTOR", (m) => warnings.push(m)) === "someone");
  check("using the old name says so", warnings.length === 1 && warnings[0].includes("FDE_ACTOR") && warnings[0].includes("WORKSPACE_ACTOR"));
  pkgCompatEnv(old, "WORKSPACE_ACTOR", (m) => warnings.push(m));
  check("it says so ONCE, not on every read", warnings.length === 1);
  check("every package variable has a declared old name", Object.keys(LEGACY_ENV_NAMES).every((k) => k.startsWith("WORKSPACE_")));
}

{
  // The deployed half. Separate module because the agent is built on its own and
  // cannot import the web app's lib/; separate TABLE because these two variables
  // are read by code that is RUNNING on a live project.
  const { compatEnv: appCompatEnv, LEGACY_APP_ENV_NAMES } = await import("../agent/lib/compat-env.ts");
  const saved = { ...process.env };
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    delete process.env.WORKSPACE_CLI_CLIENT_ID;
    process.env.FDE_CLI_CLIENT_ID = "old-client.apps.googleusercontent.com";
    check("a deployment still set with FDE_CLI_CLIENT_ID keeps admitting its CLI tokens", appCompatEnv("WORKSPACE_CLI_CLIENT_ID") === "old-client.apps.googleusercontent.com");
    check("and is told which name to move to", warnings.length === 1 && warnings[0].includes("WORKSPACE_CLI_CLIENT_ID"));
    appCompatEnv("WORKSPACE_CLI_CLIENT_ID");
    check("once per process, not once per request", warnings.length === 1);
    process.env.WORKSPACE_CLI_CLIENT_ID = "new-client.apps.googleusercontent.com";
    check("the new name wins the moment it is set", appCompatEnv("WORKSPACE_CLI_CLIENT_ID") === "new-client.apps.googleusercontent.com");
    check("the two tables are disjoint — no variable is migrated in two places", !Object.keys(LEGACY_APP_ENV_NAMES).some((k) => k in LEGACY_ENV_NAMES));
  } finally {
    console.warn = realWarn;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

/* ---------------------------------------------------------- 3. browser keys */
console.log("\nbrowser storage: an analyst who is signed in stays signed in");

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
  const local = makeStore({ "fde-google-token": "a-real-session", "fde-theme": "dark" });
  const session = makeStore({ "fde-invite-result": '{"kind":"ok"}' });
  globalThis.window = { localStorage: local, sessionStorage: session };

  const { STORAGE_KEYS, LEGACY_STORAGE_KEYS, legacyKeyFor, readStored, writeStored, removeStored } =
    await import("../lib/browser-storage.ts");

  check("the token key no longer carries the base product's role word", !STORAGE_KEYS.token.split("-").includes("fde"));
  check("every current key has a declared old spelling", Object.keys(STORAGE_KEYS).every((k) => LEGACY_STORAGE_KEYS[STORAGE_KEYS[k]]));

  /* THE ONE THAT MATTERS. This value was written by yesterday's bundle. */
  check("a session stored under the old key is still found", readStored(STORAGE_KEYS.token) === "a-real-session");
  check("so is a theme chosen before the rename", readStored(STORAGE_KEYS.theme) === "dark");
  check("a sessionStorage hand-off survives the same way", readStored(STORAGE_KEYS.inviteResult, "session") === '{"kind":"ok"}');

  writeStored(STORAGE_KEYS.token, "refreshed");
  check("a write lands under the NEW key", local.data[STORAGE_KEYS.token] === "refreshed");
  check("and leaves the old value where a tab on the old bundle will find it", local.data["fde-google-token"] === "a-real-session");
  check("the new value is what is read back", readStored(STORAGE_KEYS.token) === "refreshed");

  /* Signing out has to mean signed out. Clearing only the new key would leave a
   * live token under the old one for the next load to "restore". */
  removeStored(STORAGE_KEYS.token);
  check("signing out clears the new key", !(STORAGE_KEYS.token in local.data));
  check("signing out clears the OLD key too, or the next load signs you back in", !("fde-google-token" in local.data));
  check("and nothing is left to read", readStored(STORAGE_KEYS.token) === null);

  /* The chat list is keyed by person AND workspace, so its key is composed. */
  const composed = `${STORAGE_KEYS.chats}:someone@example.com:org-x`;
  check("a composed chat key maps to its old prefix", legacyKeyFor(composed) === "fde-chats:someone@example.com:org-x");
  local.data["fde-chats:someone@example.com:org-x"] = "[]";
  check("so a sidebar written before the rename is still there", readStored(composed) === "[]");
  check("a key with no old spelling maps to null", legacyKeyFor("something-else") === null);

  /* A browser with site data blocked THROWS on access; the app must render. */
  const hostile = { get localStorage() { throw new Error("site data blocked"); }, get sessionStorage() { throw new Error("blocked"); } };
  globalThis.window = hostile;
  check("a browser that blocks site data reads null rather than crashing the app", readStored(STORAGE_KEYS.token) === null);
  writeStored(STORAGE_KEYS.token, "x");
  removeStored(STORAGE_KEYS.token);
  check("and a write or a sign-out there is a no-op, not an exception", true);
  delete globalThis.window;
}

/* ------------------------------------------------------------------ 4. gate */
console.log("\nthe gate: a NEW offender fails while the declared aliases stand");

{
  const { wireNameGate, identifierCarriesBaseWord } = await import("./lib/agent-cli.mjs");
  const file = (path, body) => ({ path, bytes: Buffer.from(body, "utf8") });

  check("a name is an offender when a part of it IS the word", identifierCarriesBaseWord("fde_status") && identifierCarriesBaseWord("FDE_OPS_URL") && identifierCarriesBaseWord("fde-google-token"));
  check("and not when the word is merely inside an identifier", !identifierCarriesBaseWord("fdeOwner") && !identifierCarriesBaseWord("workspace_status"));

  const aliases = ["fde_status", "FDE_OPS_URL", "fde-google-token"];
  const clean = [
    file("x-tools.mjs", '    name: "workspace_status",\n    aliases: ["fde_status"],\n'),
    file("x-mcp.mjs", 'const a = process.env.WORKSPACE_OPS_URL;\n'),
    file("app.js", 'localStorage.getItem("workspace-google-token");\n'),
  ];
  check("today's shape passes", wireNameGate(clean, { aliases }).length === 0);

  /* One new offender per category — each of these would have shipped unremarked
   * before this gate, because ownNameGate excludes `_` on both sides. */
  const toolOffender = wireNameGate([file("x-tools.mjs", '    name: "fde_reindex",\n')], { aliases });
  check("a NEW tool named after the role fails", toolOffender.length === 1 && toolOffender[0].includes("advertised tool name"));

  const envOffender = wireNameGate([file("x-mcp.mjs", "const v = process.env.FDE_NEW_THING;\n")], { aliases }); // wire-name-ok: the offender this proves the gate catches
  check("a NEW FDE_* environment variable fails", envOffender.length === 1 && envOffender[0].includes("environment variable"));

  const keyOffender = wireNameGate([file("app.js", 'localStorage.setItem("fde-new-thing", v);\n')], { aliases }); // wire-name-ok: the offender this proves the gate catches
  check("a NEW fde-* storage key fails", keyOffender.length === 1 && keyOffender[0].includes("browser-storage key"));

  const indirect = wireNameGate([file("app.js", 'const SOMETHING_KEY = "fde-sneaky";\nlocalStorage.setItem(SOMETHING_KEY, v);\n')], { aliases }); // wire-name-ok: the offender this proves the gate catches
  check("including one hidden behind a constant, which is how every one of them is written", indirect.length === 1);

  /* The aliases must still stand, or the migration is a rename and the gate is
   * the thing that broke the live conversation it was supposed to protect. */
  const aliasLine = wireNameGate([file("x-tools.mjs", '    aliases: ["fde_status"],\n'), file("x-mcp.mjs", "process.env.FDE_OPS_URL;\n")], { aliases });
  check("a declared alias is NOT an offender", aliasLine.length === 0);
  const undeclared = wireNameGate([file("x-mcp.mjs", "process.env.FDE_OPS_URL;\n")], { aliases: [] });
  check("the same name with nothing declaring it IS one", undeclared.length === 1);
}

/* ------------------------------------------------------------- 5. the repo */
console.log("\nthe repo gate, over the surface that ships");

{
  const out = execFileSync(process.execPath, [join(ROOT, "scripts/check-wire-names.mjs")], { encoding: "utf8" });
  check("check:wire-names passes on this tree", out.includes("use-case agnostic"));
  check("and says how many aliases are still honoured, so a spent one is visible", /declared backward-compatibility alias/.test(out));
}

console.log(`\nwire names: ${passed}/${passed} checks passed`);
