// Sign-in, members, roles and invitations under both adapters (mold_v0-004; src/people.ts, src/builtin-auth.ts,
// src/clerk.ts), offline: an embedded database, the mock providers (a fake Clerk, Resend as the email transport, a Google
// stand-in), over HTTP. No real email is sent and Google is never called.
//   npm run test:sign-in            both: builtin, then clerk
//   tsx scripts/sign-in-test.ts builtin|clerk
//
// The same suite for both adapters:
// 1. Staff make two workspaces, each with an invited owner; the owner signs in and lands in their own workspace.
// 2. An owner invites a member and a viewer; they sign in with the invited address and get the invited role.
// 3. A role change holds on the next request (console and member key alike).
// 4. Cross-workspace isolation: an owner of A cannot change, suspend or remove B's people, and A's people read only A.
// 5. Removal: the member's access ends on the next request (sessions, built-in: revoked), their member keys are revoked.
// 6. A revoked invitation lets nobody in; a member cannot manage the team.
// Built-in only (Clerk keeps these in its own service):
// 7. The emailed code: one answer for every address (no enumeration), ten minutes, five tries, used once, newest only;
//    per-address and per-IP limits; JSON and same-site only.
// 8. Sessions: httpOnly, SameSite=Lax, expiring, stored as a hash; a fresh session at every sign-in (fixation); sign-out,
//    sign-out of other devices, sign-out everywhere.
// 9. Google: shown only when configured; state bound to the browser, PKCE, nonce, issuer, audience, verified address;
//    an address without an invitation is refused; open redirects are refused.
// 10. Platform admins: an APP_PLATFORM_ADMINS address signs in and reaches /admin; cookie writes need the CSRF header.
// Clerk only: the built-in routes answer 404 (only /api/auth/config, which names the provider).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const PROVIDER = process.argv[2] === "clerk" ? "clerk" : "builtin";
process.env.AUTH_PROVIDER = PROVIDER;
process.env.APP_PLATFORM_ADMINS = "boss@platform.example";
// Every test signs people in many times: the per-address code limit is checked on its own below.
process.env.APP_LIMIT_ENDPOINTS_SIGNIN_CODES_PER_HOUR_PER_ADDRESS = "1000";
// The test stands in for the one proxy in front of the server (src/proxy-trust.ts, mold_v0-084): each request's
// X-Forwarded-For is the address that proxy saw.
process.env.APP_PROXY_HOPS = "1";
const { cleanup, startHttp, STAMP } = await import("./lib/test-world.js");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ok = (what: string) => { n++; console.log(`✓ [${PROVIDER}] ${what}`); };

