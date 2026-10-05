/**
 * TWO DEFAULTS THAT WERE ONLY RIGHT ON VERCEL, and the rule for both: on Vercel nothing changes.
 *
 *  1. THE AGENT'S ADDRESS (lib/agent-url.ts). With none configured the web app fell back to one Vercel deployment's
 *     agent. Off Vercel that was a web app that built, started and proxied every chat to someone else's agent; on
 *     Vercel it was the same for every other project. Now a production build or server, and anything on Vercel,
 *     refuses, with a message that says what to set. In development and in an automated test build off Vercel the
 *     fallback is a local agent (`eve dev`), never a deployment's address.
 *
 *  2. TLS FOR THE MIGRATION SCRIPTS (scripts/lib/migration-ssl.mjs). `ssl: "require"` was hard-coded; a Postgres on
 *     the same machine has no TLS. `DATABASE_SSL=disable` turns it off for a local database only. Unset is "require".
 *
 * Everything here is offline. The agent address is checked three ways: the function over every environment (against a
 * copy of the function as it was), next.config.ts loaded as `next build` and `next start` load it, and one real
 * `next build` of a throwaway app that must stop with the message. The database half, against a real Postgres, is
 * scripts/test-new-database-db.mjs.
 *
 *   npm run test:off-vercel-defaults
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const agentUrl = await import("../lib/agent-url.ts");
const { migrationSsl, databaseHost } = await import("./lib/migration-ssl.mjs");
const { freePort, waitForNextStart } = await import("./lib/own-listener.mjs");

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed++;
  else failures.push(what);
  if (!ok || process.argv.includes("--verbose")) console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `\n         ${JSON.stringify(detail).slice(0, 600)}`}`);
};
const section = (title, before) => (count) => console.log(`${title}: ${passed - before - (count ?? 0)} checks`);

/* ---- 1. the agent's address ------------------------------------------------------------------------------------ */

/** The stand-in for development and test builds: a local agent, never a deployment (lib/agent-url.ts). */
const LOCAL_AGENT = agentUrl.DEFAULT_AGENT_URL;
/** Any deployment's agent address, which must never be the fallback. */
const DEPLOYED = /\.vercel\.app\b/;
/** agentBaseUrl exactly as it was before this change. */
const normalizeWas = (raw) => {
  const value = (raw ?? "").trim();
  if (!value || value === "[SENSITIVE]") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return value.replace(/\/+$/, "");
  } catch {
    return null;
  }
};
const baseWas = (env) => normalizeWas(env.EVE_API_URL) ?? normalizeWas(env.NEXT_PUBLIC_EVE_API_URL) ?? LOCAL_AGENT;

const VALUES = [undefined, "", "  ", "[SENSITIVE]", "not a url", "ftp://agent.example", "http://127.0.0.1:18210", "https://agent.example.test/", "https://other.example.test"];
const outcome = (fn) => {
  try {
    return { value: fn() };
  } catch (error) {
    return { error };
  }
};
const envOf = (base, a, b) => ({ ...base, ...(a === undefined ? {} : { EVE_API_URL: a }), ...(b === undefined ? {} : { NEXT_PUBLIC_EVE_API_URL: b }) });

