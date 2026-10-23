// The app's own domain as the AI-client address (mold_v0-118; src/console-url.ts mcpUrl), offline: an embedded
// database, a stand-in Clerk, the server over HTTP. On Vercel the console project serves the domain and forwards /mcp,
// /.well-known, /oauth and /install to the API, whose PUBLIC_URL is its own *.vercel.app address; the factory sets
// APP_MCP_URL to the domain. Here PUBLIC_URL and APP_MCP_URL are two pretend addresses and requests go to the local port.
//   npm run test:mcp-domain            both: clerk, then builtin
//   tsx scripts/mcp-domain-test.ts clerk|builtin
//
// clerk:   the resource metadata names the domain's /mcp (the admin MCP's too), the 401's resource_metadata is on the
//          domain, /install.json, the install pages and the connector address in invitations use it, OAuth tokens
//          issued for the domain and for the old address are both accepted (opaque and JWT; another resource is
//          refused), the domain is an allowed Origin and authorized party, and without APP_MCP_URL nothing changes.
// builtin: the authorization server's issuer and endpoints are on the domain; a whole sign-in through it works for the
//          domain's resource and for the old address's (a connection made before keeps working); another is refused.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const PROVIDER = process.argv[2] === "builtin" ? "builtin" : "clerk";
const API = "https://app-api.example-host.test";   // the API project's own address (PUBLIC_URL)
const DOMAIN = "https://app.example.org";          // the app's own domain (APP_MCP_URL)
Object.assign(process.env, { AUTH_PROVIDER: PROVIDER, APP_PROXY_HOPS: "1", PUBLIC_URL: API, APP_CONSOLE_URL: DOMAIN, APP_MCP_URL: `${DOMAIN}/mcp` });
const { cleanup, startHttp, STAMP } = await import("./lib/test-world.js");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const s256 = (s: string) => createHash("sha256").update(s).digest("base64url");
let n = 0;
const ok = (what: string) => { n++; console.log(`✓ [${PROVIDER}] ${what}`); };

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const http = await startHttp();
  const base = http.base;
  const json = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
  const get = (p: string, h: Record<string, string> = {}) => fetch(`${base}${p}`, { headers: h, redirect: "manual" });
  let rid = 0;
  const rpc = async (tok: string | null, h: Record<string, string> = {}) => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...h },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method: "tools/list", params: {} }) });
    await r.text();
    return { status: r.status, www: r.headers.get("www-authenticate") ?? "" };
  };
  const { mcpAudiences, mcpAudience, authorizedPartiesForTest } = await import("../src/clerk.js");
  const { allowedMcpOrigins } = await import("../src/origin.js");

  // ---------- both providers: the addresses ----------
  assert.deepEqual(mcpAudiences(), [`${DOMAIN}/mcp`, `${API}/mcp`], "the domain's /mcp first, the old address still accepted");
  assert.equal(mcpAudience(), `${DOMAIN}/mcp`);
  assert.ok(allowedMcpOrigins().has(DOMAIN) && allowedMcpOrigins().has(API), "both are allowed Origins");
  for (const origin of [DOMAIN, API]) assert.equal((await rpc(null, { origin })).status, 401, `a page on ${origin} reaches /mcp (then needs to sign in)`);
  assert.equal((await rpc(null, { origin: "https://evil.example" })).status, 403, "a foreign Origin is still refused");
  const guide = await json(await get("/install.json"));
  assert.equal(guide.url, `${DOMAIN}/mcp`, "install.json names the domain");
  for (const p of ["/install", "/install/claude"]) {
    const html = await (await get(p)).text();
    assert.ok(html.includes(`${DOMAIN}/mcp`) && !html.includes(API), `${p} shows the domain's address only`);
  }
  ok("the resource URI, Origins and install pages are on the domain; the old address is still accepted");

  if (PROVIDER === "clerk") {
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const prm = await json(await get(p));
      assert.equal(prm.resource, `${DOMAIN}/mcp`, p);
      assert.deepEqual(prm.authorization_servers, [http.mock.url], "Clerk is still the authorization server");
    }
    assert.equal((await json(await get("/.well-known/oauth-protected-resource/admin/mcp"))).resource, `${DOMAIN}/admin/mcp`, "the admin MCP's resource is on the domain too");
    const r = await rpc(null);
    assert.equal(r.status, 401);
    assert.match(r.www, new RegExp(`resource_metadata="${DOMAIN.replace(/\./g, "\\.")}/\\.well-known/oauth-protected-resource"$`), r.www);
    assert.ok(authorizedPartiesForTest().includes(DOMAIN), "sessions made on the domain are accepted");
    ok("Clerk: the resource metadata and the 401 name the domain");

    // A person in a workspace linked to a Clerk organization, and OAuth tokens Clerk issued for each resource.
    const { createOrg } = await import("../src/auth.js");
    const org = (await createOrg(`Domain ${STAMP}`)).org;
    const mockPost = async (p: string, body: unknown) => (await fetch(`${http.mock.url}${p}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk_test_mock" }, body: JSON.stringify(body) })).json();
    const corg = (await mockPost("/v1/organizations", { name: org.name })).id as string;
    await db.query("UPDATE organizations SET clerk_org_id = $1 WHERE id = $2", [corg, org.orgId]);
    const user = await mockPost("/_mock/clerk/users", { email: `domain-${STAMP}@example.org` });
    await mockPost("/_mock/clerk/memberships", { org_id: corg, user_id: user.id, role: "org:member" });
    const token = async (jwt: boolean, aud: string) => (await mockPost("/_mock/oauth", { user_id: user.id, jwt, aud })).access_token as string;
    for (const jwt of [false, true]) {
      const kind = jwt ? "JWT" : "opaque";
      assert.equal((await rpc(await token(jwt, `${DOMAIN}/mcp`))).status, 200, `${kind}: a token for the domain's /mcp`);
      assert.equal((await rpc(await token(jwt, `${API}/mcp`))).status, 200, `${kind}: a token for the old address (a connection made before)`);
      assert.equal((await rpc(await token(jwt, "https://other-product.example.com/mcp"))).status, 401, `${kind}: another resource is refused`);
      assert.equal((await rpc(await token(jwt, `${DOMAIN}/admin/mcp`))).status, 401, `${kind}: an admin MCP token is not a /mcp token`);
    }
    ok("Clerk: tokens for the domain and for the old address are accepted; another resource or the admin MCP's is refused");

    const { connectInfo } = await import("../src/admin.js");
    assert.equal(connectInfo().connector_url, `${DOMAIN}/mcp`, "invitations name the domain's address");
    // No APP_MCP_URL: exactly as before. An unusable one is ignored, never trusted.
    for (const v of [undefined, "not an address", "javascript:alert(1)"]) {
      if (v === undefined) delete process.env.APP_MCP_URL; else process.env.APP_MCP_URL = v;
      assert.deepEqual(mcpAudiences(), [`${API}/mcp`], `APP_MCP_URL=${v}`);
      assert.equal(connectInfo().connector_url, `${API}/mcp`);
      assert.ok(!allowedMcpOrigins().has(DOMAIN) && allowedMcpOrigins().has(API), "the domain is no MCP Origin of its own");
    }
    // With CLERK_MCP_AUDIENCE set the domain still comes first, and the list is kept after it, once each.
    process.env.APP_MCP_URL = DOMAIN;
    process.env.CLERK_MCP_AUDIENCE = `${API}/mcp,${DOMAIN}/mcp/,https://second.example.com/mcp`;
    assert.deepEqual(mcpAudiences(), [`${DOMAIN}/mcp`, `${API}/mcp`, "https://second.example.com/mcp"]);
    delete process.env.CLERK_MCP_AUDIENCE;
    ok("Clerk: invitations use the domain; without APP_MCP_URL (or with an unusable one) nothing changes; CLERK_MCP_AUDIENCE is kept after it");
  } else {
    // ---------- the built-in authorization server, reached through the domain ----------
    for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
      const as = await json(await get(p));
      assert.equal(as.issuer, DOMAIN, `${p}: the issuer is the domain`);
      for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"]) assert.ok(String(as[k]).startsWith(`${DOMAIN}/oauth/`), k);
    }
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const prm = await json(await get(p));
      assert.equal(prm.resource, `${DOMAIN}/mcp`, p);
      assert.deepEqual(prm.authorization_servers, [DOMAIN], p);
    }
    const r = await rpc(null);
    assert.match(r.www, new RegExp(`resource_metadata="${DOMAIN.replace(/\./g, "\\.")}/\\.well-known/oauth-protected-resource/mcp"`), r.www);
    ok("built-in: the issuer, its endpoints, the resource metadata and the 401 are on the domain");

    const { createOrg } = await import("../src/auth.js");
    const org = (await createOrg(`Domain ${STAMP}`)).org;
    const dir = `org_b${randomBytes(9).toString("base64url")}`;
    await db.query("UPDATE organizations SET clerk_org_id = $2 WHERE id = $1", [org.orgId, dir]);
    const uid = `user_b${randomBytes(9).toString("base64url")}`;
    await db.query("INSERT INTO auth_users (id, email, email_verified_at) VALUES ($1, $2, now())", [uid, `domain-${STAMP}@example.org`]);
    await db.query("INSERT INTO auth_memberships (org_id, user_id, role) VALUES ($1, $2, 'member')", [org.orgId, uid]);
    const st = randomBytes(32).toString("base64url");
    await db.query("INSERT INTO auth_sessions (id, token_hash, user_id, active_org_id, method, expires_at) VALUES ($1, $2, $3, $4, 'email_code', now() + interval '1 day')",
      [`ses_b${randomBytes(9).toString("base64url")}`, sha256(st), uid, org.orgId]);
    const cookie = `__Host-oct_session=${st}`; // PUBLIC_URL is https: only the __Host- cookie counts
    let ipN = 0;
    const ip = () => `198.51.100.${(++ipN % 250) + 1}`;
    const post = async (p: string, body: unknown, h: Record<string, string> = {}) => {
      const res = await fetch(`${base}${p}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });
      return { status: res.status, body: await json(res) };
    };
    const REDIRECT = "http://127.0.0.1:43998/callback";
    const reg = await post("/oauth/register", { client_name: "Domain Connector", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" }, { "x-forwarded-for": ip() });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const signIn = async (resource: string) => {
      const verifier = randomBytes(48).toString("base64url");
      const q = new URLSearchParams({ response_type: "code", client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: s256(verifier), code_challenge_method: "S256", state: "s", resource, scope: "mcp" });
      const a = await get(`/oauth/authorize?${q}`, { "x-forwarded-for": ip() });
      const location = a.headers.get("location") ?? "";
      if (a.status !== 302) return { status: a.status, location };
      assert.ok(location.startsWith(`${DOMAIN}/auth/consent?request=`), location);
      const d = await post(`/api/oauth/requests/${new URL(location).searchParams.get("request")}`, { decision: "allow", workspace: dir }, { cookie, "x-pack-request": "1", origin: DOMAIN });
      assert.equal(d.status, 200, JSON.stringify(d.body));
      const back = new URL(d.body.redirect);
      assert.equal(back.searchParams.get("iss"), DOMAIN, "iss in the response is the domain (RFC 9207)");
      const t = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip() },
        body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", redirect_uri: REDIRECT, client_id: reg.body.client_id, code_verifier: verifier, resource }) });
      const tb = await json(t);
      assert.equal(t.status, 200, JSON.stringify(tb));
      return { status: 302, location, access: tb.access_token as string };
    };
    for (const resource of [`${DOMAIN}/mcp`, `${API}/mcp`]) {
      const s = await signIn(resource);
      assert.equal((await rpc(s.access!)).status, 200, `a sign-in for ${resource} reaches /mcp`);
    }
    const other = await signIn("https://other-product.example.com/mcp");
    assert.notEqual(other.status, 302, "another resource is refused before the person is asked");
    ok("built-in: a whole sign-in for the domain's /mcp and for the old address's works; another resource is refused");
  }
  await http.close();
  console.log(`\n${n} checks passed (${PROVIDER})`);
} finally {
  cleanup();
}
process.exit(0);
