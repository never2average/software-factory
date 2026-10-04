/**
 * ONE WORKSPACE'S CONNECTOR CREDENTIALS ARE NEVER ANOTHER'S — CONNECTIONS_PROVIDER=env against a real Postgres.
 *
 * Off Vercel a workspace's Slack and GitHub credentials are the secrets stored on its own connector
 * (`connector_secrets`: encrypted with OPS_SECRETS_KEY under a key derived from the workspace id, behind a strict
 * row-level-security policy), or the server's environment values when CONNECTIONS_WORKSPACE binds them to that
 * workspace (agent/lib/connector-credentials.ts). scripts/test-connections-provider.mjs holds the rules with the two
 * sources stood in; this holds the real read, as app_rw (CI's isolation job):
 *
 *   - each workspace gets its own stored token, and a workspace with none gets "not connected";
 *   - a disabled connector, a personal connector (one with an owner) and a secret of another kind are never used;
 *   - the row-level-security policy and the per-workspace key each refuse on their own: B's scope cannot see A's
 *     rows, and A's ciphertext copied into B's connector does not decrypt with B's key;
 *   - the server's environment values go to the bound workspace only.
 *
 * Nothing is sent to Slack or GitHub: these are lookups, and fetch is replaced to fail the run if anything tries.
 *
 *   ADMIN_URL=… DATABASE_URL=…app_rw… npm run test:connector-credentials-db
 */
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
  check("nothing was sent to Slack or GitHub", requests.length === 0, requests);
} finally {
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
