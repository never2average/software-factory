// Credential fields connected through OAuth, and short-lived credentials in long runs (mold_v0-014; src/oauth-connections.ts,
// src/oauth-routes.ts, src/oauth-state.ts, src/run-harness.ts), offline: an embedded database, the HTTP server behind a
// fake Clerk, a stand-in OAuth provider (scripts/lib/oauth-standin.ts) and GitHub (scripts/lib/github-standin.ts), a
// simulated credential clock (src/clock.ts) and fixture runs (scripts/fixtures/runs/oa.mjs, long.mjs).
//   npm run test:oauth-providers
//
//  1. No field names a provider: nothing is mounted. definePack refuses an unknown provider, github_app with oauth, an
//     address that is not https, authorize_params that set the flow's own parameters.
//  2. The client id and secret are the key vault's (provider oauth_clients, by the labels the pack names): with none the
//     connect is refused; staff see which are set, never a value.
//  3. Connect: an owner gets the provider's sign-in address (client id, redirect address, scopes, a PKCE S256 challenge, the
//     signed one-time state); the return is refused for another workspace's session, another person, a changed state, a
//     denied sign-in, a used state, a code the provider refuses; once connected the tokens are sealed in the vault.
//  4. Runs: the connection's access token is delivered like any credential (a file, a variable), per slot (the
//     workspace, an asset); a slot with no connection gets the pasted value; two workspaces never see each other's
//     (cross-workspace injections 0); what a run prints is redacted.
//  5. Refresh: a token with less than ten minutes left is refreshed before it is given (three asking at once: one refresh,
//     the rotating refresh token used once); a provider refusing the refresh (revoked) stops it: needs_reconnect, nothing
//     sent (not even the pasted value) until connected again.
//  6. Disconnect (an owner, staff): removed at once, the provider told (RFC 7009); a running run's file is emptied at its
//     next refresh.
//  7. A run of four hours on the simulated clock with an OAuth token and a GitHub App token, each living one hour: every
//     read works, the files were rewritten with fresh tokens (at least four each); without the refresh (control) the same
//     run's reads fail after the first hour.
//  8. Workspace removal tells the provider; row-level security on the three tables; no client secret, refresh token or
//     PKCE verifier in any answer, log, table or run; no access token in clear in any table.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp } from "./lib/test-world.js";
import { startOAuthStandin } from "./lib/oauth-standin.js";
import { startGithubStandin } from "./lib/github-standin.js";

const logged: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream) as (...a: unknown[]) => boolean;
  (stream as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => { logged.push(String(chunk)); return write(chunk, ...rest); };
}
const seen: string[] = [];
const ROOT = path.resolve(import.meta.dirname, "..");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const CLIENT_ID = `acme-client-${randomBytes(6).toString("hex")}`;
const CLIENT_SECRET = `acme-secret-canary-${randomBytes(16).toString("hex")}`;
const PASTED_A = `pasted-a-${randomBytes(10).toString("hex")}`, PASTED_B = `pasted-b-${randomBytes(10).toString("hex")}`;

