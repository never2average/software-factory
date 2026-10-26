// Repository access by a GitHub App per workspace (mold_v0-014; src/github-app.ts, src/github-app-routes.ts), offline:
// an embedded database, the HTTP server behind a fake Clerk, a stand-in for GitHub (scripts/lib/github-standin.ts) and
// fixture runs (scripts/fixtures/runs/gh.mjs). No GitHub App is created anywhere.
//   npm run test:github-app
//
//  1. No field asks for the app: nothing is mounted (customer routes, webhook, staff routes).
//  2. The app's settings (staff): checked, sealed in the key vault, answered without a secret; only the vault's owners set them.
//  3. Fallback: with no app configured a field declared github_app delivers the pasted token as before.
//  4. The install flow: an owner gets a signed one-time state; the callback binds the installation to that workspace only
//     when the signature, the expiry, the session (same workspace, same person, an owner), the person's own reach on
//     GitHub (the user-authorization code) and the app all match; a used, tampered, expired or other-workspace state, an
//     installation the person cannot reach, another app's installation and one held by another workspace are refused.
//  5. Runs: a token minted per run, read-only contents, scoped to the installation's repositories or to the ones an owner
//     narrowed the asset to; reused while it has time left and minted again near expiry; a token GitHub over-grants is
//     revoked and never delivered; revoked on GitHub when the run ends; what the run prints is redacted of it. Two
//     workspaces with the same asset key: each gets its own installation's token (cross-workspace injections 0).
//  6. The webhook: a bad signature changes nothing; repositories removed leave the list and the narrowing; suspended
//     installations get no token; an uninstall ends the connection at once (the next run gets the pasted value).
//  7. Disconnect (an owner), revoke (staff) and workspace removal: the row ends, the installation is uninstalled.
//  8. Isolation and secrecy: tenant work cannot reach the three tables (row-level security, the live probe); the
//     platform's private key, client secret and webhook secret are in no run's environment, file or event, no answer, no
//     log and no table in clear; no run token is in any table in clear.
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp } from "./lib/test-world.js";
import { startGithubStandin } from "./lib/github-standin.js";

