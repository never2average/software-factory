/**
 * WITH CONNECTIONS_PROVIDER UNSET, THE CONNECTORS MAKE TODAY'S EXACT CALLS.
 *
 * The live app's Slack credentials come from Vercel Connect, and its GitHub token from the agent's own environment.
 * Adding a second source of credentials for a server that is not on Vercel (CONNECTIONS_PROVIDER=env) must change
 * nothing there: not which Connect calls are made, not their arguments, not what is handed to eve, not one request to
 * GitHub.
 *
 * This script loads the two files that import `@vercel/connect` (agent/lib/connections.ts, agent/channels/slack.ts)
 * with stand-ins that record every call into `@vercel/connect/eve`, `eve/connections` and `eve/channels/slack`
 * (scripts/lib/connect-call-recorder.mjs), then drives the GitHub token path, and records:
 *
 *   calls      connect(...) and connectSlackCredentials(...) with their arguments, in order;
 *   handed     the definitions given to defineMcpClientConnection (url, description, and WHICH object is `auth`: the
 *              one Connect returned, or the app's own token function) and the options given to slackChannel (which
 *              bot token, which webhook verifier, the thread-context setting);
 *   tokens     what the GitHub connection's getToken() returns, call after call;
 *   requests   every fetch the token path made: method, URL, headers. The App JWT is recorded as its decoded header
 *              and claims and "signature valid for the App key" (the key is made per run, so the raw signature is
 *              not comparable; everything it signs is);
 *
 * for six deployments' worth of environment (nothing set; the Slack bot-token override; the MCP URLs; a GitHub PAT;
 * a GitHub App; a GitHub App whose mint is refused), each in its own process because these modules read the
 * environment when they are loaded. Time is pinned.
 *
 * The recording made on the code BEFORE the setting existed (commit 4ad0c2c) is committed at
 * scripts/fixtures/connections/default-provider.golden.json. It was written by running THIS file, unmodified, in a
 * checkout of 4ad0c2c with only this script and its recorder added:
 *
 *     node --experimental-strip-types scripts/test-connections-default-unchanged.mjs --record
 *
 * and this test asserts the current code produces the identical recording with CONNECTIONS_PROVIDER unset, and again
 * with CONNECTIONS_PROVIDER=vercel-connect (`npm run test:connections-default`). No request leaves the process: fetch
 * is replaced, and a call to anything but the stub fails the run.
 */
import { spawnSync } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, "fixtures", "connections", "default-provider.golden.json");
const RECORD = process.argv.includes("--record");
const SCENARIO = process.argv.includes("--scenario") ? process.argv[process.argv.indexOf("--scenario") + 1] : null;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** Environment per scenario. `GITHUB_APP_PRIVATE_KEY` is filled in by the child (a key made for the run). */
const SCENARIOS = {
  "nothing set": {},
  "slack bot-token override": { SLACK_BOT_TOKEN: "xoxb-test-override", SLACK_TEAM_CHANNEL_ID: "C0TEST" },
  "mcp urls": { SLACK_MCP_URL: "https://slack-mcp.internal.test/mcp", GITHUB_MCP_URL: "https://github-mcp.internal.test/mcp/" },
  "github pat": { GITHUB_TOKEN: "ghp_test_pat" },
  "github app": { GITHUB_APP_ID: "12345", GITHUB_APP_INSTALLATION_ID: "67890", GITHUB_APP_PRIVATE_KEY: "<pem>", GITHUB_TOKEN: "ghp_ignored_when_app_is_set" },
  "github app, base64 key, mint refused": { GITHUB_APP_ID: "12345", GITHUB_APP_INSTALLATION_ID: "67890", GITHUB_APP_PRIVATE_KEY: "<base64>", MINT_STATUS: "401" },
};
/** Every name a scenario or the app reads, cleared in the child before the scenario's own are set. */
const CLEARED = ["SLACK_BOT_TOKEN", "SLACK_TEAM_CHANNEL_ID", "SLACK_MCP_URL", "SLACK_SIGNING_SECRET", "GITHUB_MCP_URL", "GITHUB_TOKEN", "GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY", "DATABASE_URL", "POSTGRES_URL", "OPS_SECRETS_KEY", "CONNECTIONS_WORKSPACE"];

