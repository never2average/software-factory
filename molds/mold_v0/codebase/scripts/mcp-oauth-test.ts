// The built-in MCP authorization server (mold_v0-013; src/mcp-oauth.ts, sql/migrations/0018_mcp_oauth.sql), offline:
// an embedded database, the fixture packs, two workspaces, over HTTP. No network: client ID metadata documents are
// answered by a stand-in fetcher (the URL and address guards are tested on their own).
//   npm run test:mcp-oauth            both: builtin, then clerk
//   tsx scripts/mcp-oauth-test.ts builtin|clerk
//
// builtin:
// 1. Discovery: a 401 on /mcp names the protected resource metadata (path-inserted; the root answers the same); the
//    authorization server metadata (RFC 8414 and OIDC discovery) has the exact issuer, S256 only, CIMD supported.
// 2. A full connector flow: register (DCR), authorize with PKCE, consent (signed out: 401; CSRF refused), token, /mcp
//    (as the person with their role, in the chosen workspace), refresh (rotation), revoke.
// 3. Refusals: wrong audience (authorize, token, and a token whose resource the server no longer serves), no PKCE,
//    plain PKCE, a wrong verifier, redirect URI mismatch (no redirect is made), a reused code (its tokens are revoked),
//    a replayed refresh token (the grant ends), an expired token or code, another client's code, cross-workspace,
//    removal and suspension, insufficient scope (403), unsafe redirect URIs, the registration limit, client secrets.
// 4. Client ID metadata documents: a verified client; a document that is not its own URL is refused; SSRF guards.
// 5. No token, code, secret or request id appears in a log line.
// clerk: none of the built-in routes answers, and Clerk's discovery is as before.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const PROVIDER = process.argv[2] === "clerk" ? "clerk" : "builtin";
process.env.AUTH_PROVIDER = PROVIDER;
// The test stands in for the one proxy in front of the server (src/proxy-trust.ts, mold_v0-084): each request's
// X-Forwarded-For is the address that proxy saw.
process.env.OCTILLION_PROXY_HOPS = "1";
const { cleanup, startHttp, STAMP } = await import("./lib/test-world.js");
const ROOT = path.resolve(import.meta.dirname, "..");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const s256 = (s: string) => createHash("sha256").update(s).digest("base64url");
let n = 0;
const ok = (what: string) => { n++; console.log(`✓ [${PROVIDER}] ${what}`); };

