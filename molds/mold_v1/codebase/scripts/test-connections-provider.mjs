/**
 * CONNECTOR CREDENTIALS WITHOUT VERCEL CONNECT (CONNECTIONS_PROVIDER=env) — the setting, the rules, the real pieces.
 *
 * On a server that is not on Vercel, Slack's and GitHub's credentials cannot come from Vercel Connect. With
 * CONNECTIONS_PROVIDER=env each workspace's come from its own stored connector secrets, or from the server's
 * environment values when those are bound to that workspace (agent/lib/connector-credentials.ts). No database here
 * (scripts/test-connector-credentials-db.mjs has the stored secrets against a real Postgres), no network, and no real
 * Slack or GitHub call: fetch is replaced and any request but the stubbed one fails the run.
 *
 *   1. the setting: only `env` turns it on; unset, empty and `vercel-connect` are today's behaviour; a typing mistake
 *      is today's behaviour too, said once;
 *   2. the rules, with the two sources stood in: a workspace's own credentials first; the server's only for the one
 *      workspace CONNECTIONS_WORKSPACE names; never another workspace's; never a mix of the two; reasons name
 *      settings and never values;
 *   3. GitHub: a token from a workspace's credentials. One mint per workspace, cached per workspace, never shared;
 *   4. the REAL eve pieces with the setting on and NOTHING configured, in a process with none of Vercel's variables:
 *      the agent's connection and channel modules load (the app starts), Vercel Connect is never called, a tool call
 *      gets eve's own "not authorized" error (the one an uninstalled Connect connector raises) instead of a crash,
 *      and the Slack route refuses an inbound request;
 *   5. the same, configured from the server's environment: the bearer is the server's, and the real Slack route
 *      answers a correctly signed request and refuses a forged one.
 *
 *   npm run test:connections-provider
 */
import { spawnSync } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PART = process.argv.includes("--part") ? process.argv[process.argv.indexOf("--part") + 1] : null;

let passed = 0;
const failed = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 600)}`}`);
  }
};
const attempt = async (fn) => {
  try {
    return { threw: false, value: await fn() };
  } catch (error) {
    return { threw: true, name: error?.name, message: String(error?.message ?? error), error };
  }
};
const finish = () => {
  console.log(`\n${passed} passed, ${failed.length} failed`);
  for (const label of failed) console.log(`  FAILED: ${label}`);
  process.exit(failed.length ? 1 : 0);
};

