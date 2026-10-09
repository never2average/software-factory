/**
 * ONE WORKSPACE'S CONNECTOR CREDENTIALS ARE NEVER ANOTHER'S — against a real Postgres.
 *
 * A workspace's GitHub credentials (on every target) and its Slack credentials (off Vercel, CONNECTIONS_PROVIDER=env)
 * are the secrets stored on its own connector (`connector_secrets`: encrypted with OPS_SECRETS_KEY under a key
 * derived from the workspace id, behind a strict row-level-security policy), or the server's environment values when
 * they belong to that workspace (agent/lib/connector-credentials.ts). scripts/test-connections-provider.mjs holds the
 * rules with the two sources stood in; this holds the real read, as app_rw (CI's isolation job):
 *
 *   - each workspace gets its own stored token, and a workspace with none gets "not connected";
 *   - a disabled connector, a personal connector (one with an owner) and a secret of another kind are never used;
 *   - the row-level-security policy and the per-workspace key each refuse on their own: B's scope cannot see A's
 *     rows, and A's ciphertext copied into B's connector does not decrypt with B's key;
 *   - the server's environment values go to the bound workspace only;
 *   - GitHub through the REAL connection (agent/lib/connections.ts, the real eve), with CONNECTIONS_PROVIDER unset
 *     and with `env`: a member of the workspace that stored a token gets that token, a member of the one that
 *     stored none gets eve's "not connected" error, and a server-wide GITHUB_TOKEN changes neither unless
 *     CONNECTIONS_WORKSPACE names one;
 *   - resolving GitHub never reads the `orgs` table: with that table made unreadable to the application's role,
 *     every answer is the same. Nothing counts, lists or infers the server's other workspaces.
 *
 * Nothing is sent to Slack or GitHub: these are lookups, and fetch is replaced to fail the run if anything tries.
 *
 *   ADMIN_URL=… DATABASE_URL=…app_rw… npm run test:connector-credentials-db
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-connector-credentials-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (app_rw).");
  process.exit(0);
}
process.env.OPS_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
for (const k of ["CONNECTIONS_WORKSPACE", "SLACK_BOT_TOKEN", "GITHUB_TOKEN", "GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY"]) delete process.env[k];
process.env.CONNECTIONS_PROVIDER = "env";
const requests = [];
globalThis.fetch = async (url) => {
  requests.push(String(url));
  throw new Error(`no network in this test: ${url}`);
};

const PART = process.argv.includes("--part") ? process.argv[process.argv.indexOf("--part") + 1] : null;
const ARG = PART ? JSON.parse(process.argv[process.argv.indexOf("--arg") + 1]) : null;

if (PART === "connection") {
  // The real connection module and the real eve, in a process with the provider setting given (or not given).
  if (ARG.provider) process.env.CONNECTIONS_PROVIDER = ARG.provider;
  else delete process.env.CONNECTIONS_PROVIDER;
  Object.assign(process.env, ARG.env ?? {});
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(" "));
  const { githubConnection } = await import("../agent/lib/connections.ts");
  const { isConnectionAuthorizationFailedError } = await import("eve/connections");
  const { closeDb } = await import("../agent/lib/db/index.ts");
  const out = { authIsResolver: typeof githubConnection.auth === "function", by: {}, warnings, requests };
  for (const [who, email] of Object.entries(ARG.people)) {
    const ctx = { session: { id: `s-${who}`, auth: { current: { attributes: { email, hd: email.split("@")[1] }, subject: email, principalType: "user" } } } };
    try {
      const spec = await githubConnection.auth(ctx);
      const got = await spec.getToken({ connection: { url: githubConnection.url }, principal: { type: "app" } });
      out.by[who] = { token: got.token, principalType: spec.principalType };
    } catch (error) {
      out.by[who] = { threw: error?.name, eveFailed: isConnectionAuthorizationFailedError(error), reason: error?.reason, message: String(error?.message ?? error) };
    }
  }
  await closeDb().catch(() => {});
  process.stdout.write(`\n@@RESULT@@${JSON.stringify(out)}\n`);
  process.exit(0);
}
if (PART === "blind") {
  // DATABASE_URL here puts a scratch schema first on the search path, whose `orgs` table app_rw may NOT read. If
  // resolving a credential ever looked at the workspace table, it would fail or change its answer here.
  delete process.env.CONNECTIONS_PROVIDER;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(" "));
  const { connectorCredentialsFor } = await import("../agent/lib/connector-credentials.ts");
  const { closeDb, getDb } = await import("../agent/lib/db/index.ts");
  const { sql } = await import("drizzle-orm");
  const out = {};
  const show = (r) => (r.connected ? { connected: true, source: r.source, token: r.values.GITHUB_TOKEN } : { connected: false, reason: r.reason });
  try {
    out.orgsReadable = await getDb().execute(sql`select org_id from orgs limit 1`).then(() => true, () => false);
    out.own = show(await connectorCredentialsFor(ARG.a, "github"));
    out.none = show(await connectorCredentialsFor(ARG.b, "github"));
    process.env.GITHUB_TOKEN = "ghp-server-token";
    out.unbound = { a: show(await connectorCredentialsFor(ARG.a, "github")), b: show(await connectorCredentialsFor(ARG.b, "github")) };
    process.env.CONNECTIONS_WORKSPACE = ARG.b;
    out.bound = { a: show(await connectorCredentialsFor(ARG.a, "github")), b: show(await connectorCredentialsFor(ARG.b, "github")) };
    out.warnings = warnings;
  } finally {
    await closeDb().catch(() => {});
  }
  process.stdout.write(`\n@@RESULT@@${JSON.stringify(out)}\n`);
  process.exit(0);
}
const child = (part, arg, env = {}) => {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server", fileURLToPath(import.meta.url), "--part", part, "--arg", JSON.stringify(arg)], { encoding: "utf8", env: { ...process.env, ...env } });
  const line = run.stdout.split("\n").find((l) => l.startsWith("@@RESULT@@"));
  return { status: run.status, stderr: run.stderr, result: line ? JSON.parse(line.slice("@@RESULT@@".length)) : null };
};

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
const app = postgres(appUrl, { max: 1, onnotice: () => {} });
let passed = 0;
const failed = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 500)}`}`);
  }
};

const stamp = Date.now();
const A = `conn-a-${stamp}`;
const B = `conn-b-${stamp}`;
const C = `conn-c-${stamp}`;
const D = `conn-d-${stamp}`;
const { connectorCredentialsFor, connectorTokenFor } = await import("../agent/lib/connector-credentials.ts");
const { closeDb } = await import("../agent/lib/db/index.ts");
/** Seal a secret exactly as the web app stores it (the Ops Center's connector secrets route). */
const { encryptSecret } = await import("../lib/secret-crypto.ts");