async function runScenario(name) {
  const env = SCENARIOS[name];
  for (const k of CLEARED) delete process.env[k];
  for (const k of Object.keys(process.env)) if (k.startsWith("VERCEL")) delete process.env[k];
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  for (const [k, v] of Object.entries(env)) {
    if (k === "MINT_STATUS") continue;
    process.env[k] = v === "<pem>" ? pem.replace(/\n/g, "\\n") : v === "<base64>" ? Buffer.from(pem).toString("base64") : v;
  }

  const RECORDER = pathToFileURL(join(HERE, "lib", "connect-call-recorder.mjs")).href;
  register(
    "data:text/javascript," +
      encodeURIComponent(`
        const RECORDER = ${JSON.stringify(RECORDER)};
        const STOOD_IN = new Set(["@vercel/connect/eve", "eve/connections", "eve/channels/slack"]);
        export async function resolve(s, c, n) {
          if (STOOD_IN.has(s) && c.parentURL !== RECORDER) return { url: RECORDER, shortCircuit: true };
          try { return await n(s, c); } catch (e) {
            if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
            throw e;
          }
        }`),
    import.meta.url,
  );

  // Pinned time, and no network: the only request the token path may make is answered here.
  const realNow = Date.now;
  Date.now = () => NOW;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const entry = { method: init.method ?? "GET", url: String(url), headers: { ...headers } };
    const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
    if (bearer && bearer.split(".").length === 3) {
      const [h, p, sig] = bearer.split(".");
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${h}.${p}`);
      entry.headers.authorization = {
        scheme: "Bearer",
        jwtHeader: JSON.parse(Buffer.from(h, "base64url").toString()),
        jwtClaims: JSON.parse(Buffer.from(p, "base64url").toString()),
        signature: verifier.verify(pair.publicKey, Buffer.from(sig, "base64url")) ? "valid for the App key" : "INVALID",
      };
    }
    requests.push(entry);
    if (!String(url).startsWith("https://api.github.com/app/installations/")) throw new Error(`unexpected request to ${url}`);
    const status = Number(env.MINT_STATUS ?? 201);
    if (status >= 400) return new Response(JSON.stringify({ message: "Bad credentials" }), { status });
    return new Response(JSON.stringify({ token: `ghs_minted_${requests.length}`, expires_at: new Date(NOW + 60 * 60 * 1000).toISOString() }), { status });
  };

  const { describe } = await import(RECORDER);
  const connections = await import("../agent/lib/connections.ts");
  const channel = await import("../agent/channels/slack.ts");
  const calls = globalThis.__connectCalls;

  const attempt = async (fn) => {
    try {
      return { value: await fn() };
    } catch (error) {
      return { threw: error?.name, message: String(error?.message ?? error) };
    }
  };
  const auth = connections.githubConnection.auth;
  const tokens = [];
  // Only a static `{ getToken }` is today's shape: a resolver function here is itself a difference, and is recorded as one.
  if (auth && typeof auth === "object" && typeof auth.getToken === "function") {
    tokens.push(await attempt(() => auth.getToken({ connection: { url: connections.githubConnection.url }, principal: { type: "app" } })));
    tokens.push(await attempt(() => auth.getToken({ connection: { url: connections.githubConnection.url }, principal: { type: "app" } })));
    // 56 minutes later the cached installation token has under five minutes left: it is minted again.
    Date.now = () => NOW + 56 * 60 * 1000;
    tokens.push(await attempt(() => auth.getToken({ connection: { url: connections.githubConnection.url }, principal: { type: "app" } })));
  }
  Date.now = realNow;

  return {
    calls,
    exports: {
      githubConnection: describe(connections.githubConnection),
      slackConnection: describe(connections.slackConnection),
      slackChannel: describe(channel.default),
      connectionsModule: Object.keys(connections).sort().filter((k) => k === "githubConnection" || k === "slackConnection"),
    },
    tokens,
    requests,
  };
}

if (SCENARIO) {
  const result = await runScenario(SCENARIO);
  process.stdout.write(`\n@@RESULT@@${JSON.stringify(result)}\n`);
  process.exit(0);
}

function recordAll(extraEnv) {
  const out = {};
  for (const name of Object.keys(SCENARIOS)) {
    const env = { ...process.env, ...extraEnv };
    if (!("CONNECTIONS_PROVIDER" in extraEnv)) delete env.CONNECTIONS_PROVIDER;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), "--scenario", name], { encoding: "utf8", env });
    const line = child.stdout.split("\n").find((l) => l.startsWith("@@RESULT@@"));
    if (child.status !== 0 || !line) {
      console.error(`scenario "${name}" did not finish (exit ${child.status}):\n${child.stderr.slice(-2000)}`);
      process.exit(1);
    }
    out[name] = JSON.parse(line.slice("@@RESULT@@".length));
  }
  return out;
}

if (RECORD) {
  const recording = recordAll({});
  writeFileSync(GOLDEN, `${JSON.stringify(recording, null, 2)}\n`);
  console.log(`recorded ${Object.keys(recording).length} scenarios to ${GOLDEN}`);
  process.exit(0);
}

if (!existsSync(GOLDEN)) {
  console.error(`missing ${GOLDEN}: record it on the code before the setting (see the header).`);
  process.exit(1);
}
const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || detail === undefined ? "" : `\n         ${detail}`}`);
};
/** The first place two JSON values differ, as a path. */
function firstDifference(a, b, path = "$") {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return `${path}: recorded ${JSON.stringify(a)}, now ${JSON.stringify(b)}`;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = firstDifference(a[key], b[key], `${path}.${key}`);
    if (d) return d;
  }
  return `${path}: differs`;
}