const CLEARED = ["CONNECTIONS_PROVIDER", "CONNECTIONS_WORKSPACE", "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "SLACK_MCP_URL", "SLACK_TEAM_CHANNEL_ID", "GITHUB_TOKEN", "GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_MCP_URL", "DATABASE_URL", "POSTGRES_URL", "OPS_SECRETS_KEY"];
/** A person's session, as eve hands it to a connection's auth resolver. */
const ctxFor = (email) => ({ session: { id: "s1", auth: { current: { attributes: { email }, subject: email, principalType: "user" } } } });

/* ================================================================================================================ */
/* Parts 4 and 5 run in their own process: the agent's modules read the setting when they are loaded.               */
/* ================================================================================================================ */
if (PART === "real") {
  const settings = JSON.parse(process.argv[process.argv.indexOf("--env") + 1]);
  for (const k of CLEARED) delete process.env[k];
  for (const k of Object.keys(process.env)) if (k.startsWith("VERCEL")) delete process.env[k];
  Object.assign(process.env, settings);
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    throw new Error(`no network in this test: ${url}`);
  };
  const out = { loaded: false };
  const connections = await import("../agent/lib/connections.ts");
  const channel = (await import("../agent/channels/slack.ts")).default;
  const { isConnectionAuthorizationFailedError } = await import("eve/connections");
  out.loaded = true;
  out.authIsResolver = { slack: typeof connections.slackConnection.auth === "function", github: typeof connections.githubConnection.auth === "function" };
  for (const kind of ["slack", "github"]) {
    const connection = kind === "slack" ? connections.slackConnection : connections.githubConnection;
    const spec = typeof connection.auth === "function" ? await connection.auth(ctxFor("reader@onfinance.in")) : connection.auth;
    const got = await attempt(() => spec.getToken({ connection: { url: connection.url }, principal: { type: "app" } }));
    out[kind] = got.threw
      ? { threw: got.name, eveFailed: isConnectionAuthorizationFailedError(got.error), reason: got.error?.reason, retryable: got.error?.retryable, connectionName: got.error?.connectionName, message: got.message }
      : { principalType: spec.principalType, token: got.value.token };
  }
  // The real Slack route.
  const route = channel.routes[0];
  out.route = { method: route.method, path: route.path };
  const body = JSON.stringify({ type: "url_verification", challenge: "challenge-abc123" });
  const ts = String(Math.floor(Date.now() / 1000));
  const hit = async (secret) => {
    const request = new Request("https://server.test/eve/v1/slack", {
      method: "POST",
      headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}` },
      body,
    });
    const saved = console.error;
    console.error = () => {};
    try {
      const got = await attempt(async () => {
        const res = await route.handler(request, {});
        return { status: res.status, text: await res.text() };
      });
      return got.threw ? { threw: got.message } : got.value;
    } finally {
      console.error = saved;
    }
  };
  out.inboundSigned = await hit(settings.SLACK_SIGNING_SECRET ?? "the-secret-nobody-set");
  out.inboundForged = await hit("a-different-secret");
  out.requests = requests;
  process.stdout.write(`\n@@RESULT@@${JSON.stringify(out)}\n`);
  process.exit(0);
}
if (PART === "recorded") {
  // The same modules with the recorder standing in for Connect and eve: what was called, and what was handed over.
  const settings = JSON.parse(process.argv[process.argv.indexOf("--env") + 1]);
  for (const k of CLEARED) delete process.env[k];
  for (const k of Object.keys(process.env)) if (k.startsWith("VERCEL")) delete process.env[k];
  Object.assign(process.env, settings);
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
  await import("../agent/lib/connections.ts");
  const channel = (await import("../agent/channels/slack.ts")).default;
  const botToken = await attempt(() => channel.credentials.botToken());
  process.stdout.write(
    `\n@@RESULT@@${JSON.stringify({
      calls: globalThis.__connectCalls,
      credentialKeys: Object.keys(channel.credentials).sort(),
      signingSecret: channel.credentials.signingSecret ?? null,
      botToken: botToken.threw ? { threw: botToken.message } : botToken.value,
      verifier: channel.credentials.webhookVerifier ? await attempt(() => channel.credentials.webhookVerifier(new Request("https://x.test"), "")) : null,
    })}\n`,
  );
  process.exit(0);
}

const child = (part, env) => {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), "--part", part, "--env", JSON.stringify(env)], { encoding: "utf8" });
  const line = run.stdout.split("\n").find((l) => l.startsWith("@@RESULT@@"));
  return { status: run.status, stderr: run.stderr, result: line ? JSON.parse(line.slice("@@RESULT@@".length)) : null };
};

/* ---- 1. the setting -------------------------------------------------------------------------------------------- */
console.log("1. The setting");
const provider = await import("../lib/connections-provider.ts");
{
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  check("unset is vercel-connect (today's behaviour)", provider.connectionsProvider({}) === "vercel-connect" && provider.connectionsFromEnv({}) === false);
  check("…and so are an empty value and the name itself", provider.connectionsProvider({ CONNECTIONS_PROVIDER: " " }) === "vercel-connect" && provider.connectionsProvider({ CONNECTIONS_PROVIDER: "vercel-connect" }) === "vercel-connect" && provider.connectionsProvider({ CONNECTIONS_PROVIDER: "Vercel-Connect" }) === "vercel-connect");
  check("nothing was said for those", warnings.length === 0, warnings);
  check("`env` turns it on", provider.connectionsProvider({ CONNECTIONS_PROVIDER: "env" }) === "env" && provider.connectionsProvider({ CONNECTIONS_PROVIDER: " ENV " }) === "env" && provider.connectionsFromEnv({ CONNECTIONS_PROVIDER: "env" }) === true);
  check("a typing mistake is today's behaviour, not a new source of credentials", provider.connectionsProvider({ CONNECTIONS_PROVIDER: "envv" }) === "vercel-connect" && provider.connectionsProvider({ CONNECTIONS_PROVIDER: "environment" }) === "vercel-connect");
  provider.connectionsProvider({ CONNECTIONS_PROVIDER: "envv" });
  check("…said once per value, naming the setting", warnings.length === 2 && warnings[0].includes("CONNECTIONS_PROVIDER") && warnings[0].includes("envv"), warnings);
  console.warn = realWarn;
  check("CONNECTIONS_WORKSPACE: a workspace id, or none", provider.connectionsWorkspace({}) === null && provider.connectionsWorkspace({ CONNECTIONS_WORKSPACE: "  " }) === null && provider.connectionsWorkspace({ CONNECTIONS_WORKSPACE: " acme " }) === "acme");
  check("the setting decides Slack and GitHub, and no other kind", provider.isProvidedConnectorKind("slack") && provider.isProvidedConnectorKind("GitHub") && !provider.isProvidedConnectorKind("gmail") && !provider.isProvidedConnectorKind("mcp"));
}

/* ---- 2. the rules ---------------------------------------------------------------------------------------------- */
console.log("\n2. Whose credentials a workspace gets");
for (const k of CLEARED) delete process.env[k];
const creds = await import("../agent/lib/connector-credentials.ts");
const A = "workspace-a";
const B = "workspace-b";
const C = "workspace-c";
/** Two sources stood in: what each workspace stored, and the server's environment. Every read is logged. */
function world({ stored = {}, env = {}, database = true } = {}) {
  const reads = [];
  return {
    reads,
    deps: {
      env,
      hasDatabase: () => database,
      readStored: async (orgId, kind) => {
        reads.push(`${orgId}:${kind}`);
        return stored[orgId]?.[kind] ?? null;
      },
    },
  };
}
{
  const w = world({
    stored: { [A]: { slack: { SLACK_BOT_TOKEN: "xoxb-A-own" }, github: { GITHUB_TOKEN: "ghp-A-own" } }, [B]: { slack: { SLACK_BOT_TOKEN: "xoxb-B-own" } } },
    env: { SLACK_BOT_TOKEN: "xoxb-server", GITHUB_TOKEN: "ghp-server" },
  });
  const a = await creds.connectorCredentialsFor(A, "slack", w.deps);
  const b = await creds.connectorCredentialsFor(B, "slack", w.deps);
  check("a workspace with its own stored credentials gets its own", a.connected && a.source === "workspace" && a.values.SLACK_BOT_TOKEN === "xoxb-A-own" && b.connected && b.values.SLACK_BOT_TOKEN === "xoxb-B-own", { a, b });
  check("…and only its own store was read for it (no other workspace is ever looked at)", JSON.stringify(w.reads) === JSON.stringify([`${A}:slack`, `${B}:slack`]), w.reads);
  const c = await creds.connectorCredentialsFor(C, "slack", w.deps);
  check("a workspace with none does NOT get the server's when they are bound to nobody", c.connected === false && c.reason.includes("CONNECTIONS_WORKSPACE") && c.reason.includes("not connected"), c);
  const bGithub = await creds.connectorCredentialsFor(B, "github", w.deps);
  check("…nor another connector kind's (B stored Slack, not GitHub)", bGithub.connected === false, bGithub);
  check("no reason carries a value", [c.reason, bGithub.reason].every((r) => !/xoxb|ghp/.test(r)), [c.reason, bGithub.reason]);
}
{
  const w = world({ stored: { [A]: { slack: { SLACK_BOT_TOKEN: "xoxb-A-own" } } }, env: { SLACK_BOT_TOKEN: "xoxb-server", GITHUB_TOKEN: "ghp-server", CONNECTIONS_WORKSPACE: B } });
  const b = await creds.connectorCredentialsFor(B, "slack", w.deps);
  check("the server's credentials are the ONE workspace's that CONNECTIONS_WORKSPACE names", b.connected && b.source === "server" && b.values.SLACK_BOT_TOKEN === "xoxb-server", b);
  const c = await creds.connectorCredentialsFor(C, "slack", w.deps);
  check("…and not any other workspace's", c.connected === false && c.reason.includes("another workspace's") && !c.reason.includes(B), c);
  const a = await creds.connectorCredentialsFor(A, "slack", w.deps);
  check("…and a workspace with its own keeps its own first", a.connected && a.source === "workspace" && a.values.SLACK_BOT_TOKEN === "xoxb-A-own", a);
  const aGithub = await creds.connectorCredentialsFor(A, "github", w.deps);
  check("…and does not borrow the server's for a kind it has not stored", aGithub.connected === false, aGithub);
}
{
  const app = { GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2", GITHUB_APP_PRIVATE_KEY: "pem" };
  const w = world({ stored: { [A]: { github: { GITHUB_APP_ID: "1" } }, [B]: { github: app } }, env: { ...app, GITHUB_APP_ID: "99", CONNECTIONS_WORKSPACE: A } });
  const a = await creds.connectorCredentialsFor(A, "github", w.deps);
  check("a set is used whole or not at all: an incomplete stored set is never completed from the server's", a.connected && a.source === "server" && a.values.GITHUB_APP_ID === "99", a);
  const b = await creds.connectorCredentialsFor(B, "github", w.deps);
  check("…and a complete stored set carries nothing of the server's", b.connected && b.source === "workspace" && b.values.GITHUB_APP_ID === "1" && Object.keys(b.values).length === 3, b);
  check("GitHub: the whole App triple or a token; half an App is not enough", creds.credentialsUsable("github", app) && creds.credentialsUsable("github", { GITHUB_TOKEN: "t" }) && !creds.credentialsUsable("github", { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "pem" }) && !creds.credentialsUsable("slack", {}));
}
{
  const none = world({});
  for (const kind of ["slack", "github"]) {
    const r = await creds.connectorCredentialsFor(A, kind, none.deps);
    check(`nothing configured: ${kind} is not connected, with a sentence saying what to store`, r.connected === false && r.reason.includes("not connected") && r.reason.includes(kind === "slack" ? "SLACK_BOT_TOKEN" : "GITHUB_APP_ID"), r);
  }
  const nobody = await creds.connectorCredentialsFor(null, "slack", world({ env: { SLACK_BOT_TOKEN: "xoxb-server" }, database: false }).deps);
  check("no workspace named: not connected, and nothing is read", nobody.connected === false && /no workspace/.test(nobody.reason), nobody);
  const local = await creds.connectorCredentialsFor(A, "slack", world({ env: { SLACK_BOT_TOKEN: "xoxb-server" }, database: false }).deps);
  check("with no database at all (local development: one workspace) the server's values are that workspace's", local.connected && local.source === "server", local);
  const personal = world({ stored: { [A]: { slack: null } }, env: {} });
  check("a failed tool call is the typed error, not a crash", (await attempt(() => creds.connectorTokenFor(A, "slack", personal.deps))).name === "NotConnectedError");
}

/* ---- 3. GitHub tokens, per workspace ---------------------------------------------------------------------------- */
console.log("\n3. GitHub: a token from a workspace's credentials (no request leaves the process)");
{
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const app = { GITHUB_APP_ID: "12345", GITHUB_APP_INSTALLATION_ID: "67890", GITHUB_APP_PRIVATE_KEY: Buffer.from(pem).toString("base64") };
  const minted = [];
  const fakeFetch = async (url, init) => {
    minted.push({ url: String(url), method: init.method, bearer: init.headers.authorization.slice(0, 7) });
    return new Response(JSON.stringify({ token: `ghs_${minted.length}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 201 });
  };
  const w = world({ stored: { [A]: { github: app }, [B]: { github: app }, [C]: { github: { GITHUB_TOKEN: "ghp-C-pat" } } } });
  creds.resetConnectorTokenCache();
  const a1 = await creds.connectorTokenFor(A, "github", w.deps, fakeFetch);
  const a2 = await creds.connectorTokenFor(A, "github", w.deps, fakeFetch);
  check("workspace A's App mints an installation token at GitHub's endpoint, once, and reuses it", a1.token === "ghs_1" && a2.token === "ghs_1" && minted.length === 1 && minted[0].url === "https://api.github.com/app/installations/67890/access_tokens" && minted[0].method === "POST" && minted[0].bearer === "Bearer ", minted);
  const b1 = await creds.connectorTokenFor(B, "github", w.deps, fakeFetch);
  check("workspace B, with the SAME App stored, gets its own token: A's cached one is never handed over", b1.token === "ghs_2" && minted.length === 2, { b1, minted: minted.length });
  check("a token says when it expires, so eve refreshes ahead of time", typeof a1.expiresAt === "number" && a1.expiresAt > Date.now());
  const c1 = await creds.connectorTokenFor(C, "github", w.deps, fakeFetch);
  check("a stored token is used as it is, with no request", c1.token === "ghp-C-pat" && minted.length === 2);
  const s = await creds.connectorTokenFor(A, "slack", world({ stored: { [A]: { slack: { SLACK_BOT_TOKEN: "xoxb-A-own" } } } }).deps, fakeFetch);
  check("Slack's bearer is the workspace's bot token", s.token === "xoxb-A-own" && minted.length === 2);
  const refused = await attempt(() => creds.githubTokenFrom(A, { ...app, GITHUB_APP_INSTALLATION_ID: "1" }, async () => new Response("{}", { status: 401 })));
  check("a refused mint is an error naming the status, not an empty token", refused.threw && refused.message.includes("401"), refused.message);
}