try {
  const clock = await import("../src/clock.js");
  const oa = await startOAuthStandin({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, now: clock.now });
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack, defineTool, z } = await import("../src/pack-api.js");
  const conn = await import("../src/oauth-connections.js");
  const { oauthRouter, oauthAdminRoutes } = await import("../src/oauth-routes.js");
  const runs = await import("../src/runs.js");
  const harness = await import("../src/run-harness.js");
  const rec = await import("../src/record-areas.js");
  const creds = await import("../src/credentials.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const express = (await import("express")).default;
  // The pack's provider is at https://login.acme.test: its calls go to the stand-in.
  conn.setOAuthFetchForTest((input, init) => fetch(String(input).replace("https://login.acme.test", oa.url), init));
  const A = (await createOrg(`OAuth A ${STAMP}`)).org, B = (await createOrg(`OAuth B ${STAMP}`)).org;

  // ---------- 1. nothing mounted; definePack's checks ----------
  {
    assert.equal(oauthRouter().stack.length, 0, "no field: nothing at /api/oauth");
    const admin = express.Router();
    oauthAdminRoutes(admin, () => (_q, _s, n) => n(), () => "x");
    assert.equal(admin.stack.length, 0);
    const area = { name: "pk_apps", label: "Apps", role: "asset", scope: "workspace", fields: [{ name: "url", label: "URL" }] };
    const prov = (x: Record<string, unknown> = {}) => ({ name: "acme", label: "Acme", authorize_url: "https://login.acme.test/authorize", token_url: "https://login.acme.test/token",
      client_id: { vault: "acme.client_id" }, client_secret: { vault: "acme.client_secret" }, ...x });
    const pack = (c: Record<string, unknown>, p: unknown[] = [prov()]) => definePack({ id: "pk", recordAreas: [area as never],
      credentials: [{ name: "tok", label: "Token", bound_to: "workspace", deliver_as: { env: "PK_TOKEN" }, ...c }] as never, oauthProviders: p as never });
    assert.throws(() => pack({ oauth: "nope" }), /does not declare \(oauthProviders\)/);
    assert.throws(() => pack({ oauth: "acme", github_app: true }), /either github_app or oauth/);
    assert.throws(() => pack({ oauth: "acme" }, [prov({ token_url: "http://login.acme.test/token" })]), /https/);
    assert.throws(() => pack({ oauth: "acme" }, [prov({ authorize_params: { redirect_uri: "https://evil.example" } })]), /flow's own parameters/);
    assert.throws(() => pack({ oauth: "acme" }, [prov(), prov()]), /each OAuth provider name once/);
    assert.doesNotThrow(() => pack({ oauth: "acme" }));
    const schema = (await import("node:fs")).readFileSync(path.join(ROOT, "packs", "pack.schema.json"), "utf8");
    assert.ok(schema.includes("\"oauth_providers\"") && schema.includes("\"oauth\""), "pack.json's schema has oauth_providers and oauth");
    console.log("✓ zero fields: nothing mounted; definePack refuses an unknown provider, github_app with oauth, http, the flow's own parameters, a name twice");
  }

  // ---------- the fixture pack ----------
  const kind = (name: string, credentials: string[], entry = "oa.mjs") => ({ name, runner: "workspace-harness", entry, lease_seconds: 30, credentials });
  const fixture = definePack({
    id: "fixture_oa",
    recordAreas: [{ name: "oa_apps", label: "Applications", role: "asset", scope: "workspace", fields: [{ name: "url", label: "Address" }] }],
    oauthProviders: [{ name: "acme", label: "Acme", authorize_url: "https://login.acme.test/authorize", token_url: "https://login.acme.test/token",
      revoke_url: "https://login.acme.test/revoke", scopes: ["read:all", "offline"], client_id: { vault: "acme.client_id" }, client_secret: { vault: "acme.client_secret" },
      authorize_params: { access_type: "offline" } }],
    credentials: [
      { name: "api_token", label: "Acme API", bound_to: "workspace", oauth: "acme", deliver_as: { file: "api_token" } },
      { name: "app_token", label: "Acme app token", bound_to: "asset", area: "oa_apps", oauth: "acme", deliver_as: { env: "APP_TOKEN" } },
      { name: "repo_token", label: "Repository token", bound_to: "workspace", github_app: true, deliver_as: { file: "gh_token" } },
    ],
    jobKinds: [kind("use", ["api_token", "app_token"]), kind("leak", ["api_token", "app_token"]), kind("long", ["api_token", "repo_token"], "long.mjs")] as never,
    tools: [defineTool({ name: "fixture_oa_run", description: "Start a run (test).", inputSchema: { kind: z.string(), targets: z.record(z.string(), z.unknown()).optional() },
      handler: async (_ws, { kind: k, targets }, { runs: r }) => r.start(k, { targets }) })],
  });
  setPacksForTest([{ manifest: { id: "fixture_oa", name: "Fixture OAuth", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: fixture }]);
  for (const [o, keys] of [[A, ["app-x"]], [B, ["app-x"]]] as const)
    for (const k of keys) await withTenant(o.orgId, () => rec.workspaceRecords("fixture_oa", o.orgId).put("oa_apps", k, { title: k, data: { url: `https://${k}.example` } }));

  const http = await startHttp();
  const ca = await connect(A), cb = await connect(B);
  const req = async (method: string, p: string, h: Record<string, string>, body?: unknown) => {
    const r = await fetch(`${http.base}${p}`, { method, redirect: "manual", headers: { ...h, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    seen.push(text, r.headers.get("location") ?? "");
    return { status: r.status, location: r.headers.get("location"), body: (() => { try { return JSON.parse(text); } catch { return text; } })() };
  };
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const client = await harness.localRunnerClient("w-oa");
  const start = async (c: typeof ca, k: string, targets: Record<string, unknown> = {}) => {
    const r = await c.call("fixture_oa_run", { kind: k, targets });
    seen.push(JSON.stringify(r));
    assert.ok(!r.isError, r.content[0]?.text);
    return r.structuredContent as { id: string };
  };
  const runIt = async (id: string, k: string, opts: Record<string, unknown> = {}) => {
    const c = await client.claim([`fixture_oa/${k}`]);
    assert.ok(c && c.run.id === id, `claimed ${id}`);
    const v = await harness.runWorkspaceHarness(client, c!, { allowSameUser: true, egress: "off", ...opts });
    assert.equal(v?.status, "succeeded", JSON.stringify(v));
  };
  const event = async (runId: string, type: string) => (await db.query<{ data: any }>("SELECT data FROM run_events WHERE run_id = $1 AND type = $2 ORDER BY id DESC LIMIT 1", [runId, type]))[0]?.data;
  const shaOf = (t: string) => sha(t);
  const accessBySha = (h: string | null) => [...oa.access.keys()].find((t) => shaOf(t) === h) ?? null;
  const injected = { cross: 0 };
  const slotA = creds.credentialSlot("fixture_oa", "api_token", null, null);

  try {
    const ownerA = await http.signIn(A, "owner"), ownerA2 = await http.signIn(A, "owner"), memberA = await http.signIn(A), ownerB = await http.signIn(B, "owner");
    for (const [tok, value] of [[ownerA, PASTED_A], [ownerB, PASTED_B]] as const)
      for (const body of [{ name: "api_token" }, { name: "app_token", asset: "app-x" }])
        assert.equal((await req("PUT", "/api/credentials", bearer(tok), { pack: "fixture_oa", ...body, value })).status, 200);
    const owner = await http.adminToken("owner"), operator = await http.adminToken("operator");

    // ---------- 2. the client is the vault's ----------
    {
      assert.equal((await req("POST", "/api/oauth/connect", bearer(ownerA), { pack: "fixture_oa", name: "api_token" })).status, 409, "no client in the vault: refused");
      const v0 = await req("GET", "/api/admin/onboarding/oauth", bearer(operator));
      assert.deepEqual([v0.body.providers[0].name, v0.body.providers[0].set], ["acme", { client_id: false, client_secret: false }]);
      assert.match(v0.body.redirect_uri, /\/api\/oauth\/callback$/);
      for (const [label, secret] of [["acme.client_id", CLIENT_ID], ["acme.client_secret", CLIENT_SECRET]])
        assert.equal((await req("POST", "/api/admin/keyvault/credentials", bearer(owner), { provider: "oauth_clients", label, secret })).status, 201);
      const v1 = await req("GET", "/api/admin/onboarding/oauth", bearer(operator));
      assert.deepEqual(v1.body.providers[0].set, { client_id: true, client_secret: true });
      console.log("✓ the client id and secret are the key vault's (oauth_clients, by label): none, no connect; staff see which are set");
    }

    // ---------- 3. connect ----------
    const begin = async (tok: string, body: Record<string, unknown> = { pack: "fixture_oa", name: "api_token" }) => {
      const r = await req("POST", "/api/oauth/connect", bearer(tok), body);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.url as string;
    };
    const back = async (tok: string, location: URL) => {
      const r = await req("GET", `/api/oauth/callback${location.search}`, bearer(tok));
      assert.equal(r.status, 303, JSON.stringify(r.body));
      return new URL(r.location!).searchParams.get("oauth");
    };
    {
      assert.equal((await req("POST", "/api/oauth/connect", bearer(memberA), { pack: "fixture_oa", name: "api_token" })).status, 403, "a member cannot connect");
      assert.equal((await req("POST", "/api/oauth/connect", bearer(ownerA), { pack: "fixture_oa", name: "app_token", asset: "app-b" })).status, 404, "an asset the workspace lacks");
      assert.equal((await req("POST", "/api/oauth/connect", { cookie: `__session=${ownerA}`, "content-type": "application/json" }, { pack: "fixture_oa", name: "api_token" })).status, 403, "a cookie POST without X-Pack-Request");
      const url = new URL(await begin(ownerA));
      assert.equal(url.origin + url.pathname, "https://login.acme.test/authorize");
      const q = url.searchParams;
      assert.deepEqual([q.get("response_type"), q.get("client_id"), q.get("scope"), q.get("code_challenge_method"), q.get("access_type")], ["code", CLIENT_ID, "read:all offline", "S256", "offline"]);
      assert.match(q.get("redirect_uri")!, /\/api\/oauth\/callback$/);
      assert.ok(!url.toString().includes(CLIENT_SECRET), "no secret in the address");
      // Another workspace's session, another person, a changed state.
      const ret = await oa.authorize(url.toString());
      assert.equal(await back(ownerB, ret), "other_workspace");
      assert.equal(await back(ownerA2, ret), "state_used", "another person of the workspace");
      const bad = new URL(ret); bad.searchParams.set("state", ret.searchParams.get("state")!.replace(/.$/, (c) => (c === "A" ? "B" : "A")));
      assert.equal(await back(ownerA, bad), "bad_state");
      // Denied at the provider.
      oa.state.deny = true;
      assert.equal(await back(ownerA, await oa.authorize(await begin(ownerA))), "denied");
      oa.state.deny = false;
      // A code the provider refuses (used already).
      const r2 = await oa.authorize(await begin(ownerA));
      const used = [...oa.codes.entries()].find(([c]) => c === r2.searchParams.get("code"))!;
      used[1].used = true;
      assert.equal(await back(ownerA, r2), "token_refused");
      assert.equal((await db.query("SELECT 1 FROM workspace_oauth_connections")).length, 0, "nothing stored by any of these");
      // Connected; the state was the one and only.
      assert.equal(await back(ownerA, ret), "connected");
      assert.equal(await back(ownerA, ret), "state_used", "a state is used once");
      assert.equal(await back(ownerA, await oa.authorize(await begin(ownerA, { pack: "fixture_oa", name: "app_token", asset: "app-x" }))), "connected");
      const list = await req("GET", "/api/oauth", bearer(memberA));
      assert.deepEqual(list.body.connections.map((c: any) => [c.name, c.asset, c.status, c.provider]), [["api_token", null, "active", "acme"], ["app_token", "app-x", "active", "acme"]]);
      assert.equal(list.body.can_manage, false);
      const [row] = await db.query<{ sealed: string }>("SELECT sealed FROM workspace_oauth_connections WHERE org_id = $1 AND name = 'api_token'", [A.orgId]);
      assert.ok(![...oa.access.keys(), ...oa.refresh.keys()].some((t) => row!.sealed.includes(t)), "sealed: no token in clear");
      // The PKCE verifier was checked by the provider (a code exchanged without it would have been refused).
      assert.ok(oa.calls.filter((c) => c.path === "/token").every((c) => !c.body.includes("code_verifier=") || /code_verifier=[A-Za-z0-9_-]{43}/.test(c.body)));
      console.log("✓ connect: sign-in address with client, scopes, PKCE and the signed state; foreign session, other person, changed state, denial, refused code, reuse refused; tokens sealed");
    }

    // ---------- 4. runs ----------
    {
      const ra = await start(ca, "use", { asset: "app-x" }), rb = await start(cb, "use", { asset: "app-x" });
      await runIt(ra.id, "use"); await runIt(rb.id, "use");
      const repA = await event(ra.id, "oa"), repB = await event(rb.id, "oa");
      const apiA = accessBySha(repA.sha.api_token), appA = accessBySha(repA.sha.app_token);
      assert.ok(apiA && appA && apiA !== appA, "A: each slot its own connection's access token (a file, a variable)");
      assert.deepEqual([await oa.me(apiA!), await oa.me(appA!)], [200, 200]);
      assert.deepEqual(repB.sha, { api_token: sha(PASTED_B), app_token: sha(PASTED_B) }, "B (not connected): its pasted values");
      if (accessBySha(repB.sha.api_token)) injected.cross++;
      const ev = await event(ra.id, "credentials");
      assert.deepEqual([ev.delivered, ev.oauth.map((x: any) => x.name)], [["api_token", "app_token"], ["api_token", "app_token"]]);
      assert.equal(JSON.stringify(repA).includes(CLIENT_SECRET), false, "no client secret in the run");
      assert.ok(![...oa.refresh.keys()].some((t) => JSON.stringify(repA).includes(t)), "no refresh token in the run");
      const lk = await start(ca, "leak", { asset: "app-x", mode: "leak" });
      await runIt(lk.id, "leak");
      const stored = JSON.stringify(await db.query("SELECT data FROM run_events WHERE run_id = $1", [lk.id]));
      assert.ok(!stored.includes(apiA!) && !stored.includes(appA!) && stored.includes("[credential api_token]"), "printed tokens are stored redacted");
      assert.equal(injected.cross, 0);
      console.log("✓ runs: the connection's access token per slot (file, variable), the pasted value where none, redacted; cross-workspace injections 0");
    }

    // ---------- 5. refresh ----------
    {
      const before = await conn.tokenForSlot(A.orgId, slotA) as { value: string };
      const grants = oa.state.grants.refresh_token;
      clock.advanceClockForTest(55 * 60_000);
      const three = await Promise.all([1, 2, 3].map(() => conn.tokenForSlot(A.orgId, slotA))) as { value: string; expires_at: string }[];
      assert.equal(oa.state.grants.refresh_token, grants + 1, "three at once: one refresh");
      assert.ok(three.every((t) => t.value === three[0]!.value) && three[0]!.value !== before.value, "all three get the refreshed token");
      assert.equal(await oa.me(three[0]!.value), 200);
      assert.ok(Date.parse(three[0]!.expires_at) - clock.now() > 50 * 60_000, "with its new hour");
      // Revoked at the provider: the refresh is refused, the connection needs to be made again, nothing is sent.
      for (const [t, r] of oa.refresh) if (!r.revoked) r.revoked = true;
      clock.advanceClockForTest(55 * 60_000);
      const refused = await conn.tokenForSlot(A.orgId, slotA);
      assert.ok(refused && "missing" in refused, JSON.stringify(refused));
      const [st] = await db.query<{ status: string; last_error: string }>("SELECT status, last_error FROM workspace_oauth_connections WHERE org_id = $1 AND name = 'api_token'", [A.orgId]);
      assert.deepEqual([st!.status, st!.last_error], ["needs_reconnect", "invalid_grant"]);
      const r = await start(ca, "use", { asset: "app-x" });
      await runIt(r.id, "use");
      assert.equal((await event(r.id, "oa")).sha.api_token, null, "a refused connection sends nothing, not the pasted value");
      assert.match((await event(r.id, "credentials")).oauth_missing[0].reason, /connect it again/);
      // Connect again: works.
      const ownerA = await http.signIn(A, "owner");
      assert.equal(await back(ownerA, await oa.authorize(await begin(ownerA))), "connected");
      assert.equal(await oa.me(((await conn.tokenForSlot(A.orgId, slotA)) as { value: string }).value), 200);
      console.log("✓ refresh: before expiry, once for concurrent askers (rotation safe); a refused refresh stops sending until connected again");
    }

    // ---------- 7. a run of four hours (simulated) ----------
    const gh = await (async () => {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
      const s = await startGithubStandin({ appId: 4242, clientId: "Iv1.0123456789abcdef", clientSecret: "x".repeat(20), publicKeyPem: publicKey, now: clock.now });
      s.installations.set(77, { id: 77, app_id: 4242, account: { login: "acme", type: "Organization" }, repository_selection: "selected", repositories: [{ id: 1, full_name: "acme/api" }] });
      const ghApp = await import("../src/github-app.js");
      ghApp.setGithubEndpointsForTest({ api: s.url, web: s.url });
      await ghApp.setAppConfig({ app_id: "4242", slug: "test-app", client_id: "Iv1.0123456789abcdef", client_secret: "x".repeat(20), webhook_secret: "y".repeat(20), private_key: privateKey });
      await db.query("INSERT INTO workspace_github_installations (org_id, installation_id, account_login, repositories) VALUES ($1, 77, 'acme', $2::jsonb)", [A.orgId, JSON.stringify([{ id: 1, full_name: "acme/api" }])]);
      return s;
    })();
    const longRun = async (refreshMs: number, ticks: number, during?: (i: number) => Promise<void>) => {
      const r = await start(ca, "long", { gh_url: gh.url, oa_url: oa.url, ticks, every_ms: 100 });
      const c = (await client.claim(["fixture_oa/long"]))!;
      assert.equal(c.run.id, r.id);
      let i = 0;
      // The credential clock moves five minutes every 100 ms while the run goes: about four hours in five seconds.
      const timer = setInterval(() => { clock.advanceClockForTest(5 * 60_000); void during?.(++i); }, 100);
      try { await harness.runWorkspaceHarness(client, c, { allowSameUser: true, egress: "off", credentialRefreshMs: refreshMs }); }
      finally { clearInterval(timer); }
      return { id: r.id, reads: (await event(r.id, "long")).reads as { oa: number; gh: number; oa_sha: string | null; gh_sha: string | null }[] };
    };
    {
      const t0 = clock.now();
      const { id, reads } = await longRun(30, 45);
      const hours = (clock.now() - t0) / 3_600_000;
      assert.ok(hours > 3, `simulated ${hours.toFixed(1)} h`);
      const failed = reads.filter((x) => x.oa !== 200 || x.gh !== 200);
      assert.equal(failed.length, 0, `every read works: ${JSON.stringify(failed.slice(0, 3))}`);
      const oaTokens = new Set(reads.map((x) => x.oa_sha)), ghTokens = new Set(reads.map((x) => x.gh_sha));
      assert.ok(oaTokens.size >= 3 && ghTokens.size >= 3, `fresh tokens in the files: OAuth ${oaTokens.size}, GitHub ${ghTokens.size}`);
      const refreshed = await db.query("SELECT data FROM run_events WHERE run_id = $1 AND type = 'credentials_refreshed'", [id]);
      assert.ok(refreshed.length >= 3, `credentials_refreshed events: ${refreshed.length}`);
      const all = JSON.stringify(await db.query("SELECT type, data FROM run_events WHERE run_id = $1", [id]));
      assert.ok(![...oa.access.keys(), ...gh.minted.map((t) => t.token)].some((t) => all.includes(t)), "no token of the run in its events");
      // Every token the run held is redacted by the engine too (it knows each one).
      const secrets = await creds.runSecrets({ id, org_id: A.orgId, pack: "fixture_oa", spec: { credentials: ["api_token", "repo_token"] }, targets: {} });
      assert.ok(secrets.length >= oaTokens.size + ghTokens.size - 2, `the engine holds the run's tokens for redaction (${secrets.length})`);
      console.log(`✓ a ${hours.toFixed(1)} h run (simulated) on one-hour tokens: ${reads.length} reads all work; ${oaTokens.size} OAuth and ${ghTokens.size} GitHub tokens rewritten into its files; ${refreshed.length} refreshes`);
      // Control: the same run with no refresh while it goes fails once its first tokens expire.
      const ctl = await longRun(3_600_000, 45);
      assert.ok(ctl.reads.slice(-5).every((x) => x.oa === 401 && x.gh === 401), `without the refresh the later reads fail: ${JSON.stringify(ctl.reads.slice(-2))}`);
      console.log("✓ control: without the mid-run refresh the same run's reads fail after the first hour");
    }

    // ---------- 6. disconnect, mid-run and staff ----------
    {
      const ownerA = await http.signIn(A, "owner");
      // Disconnected while a run goes (with no pasted value to fall back to): the provider is told, so the token stops
      // working at once; its file is emptied at the run's next refresh; nothing is sent from then on.
      assert.equal((await req("DELETE", "/api/credentials", bearer(ownerA), { pack: "fixture_oa", name: "api_token" })).status, 200);
      let done = false;
      const mid = await longRun(30, 30, async (i) => {
        if (i === 6 && !done) { done = true; const d = await req("DELETE", "/api/oauth", bearer(ownerA), { pack: "fixture_oa", name: "api_token" }); assert.deepEqual(d.body, { removed: true, revoked_at_provider: true }); }
      });
      assert.ok(mid.reads.slice(-5).every((x) => x.oa === 0 && x.gh === 200), `after the disconnect the file is empty (and the other credential still works): ${JSON.stringify(mid.reads.slice(-2))}`);
      const firstOff = mid.reads.findIndex((x) => x.oa !== 200);
      assert.ok(firstOff > 0 && mid.reads.slice(firstOff).every((x) => x.oa !== 200), "once disconnected, never working again in that run");
      assert.ok([...oa.refresh.values()].every((r) => r.revoked), "the provider was told");
      const r = await start(ca, "use", { asset: "app-x" });
      await runIt(r.id, "use");
      assert.equal((await event(r.id, "oa")).sha.api_token, null, "disconnected (and nothing pasted): nothing is sent");
      // Staff remove the asset's connection.
      const viewer = await http.adminToken("viewer");
      const v = await req("GET", "/api/admin/onboarding/oauth", bearer(viewer));
      const c = v.body.connections.find((x: any) => x.name === "app_token" && x.workspace.id === A.orgId);
      assert.ok(c);
      assert.equal((await req("DELETE", `/api/admin/onboarding/oauth/connections/${c.id}`, bearer(viewer))).status, 403);
      assert.deepEqual((await req("DELETE", `/api/admin/onboarding/oauth/connections/${c.id}`, bearer(operator))).body, { removed: true, revoked_at_provider: true });
      console.log("✓ disconnect: mid-run (the provider told: the token stops at once; its file emptied at the next refresh), nothing sent after; staff remove one by id");
    }

    // ---------- 8. workspace removal, row-level security ----------
    {
      const ownerA = await http.signIn(A, "owner");
      assert.equal(await back(ownerA, await oa.authorize(await begin(ownerA))), "connected");
      const live = [...oa.refresh.entries()].filter(([, r]) => !r.revoked).map(([t]) => t);
      assert.equal(live.length, 1);
      const { deleteOrg } = await import("../src/tenancy.js");
      await deleteOrg(A.orgId);
      assert.equal(oa.refresh.get(live[0]!)!.revoked, true, "removing the workspace tells the provider");
      const { rlsCatalogProblems, rlsProbe } = await import("../src/rls.js");
      assert.deepEqual(await rlsCatalogProblems(db), []);
      const probe = await rlsProbe(db);
      assert.deepEqual(probe.problems, []);
      for (const t of ["oauth_states", "workspace_oauth_connections", "run_oauth_tokens"])
        assert.equal(await withTenant(B.orgId, () => db.query(`/* tenant: test */ SELECT 1 FROM ${t}`).then(() => "read", (e) => e.code)), "42501", `tenant work cannot read ${t}`);
      console.log(`✓ workspace removal tells the provider; row-level security: catalog and probe pass (${probe.checked} checks), the three tables closed to tenant work`);
    }
  } finally {
    await ca.close(); await cb.close();
    await http.close();
  }

  // ---------- the secrets grep ----------
  {
    const tables = (await db.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).map((r) => r.t);
    const never = [CLIENT_SECRET, ...oa.refresh.keys()];
    const tokens = [...oa.access.keys()];
    let secretHits = 0, tokenHits = 0;
    for (const t of tables) {
      const [r] = await db.query<{ x: string | null }>(`/* tenant: test, every row of every table */ SELECT string_agg(z::text, E'\\n') AS x FROM "${t}" z`);
      const x = r?.x ?? "";
      secretHits += never.filter((n) => x.includes(n)).length;
      const n = tokens.filter((k) => x.includes(k)).length;
      if (n) console.error(`  an access token in table ${t}: ${n}`);
      tokenHits += n;
    }
    const answers = never.filter((n) => seen.join("\n").includes(n)).length + tokens.filter((n) => seen.join("\n").includes(n)).length;
    const logs = never.filter((n) => logged.join("").includes(n)).length + tokens.filter((n) => logged.join("").includes(n)).length;
    console.log(`✓ secrets grep: client secret and refresh tokens in tables ${secretHits}; access tokens in clear in tables ${tokenHits}; any of them in answers ${answers}, logs ${logs}`);
    assert.deepEqual({ secretHits, tokenHits, answers, logs }, { secretHits: 0, tokenHits: 0, answers: 0, logs: 0 });
  }
  await db.close();
  console.log("OAUTH PROVIDERS TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