const logged: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream) as (...a: unknown[]) => boolean;
  (stream as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => { logged.push(String(chunk)); return write(chunk, ...rest); };
}
const seen: string[] = [];
const ROOT = path.resolve(import.meta.dirname, "..");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const GH_APP_ID = 424242;
const { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const CLIENT_ID = `Iv1.${randomBytes(8).toString("hex")}`;
const CLIENT_SECRET = `client-secret-canary-${randomBytes(16).toString("hex")}`;
const WEBHOOK_SECRET = `webhook-secret-canary-${randomBytes(16).toString("hex")}`;
const PASTED_A = `pasted-a-${randomBytes(10).toString("hex")}`, PASTED_B = `pasted-b-${randomBytes(10).toString("hex")}`;
/** The platform's secrets as they could appear anywhere: whole, JSON-escaped, base64, and each line of the key. */
const keyLines = PRIVATE_KEY.split("\n").filter((l) => l.length > 40);
const secretNeedles = [CLIENT_SECRET, WEBHOOK_SECRET, PRIVATE_KEY, JSON.stringify(PRIVATE_KEY).slice(1, -1), Buffer.from(PRIVATE_KEY).toString("base64").slice(10, 70), ...keyLines,
  Buffer.from(CLIENT_SECRET).toString("base64"), Buffer.from(WEBHOOK_SECRET).toString("base64")];
const secretHits = (text: string | Buffer) => secretNeedles.filter((n) => text.includes(n)).length;

const gh = await startGithubStandin({ appId: GH_APP_ID, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, publicKeyPem: PUBLIC_KEY });
const repos = (owner: string, base: number, names: string[]) => names.map((n, i) => ({ id: base + i, full_name: `${owner}/${n}` }));
gh.installations.set(1001, { id: 1001, app_id: GH_APP_ID, account: { login: "acme", type: "Organization" }, repository_selection: "selected", repositories: repos("acme", 10, ["api", "web", "infra"]) });
gh.installations.set(2002, { id: 2002, app_id: GH_APP_ID, account: { login: "globex", type: "Organization" }, repository_selection: "selected", repositories: repos("globex", 20, ["api", "ops"]) });
gh.installations.set(3003, { id: 3003, app_id: 999, account: { login: "other-app-org", type: "Organization" }, repository_selection: "all", repositories: repos("oa", 30, ["x"]) });

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack, defineTool, z } = await import("../src/pack-api.js");
  const ghApp = await import("../src/github-app.js");
  const { githubAppRouter, githubAppAdminRoutes } = await import("../src/github-app-routes.js");
  const runs = await import("../src/runs.js");
  const harness = await import("../src/run-harness.js");
  const rec = await import("../src/record-areas.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const express = (await import("express")).default;
  ghApp.setGithubEndpointsForTest({ api: gh.url, web: gh.url });
  const A = (await createOrg(`GitHub A ${STAMP}`)).org, B = (await createOrg(`GitHub B ${STAMP}`)).org;

  // ---------- 1. nothing mounted without a field ----------
  {
    assert.deepEqual(ghApp.githubAppFields(), []);
    assert.equal(githubAppRouter().stack.length, 0, "no field: nothing at /api/github-app (the webhook neither)");
    const admin = express.Router();
    githubAppAdminRoutes(admin, () => (_q, _s, n) => n(), () => "x");
    assert.equal(admin.stack.length, 0, "nor on the staff API");
    console.log("✓ zero fields: nothing mounted for customers, GitHub or staff");
  }

  // ---------- the fixture pack ----------
  const kind = (name: string, extra: Record<string, unknown> = {}) => ({ name, runner: "workspace-harness", entry: "gh.mjs", lease_seconds: 30, credentials: ["repo_token"], ...extra });
  const fixture = definePack({
    id: "fixture_gh",
    recordAreas: [
      { name: "gh_apps", label: "Applications", role: "asset", scope: "workspace", fields: [{ name: "url", label: "Address" }] },
      { name: "gh_checks", label: "Checks", role: "check", scope: "platform", fields: [{ name: "summary", label: "Summary" }] },
    ],
    credentials: [
      { name: "repo_token", label: "Repository read token", bound_to: "asset", area: "gh_apps", github_app: true, deliver_as: { env: "GITHUB_TOKEN" } },
    ],
    jobKinds: [kind("clone"), kind("leak")] as never,
    tools: [
      defineTool({ name: "fixture_gh_run", description: "Start a run (test).", inputSchema: { kind: z.string(), targets: z.record(z.string(), z.unknown()).optional() },
        handler: async (_ws, { kind: k, targets }, { runs: r }) => r.start(k, { targets }) }),
    ],
  });
  assert.equal(fixture.credentials?.[0]?.github_app, true, "definePack takes github_app");
  const schema = JSON.parse((await import("node:fs")).readFileSync(path.join(ROOT, "packs", "pack.schema.json"), "utf8"));
  assert.ok(JSON.stringify(schema).includes("\"github_app\""), "pack.json's schema has github_app");
  setPacksForTest([{ manifest: { id: "fixture_gh", name: "Fixture GitHub", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: fixture }]);
  assert.deepEqual(ghApp.githubAppFields().map((f) => f.name), ["repo_token"]);
  for (const [o, keys] of [[A, ["app-x", "app-a"]], [B, ["app-x", "app-b"]]] as const)
    for (const k of keys) await withTenant(o.orgId, () => rec.workspaceRecords("fixture_gh", o.orgId).put("gh_apps", k, { title: k, data: { url: `https://${k}.example` } }));

  const http = await startHttp();
  const ca = await connect(A), cb = await connect(B);
  const req = async (method: string, p: string, h: Record<string, string>, body?: unknown) => {
    const r = await fetch(`${http.base}${p}`, { method, redirect: "manual",
      headers: { ...h, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await r.text();
    seen.push(text, r.headers.get("location") ?? "");
    return { status: r.status, location: r.headers.get("location"), body: (() => { try { return JSON.parse(text); } catch { return text; } })() };
  };
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const client = await harness.localRunnerClient("w-gh");
  const start = async (c: typeof ca, k: string, targets: Record<string, unknown> = {}) => {
    const r = await c.call("fixture_gh_run", { kind: k, targets });
    seen.push(JSON.stringify(r));
    assert.ok(!r.isError, r.content[0]?.text);
    return r.structuredContent as { id: string };
  };
  const runIt = async (id: string, k = "clone") => {
    const c = await client.claim([`fixture_gh/${k}`]);
    assert.ok(c && c.run.id === id, `claimed ${id}`);
    assert.equal(secretHits(JSON.stringify(c)), 0, "the claim carries no platform secret");
    const v = await harness.runWorkspaceHarness(client, c!, { allowSameUser: true, egress: "off" });
    assert.equal(v?.status, "succeeded", JSON.stringify(v));
    return v;
  };
  const report = async (runId: string) => (await db.query<{ data: any }>("SELECT data FROM run_events WHERE run_id = $1 AND type = 'gh' ORDER BY id DESC LIMIT 1", [runId]))[0]?.data;
  const credEvent = async (runId: string) => (await db.query<{ data: any }>("SELECT data FROM run_events WHERE run_id = $1 AND type = 'credentials' ORDER BY id DESC LIMIT 1", [runId]))[0]?.data;
  const tokenBySha = (h: string | null) => gh.minted.find((t) => sha(t.token) === h) ?? null;
  const injected = { cross: 0 };

  try {
    const ownerA = await http.signIn(A, "owner"), ownerA2 = await http.signIn(A, "owner"), memberA = await http.signIn(A), ownerB = await http.signIn(B, "owner");
    // Pasted tokens, the fallback.
    for (const [tok, value] of [[ownerA, PASTED_A], [ownerB, PASTED_B]] as const)
      assert.equal((await req("PUT", "/api/credentials", bearer(tok), { pack: "fixture_gh", name: "repo_token", asset: "app-x", value })).status, 200);

    // ---------- 3. fallback: no app configured ----------
    {
      const v = await req("GET", "/api/github-app", bearer(ownerA));
      assert.equal(v.status, 200);
      assert.deepEqual([v.body.available, v.body.installation, v.body.can_manage], [false, null, true]);
      assert.equal((await req("POST", "/api/github-app/install", bearer(ownerA))).status, 409, "no app: no install");
      const r = await start(ca, "clone", { asset: "app-x" });
      await runIt(r.id);
      assert.equal((await report(r.id)).sha, sha(PASTED_A), "no app: the pasted token is delivered as before");
      assert.equal((await credEvent(r.id)).github_app, undefined);
      console.log("✓ fallback: with no app configured the pasted token is delivered, the install refused");
    }

    // ---------- 2. the app's settings (staff) ----------
    {
      const owner = await http.adminToken("owner"), operator = await http.adminToken("operator");
      const g0 = await req("GET", "/api/admin/onboarding/github-app", bearer(operator));
      assert.equal(g0.status, 200);
      assert.equal(g0.body.app.configured, false);
      assert.match(g0.body.setup.callback_url, /\/api\/github-app\/callback$/);
      assert.match(g0.body.setup.webhook_url, /\/api\/github-app\/webhook$/);
      assert.deepEqual(g0.body.setup.permissions, { contents: "read", metadata: "read" });
      const put = (tok: string, body: unknown) => req("PUT", "/api/admin/onboarding/github-app", bearer(tok), body);
      assert.equal((await put(operator, { app_id: String(GH_APP_ID) })).status, 403, "only the key vault's owners set it");
      const badKey = `-----BEGIN RSA PRIVATE KEY-----\n${CLIENT_SECRET}\n-----END RSA PRIVATE KEY-----\n`;
      const bk = await put(owner, { private_key: badKey });
      assert.equal(bk.status, 400);
      assert.equal(secretHits(JSON.stringify(bk.body)), 0, "a refused key is not quoted");
      assert.equal((await put(owner, { app_id: "12ab" })).status, 400);
      assert.equal((await put(owner, { webhook_secret: "short" })).status, 400);
      assert.equal((await put(owner, { nope: "x" })).status, 400);
      const ok = await put(owner, { app_id: String(GH_APP_ID), slug: "workspace-test-app", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, private_key: PRIVATE_KEY, webhook_secret: WEBHOOK_SECRET });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.configured, true);
      assert.deepEqual(ok.body.set, { client_secret: true, private_key: true, webhook_secret: true });
      assert.match(ok.body.private_key_fingerprint, /^SHA256:/);
      const [row] = await db.query<{ ciphertext: string; hint: string }>("SELECT ciphertext, hint FROM vault_credentials WHERE provider = 'github_app'");
      assert.equal(secretHits(row!.ciphertext + row!.hint), 0, "sealed in the key vault");
      assert.equal(secretHits(JSON.stringify((await req("GET", "/api/admin/onboarding/github-app", bearer(operator))).body)), 0, "the staff view carries no secret");
      assert.equal(secretHits(JSON.stringify((await req("GET", "/api/admin/keyvault/credentials", bearer(operator))).body)), 0, "nor the key vault's list");
      console.log("✓ settings: checked (a bad key not quoted), sealed in the key vault, answered without a secret, set by the vault's owners only");
    }

    // ---------- 4. the install flow ----------
    const begin = async (tok: string) => {
      const r = await req("POST", "/api/github-app/install", bearer(tok));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const u = new URL(r.body.url);
      assert.equal(u.pathname, "/apps/workspace-test-app/installations/new");
      return u.searchParams.get("state")!;
    };
    const code = (installations: number[]) => { const c = randomBytes(10).toString("hex"); gh.codes.set(c, installations); return c; };
    const back = async (tok: string, q: Record<string, string>) => {
      const r = await req("GET", `/api/github-app/callback?${new URLSearchParams(q)}`, bearer(tok));
      assert.equal(r.status, 303, JSON.stringify(r.body));
      return new URL(r.location!).searchParams.get("github");
    };
    {
      assert.equal((await req("POST", "/api/github-app/install", bearer(memberA))).status, 403, "a member cannot connect");
      assert.equal((await req("POST", "/api/github-app/install", { cookie: `__session=${ownerA}` })).status, 403, "a cookie POST without X-Pack-Request is refused");
      // Cross-workspace: B's owner brings A's state back.
      const sA = await begin(ownerA);
      assert.equal(await back(ownerB, { installation_id: "1001", setup_action: "install", state: sA, code: code([1001]) }), "other_workspace", "another workspace's session is refused");
      assert.equal(await back(ownerA2, { installation_id: "1001", setup_action: "install", state: sA, code: code([1001]) }), "state_used", "another person of the same workspace: refused");
      assert.equal(await back(memberA, { installation_id: "1001", setup_action: "install", state: sA, code: code([1001]) }), "not_owner");
      // Tampered and expired states.
      const [payload, sig] = sA.split(".");
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), o: B.orgId })).toString("base64url");
      assert.equal(await back(ownerB, { installation_id: "1001", setup_action: "install", state: `${forged}.${sig}`, code: code([1001]) }), "bad_state", "a payload changed under its signature");
      // The shared signed state (src/oauth-state.ts): a payload signed with the server's own key, here for the test.
      const { signState } = await import("../src/oauth-state.js");
      const signed = (p: object) => { const x = Buffer.from(JSON.stringify({ p: "github_app", ...p })).toString("base64url"); return `${x}.${signState(x)}`; };
      assert.equal(await back(ownerA, { installation_id: "1001", state: signed({ v: 1, o: A.orgId, n: "x", e: Date.now() - 1000 }), code: code([1001]) }), "expired");
      assert.equal(await back(ownerA, { installation_id: "1001", state: signed({ v: 1, o: A.orgId, n: "never-issued", e: Date.now() + 60_000 }), code: code([1001]) }), "state_used", "a nonce never issued");
      // The person's reach on GitHub, the user-authorization code, the app.
      const s2 = await begin(ownerA);
      assert.equal(await back(ownerA, { installation_id: "2002", setup_action: "install", state: s2, code: code([1001]) }), "not_your_installation", "an installation the person cannot reach");
      assert.equal(await back(ownerA, { installation_id: "1001", setup_action: "install", state: await begin(ownerA) }), "no_user_authorization", "no user-authorization code");
      assert.equal(await back(ownerA, { installation_id: "1001", setup_action: "install", state: await begin(ownerA), code: "never-issued" }), "user_authorization_failed");
      assert.equal(await back(ownerA, { installation_id: "3003", setup_action: "install", state: await begin(ownerA), code: code([3003]) }), "other_app", "another app's installation");
      assert.equal(await back(ownerA, { setup_action: "request", state: await begin(ownerA) }), "requested", "an install asked of an organization's owner");
      assert.equal((await db.query("SELECT 1 FROM workspace_github_installations")).length, 0, "nothing bound by any of these");
      // Now A binds 1001, once; the state is spent.
      const good = await begin(ownerA);
      assert.equal(await back(ownerA, { installation_id: "1001", setup_action: "install", state: good, code: code([1001]) }), "connected");
      assert.equal(await back(ownerA, { installation_id: "1001", setup_action: "install", state: good, code: code([1001]) }), "state_used", "a state is used once");
      // The user tokens the codes gave were revoked at once.
      assert.ok([...gh.userTokens.values()].every((u) => u.revoked), "every user token the callback got is revoked");
      // B cannot take A's installation, even with a person who reaches it on GitHub.
      assert.equal(await back(ownerB, { installation_id: "1001", setup_action: "install", state: await begin(ownerB), code: code([1001, 2002]) }), "installation_in_use");
      assert.equal(await back(ownerB, { installation_id: "2002", setup_action: "install", state: await begin(ownerB), code: code([2002]) }), "connected");
      assert.equal(await back(ownerB, { installation_id: "1001", setup_action: "install", state: await begin(ownerB), code: code([1001]) }), "installation_in_use");
      const vA = await req("GET", "/api/github-app", bearer(memberA));
      assert.deepEqual([vA.body.available, vA.body.installation.account, vA.body.installation.repositories, vA.body.can_manage],
        [true, "acme", ["acme/api", "acme/infra", "acme/web"], false]);
      assert.equal((await req("GET", "/api/github-app", bearer(ownerB))).body.installation.account, "globex", "each workspace sees its own");
      // Every call to GitHub with the app's key was a JWT to /app/* only; the key itself was never sent.
      assert.ok(gh.calls.filter((c) => /^Bearer [^.]+\.[^.]+\.[^.]+$/.test(c.auth)).every((c) => c.path.startsWith("/app/")), "the app's JWT goes to /app/ routes only");
      // (The client secret does go to GitHub: in the code exchange and the user token's revocation, as GitHub requires.)
      const sent = gh.calls.map((c) => c.auth + c.body).join("\n");
      assert.equal([WEBHOOK_SECRET, PRIVATE_KEY, ...keyLines, Buffer.from(WEBHOOK_SECRET).toString("base64")].filter((n) => sent.includes(n)).length, 0, "the private key and webhook secret never leave the server");
      console.log("✓ install: signed one-time state bound to workspace and person; tampered, expired, used, foreign states, unreachable, other-app and held installations refused; user tokens revoked");
    }

    // ---------- 5. runs ----------
    {
      const scopeOf = (t: { repository_ids: number[] | null; installation: number }) => (t.repository_ids ?? []).map((id) => gh.installations.get(t.installation)!.repositories.find((r) => r.id === id)!.full_name).sort();
      const ra = await start(ca, "clone", { asset: "app-x" }), rb = await start(cb, "clone", { asset: "app-x" });
      await runIt(ra.id); await runIt(rb.id);
      const ta = tokenBySha((await report(ra.id)).sha), tb = tokenBySha((await report(rb.id)).sha);
      assert.ok(ta && tb, "each run got a token the stand-in minted");
      if (ta!.installation !== 1001) injected.cross++;
      if (tb!.installation !== 2002) injected.cross++;
      assert.deepEqual([ta!.installation, scopeOf(ta!), ta!.permissions], [1001, ["acme/api", "acme/infra", "acme/web"], { contents: "read", metadata: "read" }], "A: its installation, its repositories, read contents only");
      assert.deepEqual([tb!.installation, scopeOf(tb!)], [2002, ["globex/api", "globex/ops"]], "B: its own");
      const ev = await credEvent(ra.id);
      assert.deepEqual([ev.delivered, ev.missing, ev.github_app[0].name, ev.github_app[0].repositories.sort()], [["repo_token"], [], "repo_token", ["acme/api", "acme/infra", "acme/web"]]);
      assert.equal(secretHits(JSON.stringify(ev)), 0);
      // The run ended: its token is revoked on GitHub (the flush after the attempt's end).
      await ghApp.flushRevocations();
      assert.equal(ta!.revoked, true, "revoked on GitHub when the run ended");
      assert.equal(await gh.read(ta!.token, "acme/api"), 401, "a revoked token reads nothing");
      // Narrowed to one repository for app-x.
      const nr = await req("PUT", "/api/github-app/repositories", bearer(ownerA), { area: "gh_apps", asset: "app-x", repositories: ["ACME/api"] });
      assert.equal(nr.status, 200, JSON.stringify(nr.body));
      assert.deepEqual(nr.body.repositories, ["acme/api"]);
      assert.equal((await req("PUT", "/api/github-app/repositories", bearer(ownerA), { area: "gh_apps", asset: "app-x", repositories: ["globex/api"] })).status, 400, "another installation's repository");
      assert.equal((await req("PUT", "/api/github-app/repositories", bearer(ownerA), { area: "gh_apps", asset: "app-b", repositories: ["acme/api"] })).status, 404, "another workspace's asset");
      assert.equal((await req("PUT", "/api/github-app/repositories", bearer(memberA), { area: "gh_apps", asset: "app-x", repositories: [] })).status, 403);
      const rn = await start(ca, "clone", { asset: "app-x" });
      // Fetched twice in the run (a runner that asks again): one token, reused.
      const claim = (await client.claim(["fixture_gh/clone"]))!;
      assert.equal(claim.run.id, rn.id);
      const c1 = await runs.runCredentialsForLease(claim.run.id, claim.lease_token), c2 = await runs.runCredentialsForLease(claim.run.id, claim.lease_token);
      assert.equal(c1.credentials[0]!.value, c2.credentials[0]!.value, "reused while it has time left");
      assert.equal(secretHits(JSON.stringify(c1)), 0, "what a runner receives holds no platform secret");
      const tn = gh.minted.find((t) => t.token === c1.credentials[0]!.value)!;
      assert.deepEqual(scopeOf(tn), ["acme/api"], "narrowed to the asset's repositories");
      assert.deepEqual([await gh.read(tn.token, "acme/api"), await gh.read(tn.token, "acme/web"), await gh.read(tn.token, "globex/api")], [200, 404, 404], "it reads exactly those");
      // Near expiry (two minutes left, on GitHub and here): minted again.
      const t1 = gh.minted.find((t) => t.token === c1.credentials[0]!.value)!;
      t1.expires_at = Date.now() + 120_000;
      await db.query("UPDATE run_github_app_tokens SET expires_at = $2 WHERE run_id = $1", [rn.id, new Date(t1.expires_at)]);
      const c3 = await runs.runCredentialsForLease(claim.run.id, claim.lease_token);
      assert.notEqual(c3.credentials[0]!.value, c1.credentials[0]!.value, "a token with under five minutes left is not handed out again");
      // Expired: GitHub refuses it, and it is never handed out again.
      const t3 = gh.minted.find((t) => t.token === c3.credentials[0]!.value)!;
      t3.expires_at = Date.now() - 1000;
      await db.query("UPDATE run_github_app_tokens SET expires_at = $2 WHERE run_id = $1 AND expires_at > now() + interval '10 minutes'", [rn.id, new Date(t3.expires_at)]);
      assert.equal(await gh.read(t3.token, "acme/api"), 401, "expired: it reads nothing");
      const c4 = await runs.runCredentialsForLease(claim.run.id, claim.lease_token);
      assert.ok(![c1, c3].some((c) => c.credentials[0]!.value === c4.credentials[0]!.value), "an expired token is not handed out: a new one is minted");
      assert.equal(await gh.read(c4.credentials[0]!.value, "acme/api"), 200);
      // Everything minted for the run is redacted from what it writes, and revoked at its end.
      const all = [c1, c3, c4].map((c) => c.credentials[0]!.value);
      await runs.appendRunEvents(claim.run.id, claim.lease_token, [{ type: "log", data: { line: `t1 ${all[0]} t3 ${all[1]} t4 ${all[2]}` } }]);
      await runs.completeRun(claim.run.id, claim.lease_token, { outcome: "succeeded", results: [] });
      const stored = JSON.stringify(await db.query("SELECT data FROM run_events WHERE run_id = $1", [rn.id]));
      assert.ok(all.every((v) => !stored.includes(v)) && stored.includes("[credential repo_token]"), "redacted by the engine, every token of the run (the expired one too)");
      await ghApp.flushRevocations();
      assert.deepEqual([t1.revoked, gh.minted.find((t) => t.token === all[2])!.revoked], [true, true], "each token GitHub still honoured is revoked on GitHub");
      // A run that prints its token: stored redacted.
      const lk = await start(ca, "leak", { asset: "app-x" });
      await runIt(lk.id, "leak");
      const lkEvents = JSON.stringify(await db.query("SELECT type, data FROM run_events WHERE run_id = $1", [lk.id]));
      const lkToken = gh.minted.filter((t) => t.installation === 1001).at(-1)!.token;
      assert.ok(!lkEvents.includes(lkToken) && !lkEvents.includes(Buffer.from(lkToken).toString("base64")) && lkEvents.includes("[credential repo_token]"), "printed, base64'd, in a URL: redacted");
      // Over-granted by GitHub: revoked, not delivered (the run gets none, never a broader one).
      gh.state.overgrant = { contents: "write" };
      const og = await start(ca, "clone", { asset: "app-a" });
      await runIt(og.id);
      gh.state.overgrant = false;
      assert.equal((await report(og.id)).sha, null, "an over-granted token is not delivered");
      assert.match((await credEvent(og.id)).github_app_missing[0].reason, /more than was asked/);
      assert.ok(gh.minted.at(-1)!.revoked, "and it was revoked");
      // The other workspace's assets: app-a (A's, no narrowing) gets every repository of A's installation; B's gets B's.
      const rA2 = await start(ca, "clone", { asset: "app-a" }), rB2 = await start(cb, "clone", { asset: "app-x" });
      await runIt(rA2.id); await runIt(rB2.id);
      for (const [id, inst] of [[rA2.id, 1001], [rB2.id, 2002]] as const) if (tokenBySha((await report(id)).sha)?.installation !== inst) injected.cross++;
      assert.equal(injected.cross, 0);
      // The program saw nothing of the platform's: not in its environment, not in its credential directory.
      for (const id of [ra.id, rb.id, rA2.id, rB2.id]) assert.equal(secretHits(JSON.stringify(await report(id))), 0, "no platform secret in the run's environment or files");
      console.log(`✓ runs: one token per run (read contents, the installation's repositories or the asset's), reused, re-minted near expiry, revoked at the end, redacted, over-grants refused; cross-workspace injections ${injected.cross}`);
    }

    // ---------- 6. the webhook ----------
    {
      const hook = async (event: string, body: unknown, secret = WEBHOOK_SECRET) => {
        const raw = JSON.stringify(body);
        return req("POST", "/api/github-app/webhook", { "x-github-event": event, "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`, "content-type": "application/json" }, raw);
      };
      assert.equal((await hook("installation", { action: "deleted", installation: { id: 1001 } }, "not-the-secret-0000")).status, 401, "a bad signature");
      assert.equal((await req("POST", "/api/github-app/webhook", { "x-github-event": "installation", "content-type": "application/json" }, JSON.stringify({ action: "deleted", installation: { id: 1001 } }))).status, 401, "no signature");
      assert.equal((await db.query("SELECT 1 FROM workspace_github_installations WHERE installation_id = 1001 AND removed_at IS NULL")).length, 1, "nothing changed");
      assert.equal((await hook("ping", { zen: "x" })).status, 200);
      // Repositories removed from the installation: gone from the list and from app-x's narrowing.
      gh.installations.get(1001)!.repositories = gh.installations.get(1001)!.repositories.filter((r) => r.full_name !== "acme/api");
      assert.deepEqual((await hook("installation_repositories", { action: "removed", installation: { id: 1001 }, repository_selection: "selected", repositories_added: [], repositories_removed: [{ id: 10, full_name: "acme/api" }] })).body, { handled: "repositories" });
      const vA = (await req("GET", "/api/github-app", bearer(ownerA))).body.installation;
      assert.deepEqual([vA.repositories, vA.asset_repositories], [["acme/infra", "acme/web"], {}], "the list and the narrowing follow");
      // Suspended: no token (and no fallback to the pasted one), until unsuspended.
      await hook("installation", { action: "suspend", installation: { id: 1001 } });
      const sus = await start(ca, "clone", { asset: "app-x" });
      await runIt(sus.id);
      assert.equal((await report(sus.id)).sha, null, "suspended: no token");
      assert.match((await credEvent(sus.id)).github_app_missing[0].reason, /suspended/);
      await hook("installation", { action: "unsuspend", installation: { id: 1001 } });
      // Uninstalled on GitHub: the connection ends at once; the next run falls back to the pasted token.
      const live = await start(ca, "clone", { asset: "app-x" });
      const lc = (await client.claim(["fixture_gh/clone"]))!;
      const got = await runs.runCredentialsForLease(lc.run.id, lc.lease_token);
      assert.ok(gh.minted.some((t) => t.token === got.credentials[0]!.value && t.installation === 1001));
      gh.installations.get(1001)!.uninstalled = true;
      assert.deepEqual((await hook("installation", { action: "deleted", installation: { id: 1001 } })).body, { handled: "uninstalled" });
      const [ended] = await db.query<{ removed_reason: string }>("SELECT removed_reason FROM workspace_github_installations WHERE installation_id = 1001");
      assert.equal(ended!.removed_reason, "uninstalled");
      assert.equal((await db.query("SELECT 1 FROM run_github_app_tokens WHERE installation_id = 1001 AND revoked_at IS NULL")).length, 0, "its tokens count as revoked");
      const after = await runs.runCredentialsForLease(lc.run.id, lc.lease_token);
      assert.equal(after.credentials[0]!.value, PASTED_A, "the same run asking again gets the pasted token, not the uninstalled installation's");
      await runs.completeRun(lc.run.id, lc.lease_token, { outcome: "succeeded", results: [] });
      void live;
      assert.equal((await req("GET", "/api/github-app", bearer(ownerA))).body.installation, null);
      console.log("✓ webhook: verified by its secret; repositories and narrowing follow; suspended gets nothing; uninstalled ends the connection at once (back to the pasted token)");
    }

    // ---------- 7. disconnect, staff revoke, workspace removal ----------
    {
      // B disconnects: uninstalled on GitHub, tokens revoked.
      const rb = await start(cb, "clone", { asset: "app-x" });
      const bc = (await client.claim(["fixture_gh/clone"]))!;
      const bt = (await runs.runCredentialsForLease(bc.run.id, bc.lease_token)).credentials[0]!.value;
      assert.equal((await req("DELETE", "/api/github-app", bearer(memberA))).status, 403);
      const d = await req("DELETE", "/api/github-app", bearer(ownerB));
      assert.deepEqual(d.body, { disconnected: true, uninstalled: true });
      assert.equal(gh.installations.get(2002)!.uninstalled, true, "uninstalled on GitHub");
      assert.equal(await gh.read(bt, "globex/api"), 401, "the running run's token is dead");
      assert.equal((await runs.runCredentialsForLease(bc.run.id, bc.lease_token)).credentials[0]!.value, PASTED_B, "and the run gets the pasted one");
      await runs.completeRun(bc.run.id, bc.lease_token, { outcome: "succeeded", results: [] });
      void rb;
      // A connects a new installation; staff revoke it.
      gh.installations.set(4004, { id: 4004, app_id: GH_APP_ID, account: { login: "acme", type: "Organization" }, repository_selection: "all", repositories: repos("acme", 40, ["api"]) });
      assert.equal(await back(ownerA, { installation_id: "4004", setup_action: "install", state: await begin(ownerA), code: code([4004]) }), "connected");
      const viewer = await http.adminToken("viewer"), operator = await http.adminToken("operator");
      const list = await req("GET", "/api/admin/onboarding/github-app", bearer(viewer));
      assert.deepEqual(list.body.installations.map((i: any) => [i.workspace.id, i.installation_id, i.account, i.removed_reason]),
        [[A.orgId, 4004, "acme", null], [B.orgId, 2002, "globex", "disconnected"], [A.orgId, 1001, "acme", "uninstalled"]], "staff see every installation, live first");
      assert.equal((await req("DELETE", `/api/admin/onboarding/github-app/installations/${A.orgId}`, bearer(viewer))).status, 403);
      assert.deepEqual((await req("DELETE", `/api/admin/onboarding/github-app/installations/${A.orgId}`, bearer(operator))).body, { disconnected: true, uninstalled: true });
      // And again, then the workspace goes.
      gh.installations.get(4004)!.uninstalled = false;
      assert.equal(await back(ownerA, { installation_id: "4004", setup_action: "install", state: await begin(ownerA), code: code([4004]) }), "connected");
      const { deleteOrg } = await import("../src/tenancy.js");
      await deleteOrg(A.orgId);
      assert.equal(gh.installations.get(4004)!.uninstalled, true, "removing the workspace uninstalls its installation");
      assert.equal((await db.query("SELECT 1 FROM workspace_github_installations WHERE org_id = $1", [A.orgId])).length, 0, "and its rows go with it");
      console.log("✓ disconnect (owner), revoke (staff) and workspace removal: ended, uninstalled on GitHub, tokens dead");
    }

    // ---------- 8. row-level security ----------
    {
      const { rlsCatalogProblems, rlsProbe } = await import("../src/rls.js");
      assert.deepEqual(await rlsCatalogProblems(db), []);
      const probe = await rlsProbe(db);
      assert.deepEqual(probe.problems, []);
      for (const t of ["workspace_github_installations", "oauth_states", "run_github_app_tokens"]) {
        const code = await withTenant(B.orgId, () => db.query(`/* tenant: test */ SELECT 1 FROM ${t}`).then(() => "read", (e) => e.code));
        assert.equal(code, "42501", `tenant work cannot read ${t}`);
      }
      console.log(`✓ row-level security: catalog and probe pass (${probe.checked} checks); tenant work cannot reach the three tables`);
    }
  } finally {
    await ca.close(); await cb.close();
    await http.close();
  }

  // ---------- 8. the secrets grep ----------
  {
    const tables = (await db.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).map((r) => r.t);
    let dbHits = 0, tokenHits = 0;
    const tokens = gh.minted.map((t) => t.token);
    for (const t of tables) {
      const [r] = await db.query<{ x: string | null }>(`/* tenant: test, every row of every table */ SELECT string_agg(z::text, E'\\n') AS x FROM "${t}" z`);
      const x = r?.x ?? "";
      dbHits += secretHits(x);
      const n = tokens.filter((k) => x.includes(k)).length;
      if (n) console.error(`  a run token in table ${t}: ${n}`);
      tokenHits += n;
    }
    const answers = secretHits(seen.join("\n")), logs = secretHits(logged.join(""));
    console.log(`✓ secrets grep: platform secrets in tables ${dbHits}, answers ${answers}, logs ${logs}; run tokens in clear in tables ${tokenHits}`);
    assert.deepEqual({ dbHits, answers, logs, tokenHits }, { dbHits: 0, answers: 0, logs: 0, tokenHits: 0 });
  }
  await gh.close();
  await db.close();
  console.log("GITHUB APP TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