/* ---- 3b. what the Ops Center reports ----------------------------------------------------------------------------- */
console.log("\n3b. The Ops Center's report follows the same two sources");
{
  const health = await import("../lib/connector-health.ts");
  const slack = [{ name: "SLACK_BOT_TOKEN" }, { name: "SLACK_TEAM_CHANNEL_ID" }, { name: "SLACK_MCP_URL", optional: true }];
  const serverHasAll = new Map([["SLACK_BOT_TOKEN", true], ["SLACK_TEAM_CHANNEL_ID", true], ["SLACK_MCP_URL", true]]);
  const serverHasNone = new Map([["SLACK_BOT_TOKEN", false], ["SLACK_TEAM_CHANNEL_ID", false], ["SLACK_MCP_URL", false]]);
  check("nothing stored, nothing on the server: missing (not connected), as an unconnected connector is today", health.workspaceConnectorHealth(slack, new Set(), serverHasNone, true) === "missing" && health.workspaceConnectorHealth(slack, undefined, serverHasNone, false) === "missing");
  check("the server holds a token, bound to ANOTHER workspace: this workspace's connector is still missing", health.workspaceConnectorHealth(slack, new Set(), serverHasAll, false) === "missing");
  check("…and for the workspace it is bound to, it is live", health.workspaceConnectorHealth(slack, new Set(), serverHasAll, true) === "live");
  check("a secret stored on this workspace's connector IS live, whatever the server holds", health.workspaceConnectorHealth(slack, new Set(["SLACK_BOT_TOKEN", "SLACK_TEAM_CHANNEL_ID", "SLACK_MCP_URL"]), serverHasNone, false) === "live");
  check("required ones stored, the optional one not: degraded", health.workspaceConnectorHealth(slack, new Set(["SLACK_BOT_TOKEN", "SLACK_TEAM_CHANNEL_ID"]), serverHasNone, false) === "degraded");
  check("bound to this workspace, the agent has not reported yet: unknown, not a green dot", health.workspaceConnectorHealth(slack, new Set(), new Map(), true) === "unknown");
  check("per secret: stored is live; the server's only when bound; unreported is undefined", health.workspaceSecretLive("X", new Set(["X"]), new Map(), false) === true && health.workspaceSecretLive("X", new Set(), new Map([["X", true]]), false) === false && health.workspaceSecretLive("X", new Set(), new Map([["X", true]]), true) === true && health.workspaceSecretLive("X", undefined, new Map(), true) === undefined);
}