let before = passed;
check("the stand-in is a local agent, not a deployment's address", /^http:\/\/127\.0\.0\.1:\d+$/.test(LOCAL_AGENT) && !DEPLOYED.test(LOCAL_AGENT), LOCAL_AGENT);
// Every place the fallback is the local stand-in when nothing usable is set, and the configured agent otherwise.
const UNCHANGED = [
  ["development (next dev)", { NODE_ENV: "development" }],
  ["a plain-node test (NODE_ENV unset)", {}],
  ["NODE_ENV=test", { NODE_ENV: "test" }],
  ["an automated test build off Vercel (CI=true, production)", { CI: "true", NODE_ENV: "production" }],
  ["a hand-made test build (EVE_API_URL_OPTIONAL=1, production)", { EVE_API_URL_OPTIONAL: "1", NODE_ENV: "production" }],
];
for (const [label, base] of UNCHANGED) {
  let same = 0;
  const differ = [];
  for (const a of VALUES) {
    for (const b of VALUES) {
      const env = envOf(base, a, b);
      const got = outcome(() => agentUrl.agentBaseUrl(env));
      if (got.value === baseWas(env)) same++;
      else differ.push({ a, b, got: got.value ?? String(got.error?.message).slice(0, 80) });
    }
  }
  check(`${label}: agentBaseUrl is what it was for all ${VALUES.length ** 2} combinations of the two variables`, differ.length === 0 && same === VALUES.length ** 2, differ.slice(0, 3));
  check(`${label}: it is not "required"`, agentUrl.agentUrlRequired(base) === false);
}
// ON VERCEL the address is required, whatever else is set: no deployment's agent stands in for a missing one.
for (const [label, base] of [
  ["on Vercel, build or function (VERCEL=1, production)", { VERCEL: "1", NODE_ENV: "production" }],
  ["on Vercel with CI set too (the Vercel builder)", { VERCEL: "1", CI: "1", NODE_ENV: "production" }],
  ["on Vercel, a preview", { VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production" }],
  ["on Vercel, development", { VERCEL: "1", VERCEL_ENV: "development", NODE_ENV: "development" }],
]) {
  check(`${label}: the address is required`, agentUrl.agentUrlRequired(base) === true);
  const unset = outcome(() => agentUrl.agentUrlFallback(envOf(base, undefined, undefined)));
  check(`${label}: nothing set → REFUSED (the session proxy's fallback too), never a deployment's agent`, unset.error?.name === "AgentUrlNotConfiguredError" && outcome(() => agentUrl.agentBaseUrl(envOf(base, undefined, "[SENSITIVE]"))).error?.name === "AgentUrlNotConfiguredError", unset.value);
  check(`${label}: NEXT_PUBLIC_EVE_API_URL set → that agent`, agentUrl.agentUrlFallback(envOf(base, undefined, "https://agent.example.test/")) === "https://agent.example.test");
}
check("a 0 / false / empty CI or EVE_API_URL_OPTIONAL does not count as set", ["0", "false", "", "no", "off"].every((v) => agentUrl.agentUrlRequired({ NODE_ENV: "production", CI: v, EVE_API_URL_OPTIONAL: v }) === true));
section("\nThe agent's address in development, tests and on Vercel", before)();

before = passed;
const OFF = { NODE_ENV: "production" }; // off Vercel, a production build or server, nobody said it is a test
check("off Vercel, production: the address is required", agentUrl.agentUrlRequired(OFF) === true);
for (const [label, a, b] of [
  ["neither variable set", undefined, undefined],
  ["both empty", "", ""],
  ["Vercel's unreadable placeholder in both", "[SENSITIVE]", "[SENSITIVE]"],
  ["a value that is not a URL", undefined, "agent.internal:8080"],
]) {
  const got = outcome(() => agentUrl.agentBaseUrl(envOf(OFF, a, b)));
  const message = String(got.error?.message ?? "");
  check(`${label}: REFUSED (no falling back to the Vercel agent)`, got.error?.name === "AgentUrlNotConfiguredError", got.value);
  check(
    `${label}: the message says what is wrong, why, and exactly what to set`,
    /is not configured/.test(message) && !DEPLOYED.test(message) && /will not fall back to any default agent address: chat would silently go somewhere else/.test(message) && /NEXT_PUBLIC_EVE_API_URL=<agent address>/.test(message) && /build AND of the running server/.test(message),
    message,
  );
  check(`${label}: the session proxy's fallback is refused the same way`, outcome(() => agentUrl.agentUrlFallback(envOf(OFF, a, b))).error?.name === "AgentUrlNotConfiguredError");
}
const MINE = "http://127.0.0.1:18210";
check("NEXT_PUBLIC_EVE_API_URL alone: that agent", agentUrl.agentBaseUrl(envOf(OFF, undefined, MINE)) === MINE && agentUrl.agentUrlFallback(envOf(OFF, undefined, MINE)) === MINE);
check("both set to the same address (a trailing slash aside): that agent", agentUrl.agentBaseUrl(envOf(OFF, `${MINE}/`, MINE)) === MINE);
const onlyNew = outcome(() => agentUrl.agentBaseUrl(envOf(OFF, MINE, undefined)));
check("EVE_API_URL alone is REFUSED: most of the server reads the other name and would have no agent", onlyNew.error?.name === "AgentUrlNotConfiguredError" && /EVE_API_URL is set but NEXT_PUBLIC_EVE_API_URL is not/.test(onlyNew.error.message), onlyNew.value);
const two = outcome(() => agentUrl.agentBaseUrl(envOf(OFF, MINE, "https://other.example.test")));
check("two different addresses are REFUSED, naming both", two.error?.name === "AgentUrlNotConfiguredError" && two.error.message.includes(MINE) && two.error.message.includes("https://other.example.test"), two.value);
check("no deployment's address is ever returned unless someone set it", [OFF, { VERCEL: "1" }, {}, { NODE_ENV: "development" }].every((base) => VALUES.flatMap((a) => VALUES.map((b) => outcome(() => agentUrl.agentBaseUrl(envOf(base, a, b))).value)).every((v) => v === undefined || !DEPLOYED.test(v) || VALUES.includes(v))));
section("The agent's address, off Vercel in production", before)();

/* ---- next.config.ts, as `next build` and `next start` load it ---------------------------------------------------- */

before = passed;
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VERCEL") && !["CI", "EVE_API_URL", "NEXT_PUBLIC_EVE_API_URL", "EVE_API_URL_OPTIONAL", "NODE_ENV", "BUNDLE_BUDGET_DIST"].includes(k)));
function loadConfig(env) {
  const code = `const c = (await import(${JSON.stringify(pathToFileURL(join(ROOT, "next.config.ts")).href)})).default; const r = await c.rewrites(); process.stdout.write("@@" + JSON.stringify(r.fallback.map((f) => f.destination)));`;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code], { env: { ...clean(), ...env }, encoding: "utf8" });
  return { status: r.status, destinations: r.stdout.includes("@@") ? JSON.parse(r.stdout.split("@@")[1]) : null, stderr: r.stderr };
}
const cfgRefused = loadConfig({ NODE_ENV: "production" });
check("next.config.ts off Vercel in production with no address: loading it fails", cfgRefused.status !== 0 && cfgRefused.destinations === null, cfgRefused.destinations);
check("…with the plain message, not a rewrite error", /AgentUrlNotConfiguredError/.test(cfgRefused.stderr) && /NEXT_PUBLIC_EVE_API_URL=<agent address>/.test(cfgRefused.stderr) && !/Invalid rewrites/.test(cfgRefused.stderr), cfgRefused.stderr.slice(-400));
const cfgMine = loadConfig({ NODE_ENV: "production", NEXT_PUBLIC_EVE_API_URL: MINE });
check("…with the address: /eve/v1 and the workflow well-known path are rewritten to THAT agent", cfgMine.status === 0 && JSON.stringify(cfgMine.destinations) === JSON.stringify([`${MINE}/eve/v1/:path*`, `${MINE}/.well-known/workflow/:path*`]), cfgMine);
const cfgVercel = loadConfig({ NODE_ENV: "production", VERCEL: "1" });
check("next.config.ts ON VERCEL with no address: loading it fails with the plain message (no deployment's agent stands in)", cfgVercel.status !== 0 && cfgVercel.destinations === null && /NEXT_PUBLIC_EVE_API_URL=<agent address>/.test(cfgVercel.stderr), cfgVercel.stderr.slice(-300));
for (const [label, env] of [
  ["in development", { NODE_ENV: "development" }],
  ["in an automated test build (CI)", { NODE_ENV: "production", CI: "true" }],
]) {
  const cfg = loadConfig(env);
  check(`next.config.ts ${label} with no address: the rewrites go to the local agent`, cfg.status === 0 && JSON.stringify(cfg.destinations) === JSON.stringify([`${LOCAL_AGENT}/eve/v1/:path*`, `${LOCAL_AGENT}/.well-known/workflow/:path*`]), cfg);
}