const connector = async (orgId, kind, { enabled = true, owner = null } = {}) =>
  (await admin`insert into connectors (org_id, name, kind, status, enabled, created_by, owner_email) values (${orgId}, ${`${kind} ${orgId}`}, ${kind}, 'connected', ${enabled}, 'test', ${owner}) returning id`)[0].id;
const store = async (orgId, connectorId, name, value, owner = null) => {
  const s = encryptSecret(value, orgId, owner);
  await admin`insert into connector_secrets (org_id, connector_id, name, ciphertext, iv, tag, key_version, updated_by)
              values (${orgId}, ${connectorId}, ${name}, ${s.ciphertext}, ${s.iv}, ${s.tag}, ${s.keyVersion}, 'test')`;
  return s;
};

try {
  await admin`insert into orgs (org_id, name, status) values (${A}, 'Conn A', 'active'), (${B}, 'Conn B', 'active'), (${C}, 'Conn C', 'active'), (${D}, 'Conn D', 'active')`;
  const aSlack = await connector(A, "slack");
  const aSealed = await store(A, aSlack, "SLACK_BOT_TOKEN", "xoxb-A-own-token");
  await store(A, aSlack, "IMAP_PASSWORD", "not-a-slack-credential");
  const aGithub = await connector(A, "github");
  await store(A, aGithub, "GITHUB_TOKEN", "ghp-A-own-token");
  const bSlack = await connector(B, "slack");
  await store(B, bSlack, "SLACK_BOT_TOKEN", "xoxb-B-own-token");
  // C: a disabled Slack connector with a token, and a PERSONAL GitHub connector with a token. Neither is the workspace's.
  const cSlack = await connector(C, "slack", { enabled: false });
  await store(C, cSlack, "SLACK_BOT_TOKEN", "xoxb-C-disabled");
  const cGithub = await connector(C, "github", { owner: "someone@c.example" });
  await store(C, cGithub, "GITHUB_TOKEN", "ghp-C-personal", "someone@c.example");
  // D: a Slack connector whose stored row is A's ciphertext, copied (what a row smuggled across workspaces would be).
  const dSlack = await connector(D, "slack");
  await admin`insert into connector_secrets (org_id, connector_id, name, ciphertext, iv, tag, key_version, updated_by)
              values (${D}, ${dSlack}, 'SLACK_BOT_TOKEN', ${aSealed.ciphertext}, ${aSealed.iv}, ${aSealed.tag}, ${aSealed.keyVersion}, 'test')`;

  console.log("\n1. Each workspace reads its OWN stored credentials");
  const a = await connectorCredentialsFor(A, "slack");
  const b = await connectorCredentialsFor(B, "slack");
  check("workspace A gets A's Slack token, decrypted in A's scope", a.connected && a.source === "workspace" && a.values.SLACK_BOT_TOKEN === "xoxb-A-own-token", a.connected ? a.source : a);
  check("workspace B gets B's", b.connected && b.source === "workspace" && b.values.SLACK_BOT_TOKEN === "xoxb-B-own-token", b.connected ? b.source : b);
  check("only the connector kind's own names are read (another secret on the row is not a credential)", a.connected && JSON.stringify(Object.keys(a.values)) === '["SLACK_BOT_TOKEN"]', a.connected ? Object.keys(a.values) : a);
  const aGh = await connectorTokenFor(A, "github");
  check("workspace A's GitHub token is A's stored one", aGh.token === "ghp-A-own-token");
  const bGh = await connectorCredentialsFor(B, "github");
  check("workspace B, which stored no GitHub credentials, is not connected (it does not get A's)", bGh.connected === false && !/ghp|xoxb/.test(bGh.reason), bGh);

  console.log("\n2. What is not a workspace's credential is never used");
  const cS = await connectorCredentialsFor(C, "slack");
  check("a disabled connector's token is not used", cS.connected === false, cS);
  const cG = await connectorCredentialsFor(C, "github");
  check("a personal connector's token is not the workspace's", cG.connected === false, cG);
  const d = await connectorCredentialsFor(D, "slack");
  check("A's ciphertext copied onto another workspace's connector does not decrypt with that workspace's key", d.connected === false, d);
  const thrown = await connectorTokenFor(C, "slack").then(() => null, (e) => e);
  check("a tool call there fails with the typed error and a sentence, not a crash", thrown?.name === "NotConnectedError" && /not connected/.test(thrown.message), thrown?.message);

  console.log("\n3. The database refuses on its own, too");
  const outside = await app`select count(*)::int as n from connector_secrets`;
  check("outside a workspace's scope app_rw sees no stored secret at all (strict row-level security)", outside[0].n === 0, outside[0]);
  const inB = await app.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${B}, true)`;
    return tx`select org_id from connector_secrets`;
  });
  check("inside B's scope, only B's rows exist", inB.length === 1 && inB.every((r) => r.org_id === B), inB);

  console.log("\n4. The server's environment values are ONE workspace's");
  process.env.SLACK_BOT_TOKEN = "xoxb-server-token";
  process.env.GITHUB_TOKEN = "ghp-server-token";
  const unbound = await connectorCredentialsFor(C, "slack");
  check("unbound, no workspace uses them (C has none of its own)", unbound.connected === false && /CONNECTIONS_WORKSPACE/.test(unbound.reason), unbound);
  process.env.CONNECTIONS_WORKSPACE = C;
  const bound = await connectorCredentialsFor(C, "slack");
  check("bound to C, C uses them", bound.connected && bound.source === "server" && bound.values.SLACK_BOT_TOKEN === "xoxb-server-token", bound.connected ? bound.source : bound);
  const stillB = await connectorCredentialsFor(B, "github");
  check("…and B, which has no GitHub credentials, still does not", stillB.connected === false && /another workspace's/.test(stillB.reason), stillB);
  const stillA = await connectorCredentialsFor(A, "slack");
  check("…and A keeps its own stored token first", stillA.connected && stillA.source === "workspace" && stillA.values.SLACK_BOT_TOKEN === "xoxb-A-own-token");
  process.env.CONNECTIONS_WORKSPACE = A;
  const aBound = await connectorCredentialsFor(A, "slack");
  check("…even when the server's are bound to A itself", aBound.connected && aBound.source === "workspace");

  console.log("\n5. Workspace B can never resolve workspace A's GitHub credential");
  delete process.env.CONNECTIONS_WORKSPACE;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const seenFromB = await app.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${B}, true)`;
    return {
      // What the resolver would read if it were ever asked, in B's scope, for A's connector or A's rows.
      connectorByKind: await tx`select id from connectors where kind = 'github' and org_id = ${A}`,
      secretsOfAsConnector: await tx`select name from connector_secrets where connector_id = ${aGithub}`,
      secretsNamedForA: await tx`select name from connector_secrets where org_id = ${A}`,
      githubSecretsAtAll: await tx`select org_id from connector_secrets where name = 'GITHUB_TOKEN'`,
    };
  });
  check("in B's scope, A's GitHub secret rows do not exist: by connector id, by workspace id, by name (strict row-level security)", seenFromB.secretsOfAsConnector.length === 0 && seenFromB.secretsNamedForA.length === 0 && seenFromB.githubSecretsAtAll.length === 0, seenFromB);
  const written = await app.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${B}, true)`;
    return tx`update connector_secrets set updated_by = 'b' where connector_id = ${aGithub} returning name`;
  });
  check("…and cannot be touched from there", written.length === 0, written);
  // The other fence: A's sealed GitHub token copied onto a GitHub connector of B's own.
  const [aGhRow] = await admin`select ciphertext, iv, tag, key_version from connector_secrets where connector_id = ${aGithub} and name = 'GITHUB_TOKEN'`;
  const bGithub = await connector(B, "github");
  await admin`insert into connector_secrets (org_id, connector_id, name, ciphertext, iv, tag, key_version, updated_by)
              values (${B}, ${bGithub}, 'GITHUB_TOKEN', ${aGhRow.ciphertext}, ${aGhRow.iv}, ${aGhRow.tag}, ${aGhRow.key_version}, 'test')`;
  const smuggled = await connectorCredentialsFor(B, "github");
  check("A's sealed GitHub token copied onto B's own connector does not open with B's key: B is still not connected", smuggled.connected === false && !/ghp/.test(smuggled.reason), smuggled);
  await admin`delete from connector_secrets where connector_id = ${bGithub}`;
  await admin`delete from connectors where id = ${bGithub}`;
  const stillAs = await connectorTokenFor(A, "github");
  check("…and A still resolves its own", stillAs.token === "ghp-A-own-token");

  console.log("\n6. GitHub through the real connection, on both provider settings");
  const ALICE = `alice@conn-a-${stamp}.example`;
  const BOB = `bob@conn-b-${stamp}.example`;
  await admin`insert into org_members (org_id, email, role) values (${A}, ${ALICE}, 'owner'), (${B}, ${BOB}, 'owner')`;
  const people = { alice: ALICE, bob: BOB };
  for (const [label, provider] of [["CONNECTIONS_PROVIDER unset (Vercel)", null], ["CONNECTIONS_PROVIDER=env", "env"]]) {
    const own = child("connection", { provider, people });
    const r = own.result;
    check(`${label}: GitHub's auth is resolved per caller`, own.status === 0 && r?.authIsResolver === true, own.status === 0 ? r : own.stderr.slice(-600));
    check(`${label}: a member of A (which stored a token) gets A's token`, r?.by?.alice?.token === "ghp-A-own-token" && r.by.alice.principalType === "app", r?.by?.alice);
    check(`${label}: a member of B (which stored none) gets eve's "not connected" error, as an unconnected connector does`, r?.by?.bob?.threw === "ConnectionAuthorizationFailedError" && r.by.bob.eveFailed === true && r.by.bob.reason === "app_not_installed" && /not connected/.test(r.by.bob.message) && !/ghp/.test(r.by.bob.message), r?.by?.bob);
    const wide = child("connection", { provider, people, env: { GITHUB_TOKEN: "ghp-server-token" } });
    const w = wide.result;
    check(`${label}: a server-wide GITHUB_TOKEN without CONNECTIONS_WORKSPACE does not connect B`, w?.by?.bob?.threw === "ConnectionAuthorizationFailedError" && /CONNECTIONS_WORKSPACE/.test(w.by.bob.message) && /no workspace uses them/.test(w.by.bob.message), w?.by?.bob);
    check(`${label}: …A keeps its own, and it is said once in the log`, w?.by?.alice?.token === "ghp-A-own-token" && w.warnings.length === 1 && /not being used/.test(w.warnings[0]) && !/ghp/.test(w.warnings[0]), { alice: w?.by?.alice, warnings: w?.warnings });
    const named = child("connection", { provider, people, env: { GITHUB_TOKEN: "ghp-server-token", CONNECTIONS_WORKSPACE: B } });
    const n = named.result;
    check(`${label}: CONNECTIONS_WORKSPACE=B gives the server-wide token to B only; A keeps its own; nothing is warned`, n?.by?.bob?.token === "ghp-server-token" && n.by.alice?.token === "ghp-A-own-token" && n.warnings.length === 0, n);
    check(`${label}: nothing was sent to GitHub`, [r, w, n].every((x) => x?.requests?.length === 0), [r?.requests, w?.requests, n?.requests]);
  }

  console.log("\n7. Resolving GitHub never looks at the workspace table");
  const schema = `blind_${stamp}`;
  await admin.unsafe(`create schema "${schema}"`);
  try {
    // An `orgs` the application's role can find but not read: usage on the schema, no privilege on the table.
    await admin.unsafe(`create table "${schema}".orgs (like public.orgs including all)`);
    await admin.unsafe(`grant usage on schema "${schema}" to app_rw`);
    const url = new URL(appUrl);
    url.searchParams.set("search_path", `${schema},public`);
    const blind = child("blind", { a: A, b: B }, { DATABASE_URL: url.toString() });
    const r = blind.result;
    check("the workspace table really is unreadable to the application's role in this run", blind.status === 0 && r?.orgsReadable === false, blind.status === 0 ? r : blind.stderr.slice(-600));
    check("…and A still resolves its own stored GitHub token, B still gets \"not connected\"", r?.own?.connected === true && r.own.source === "workspace" && r.own.token === "ghp-A-own-token" && r.none?.connected === false, { own: r?.own, none: r?.none });
    check("a server-wide GITHUB_TOKEN without CONNECTIONS_WORKSPACE: ignored for B, A keeps its own, one warning with no value in it", r?.unbound?.b?.connected === false && /CONNECTIONS_WORKSPACE/.test(r.unbound.b.reason) && r.unbound.a.source === "workspace" && r.warnings?.length === 1 && !/ghp/.test(r.warnings[0]), { unbound: r?.unbound, warnings: r?.warnings });
    check("with CONNECTIONS_WORKSPACE=B: B gets the server-wide token, A keeps its own", r?.bound?.b?.connected === true && r.bound.b.source === "server" && r.bound.b.token === "ghp-server-token" && r.bound.a.source === "workspace", r?.bound);
  } finally {
    await admin.unsafe(`drop schema "${schema}" cascade`).catch(() => {});
  }

  check("nothing was sent to Slack or GitHub", requests.length === 0, requests);
} finally {
  await admin`delete from org_members where org_id in ${admin([A, B])}`.catch(() => {});
  for (const org of [A, B, C, D]) {
    await admin`delete from connector_secrets where org_id = ${org}`.catch(() => {});
    await admin`delete from connectors where org_id = ${org}`.catch(() => {});
    await admin`delete from orgs where org_id = ${org}`.catch(() => {});
  }
  await closeDb().catch(() => {});
  await app.end({ timeout: 5 }).catch(() => {});
  await admin.end({ timeout: 5 }).catch(() => {});
}

console.log(`\n${passed} passed, ${failed.length} failed`);
for (const label of failed) console.log(`  FAILED: ${label}`);
process.exit(failed.length ? 1 : 0);