/* ---- 4. the real pieces, nothing configured --------------------------------------------------------------------- */
console.log("\n4. CONNECTIONS_PROVIDER=env and nothing configured: the agent starts, and nothing is connected");
{
  const real = child("real", { CONNECTIONS_PROVIDER: "env" });
  const r = real.result;
  check("the agent's connection and channel modules load, in a process with none of Vercel's variables", real.status === 0 && r?.loaded === true, real.stderr.slice(-600));
  check("each connection's auth is resolved per caller", r?.authIsResolver?.slack === true && r?.authIsResolver?.github === true, r?.authIsResolver);
  for (const kind of ["slack", "github"]) {
    const got = r?.[kind];
    check(`a ${kind} tool call gets eve's own authorization-failed error (what an uninstalled Vercel Connect connector raises), not a crash`, got?.threw === "ConnectionAuthorizationFailedError" && got.eveFailed === true && got.reason === "app_not_installed" && got.retryable === false && got.connectionName === kind, got);
    check(`…whose message says ${kind} is not connected, and what to store`, /not connected/.test(got?.message ?? "") && !/undefined|null/.test(got?.message ?? ""), got?.message);
  }
  check("the real Slack route refuses an inbound request (401): with no signing secret nothing can be verified", r?.inboundSigned?.status === 401 && r?.inboundForged?.status === 401, { signed: r?.inboundSigned, forged: r?.inboundForged });
  check("no request was made to anyone", Array.isArray(r?.requests) && r.requests.length === 0, r?.requests);

  const rec = child("recorded", { CONNECTIONS_PROVIDER: "env" });
  const calls = rec.result?.calls ?? [];
  check("Vercel Connect is never called: no connect(), no connectSlackCredentials()", rec.status === 0 && calls.length === 3 && calls.every((c) => c.call === "defineMcpClientConnection" || c.call === "slackChannel"), calls.map((c) => c.call));
  check("the channel is given no Connect verifier: a bot token read when used, and a verifier that refuses", JSON.stringify(rec.result?.credentialKeys) === '["botToken","webhookVerifier"]' && rec.result.verifier?.threw === true && /SLACK_SIGNING_SECRET/.test(rec.result.verifier.message), rec.result);
  check("a post with no bot token fails with a sentence naming the setting (the schedules record a failed delivery and move on)", /Slack is not connected: SLACK_BOT_TOKEN/.test(rec.result?.botToken?.threw ?? ""), rec.result?.botToken);
}