for (const [label, extra] of [
  ["CONNECTIONS_PROVIDER unset", {}],
  ["CONNECTIONS_PROVIDER=vercel-connect", { CONNECTIONS_PROVIDER: "vercel-connect" }],
  ["CONNECTIONS_PROVIDER empty", { CONNECTIONS_PROVIDER: "" }],
]) {
  console.log(`${label}`);
  const now = recordAll(extra);
  for (const name of Object.keys(SCENARIOS)) {
    const g = golden[name];
    const n = now[name];
    for (const part of ["calls", "exports", "tokens", "requests"]) {
      const diff = firstDifference(g?.[part], n?.[part]);
      const count = Array.isArray(g?.[part]) ? `${g[part].length} ` : "";
      check(`${name}: ${count}${part} identical to the recording made before the setting`, diff === null, diff ?? undefined);
    }
  }
}
{
  // The recording must hold what it claims to pin, or "identical" proves nothing.
  const all = Object.values(golden);
  check("the recording has Connect's two calls with the live connector id", all.every((s) => s.calls.some((c) => c.call === "connect" && JSON.stringify(c.args) === '[{"connector":"slack/fde-agent","principalType":"app"}]') && s.calls.some((c) => c.call === "connectSlackCredentials" && JSON.stringify(c.args) === '["slack/fde-agent"]')));
  check("…the Slack connection's auth is the object Connect returned, and the channel's verifier is Connect's", all.every((s) => s.exports.slackConnection.auth?.tagged === "connect#1" && s.exports.slackChannel.credentials.webhookVerifier?.tagged === "connectSlackCredentials#1.webhookVerifier"));
  check("…the bot-token override replaces only the token", golden["slack bot-token override"].exports.slackChannel.credentials.botToken === "xoxb-test-override" && golden["nothing set"].exports.slackChannel.credentials.botToken?.tagged === "connectSlackCredentials#1.botToken");
  check("…a GitHub App mints once, reuses the token, and mints again near expiry (2 requests for 3 calls)", golden["github app"].requests.length === 2 && golden["github app"].tokens.length === 3 && golden["github app"].requests[0].headers.authorization.signature === "valid for the App key");
  check("…and with nothing set the GitHub token is empty and no request is made", golden["nothing set"].tokens[0].value.token === "" && golden["nothing set"].requests.length === 0);
}

console.log(failed ? `\n${failed} failed` : "\nall identical");
process.exit(failed ? 1 : 0);