try {
  const http = await startHttp();
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  // Email: the mock Resend is the transport (src/email.ts, RESEND_API_URL); every email lands in mock.state.emails.
  process.env.RESEND_API_URL = http.mock.url;
  await (await import("../src/keyvault.js")).setCredential("resend", `re_test_${STAMP}_secret`);
  // Google: the stand-in in the mock providers.
  Object.assign(process.env, { GOOGLE_CLIENT_ID: "test-client.apps.example", GOOGLE_CLIENT_SECRET: "test-secret",
    GOOGLE_AUTH_URL: `${http.mock.url}/_mock/google/authorize`, GOOGLE_TOKEN_URL: `${http.mock.url}/_mock/google/token`,
    GOOGLE_JWKS_URL: `${http.mock.url}/_mock/google/jwks`, GOOGLE_ISSUER: `${http.mock.url}/google` });
  const { people } = await import("../src/people.js");
  assert.equal(people().provider, PROVIDER, "AUTH_PROVIDER picks the adapter");

  type H = Record<string, string>;
  const call = async (method: string, p: string, h: H = {}, body?: unknown) => {
    const r = await http.req(method, p, h, body);
    const t = await r.text();
    let json: any = null;
    try { json = t ? JSON.parse(t) : null; } catch { json = t; }
    return { status: r.status, body: json, headers: r.headers };
  };
  const emails = () => http.mock.state.emails as any[];
  const kindOf = (e: any) => e.tags?.find((t: any) => t.name === "kind")?.value;
  const emailsTo = (to: string, kind: string) => emails().filter((e) => e.to.includes(to) && kindOf(e) === kind);
  /** The newest sign-in code emailed to `to` (emails go out after the answer: wait for it). */
  const codeFor = async (to: string, after = 0) => {
    for (let i = 0; i < 100; i++) {
      const m = emailsTo(to, "sign_in_code");
      if (m.length > after) return /sign-in code is (\d{8})/.exec(m.at(-1).text)![1]!;
      await wait(20);
    }
    throw new Error(`no code emailed to ${to}`);
  };
  const cookieOf = (res: { headers: Headers }) => {
    const set = res.headers.getSetCookie().find((c) => /^(__Host-)?oct_session=[^;]+/.test(c) && !/Max-Age=0/.test(c));
    return set ? set.split(";")[0]! : null;
  };
  let ipN = 0;
  const freshIp = () => `198.51.100.${(++ipN % 250) + 1}`;

  // ---------- the adapter driver: how a person who was invited signs in ----------
  const mockPost = async (p: string, body: unknown) => (await fetch(`${http.mock.url}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  /** Sign in with an emailed code (built-in): the session cookie as a header. */
  const codeSignIn = async (email: string, ip = freshIp()) => {
    const before = emailsTo(email, "sign_in_code").length;
    const r1 = await call("POST", "/api/auth/email/request", { "x-forwarded-for": ip }, { email });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    const code = await codeFor(email, before);
    const r2 = await call("POST", "/api/auth/email/verify", { "x-forwarded-for": ip }, { email, code });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    const c = cookieOf(r2);
    assert.ok(c, "a session cookie");
    return { cookie: c!, res: r2 };
  };
  /** The person behind an invitation to `email`, signed in: headers for the API, and their user id. */
  const accept = async (email: string): Promise<{ h: H; user: string }> => {
    if (PROVIDER === "builtin") {
      const { cookie } = await codeSignIn(email);
      const h = { cookie, "x-pack-request": "1" };
      return { h, user: (await call("GET", "/api/auth/session", h)).body.user.id };
    }
    const inv = [...(http.mock.state.invitations as Map<string, any>).values()].filter((x) => x.email_address === email && x.status === "pending").at(-1);
    assert.ok(inv, `a Clerk invitation for ${email}`);
    const { user, membership } = await mockPost(`/_mock/invitations/${inv.id}/accept`, {});
    const { token } = await mockPost("/_mock/session", { user_id: user.id, org_id: membership.organization.id });
    return { h: { authorization: `Bearer ${token}`, "x-pack-request": "1" }, user: user.id };
  };
  const adminTok = await http.adminToken("owner");
  const admin = { authorization: `Bearer ${adminTok}` };

  // ---------- 1. staff make two workspaces with an invited owner each ----------
  const ownerAEmail = `owner-a-${STAMP}@a.example`, ownerBEmail = `owner-b-${STAMP}@b.example`;
  const A = await call("POST", "/api/admin/onboarding/orgs", admin, { name: `Sign A ${STAMP}`, email: ownerAEmail });
  const B = await call("POST", "/api/admin/onboarding/orgs", admin, { name: `Sign B ${STAMP}`, email: ownerBEmail });
  assert.equal(A.status, 201, JSON.stringify(A.body)); assert.equal(B.status, 201, JSON.stringify(B.body));
  assert.ok(A.body.invitation && !A.body.key, "an invitation, not a key, under either adapter");
  const slugA = A.body.org.slug, slugB = B.body.org.slug;
  const [rowA] = await db.query<{ id: number; clerk_org_id: string }>("SELECT id, clerk_org_id FROM organizations WHERE slug = $1", [slugA]);
  const [rowB] = await db.query<{ id: number; clerk_org_id: string }>("SELECT id, clerk_org_id FROM organizations WHERE slug = $1", [slugB]);
  assert.ok(rowA!.clerk_org_id && rowB!.clerk_org_id, "each workspace has its directory id");
  if (PROVIDER === "builtin") {
    for (const e of [ownerAEmail, ownerBEmail]) {
      for (let i = 0; i < 100 && !emailsTo(e, "invitation").length; i++) await wait(20);
      const inv = emailsTo(e, "invitation")[0];
      assert.ok(inv, `the invitation is emailed to ${e}`);
      assert.match(inv.text, /\/auth\/sign-in\?redirect_url=%2Fapp/, "it links to the sign-in page");
      assert.doesNotMatch(inv.text, /inv_b|token/i, "the email carries no invitation secret: signing in with the address is the acceptance");
    }
  }
  const ownerA = await accept(ownerAEmail), ownerB = await accept(ownerBEmail);
  const meA = await call("GET", "/api/app/me", ownerA.h);
  assert.equal(meA.status, 200, JSON.stringify(meA.body));
  assert.equal(meA.body.account.slug, slugA); assert.equal(meA.body.account_role, "owner"); assert.equal(meA.body.via, PROVIDER);
  assert.equal((await call("GET", "/api/app/me", ownerB.h)).body.account.slug, slugB);
  assert.equal((await call("GET", "/api/app/me")).status, 401, "signed out: 401");
  ok("staff make workspaces with an invited owner; the owner signs in with the invited address and lands in their own workspace");

  // ---------- 2. an owner invites a member and a viewer ----------
  const memberEmail = `member-${STAMP}@a.example`, viewerEmail = `viewer-${STAMP}@a.example`;
  for (const [email, role] of [[memberEmail, "member"], [viewerEmail, "viewer"]] as const) {
    const r = await call("POST", "/api/app/team/invitations", ownerA.h, { email, role });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.invitation.account_role, role);
  }
  const team0 = await call("GET", "/api/app/team", ownerA.h);
  assert.deepEqual(team0.body.invitations.map((x: any) => x.email).sort(), [memberEmail, viewerEmail].sort(), "the pending invitations are listed");
  const member = await accept(memberEmail), viewer = await accept(viewerEmail);
  assert.equal((await call("GET", "/api/app/me", member.h)).body.account_role, "member");
  assert.equal((await call("GET", "/api/app/me", viewer.h)).body.account_role, "viewer");
  const team1 = await call("GET", "/api/app/team", ownerA.h);
  assert.deepEqual(team1.body.members.map((m: any) => m.account_role).sort(), ["member", "owner", "viewer"]);
  assert.equal(team1.body.invitations.length, 0, "accepted invitations leave the list");
  if (PROVIDER === "builtin") {
    const accepted = await db.query<{ status: string }>("SELECT status FROM auth_invitations WHERE email = ANY($1)", [[memberEmail, viewerEmail]]);
    assert.ok(accepted.every((x) => x.status === "accepted"), "each invitation is used once");
  }
  // A member may not manage the team.
  assert.equal((await call("POST", "/api/app/team/invitations", member.h, { email: `x-${STAMP}@a.example` })).status, 403, "a member cannot invite");
  ok("an owner invites a member and a viewer; each signs in with the invited address and gets the invited role; a member cannot invite");

  // ---------- 3. role change, and a member key that follows it ----------
  const key = await call("POST", "/api/keys", viewer.h, { name: "viewer's laptop" });
  assert.equal(key.status, 201, JSON.stringify(key.body));
  const rpc = async (k: string, method = "tools/list") => {
    const r = await fetch(`${http.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${k}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }) });
    return r.status;
  };
  assert.equal(await rpc(key.body.key), 200, "the viewer's member key works in a header");
  const role = await call("POST", `/api/app/team/members/${viewer.user}/role`, ownerA.h, { role: "member" });
  assert.equal(role.status, 204, JSON.stringify(role.body));
  assert.equal((await call("GET", "/api/app/me", viewer.h)).body.account_role, "member", "the new role holds on the next request");
  const { memberRole } = await import("../src/auth.js");
  assert.equal(await memberRole(viewer.user, rowA!.clerk_org_id), "member", "and for the member key");
  assert.equal((await call("POST", `/api/app/team/members/${ownerA.user}/role`, ownerA.h, { role: "member" })).status, 400, "nobody changes their own role");
  ok("a role change holds on the next request, for the console and the member key alike");

  // ---------- 4. cross-workspace isolation ----------
  for (const [what, path, body] of [["change the role of", `/api/app/team/members/${ownerB.user}/role`, { role: "viewer" }],
    ["suspend", `/api/app/team/members/${ownerB.user}/deactivate`, undefined], ["remove", `/api/app/team/members/${ownerB.user}/remove`, undefined]] as const) {
    const r = await call("POST", path, ownerA.h, body);
    assert.equal(r.status, 404, `an owner of A cannot ${what} B's owner: ${r.status} ${JSON.stringify(r.body)}`);
  }
  assert.equal((await call("GET", "/api/app/me", ownerB.h)).body.account_role, "owner", "B's owner is untouched");
  const teamA = JSON.stringify((await call("GET", "/api/app/team", ownerA.h)).body);
  assert.ok(!teamA.includes(ownerBEmail) && !teamA.includes(ownerB.user), "A's team list names nobody of B");
  const invB = await call("GET", "/api/app/team", ownerB.h);
  assert.ok(!JSON.stringify(invB.body).includes(memberEmail), "B's team list names nobody of A");
  if (PROVIDER === "builtin") {
    const sw = await call("POST", "/api/auth/active-org", member.h, { organization_id: rowB!.clerk_org_id });
    assert.equal(sw.status, 404, "a member of A cannot switch their session into B");
    assert.equal((await call("GET", "/api/app/me", member.h)).body.account.slug, slugA);
    // An invitation of A's revoked by B's owner? B cannot even see it.
    const pend = await call("POST", "/api/app/team/invitations", ownerA.h, { email: `pending-${STAMP}@a.example` });
    assert.equal((await call("POST", `/api/app/team/invitations/${pend.body.invitation.id}/revoke`, ownerB.h)).status, 404, "B's owner cannot revoke A's invitation");
    assert.equal((await call("POST", `/api/app/team/invitations/${pend.body.invitation.id}/revoke`, ownerA.h)).status, 204);
  }
  if (PROVIDER === "builtin") {
    // Someone already in a workspace who is invited to another is not moved there by signing in: they accept it themselves.
    const r = await call("POST", "/api/app/team/invitations", ownerB.h, { email: ownerAEmail, role: "member" });
    assert.equal(r.status, 201);
    const again = await codeSignIn(ownerAEmail);
    const h = { cookie: again.cookie, "x-pack-request": "1" };
    assert.equal((await call("GET", "/api/app/me", h)).body.account.slug, slugA, "signing in keeps them in their own workspace");
    const sess = (await call("GET", "/api/auth/session", h)).body;
    assert.equal(sess.memberships.length, 1, "not a member of B until they accept");
    assert.deepEqual(sess.invitations.map((i: any) => i.organization.id), [rowB!.clerk_org_id], "the invitation waits for them");
    assert.equal((await call("POST", `/api/auth/invitations/${sess.invitations[0].id}/accept`, ownerB.h, {})).status, 404, "nobody else can accept it");
    const acc = await call("POST", `/api/auth/invitations/${sess.invitations[0].id}/accept`, h, {});
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    assert.equal((await call("GET", "/api/app/me", h)).body.account.slug, slugA, "accepting does not switch their session");
    assert.equal((await call("GET", "/api/auth/session", h)).body.memberships.length, 2);
    // Back out of B so the rest of the suite reads A's owner as before.
    assert.equal((await call("POST", `/api/app/team/members/${ownerA.user}/remove`, ownerB.h)).status, 200);
  }
  ok("cross-workspace: an owner of A cannot change, suspend or remove B's people, and each team list names only its own" + (PROVIDER === "builtin" ? "; an invitation to someone already in a workspace waits for them to accept it" : ""));

  // ---------- 5. removal ends sessions and revokes member keys ----------
  const mk = await call("POST", "/api/keys", member.h, { name: "member's CLI" });
  assert.equal(mk.status, 201);
  assert.equal(await rpc(mk.body.key), 200);
  assert.equal((await call("POST", `/api/app/team/members/${ownerA.user}/remove`, ownerA.h)).status, 400, "nobody removes themselves");
  assert.equal((await call("POST", `/api/app/team/members/${member.user}/remove`, viewer.h)).status, 403, "only an owner removes people");
  const rm = await call("POST", `/api/app/team/members/${member.user}/remove`, ownerA.h);
  assert.equal(rm.status, 200, JSON.stringify(rm.body));
  assert.equal(rm.body.keys_revoked, 1, "the member's key in this workspace is revoked");
  const after = await call("GET", "/api/app/me", member.h);
  assert.ok(after.status === 401 || after.status === 403, `the removed member is refused on the next request: ${after.status}`);
  assert.equal(await rpc(mk.body.key), 401, "their member key is refused");
  const [k] = await db.query<{ revoked_at: Date | null; revoked_by: string }>("SELECT revoked_at, revoked_by FROM api_keys WHERE id = $1", [mk.body.id]);
  assert.ok(k!.revoked_at && /^removed:/.test(k!.revoked_by), "revoked, and by whom");
  if (PROVIDER === "builtin") {
    assert.equal(after.status, 401, "built-in: their session itself was revoked");
    assert.equal((await call("GET", "/api/auth/session", member.h)).body.signed_in, false);
    const [s] = await db.query<{ revoked_why: string }>("SELECT revoked_why FROM auth_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [member.user]);
    assert.equal(s!.revoked_why, "removed");
  }
  // Suspension: the key stops, and comes back when restored (it was not revoked).
  assert.equal((await call("POST", `/api/app/team/members/${viewer.user}/deactivate`, ownerA.h)).status, 204);
  assert.equal(await rpc(key.body.key), 401, "a suspended member's key is refused");
  assert.equal((await call("GET", "/api/app/me", viewer.h)).status, 403, "and their console");
  assert.equal((await call("POST", `/api/app/team/members/${viewer.user}/reactivate`, ownerA.h)).status, 204);
  assert.equal(await rpc(key.body.key), 200, "restored");
  ok("removal: the member is refused on the next request and their member keys are revoked; suspension holds and lifts");

  // ---------- 6. a revoked invitation ----------
  const revEmail = `revoked-${STAMP}@a.example`;
  const inv = await call("POST", "/api/app/team/invitations", ownerA.h, { email: revEmail });
  assert.equal((await call("POST", `/api/app/team/invitations/${inv.body.invitation.id}/revoke`, ownerA.h)).status, 204);
  if (PROVIDER === "builtin") {
    const r = await call("POST", "/api/auth/email/request", { "x-forwarded-for": freshIp() }, { email: revEmail });
    assert.equal(r.status, 200, "the same answer");
    await wait(150);
    assert.equal(emailsTo(revEmail, "sign_in_code").length, 0, "but no code goes to a revoked invitation's address");
  }
  ok("a revoked invitation lets nobody in");

  if (PROVIDER === "builtin") {
    // ---------- 7. the emailed code ----------
    {
      // One answer for every address; a row for every request; a code only to a known one.
      const unknown = `nobody-${STAMP}@nowhere.example`;
      const a = await call("POST", "/api/auth/email/request", { "x-forwarded-for": freshIp() }, { email: viewerEmail });
      const b = await call("POST", "/api/auth/email/request", { "x-forwarded-for": freshIp() }, { email: unknown });
      assert.equal(a.status, b.status); assert.deepEqual(a.body, b.body, "the same words for a known and an unknown address");
      await wait(150);
      assert.equal(emailsTo(unknown, "sign_in_code").length, 0, "no email to an unknown address");
      assert.equal((await db.query("SELECT 1 FROM auth_codes WHERE email = $1", [unknown])).length, 1, "the same write for it");
      // Even the right digits for an unknown address are refused (it was never sent).
      const [u] = await db.query<{ id: number }>("SELECT id FROM auth_codes WHERE email = $1", [unknown]);
      const { CODE_REFUSED } = await import("../src/builtin-auth.js");
      for (let i = 0; i < 3; i++) assert.equal((await call("POST", "/api/auth/email/verify", { "x-forwarded-for": freshIp() }, { email: unknown, code: String(10000000 + i) })).body.error, CODE_REFUSED);
      assert.ok(u, "row exists");
      // The code: only its HMAC is stored.
      const email = viewerEmail;
      const code = await codeFor(email);
      const rows = await db.query<{ code_hash: string }>("SELECT code_hash FROM auth_codes WHERE email = $1", [email]);
      assert.ok(rows.every((x) => x.code_hash !== code && x.code_hash !== sha256(code) && !x.code_hash.includes(code)), "the code is never stored, nor its plain sha256");
      const [logged] = await db.query<{ subject: string; meta: unknown }>("SELECT subject, meta FROM email_log WHERE kind = 'sign_in_code' ORDER BY id DESC LIMIT 1");
      assert.ok(!JSON.stringify(logged).includes(code), "nor in the email log");
      // Five tries: four wrong, the fifth right still works; a sixth after five wrong is refused even when right.
      const wrong = (c: string) => (c === "00000000" ? "00000001" : "00000000");
      for (let i = 0; i < 4; i++) assert.equal((await call("POST", "/api/auth/email/verify", { "x-forwarded-for": freshIp() }, { email, code: wrong(code) })).status, 401);
      assert.equal((await call("POST", "/api/auth/email/verify", { "x-forwarded-for": freshIp() }, { email, code })).status, 200, "the fifth try, right, signs in");
      assert.equal((await call("POST", "/api/auth/email/verify", { "x-forwarded-for": freshIp() }, { email, code })).status, 401, "a used code is refused");
      await call("POST", "/api/auth/email/request", { "x-forwarded-for": freshIp() }, { email });
      const c2 = await codeFor(email, emailsTo(email, "sign_in_code").length - 1);
      for (let i = 0; i < 5; i++) await call("POST", "/api/auth/email/verify", { "x-forwarded-for": freshIp() }, { email, code: wrong(c2) });
      const sixth = await call("POST", "/api/auth/email/verify", { "x-forwarded-for": freshIp() }, { email, code: c2 });
      assert.equal(sixth.status, 429, `after five wrong tries even the right code is refused: ${sixth.status}`);
      // Newest only: a new code retires the old one.
      let before = emailsTo(email, "sign_in_code").length;
      await call("POST", "/api/auth/email/request", { "x-forwarded-for": freshIp() }, { email });
      const old = await codeFor(email, before);
      before = emailsTo(email, "sign_in_code").length;
      await call("POST", "/api/auth/email/request", { "x-forwarded-for": freshIp() }, { email });
      const newer = await codeFor(email, before);
      if (old !== newer) assert.equal((await call("POST", "/api/auth/email/verify", { "x-forwarded-for": freshIp() }, { email, code: old })).status, 401, "the older code is retired");
      // Expired: ten minutes.
      await db.query("UPDATE auth_codes SET expires_at = now() - interval '1 second' WHERE email = $1 AND consumed_at IS NULL", [email]);
      assert.equal((await call("POST", "/api/auth/email/verify", { "x-forwarded-for": freshIp() }, { email, code: newer })).status, 401, "an expired code is refused");
      const [ttl] = await db.query<{ m: number }>("SELECT extract(epoch FROM expires_at - created_at)::int / 60 AS m FROM auth_codes WHERE email = $1 ORDER BY id DESC LIMIT 1", [ownerAEmail]);
      assert.equal(Number(ttl!.m), 10, "codes live ten minutes");
      // Per address and IP: five codes an hour; per address: ten an hour (the default), from any IP.
      delete process.env.APP_LIMIT_ENDPOINTS_SIGNIN_CODES_PER_HOUR_PER_ADDRESS;
      const busy = `busy-${STAMP}@a.example`, oneIp = freshIp();
      for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/api/auth/email/request", { "x-forwarded-for": oneIp }, { email: busy })).status, 200);
      assert.equal((await call("POST", "/api/auth/email/request", { "x-forwarded-for": oneIp }, { email: busy })).status, 429, "the sixth code in an hour for one address from one IP");
      for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/api/auth/email/request", { "x-forwarded-for": freshIp() }, { email: busy })).status, 200);
      assert.equal((await call("POST", "/api/auth/email/request", { "x-forwarded-for": freshIp() }, { email: busy })).status, 429, "the eleventh code in an hour for one address, from any IP");
      // No longer lock-out: wrong tries never close an address to new codes (anyone could keep its person out).
      await db.query("UPDATE auth_codes SET created_at = now() - interval '2 hours' WHERE email = $1", [busy]);
      await db.query("INSERT INTO auth_codes (email, code_hash, deliverable, attempts, expires_at, created_at) VALUES ($1, 'x', false, 100, now(), now() - interval '3 hours')", [busy]);
      assert.equal((await call("POST", "/api/auth/email/request", { "x-forwarded-for": freshIp() }, { email: busy })).status, 200, "a hundred wrong tries by someone else do not lock the address");
      process.env.APP_LIMIT_ENDPOINTS_SIGNIN_CODES_PER_HOUR_PER_ADDRESS = "1000";
      await db.query("DELETE FROM auth_codes WHERE email = $1", [viewerEmail]);
      // Per IP.
      process.env.APP_LIMIT_ENDPOINTS_SIGNIN_PER_HOUR_PER_IP = "3";
      const ip = freshIp();
      for (let i = 0; i < 3; i++) assert.equal((await call("POST", "/api/auth/email/request", { "x-forwarded-for": ip }, { email: `ip${i}-${STAMP}@a.example` })).status, 200);
      assert.equal((await call("POST", "/api/auth/email/request", { "x-forwarded-for": ip }, { email: `ip9-${STAMP}@a.example` })).status, 429, "per IP");
      delete process.env.APP_LIMIT_ENDPOINTS_SIGNIN_PER_HOUR_PER_IP;
      process.env.APP_LIMIT_ENDPOINTS_SIGNIN_CHECKS_PER_HOUR_PER_IP = "2";
      const ip2 = freshIp();
      for (let i = 0; i < 2; i++) await call("POST", "/api/auth/email/verify", { "x-forwarded-for": ip2 }, { email: busy, code: "12345678" });
      assert.equal((await call("POST", "/api/auth/email/verify", { "x-forwarded-for": ip2 }, { email: busy, code: "12345678" })).status, 429, "code checks per IP");
      delete process.env.APP_LIMIT_ENDPOINTS_SIGNIN_CHECKS_PER_HOUR_PER_IP;
      // JSON from this site only.
      const form = await fetch(`${http.base}/api/auth/email/request`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `email=${encodeURIComponent(viewerEmail)}` });
      assert.equal(form.status, 415, "a form post (what a cross-site page can send) is refused");
      const foreign = await call("POST", "/api/auth/email/verify", { origin: "https://evil.example" }, { email: viewerEmail, code: "12345678" });
      assert.equal(foreign.status, 403, "a request from another site's page is refused");
      assert.equal((await call("POST", "/api/auth/email/request", {}, { email: "not an address" })).status, 400);
      // A cookie-borne change to /api/app needs the CSRF header.
      const owner = (await codeSignIn(ownerAEmail)).cookie;
      assert.equal((await call("POST", "/api/app/team/invitations", { cookie: owner }, { email: `csrf-${STAMP}@a.example` })).status, 403, "no X-Pack-Request: refused");
      assert.equal((await call("POST", "/api/app/team/invitations", { cookie: owner, "x-pack-request": "1" }, { email: `csrf-${STAMP}@a.example` })).status, 201);
      ok("the emailed code: eight digits, the same answer and write for any address (no enumeration), only its HMAC stored, five tries, used once, newest only, ten minutes; per-address, per-address-and-IP and per-IP limits, no lock-out; JSON from this site only; /api/app cookie writes need the CSRF header");
    }

    // ---------- 8. sessions ----------
    {
      const { cookie, res } = await codeSignIn(viewerEmail);
      const set = res.headers.getSetCookie().find((c) => c.startsWith(cookie.split("=")[0] + "=") && !/Max-Age=0/.test(c))!;
      assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Lax/); assert.match(set, /Path=\//);
      const maxAge = Number(/Max-Age=(\d+)/.exec(set)![1]);
      assert.equal(maxAge, 14 * 86_400, "it expires (14 days by default)");
      const value = cookie.split("=")[1]!;
      assert.ok(value.length >= 43, "a 256-bit random value");
      assert.ok(!JSON.stringify(await db.query("SELECT * FROM auth_sessions")).includes(value), "only its hash is stored");
      assert.equal((await db.query("SELECT 1 FROM auth_sessions WHERE token_hash = $1", [sha256(value)])).length, 1);
      // Fixation: whatever cookie the browser brings to a sign-in, it leaves with a new one, and the old one is ended.
      const planted = `oct_session=${"A".repeat(43)}`;
      // On an https site only the __Host- cookie counts: a plain one (which a sibling host could plant) is nobody.
      const pub = process.env.PUBLIC_URL;
      process.env.PUBLIC_URL = "https://console.example";
      assert.equal((await call("GET", "/api/auth/session", { cookie })).body.signed_in, false, "https: the plain cookie is not read");
      assert.equal((await call("GET", "/api/auth/session", { cookie: `__Host-${cookie}` })).body.signed_in, true, "https: the __Host- one is");
      if (pub === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = pub;
      const again = await codeSignIn(viewerEmail);
      const viaPlanted = await (async () => {
        const before = emailsTo(viewerEmail, "sign_in_code").length;
        await call("POST", "/api/auth/email/request", { "x-forwarded-for": freshIp(), cookie: planted }, { email: viewerEmail });
        const c = await codeFor(viewerEmail, before);
        return call("POST", "/api/auth/email/verify", { "x-forwarded-for": freshIp(), cookie: again.cookie }, { email: viewerEmail, code: c });
      })();
      const fresh = cookieOf(viaPlanted)!;
      assert.notEqual(fresh, again.cookie, "a new session at sign-in");
      assert.equal((await call("GET", "/api/auth/session", { cookie: again.cookie })).body.signed_in, false, "the session the browser came with is ended");
      assert.equal((await call("GET", "/api/auth/session", { cookie: planted })).body.signed_in, false, "a made-up value is nobody");
      // Expiry.
      await db.query("UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [sha256(fresh.split("=")[1]!)]);
      assert.equal((await call("GET", "/api/app/me", { cookie: fresh })).status, 401, "an expired session is refused");
      // Sign-out ends this one.
      const s1 = (await codeSignIn(viewerEmail)).cookie;
      const out = await call("POST", "/api/auth/sign-out", { cookie: s1 }, {});
      assert.ok(out.headers.getSetCookie().some((c) => /Max-Age=0/.test(c)), "the cookie is cleared");
      assert.equal((await call("GET", "/api/app/me", { cookie: s1 })).status, 401, "and the session ended on the server");
      // Other devices; then everywhere.
      const d1 = (await codeSignIn(viewerEmail)).cookie, d2 = (await codeSignIn(viewerEmail)).cookie, d3 = (await codeSignIn(viewerEmail)).cookie;
      const others = await call("POST", "/api/auth/sign-out/others", { cookie: d1 }, {});
      assert.equal(others.status, 200); assert.ok(others.body.ended >= 2);
      assert.equal((await call("GET", "/api/app/me", { cookie: d1 })).status, 200, "this device stays signed in");
      for (const d of [d2, d3]) assert.equal((await call("GET", "/api/app/me", { cookie: d })).status, 401, "the others are signed out");
      const d4 = (await codeSignIn(viewerEmail)).cookie;
      const every = await call("POST", "/api/auth/sign-out/everywhere", { cookie: d4 }, {});
      assert.equal(every.status, 200);
      for (const d of [d1, d4]) assert.equal((await call("GET", "/api/app/me", { cookie: d })).status, 401, "signed out everywhere, this device too");
      assert.equal((await call("POST", "/api/auth/sign-out/everywhere", { cookie: d4, origin: "https://evil.example" }, {})).status, 403, "not from another site");
      assert.equal(await rpc(key.body.key), 200, "member keys are their own credential: signing out does not revoke them (the person revokes keys on the keys page)");
      ok("sessions: httpOnly, SameSite=Lax, 14 days, stored as a hash; a new one at every sign-in and the old one ended; sign-out, other devices, everywhere");
    }

    // ---------- 9. Google ----------
    {
      const cfg = await call("GET", "/api/auth/config");
      assert.deepEqual(cfg.body, { provider: "builtin", email_code: true, google: true, accounts: "invite_only" });
      const gEmail = `google-${STAMP}@a.example`;
      await call("POST", "/api/app/team/invitations", ownerA.h, { email: gEmail, role: "viewer" });
      const start = async (redirect = "/app/usage") => {
        const r = await fetch(`${http.base}/api/auth/google/start?redirect_url=${encodeURIComponent(redirect)}`, { redirect: "manual", headers: { "x-forwarded-for": freshIp() } });
        assert.equal(r.status, 302);
        const loc = new URL(r.headers.get("location")!);
        assert.equal(loc.origin + loc.pathname, process.env.GOOGLE_AUTH_URL);
        const q = Object.fromEntries(loc.searchParams);
        assert.equal(q.code_challenge_method, "S256"); assert.equal(q.response_type, "code"); assert.match(q.scope!, /openid/);
        assert.ok(q.state && q.nonce && q.code_challenge);
        assert.equal(q.redirect_uri, `${http.base}/api/auth/google/callback`, "back to the origin the browser is on");
        const c = r.headers.getSetCookie().find((x) => x.startsWith("oct_oauth_state="))!;
        assert.match(c, /HttpOnly/);
        return { q, cookie: c.split(";")[0]! };
      };
      const back = async (st: { q: Record<string, string>; cookie: string }, claims: Record<string, unknown>, cookie: string | null = st.cookie) => {
        const { code } = await mockPost("/_mock/google/code", { nonce: st.q.nonce, code_challenge: st.q.code_challenge, redirect_uri: st.q.redirect_uri, hd: "a.example", ...claims });
        const r = await fetch(`${http.base}/api/auth/google/callback?code=${code}&state=${encodeURIComponent(st.q.state!)}`, { redirect: "manual", headers: { "x-forwarded-for": freshIp(), ...(cookie ? { cookie } : {}) } });
        return { status: r.status, location: r.headers.get("location") ?? "", cookie: cookieOf(r) };
      };
      const sub = `g-${STAMP}`;
      // The state must come back to the browser that started it.
      const s0 = await start();
      assert.match((await back(s0, { email: gEmail, sub }, null)).location, /error=google_state/, "no state cookie: refused");
      // Each check of the ID token.
      for (const [what, claims] of [["another audience", { aud: "someone-else" }], ["another issuer", { iss: "https://evil.example" }], ["an unverified address", { email_verified: false }],
        ["another nonce", { nonce: "x" }], ["an expired token", { expired: true }]] as const) {
        const s = await start();
        const r = await back(s, { email: gEmail, sub, ...claims });
        assert.match(r.location, /error=google_failed/, `${what}: refused (${r.location})`);
        assert.equal(r.cookie, null);
      }
      // Google speaks only for Gmail or its own Workspace domain: a consumer account with a work address is refused.
      const sH = await start();
      assert.match((await back(sH, { email: gEmail, sub, hd: undefined })).location, /error=google_not_authoritative/, "no hd claim for a work address");
      const sH2 = await start();
      assert.match((await back(sH2, { email: gEmail, sub, hd: "other.example" })).location, /error=google_not_authoritative/, "another Workspace domain");
      const gmail = `invited.${STAMP}@gmail.com`;
      await call("POST", "/api/app/team/invitations", ownerA.h, { email: gmail, role: "viewer" });
      const sG = await start();
      const gm = await back(sG, { email: gmail, sub: `gm-${STAMP}`, hd: undefined });
      assert.equal(gm.location, "/app/usage"); assert.ok(gm.cookie, "a Gmail address needs no hd");
      // An address with no invitation.
      const sN = await start();
      assert.match((await back(sN, { email: `stranger-${STAMP}@a.example`, sub: `x-${STAMP}` })).location, /error=not_invited/);
      // The invited address: signed in, the invitation accepted, back where they started.
      const s1 = await start("/app/usage");
      const ok1 = await back(s1, { email: gEmail, sub, given_name: "Gina" });
      assert.equal(ok1.location, "/app/usage"); assert.ok(ok1.cookie, "a session");
      const gme = await call("GET", "/api/app/me", { cookie: ok1.cookie! });
      assert.equal(gme.body.account_role, "viewer"); assert.equal(gme.body.account.slug, slugA);
      assert.equal((await call("GET", "/api/auth/session", { cookie: ok1.cookie! })).body.user.google, true);
      // The state is used once.
      assert.match((await back(s1, { email: gEmail, sub })).location, /error=google_state/, "a replayed state is refused");
      // Another Google account claiming the same address later is refused (the address is linked).
      const s2 = await start();
      assert.match((await back(s2, { email: gEmail, sub: `other-${STAMP}` })).location, /error=google_linked_elsewhere/);
      // Open redirects.
      for (const bad of ["https://evil.example/x", "//evil.example", "/\\evil.example", "javascript:alert(1)", "/.//evil.example", "/..//evil.example", "/%2e//evil.example", "/a/..//evil.example"]) {
        const s = await start(bad);
        assert.equal((await back(s, { email: gEmail, sub })).location, "/app", `${bad} is not followed`);
      }
      const v = await codeSignIn(viewerEmail);
      const before = emailsTo(viewerEmail, "sign_in_code").length;
      await call("POST", "/api/auth/email/request", { "x-forwarded-for": freshIp() }, { email: viewerEmail });
      const code = await codeFor(viewerEmail, before);
      const red = await call("POST", "/api/auth/email/verify", { "x-forwarded-for": freshIp(), cookie: v.cookie }, { email: viewerEmail, code, redirect_url: "//evil.example/x" });
      assert.equal(red.body.redirect, "/app", "an emailed-code sign-in refuses an open redirect too");
      // Hidden when not configured.
      const id = process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_ID;
      assert.equal((await call("GET", "/api/auth/config")).body.google, false, "no client id: no Google button");
      assert.equal((await fetch(`${http.base}/api/auth/google/start`, { redirect: "manual" })).status, 404);
      process.env.GOOGLE_CLIENT_ID = id;
      ok("Google: shown only when configured; state bound to the browser and used once, PKCE, nonce, issuer, audience, expiry and a verified address checked; no invitation, no entry; one Google account per address; no open redirect");
    }

    // ---------- 10. platform admins ----------
    {
      const boss = (await codeSignIn("boss@platform.example")).cookie;
      const s = await call("GET", "/admin/session", { cookie: boss });
      assert.equal(s.body.is_platform_admin, true, JSON.stringify(s.body)); assert.equal(s.body.role, "owner"); assert.equal(s.body.auth_provider, "builtin");
      assert.equal((await call("GET", "/api/admin/onboarding/orgs", { cookie: boss })).status, 200, "an environment admin reaches /api/admin");
      assert.equal((await call("POST", "/api/admin/onboarding/orgs", { cookie: boss }, { name: `x ${STAMP}` })).status, 403, "a cookie write without the CSRF header is refused");
      assert.equal((await call("GET", "/api/admin/onboarding/orgs", ownerA.h)).status, 403, "a workspace owner is no platform admin");
      // A platform role given on /admin/admins (stored on the person) works too.
      const add = await call("POST", "/api/admin/onboarding/admins", { cookie: boss, "x-app-admin": "1" }, { email: `support-${STAMP}@platform.example`, role: "support" });
      assert.ok(add.status === 200 || add.status === 201, JSON.stringify(add.body));
      const sup = (await codeSignIn(`support-${STAMP}@platform.example`)).cookie;
      assert.equal((await call("GET", "/admin/session", { cookie: sup })).body.role, "support");
      // MCP under the built-in sign-in: this server is the OAuth server (mold_v0-013, src/mcp-oauth.ts; scripts/mcp-oauth-test.ts).
      const prm = await call("GET", "/.well-known/oauth-protected-resource");
      assert.equal(prm.status, 200); assert.deepEqual(prm.body.authorization_servers, [process.env.PUBLIC_URL ?? "http://127.0.0.1:3333"], "this server is the authorization server");
      const bare = await fetch(`${http.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      assert.equal(bare.status, 401); assert.match(bare.headers.get("www-authenticate") ?? "", /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/, "the 401 sends clients to sign in");
      ok("platform admins: an APP_PLATFORM_ADMINS address and a person given a role on /admin/admins sign in with a code and reach /admin; cookie writes need the CSRF header");
    }
  } else {
    // ---------- Clerk: the built-in routes stay out of the way ----------
    assert.deepEqual((await call("GET", "/api/auth/config")).body, { provider: "clerk", accounts: "invite_only" });
    for (const p of ["/api/auth/session", "/api/auth/google/start"]) assert.equal((await call("GET", p)).status, 404, p);
    assert.equal((await call("POST", "/api/auth/email/request", {}, { email: ownerAEmail })).status, 404);
    assert.equal(emailsTo(ownerAEmail, "sign_in_code").length, 0);
    assert.equal(emailsTo(ownerAEmail, "invitation").length, 0, "Clerk sends its own invitations");
    const s = await call("GET", "/admin/session");
    assert.equal(s.body.auth_provider, undefined, "Clerk's /admin/session is as it was");
    ok("Clerk: the built-in routes answer 404 (only /api/auth/config, which names Clerk); no code or invitation email is sent by the shell");
  }

  await http.close();
  console.log(`\nSIGN-IN TEST PASS (${PROVIDER}): ${n} groups`);
} finally {
  cleanup();
}
process.exit(0);