/* ---- 5. the real pieces, configured from the server's environment ------------------------------------------------ */
console.log("\n5. CONNECTIONS_PROVIDER=env, configured from the server's environment");
{
  const env = { CONNECTIONS_PROVIDER: "env", SLACK_BOT_TOKEN: "xoxb-server-token", SLACK_SIGNING_SECRET: "signing-secret-for-this-test", GITHUB_TOKEN: "ghp-server-token" };
  const real = child("real", env);
  const r = real.result;
  check("the modules load", real.status === 0 && r?.loaded === true, real.stderr.slice(-600));
  check("Slack's bearer is the server's bot token, as an app credential (no database here, so one workspace)", r?.slack?.token === "xoxb-server-token" && r.slack.principalType === "app", r?.slack);
  check("GitHub's bearer is the server's token", r?.github?.token === "ghp-server-token", r?.github);
  check("the real Slack route answers a request signed with SLACK_SIGNING_SECRET (Slack's own URL check)", r?.inboundSigned?.status === 200 && r.inboundSigned.text === "challenge-abc123", r?.inboundSigned);
  check("…and refuses one signed with anything else (401)", r?.inboundForged?.status === 401, r?.inboundForged);
  check("no request was made to anyone", r?.requests?.length === 0, r?.requests);
  const rec = child("recorded", env);
  check("Vercel Connect is still never called", rec.status === 0 && (rec.result?.calls ?? []).every((c) => c.call !== "connect" && c.call !== "connectSlackCredentials"), rec.result?.calls?.map((c) => c.call));
  check("the channel verifies with the signing secret, and posts with the server's bot token", JSON.stringify(rec.result?.credentialKeys) === '["botToken","signingSecret"]' && rec.result.signingSecret === "signing-secret-for-this-test" && rec.result.botToken === "xoxb-server-token", rec.result);
}
{
  const unset = child("recorded", {});
  const calls = (unset.result?.calls ?? []).map((c) => c.call);
  check("with the setting UNSET both Connect calls are made, as today (the recording in test:connections-default has every argument)", unset.status === 0 && calls.includes("connect") && calls.includes("connectSlackCredentials"), calls);
}

finish();