// One real `next build`: a throwaway app that has only this repo's next.config.ts and what it imports.
const mini = mkdtempSync(join(tmpdir(), "agent-url-build-"));
try {
  mkdirSync(join(mini, "lib"));
  mkdirSync(join(mini, "app"));
  for (const f of ["next.config.ts", "lib/agent-url.ts", "lib/bundle-budget-dist.ts"]) cpSync(join(ROOT, f), join(mini, f));
  writeFileSync(join(mini, "package.json"), JSON.stringify({ name: "agent-url-build-probe", private: true, type: "module" }));
  writeFileSync(join(mini, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowImportingTsExtensions: true, noEmit: true, module: "esnext", moduleResolution: "bundler", jsx: "preserve", strict: true, skipLibCheck: true } }));
  writeFileSync(join(mini, "app/layout.tsx"), "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  writeFileSync(join(mini, "app/page.tsx"), "export default function Page() { return <p>probe</p>; }\n");
  symlinkSync(join(ROOT, "node_modules"), join(mini, "node_modules"));
  const next = join(ROOT, "node_modules/next/dist/bin/next");
  const started = Date.now();
  const build = spawnSync(process.execPath, [next, "build"], { cwd: mini, env: { ...clean(), NEXT_TELEMETRY_DISABLED: "1" }, encoding: "utf8", timeout: 120_000 });
  const output = `${build.stdout}\n${build.stderr}`;
  check("a real `next build` off Vercel with no address EXITS NON-ZERO", build.status !== 0 && build.status !== null, { status: build.status, tail: output.slice(-300) });
  check("…printing the plain message", /The agent's address is not configured/.test(output) && /NEXT_PUBLIC_EVE_API_URL=<agent address>/.test(output), output.slice(-500));
  check("…before compiling anything (it stops at the configuration)", !/Compiled successfully|Generating static pages/.test(output) && Date.now() - started < 60_000, { ms: Date.now() - started });
  // It must NOT come up. Started the way every script here starts a server (scripts/lib/own-listener.mjs): a port
  // that is free now, and "up" only if OUR child announces it and answers. waitForNextStart throws at once when the
  // child exits, which is the outcome wanted; if it returns, the server started and the check fails.
  const port = await freePort();
  const server = spawn(process.execPath, [next, "start", "-p", String(port)], { cwd: mini, env: { ...clean(), NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let startOut = "";
  server.stdout.on("data", (d) => (startOut += d));
  server.stderr.on("data", (d) => (startOut += d));
  const exited = new Promise((resolve) => server.once("exit", () => resolve()));
  let cameUp = false;
  try {
    await waitForNextStart({ server, port, log: () => startOut, path: "/", tries: 240 });
    cameUp = true;
  } catch {
    /* exited, or never listened */
  }
  if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
  await exited;
  check("a real `next start` off Vercel with no address does not start, with the same message", !cameUp && server.exitCode !== 0 && server.exitCode !== null && /The agent's address is not configured/.test(startOut), { cameUp, status: server.exitCode, tail: startOut.slice(-400) });
} finally {
  rmSync(mini, { recursive: true, force: true });
}
section("next.config.ts and a real next build / next start", before)();

/* ---- 2. TLS for the migration scripts ---------------------------------------------------------------------------- */

before = passed;
const REMOTE = "postgres://postgres:secret@db.abcd.supabase.co:5432/postgres";
const LOCALS = [
  "postgres://postgres:secret@127.0.0.1:5432/app",
  "postgres://postgres:secret@localhost/app",
  "postgres://postgres:secret@LOCALHOST:5433/app",
  "postgres://postgres:secret@127.0.5.9/app",
  "postgres://postgres:secret@[::1]:5432/app",
  "postgres:///app?host=/var/run/postgresql",
  "postgres://postgres@%2Fvar%2Frun%2Fpostgresql/app",
];
for (const url of [REMOTE, ...LOCALS]) {
  for (const v of [undefined, "", "require", " Require "]) {
    check(`DATABASE_SSL ${JSON.stringify(v ?? null)}, ${databaseHost(url).host || "(socket)"}: TLS required, as before`, migrationSsl(url, v === undefined ? {} : { DATABASE_SSL: v }) === "require");
  }
}
for (const url of LOCALS) check(`DATABASE_SSL=disable, ${databaseHost(url).host}: no TLS (this machine)`, migrationSsl(url, { DATABASE_SSL: "disable" }) === false && databaseHost(url).local === true);
for (const url of [REMOTE, "postgres://u:p@10.0.0.5/app", "postgres://u:p@192.168.1.4/app", "postgres://u:p@127.0.0.1.evil.example/app", "postgres://u:p@localhost.evil.example/app", "postgres://u:p@[2001:db8::1]/app"]) {
  const got = outcome(() => migrationSsl(url, { DATABASE_SSL: "disable" }));
  check(`DATABASE_SSL=disable, ${databaseHost(url).host}: REFUSED (not this machine), naming the host and never the password`, /only for a Postgres on this machine/.test(String(got.error?.message)) && got.error.message.includes(databaseHost(url).host) && !/secret|:p@/.test(got.error.message), got.value);
}
for (const v of ["off", "false", "no-verify", "prefer", "0"]) {
  const got = outcome(() => migrationSsl(LOCALS[0], { DATABASE_SSL: v }));
  check(`DATABASE_SSL=${v}: an unknown value is an error naming the setting, not a guess`, /DATABASE_SSL=.* is not supported\. Use "require" \(the default\) or "disable"/.test(String(got.error?.message)), got.value);
}
check("a database URL that is not a URL is a plain error", /could not be read as a URL/.test(String(outcome(() => migrationSsl("not a url", { DATABASE_SSL: "disable" })).error?.message)));
// Both scripts take the option from the helper and nowhere else.
const { readFileSync } = await import("node:fs");
for (const file of ["scripts/migrate-production.mjs", ".migrate-task-workflow-service.mjs"]) {
  const source = readFileSync(join(ROOT, file), "utf8");
  check(`${file}: every connection takes its TLS option from the helper (no hard-coded "require" left)`, !/ssl:\s*"require"/.test(source) && /ssl:\s*migrationSsl\(/.test(source) && /migration-ssl\.mjs/.test(source));
}
section("TLS for the migration scripts", before)();

console.log(failures.length ? `\ntest-off-vercel-defaults: ${failures.length} FAILED (${passed} passed)` : `\ntest-off-vercel-defaults: ${passed} checks passed`);
assert.equal(failures.length, 0, `${failures.length} assertion(s) failed: ${failures.slice(0, 5).join(" | ")}`);