// Every log line, to check that no secret reaches one.
const logged: string[] = [];
const origErr = console.error, origLog = console.log, origWarn = console.warn;
console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); origErr(...a); };
console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); origWarn(...a); };
const secrets: string[] = [];

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const http = await startHttp();
  process.env.PUBLIC_URL = http.base;
  const base = http.base;

  if (PROVIDER === "clerk") {
    const r404 = async (p: string, init?: RequestInit) => (await fetch(`${base}${p}`, init)).status;
    assert.equal(await r404("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://a.example/cb"] }) }), 404);
    assert.equal(await r404("/oauth/authorize?client_id=x"), 404);
    assert.equal(await r404("/oauth/token", { method: "POST" }), 404);
    assert.equal(await r404("/api/oauth/grants"), 404);
    assert.equal(await r404("/.well-known/openid-configuration"), 404);
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    assert.deepEqual(prm.authorization_servers, [http.mock.url], "Clerk is the authorization server");
    assert.deepEqual(prm.scopes_supported, ["profile", "email"]);
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer oma_${"a".repeat(43)}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /^Bearer error="unauthorized", error_description="Sign in to [^"]+", resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"$/,
      "the 401 is Clerk's, unchanged");
    ok("with Clerk on, nothing of the built-in authorization server answers and the discovery is Clerk's, unchanged");
    await http.close();
  } else {
    // ---------- the world: two workspaces, a person in both (member in A, viewer in B), one in B only ----------
    const { setPacksForTest } = await import("../src/packs.js");
    const { compileDeclarations } = await import("../src/pack-manifest.js");
    const fixture = (id: string) => JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", id, "pack.json"), "utf8"));
    const declared = (id: string) => {
      const j = fixture(id);
      return { manifest: { id, name: j.name, version: j.version, entry: null, migrations: null, words: j.words ?? {}, dir: path.join(ROOT, "scripts", "fixtures", "packs", id) },
        declared: compileDeclarations(j) };
    };
    setPacksForTest([declared("fixture_tracker"), declared("fixture_review")]);
    const { createOrg } = await import("../src/auth.js");
    const A = (await createOrg(`OAuth A ${STAMP}`)).org, B = (await createOrg(`OAuth B ${STAMP}`)).org;
    const dirA = `org_b${randomBytes(9).toString("base64url")}`, dirB = `org_b${randomBytes(9).toString("base64url")}`;
    await db.query("UPDATE organizations SET clerk_org_id = $2 WHERE id = $1", [A.orgId, dirA]);
    await db.query("UPDATE organizations SET clerk_org_id = $2 WHERE id = $1", [B.orgId, dirB]);
    const person = async (email: string, ms: [number, string][]) => {
      const id = `user_b${randomBytes(9).toString("base64url")}`;
      await db.query("INSERT INTO auth_users (id, email, email_verified_at) VALUES ($1, $2, now())", [id, email]);
      for (const [org, role] of ms) await db.query("INSERT INTO auth_memberships (org_id, user_id, role) VALUES ($1, $2, $3)", [org, id, role]);
      const t = randomBytes(32).toString("base64url");
      await db.query("INSERT INTO auth_sessions (id, token_hash, user_id, active_org_id, method, expires_at) VALUES ($1, $2, $3, $4, 'email_code', now() + interval '1 day')",
        [`ses_b${randomBytes(9).toString("base64url")}`, sha256(t), id, ms[0]?.[0] ?? null]);
      secrets.push(t);
      return { id, cookie: `oct_session=${t}` };
    };
    const P = await person(`p-${STAMP}@a.example`, [[A.orgId, "member"], [B.orgId, "viewer"]]);
    const Q = await person(`q-${STAMP}@b.example`, [[B.orgId, "member"]]);

    let ipN = 0;
    const ip = () => `203.0.113.${(++ipN % 250) + 1}`;
    const get = (p: string, h: Record<string, string> = {}) => fetch(`${base}${p}`, { headers: h, redirect: "manual" });
    const json = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
    const post = async (p: string, body: unknown, h: Record<string, string> = {}) => {
      const r = await fetch(`${base}${p}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });
      return { status: r.status, body: await json(r), headers: r.headers };
    };
    const form = async (p: string, body: Record<string, string>, h: Record<string, string> = {}) => {
      const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip(), ...h }, body: new URLSearchParams(body) });
      return { status: r.status, body: await json(r), headers: r.headers };
    };
    let rid = 0;
    const rpc = async (tok: string, method = "tools/list", params: unknown = {}) => {
      const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }) });
      const t = await r.text();
      const line = t.split("\n").find((l) => l.startsWith("data: "));
      let body: any = null;
      try { body = JSON.parse(line ? line.slice(6) : t); } catch { body = t; }
      return { status: r.status, body, www: r.headers.get("www-authenticate") };
    };
    const toolNames = async (tok: string) => {
      const r = await rpc(tok);
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
      return (r.body.result.tools as { name: string }[]).map((t) => t.name).sort();
    };
    const RESOURCE = `${base}/mcp`;
    const REDIRECT = "http://127.0.0.1:43999/callback";

    // ---------- 1. discovery ----------
    {
      const r = await rpc("");
      const unauth = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      assert.equal(unauth.status, 401);
      const www = unauth.headers.get("www-authenticate") ?? "";
      assert.match(www, new RegExp(`resource_metadata="${base}/\\.well-known/oauth-protected-resource/mcp"`), www);
      assert.match(www, /scope="mcp"/);
      assert.equal(r.status, 401);
      for (const p of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
        const prm = await json(await get(p));
        assert.equal(prm.resource, RESOURCE, p);
        assert.deepEqual(prm.authorization_servers, [base], p);
        assert.deepEqual(prm.scopes_supported, ["mcp"]);
      }
      for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
        const res = await get(p);
        assert.equal(res.headers.get("access-control-allow-origin"), "*", "CORS-open for browser clients");
        const as = await json(res);
        assert.equal(as.issuer, base, "the issuer is exactly PUBLIC_URL");
        assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
        assert.equal(as.client_id_metadata_document_supported, true);
        assert.equal(as.authorization_response_iss_parameter_supported, true);
        assert.deepEqual(as.response_types_supported, ["code"]);
        for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"]) assert.ok(String(as[k]).startsWith(`${base}/oauth/`), k);
      }
      ok("discovery: the 401 names the path-inserted resource metadata, both URIs answer, the issuer is exact, S256 only, CIMD advertised");
    }

    // ---------- 2. the connector flow ----------
    const register = async (body: Record<string, unknown>, from = ip()) => post("/oauth/register", body, { "x-forwarded-for": from });
    const reg = await register({ client_name: "Test‮ Connector", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const clientId: string = reg.body.client_id;
    assert.equal(reg.body.client_name, "Test Connector", "the name is cleaned of direction controls");
    assert.equal(reg.body.client_secret, undefined, "a public client gets no secret");

    const authorizeUrl = (o: Record<string, string | undefined>) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(o)) if (v !== undefined) q.set(k, v);
      return `/oauth/authorize?${q}`;
    };
    const pkce = () => { const verifier = randomBytes(48).toString("base64url"); return { verifier, challenge: s256(verifier) }; };
    /** authorize → the consent request id (the browser lands on the console's consent page). */
    const startAuth = async (o: Partial<Record<string, string | undefined>> = {}, client = clientId, redirect = REDIRECT) => {
      const k = pkce();
      const res = await get(authorizeUrl({ response_type: "code", client_id: client, redirect_uri: redirect, code_challenge: k.challenge, code_challenge_method: "S256",
        state: "st-123", resource: RESOURCE, scope: "mcp", ...o }));
      return { res, verifier: k.verifier, location: res.headers.get("location") ?? "" };
    };
    const consentHeaders = (cookie: string) => ({ cookie, "x-pack-request": "1", origin: base });
    const allow = async (cookie: string, requestId: string, workspace = dirA) => post(`/api/oauth/requests/${requestId}`, { decision: "allow", workspace }, consentHeaders(cookie));
    const requestOf = (location: string) => new URL(location).searchParams.get("request") ?? "";
    const codeOf = (redirect: string) => new URL(redirect).searchParams.get("code") ?? "";
    /** The whole flow for `who` in `workspace`: tokens. */
    const flow = async (who = P, workspace = dirA, o: Partial<Record<string, string>> = {}, client = clientId) => {
      const s = await startAuth(o, client);
      assert.equal(s.res.status, 302, s.location);
      const d = await allow(who.cookie, requestOf(s.location), workspace);
      assert.equal(d.status, 200, JSON.stringify(d.body));
      const code = codeOf(d.body.redirect);
      const t = await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client, code_verifier: s.verifier, resource: o.resource ?? RESOURCE });
      assert.equal(t.status, 200, JSON.stringify(t.body));
      secrets.push(code, t.body.access_token, t.body.refresh_token);
      return { ...t.body, code, verifier: s.verifier } as { access_token: string; refresh_token: string; expires_in: number; scope: string; code: string; verifier: string };
    };

    let first: { access_token: string; refresh_token: string };
    {
      const s = await startAuth();
      assert.equal(s.res.status, 302);
      assert.ok(s.location.startsWith(`${base}/auth/consent?request=`), s.location);
      const id = requestOf(s.location);
      secrets.push(id);
      // The consent page's API: signed out is a 401; the view names the client (not verified), the way back, the workspaces.
      assert.equal((await get(`/api/oauth/requests/${id}`)).status, 401);
      const view = await json(await get(`/api/oauth/requests/${id}`, { cookie: P.cookie }));
      assert.equal(view.client.name, "Test Connector"); assert.equal(view.client.verified, false);
      assert.deepEqual(view.redirect, { scheme: "http", host: "127.0.0.1:43999" });
      assert.deepEqual(view.workspaces.map((w: any) => [w.id, w.role]).sort(), [[dirA, "member"], [dirB, "viewer"]].sort());
      assert.equal(view.default_workspace, dirA);
      // CSRF: another site's Origin, a missing X-Pack-Request header, or a form body are refused.
      assert.equal((await post(`/api/oauth/requests/${id}`, { decision: "allow", workspace: dirA }, { cookie: P.cookie, "x-pack-request": "1", origin: "https://evil.example" })).status, 403);
      assert.equal((await post(`/api/oauth/requests/${id}`, { decision: "allow", workspace: dirA }, { cookie: P.cookie, origin: base })).status, 403);
      const formPost = await fetch(`${base}/api/oauth/requests/${id}`, { method: "POST", headers: { cookie: P.cookie, "content-type": "application/x-www-form-urlencoded", "x-pack-request": "1" }, body: "decision=allow&workspace=" + dirA });
      assert.equal(formPost.status, 403);
      // Cross-workspace: Q cannot connect A (not theirs).
      assert.equal((await allow(Q.cookie, id, dirA)).status, 403, "a workspace the person is not in is refused");
      const d = await allow(P.cookie, id);
      assert.equal(d.status, 200, JSON.stringify(d.body));
      const back = new URL(d.body.redirect);
      assert.equal(back.origin + back.pathname, REDIRECT);
      assert.equal(back.searchParams.get("state"), "st-123"); assert.equal(back.searchParams.get("iss"), base, "iss in the response (RFC 9207)");
      assert.equal((await allow(P.cookie, id)).status, 404, "a request is answered once");
      const sd = await startAuth();
      const deny = await post(`/api/oauth/requests/${requestOf(sd.location)}`, { decision: "deny" }, consentHeaders(P.cookie));
      const denied = new URL(deny.body.redirect);
      assert.equal(denied.searchParams.get("error"), "access_denied"); assert.equal(denied.searchParams.get("state"), "st-123"); assert.equal(denied.searchParams.get("iss"), base);
      const code = codeOf(d.body.redirect);
      const t = await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: s.verifier, resource: RESOURCE });
      assert.equal(t.status, 200, JSON.stringify(t.body));
      assert.equal(t.headers.get("cache-control"), "no-store");
      assert.equal(t.body.token_type, "Bearer"); assert.equal(t.body.expires_in, 1800); assert.equal(t.body.scope, "mcp");
      assert.match(t.body.access_token, /^oma_[A-Za-z0-9_-]{43}$/); assert.match(t.body.refresh_token, /^omr_[A-Za-z0-9_-]{43}$/);
      secrets.push(code, t.body.access_token, t.body.refresh_token);
      first = t.body;
      // Stored as hashes only.
      const raw = JSON.stringify(await db.query("SELECT * FROM oauth_tokens")) + JSON.stringify(await db.query("SELECT * FROM oauth_codes")) + JSON.stringify(await db.query("SELECT * FROM oauth_requests"));
      for (const x of [code, t.body.access_token, t.body.refresh_token, id]) assert.ok(!raw.includes(x), "no token, code or request id is stored in the clear");
      assert.equal((await db.query("SELECT 1 FROM oauth_tokens WHERE token_hash = $1", [sha256(t.body.access_token)])).length, 1);
    }
    // /mcp as the person, with their role, in A: the same tools as their own member key in A.
    const keyA = await post("/api/keys", { name: "compare" }, { cookie: P.cookie, "x-pack-request": "1" });
    assert.equal(keyA.status, 201, JSON.stringify(keyA.body));
    secrets.push(keyA.body.key);
    const memberTools = await toolNames(keyA.body.key);
    assert.deepEqual(await toolNames(first.access_token), memberTools, "the token is offered what the person's member key in A is");
    for (let i = 0; i < 50; i++) {
      const rows = await db.query<{ org_id: number }>("SELECT org_id FROM mcp_events WHERE user_id = $1 AND key_id IS NULL", [P.id]);
      if (rows.length) { assert.ok(rows.every((x) => x.org_id === A.orgId), "its calls are recorded in A only"); break; }
      await new Promise((r) => setTimeout(r, 20));
    }
    ok("a full connector flow: register, authorize with PKCE, consent (signed out 401, CSRF refused), token (hashes only), /mcp as the member in A");

    // The viewer role in B: a token for B is offered no write, like a viewer's key.
    {
      const tB = await flow(P, dirB);
      const vt = await toolNames(tB.access_token);
      assert.ok(vt.includes("review_list_review_items") && !vt.includes("review_create_review_items"), `the viewer's token is offered no write: ${vt.filter((x) => x.startsWith("review_"))}`);
      const w = await rpc(tB.access_token, "tools/call", { name: "review_create_review_items", arguments: {} });
      assert.ok(w.status !== 200 || w.body?.error || w.body?.result?.isError, "a write is refused when called by name");
      ok("a token acts with the person's role in the workspace they chose (viewer in B: no write)");
    }

    // ---------- refresh: rotation; a replayed refresh token ends the grant ----------
    {
      const r1 = await form("/oauth/token", { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId, resource: RESOURCE });
      assert.equal(r1.status, 200, JSON.stringify(r1.body));
      secrets.push(r1.body.access_token, r1.body.refresh_token);
      assert.notEqual(r1.body.refresh_token, first.refresh_token, "a new refresh token every time");
      assert.equal((await rpc(r1.body.access_token)).status, 200);
      const wider = await form("/oauth/token", { grant_type: "refresh_token", refresh_token: r1.body.refresh_token, client_id: clientId, scope: "mcp admin" });
      assert.equal(wider.status, 400); assert.equal(wider.body.error, "invalid_scope");
      // wider used r1's refresh token: it was consumed. A replay of the first one ends the grant.
      const replay = await form("/oauth/token", { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId });
      assert.equal(replay.status, 400); assert.equal(replay.body.error, "invalid_grant");
      const after = await rpc(r1.body.access_token);
      assert.equal(after.status, 401, "every token of the grant is revoked after a replay");
      assert.match(after.www ?? "", /error="invalid_token"/);
      ok("refresh tokens rotate; a refresh cannot widen the scope; a replayed refresh token revokes the grant");
    }

    // ---------- revoke ----------
    {
      const t = await flow();
      assert.equal((await rpc(t.access_token)).status, 200);
      const other = await register({ redirect_uris: [REDIRECT] });
      const wrong = await form("/oauth/revoke", { token: t.access_token, client_id: other.body.client_id });
      assert.equal(wrong.status, 200, "revocation answers 200 whatever the token");
      assert.equal((await rpc(t.access_token)).status, 200, "another client cannot revoke it");
      const rv = await form("/oauth/revoke", { token: t.refresh_token, client_id: clientId });
      assert.equal(rv.status, 200);
      assert.equal((await rpc(t.access_token)).status, 401, "revoking the refresh token ends the access token too");
      assert.equal((await form("/oauth/token", { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId })).body.error, "invalid_grant");
      // The person revokes a connected app from the console.
      const t2 = await flow();
      const list = await json(await get("/api/oauth/grants", { cookie: P.cookie }));
      assert.ok(list.grants.length >= 1 && list.grants.every((g: any) => [dirA, dirB].includes(g.workspace.id)));
      const mine = list.grants[0].id;
      assert.equal((await post(`/api/oauth/grants/${mine}/revoke`, {}, consentHeaders(Q.cookie))).status, 404, "not someone else's");
      for (const g of list.grants) assert.equal((await post(`/api/oauth/grants/${g.id}/revoke`, {}, consentHeaders(P.cookie))).status, 200);
      assert.equal((await rpc(t2.access_token)).status, 401);
      ok("revocation: by the client (RFC 7009, its own tokens only) and by the person from the console");
    }

    // ---------- 3. refusals ----------
    /** A refusal before consent: an error page naming the error, never a redirect (no open redirector). */
    const refused = async (s: { res: Response; location: string }, error: string, what = error) => {
      assert.equal(s.res.status, 400, what); assert.equal(s.location, "", `${what}: no redirect before the person answers`);
      assert.ok((await s.res.text()).includes(`(${error})`), what);
    };
    {
      // Wrong audience at authorize: another resource, the admin MCP, none at all.
      for (const resource of ["https://evil.example/mcp", `${base}/admin/mcp`, `${base}/api/admin/mcp`]) {
        const s = await startAuth({ resource });
        await refused(s, "invalid_target", resource);
      }
      const none = await startAuth({ resource: undefined });
      await refused(none, "invalid_target", "no resource: refused (RFC 8707)");
      // Wrong audience at the token endpoint.
      const s = await startAuth();
      const d = await allow(P.cookie, requestOf(s.location));
      const bad = await form("/oauth/token", { grant_type: "authorization_code", code: codeOf(d.body.redirect), redirect_uri: REDIRECT, client_id: clientId, code_verifier: s.verifier, resource: "https://evil.example/mcp" });
      assert.equal(bad.body.error, "invalid_target");
      // A token issued for a second address of this server, which it then stops answering for: refused on /mcp.
      process.env.CLERK_MCP_AUDIENCE = `${RESOURCE},https://alias.example/mcp`;
      const alias = await flow(P, dirA, { resource: "https://alias.example/mcp" });
      assert.equal((await rpc(alias.access_token)).status, 200, "a token for a listed address works");
      process.env.CLERK_MCP_AUDIENCE = RESOURCE;
      assert.equal((await rpc(alias.access_token)).status, 401, "a token whose audience this server no longer serves is refused");
      delete process.env.CLERK_MCP_AUDIENCE;
      ok("wrong audience: refused at authorize (another resource, the admin MCP, none), at the token endpoint, and on /mcp");
    }
    {
      const noPkce = await startAuth({ code_challenge: undefined });
      await refused(noPkce, "invalid_request", "no PKCE");
      const plain = await startAuth({ code_challenge: "a".repeat(43), code_challenge_method: "plain" });
      await refused(plain, "invalid_request", "plain PKCE");
      const noMethod = await startAuth({ code_challenge_method: undefined });
      await refused(noMethod, "invalid_request", "no method means plain: refused");
      const token = await startAuth({ response_type: "token" });
      await refused(token, "unsupported_response_type");
      // A wrong verifier, and no verifier.
      const s = await startAuth();
      const code = codeOf((await allow(P.cookie, requestOf(s.location))).body.redirect);
      assert.equal((await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: pkce().verifier })).body.error, "invalid_grant");
      const s2 = await startAuth();
      const code2 = codeOf((await allow(P.cookie, requestOf(s2.location))).body.redirect);
      assert.equal((await form("/oauth/token", { grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, client_id: clientId })).body.error, "invalid_request");
      ok("PKCE: none, plain, or no method refused at authorize; a wrong or missing verifier refused at the token endpoint");
    }
    {
      // Redirect URI mismatch: an error page, never a redirect.
      for (const redirect of ["https://evil.example/cb", "http://127.0.0.1:43999/other", "http://127.0.0.1:43999/callback?x=1"]) {
        const s = await startAuth({}, clientId, redirect);
        assert.equal(s.res.status, 400, redirect); assert.equal(s.location, "", "no Location header");
        assert.match(await s.res.text(), /did not register/);
        assert.equal(s.res.headers.get("x-frame-options"), "DENY");
      }
      // A loopback redirect may change port (RFC 8252); the token request must repeat the exact one.
      const port = await startAuth({}, clientId, "http://127.0.0.1:50123/callback");
      assert.equal(port.res.status, 302, "a loopback port change is allowed");
      const unknown = await startAuth({}, "ocl_nope");
      assert.equal(unknown.res.status, 400); assert.equal(unknown.location, "");
      const s = await startAuth();
      const code = codeOf((await allow(P.cookie, requestOf(s.location))).body.redirect);
      assert.equal((await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: "http://127.0.0.1:43999/elsewhere", client_id: clientId, code_verifier: s.verifier })).body.error, "invalid_grant");
      ok("redirect URI mismatch: an error page and no redirect at authorize, invalid_grant at the token endpoint; unknown clients get the page too");
    }
    {
      // A reused code: refused, and what the first use gave is revoked.
      const t = await flow();
      assert.equal((await rpc(t.access_token)).status, 200);
      const again = await form("/oauth/token", { grant_type: "authorization_code", code: t.code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: t.verifier });
      assert.equal(again.body.error, "invalid_grant");
      const stranger = await register({ redirect_uris: [REDIRECT] });
      const t0 = await flow();
      assert.equal((await form("/oauth/token", { grant_type: "authorization_code", code: t0.code, redirect_uri: REDIRECT, client_id: stranger.body.client_id, code_verifier: t0.verifier })).body.error, "invalid_grant");
      assert.equal((await rpc(t0.access_token)).status, 200, "another client replaying a used code cannot revoke the grant");
      assert.equal((await rpc(t.access_token)).status, 401, "the first use's tokens are revoked");
      // Another client's code.
      const other = await register({ redirect_uris: [REDIRECT] });
      const s = await startAuth();
      const code = codeOf((await allow(P.cookie, requestOf(s.location))).body.redirect);
      assert.equal((await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: other.body.client_id, code_verifier: s.verifier })).body.error, "invalid_grant");
      // An expired code.
      const s3 = await startAuth();
      const code3 = codeOf((await allow(P.cookie, requestOf(s3.location))).body.redirect);
      await db.query("UPDATE oauth_codes SET expires_at = now() - interval '1 second' WHERE code_hash = $1", [sha256(code3)]);
      assert.equal((await form("/oauth/token", { grant_type: "authorization_code", code: code3, redirect_uri: REDIRECT, client_id: clientId, code_verifier: s3.verifier })).body.error, "invalid_grant");
      // An expired access token, and an expired request.
      const t4 = await flow();
      await db.query("UPDATE oauth_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [sha256(t4.access_token)]);
      const exp = await rpc(t4.access_token);
      assert.equal(exp.status, 401); assert.match(exp.www ?? "", /error="invalid_token"/); assert.match(exp.www ?? "", /resource_metadata=/);
      const s5 = await startAuth();
      await db.query("UPDATE oauth_requests SET expires_at = now() - interval '1 second' WHERE id_hash = $1", [sha256(requestOf(s5.location))]);
      assert.equal((await allow(P.cookie, requestOf(s5.location))).status, 404);
      ok("a reused code is refused and revokes its tokens; another client's or an expired code, an expired token or request are refused");
    }
    {
      // Cross-workspace: Q's token acts in B only; P's in A. Removal and suspension hold on the next call.
      const tq = await flow(Q, dirB);
      assert.equal((await rpc(tq.access_token)).status, 200);
      const tp = await flow(P, dirA);
      await db.query("UPDATE auth_memberships SET suspended = true WHERE org_id = $1 AND user_id = $2", [A.orgId, P.id]);
      assert.equal((await rpc(tp.access_token)).status, 401, "a suspended member's token stops at once");
      await db.query("UPDATE auth_memberships SET suspended = false WHERE org_id = $1 AND user_id = $2", [A.orgId, P.id]);
      assert.equal((await rpc(tp.access_token)).status, 200);
      const { memberships } = await import("../src/builtin-auth.js");
      await memberships.remove(dirA, P.id);
      assert.equal((await rpc(tp.access_token)).status, 401, "a removed member's token stops at once");
      assert.equal((await form("/oauth/token", { grant_type: "refresh_token", refresh_token: tp.refresh_token, client_id: clientId })).body.error, "invalid_grant", "and cannot be refreshed");
      assert.equal((await db.query("SELECT revoked_why FROM oauth_grants WHERE id = (SELECT grant_id FROM oauth_tokens WHERE token_hash = $1)", [sha256(tp.access_token)]))[0]?.revoked_why, "membership_ended");
      const s = await startAuth();
      assert.equal((await allow(P.cookie, requestOf(s.location), dirA)).status, 401, "removal ended their session working in A");
      const t = randomBytes(32).toString("base64url");
      secrets.push(t);
      await db.query("INSERT INTO auth_sessions (id, token_hash, user_id, active_org_id, method, expires_at) VALUES ($1, $2, $3, $4, 'email_code', now() + interval '1 day')",
        [`ses_b${randomBytes(9).toString("base64url")}`, sha256(t), P.id, B.orgId]);
      P.cookie = `oct_session=${t}`;
      assert.equal((await allow(P.cookie, requestOf(s.location), dirA)).status, 403, "a workspace they left cannot be chosen");
      await db.query("INSERT INTO auth_memberships (org_id, user_id, role) VALUES ($1, $2, 'member')", [A.orgId, P.id]);
      ok("cross-workspace: a token acts in its one workspace; a workspace the person is not in cannot be chosen; suspension and removal hold on the next call");
    }
    {
      // Insufficient scope: a 403 the client can step up from.
      const t = await flow(P, dirA, { scope: "offline_access" });
      assert.equal(t.scope, "offline_access");
      const r = await rpc(t.access_token);
      assert.equal(r.status, 403); assert.match(r.www ?? "", /error="insufficient_scope"/); assert.match(r.www ?? "", /scope="mcp"/);
      const unknownScope = await startAuth({ scope: "admin root" });
      await refused(unknownScope, "invalid_scope");
      ok("insufficient scope: 403 with error=insufficient_scope and the scope to ask for; unknown scopes refused");
    }
    {
      // DCR: unsafe redirect URIs, too many, bad grant types; the per-address limit; confidential clients.
      for (const uri of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "http://evil.example/cb", "https://a.example/cb#frag", "https://user:pw@a.example/cb", "vbscript:x", " https://a.example/cb",
        "x-safari-https://evil.example/cb", "googlechromes://evil.example", "microsoft-edge:https://evil.example", "intent://evil.example#Intent;end", "search-ms:query=x", "myapp:/cb"]) {
        const r = await register({ redirect_uris: [uri] });
        assert.equal(r.status, 400, uri); assert.equal(r.body.error, "invalid_redirect_uri");
      }
      assert.equal((await register({ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`) })).status, 400);
      assert.equal((await register({ redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials"] })).body.error, "invalid_client_metadata");
      assert.equal((await register({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "private_key_jwt" })).body.error, "invalid_client_metadata");
      assert.equal((await register({ redirect_uris: ["cursor://anysphere.cursor-retrieval/oauth/callback"] })).status, 201, "an app's own scheme is fine");
      assert.equal((await register({ redirect_uris: ["com.example.app:/oauth/callback"] })).status, 201, "a reverse-domain scheme is fine");
      const from = "198.51.100.77";
      let last = 0;
      for (let i = 0; i < 21; i++) last = (await register({ redirect_uris: ["https://a.example/cb"] }, from)).status;
      assert.equal(last, 429, "at most 20 registrations an hour from one address");
      const conf = await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" });
      assert.equal(conf.status, 201); assert.match(conf.body.client_secret, /^ocs_/);
      secrets.push(conf.body.client_secret);
      const s = await startAuth({}, conf.body.client_id);
      const code = codeOf((await allow(P.cookie, requestOf(s.location))).body.redirect);
      const noSecret = await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: conf.body.client_id, code_verifier: s.verifier });
      assert.equal(noSecret.status, 401); assert.equal(noSecret.body.error, "invalid_client");
      const basic = (sec: string) => ({ authorization: `Basic ${Buffer.from(`${encodeURIComponent(conf.body.client_id)}:${encodeURIComponent(sec)}`).toString("base64")}` });
      const wrongSecret = await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: s.verifier }, basic("ocs_wrong"));
      assert.equal(wrongSecret.status, 401);
      const good = await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: s.verifier }, basic(conf.body.client_secret));
      assert.equal(good.status, 200, JSON.stringify(good.body));
      secrets.push(good.body.access_token, good.body.refresh_token);
      assert.equal((await db.query("SELECT secret_hash FROM oauth_clients WHERE id = $1", [conf.body.client_id]))[0]?.secret_hash, sha256(conf.body.client_secret), "the secret is kept as a hash");
      assert.equal((await form("/oauth/token", { grant_type: "client_credentials", client_id: clientId })).body.error, "unsupported_grant_type");
      ok("registration: unsafe or too many redirect URIs, other grant types and auth methods refused; 20 an hour per address; client secrets checked and hashed");
    }

    // ---------- 4. client ID metadata documents ----------
    {
      const oauth = await import("../src/mcp-oauth.js");
      const DOC = "https://app.example.com/oauth/client.json";
      const docs = new Map<string, unknown>([[DOC, { client_id: DOC, client_name: "Example App", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }],
        ["https://liar.example.com/c.json", { client_id: "https://other.example.com/c.json", redirect_uris: [REDIRECT] }],
        ["https://secret.example.com/c.json", { client_id: "https://secret.example.com/c.json", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" }]]);
      const fetched: string[] = [];
      oauth.setDocumentFetcherForTest(async (u) => { fetched.push(u); if (!docs.has(u)) throw new Error("404"); return docs.get(u); });
      const s = await startAuth({}, DOC);
      assert.equal(s.res.status, 302, s.location);
      const view = await json(await get(`/api/oauth/requests/${requestOf(s.location)}`, { cookie: P.cookie }));
      assert.equal(view.client.verified, true); assert.equal(view.client.id_host, "app.example.com"); assert.equal(view.client.name, "Example App");
      const code = codeOf((await allow(P.cookie, requestOf(s.location))).body.redirect);
      const t = await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: DOC, code_verifier: s.verifier, resource: RESOURCE });
      assert.equal(t.status, 200, JSON.stringify(t.body));
      secrets.push(t.body.access_token, t.body.refresh_token);
      assert.equal((await rpc(t.body.access_token)).status, 200);
      assert.equal(fetched.filter((u) => u === DOC).length, 1, "the document is cached");
      for (const bad of ["https://liar.example.com/c.json", "https://secret.example.com/c.json", "https://missing.example.com/c.json"])
        assert.equal((await startAuth({}, bad)).res.status, 400, bad);
      const before = fetched.length;
      for (const bad of ["http://app.example.com/c.json", "https://127.0.0.1/c.json", "https://[::1]/c.json", "https://localhost/c.json", "https://app.example.com/", "https://app.example.com/c.json#x",
        "https://u:p@app.example.com/c.json", "https://10.0.0.5/c.json", "https://intranet/c.json", "https://app.example.com/a/../c.json"]) {
        assert.equal(oauth.cimdUrlOk(bad), false, bad);
        assert.equal((await startAuth({}, bad)).res.status, 400, bad);
      }
      assert.equal(fetched.length, before, "a refused URL is never fetched");
      for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "224.0.0.1", "not-an-ip"])
        assert.equal(oauth.publicAddress(a), false, a);
      for (const a of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(oauth.publicAddress(a), true, a);
      oauth.setDocumentFetcherForTest(null);
      ok("client ID metadata documents: a verified client end to end; a document naming another URL, asking for a secret or missing is refused; SSRF guards");
    }

    // ---------- sign-out everywhere ends connected apps too; a malformed body is refused without logging it ----------
    {
      const t = await flow(P, dirB);
      assert.equal((await rpc(t.access_token)).status, 200);
      const out = await post("/api/auth/sign-out/everywhere", {}, { cookie: P.cookie, origin: base });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.equal((await rpc(t.access_token)).status, 401, "signing out everywhere signs connected apps out");
      const bad = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: `"${t.refresh_token}` });
      assert.equal(bad.status, 400);
      ok("signing out everywhere revokes connected apps; a malformed token request is a 400");
    }

    // ---------- 5. logs ----------
    {
      const all = logged.join("\n");
      for (const x of secrets) assert.ok(!all.includes(x), `a secret appeared in a log line (${x.slice(0, 6)}…)`);
      ok(`no token, code, client secret, session or request id in ${logged.length} log lines`);
    }
    await http.close();
  }
  console.log(`\n${n} checks passed (${PROVIDER})`);
} finally {
  console.error = origErr; console.log = origLog; console.warn = origWarn;
  cleanup();
}
process.exit(0);
