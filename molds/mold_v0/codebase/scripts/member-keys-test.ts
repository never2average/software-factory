// Per-member MCP keys (mold_v0-007; src/member-keys.ts, src/auth.ts resolveKey, sql/migrations/0013_member_keys.sql),
// offline: an embedded database, a fake Clerk, the declarative fixture packs, two workspaces, over HTTP.
//   npm run test:member-keys
//
// 1. A signed-in person makes, names and lists their keys; the value is answered once (with each client's setup, the
//    key in a header, never in a URL) and only its sha256 is stored; names and expiries are checked.
// 2. A member key works in a header (Authorization or X-API-Key) and is refused in a URL (/mcp/<key>).
// 3. It acts with its person's role: a viewer's key is offered no write and a write is refused when called; a role
//    change holds on the next call; a removed or suspended member's keys stop working.
// 4. Revoked or expired: refused on the next call.
// 5. Workspace A's key never reaches B: its calls act in A only, B's keys and records are not A's to list or revoke.
// 6. Owners see every key of the workspace (older ones included) and revoke any; a member only their own.
// 7. Existing keys keep working: the account's key (header, and the deprecated URL), an older person key.
// 8. Limits: per member across all their keys, the key-creation limit per workspace; the CSRF header on cookie writes.
// 9. Off (mold_v0-099, profile member_keys: false): /api/keys refuses everything with a sentence saying to sign in; a
//    key made before is refused on /mcp, saying why; the account's own key still works; on again, the key works again.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, startHttp, STAMP, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.OCTILLION_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
const fixture = (id: string) => JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", id, "pack.json"), "utf8"));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** The person and Clerk organization a (mock) session token names. */
const claims = (tok: string) => JSON.parse(Buffer.from(tok.split(".")[1]!, "base64url").toString()) as { sub: string; o?: { id: string } };

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg, createApiKey } = await import("../src/auth.js");
  const clerk = await import("../src/clerk.js");
  const declared = (id: string) => {
    const j = fixture(id);
    return { manifest: { id, name: j.name, version: j.version, entry: null, migrations: null, words: j.words ?? {}, dir: path.join(ROOT, "scripts", "fixtures", "packs", id) },
      declared: compileDeclarations(j) };
  };
  setPacksForTest([declared("fixture_tracker"), declared("fixture_review")]);
  const A = await createOrg(`Keys A ${STAMP}`), B = await createOrg(`Keys B ${STAMP}`);
  const http = await startHttp();
  const call = async (method: string, p: string, tok: string | null, body?: unknown, h: Record<string, string> = {}) => {
    const r = await http.req(method, p, { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...h }, body);
    const t = await r.text();
    let json: any = null;
    try { json = t ? JSON.parse(t) : null; } catch { json = t; }
    return { status: r.status, body: json, headers: r.headers };
  };
  /** One JSON-RPC request to /mcp with these headers (or to /mcp/<key>). */
  let rid = 0;
  const rpc = async (headers: Record<string, string>, method: string, params: unknown = {}, p = "/mcp") => {
    const r = await fetch(`${http.base}${p}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }) });
    const t = await r.text();
    const line = t.split("\n").find((l) => l.startsWith("data: "));
    let body: any = null;
    try { body = JSON.parse(line ? line.slice(6) : t); } catch { body = t; }
    return { status: r.status, body };
  };
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
  const tools = async (key: string) => ((await rpc(bearer(key), "tools/list")).body?.result?.tools ?? []).map((t: { name: string }) => t.name) as string[];
  const tool = (key: string, name: string, args: Record<string, unknown> = {}, h = bearer(key)) => rpc(h, "tools/call", { name, arguments: args });
  const okCall = (r: { status: number; body: any }) => r.status === 200 && r.body?.result && !r.body.result.isError;

  const memberA = await http.signIn(A.org), viewerA = await http.signIn(A.org, "viewer"), ownerA = await http.signIn(A.org, "owner");
  const memberB = await http.signIn(B.org), ownerB = await http.signIn(B.org, "owner");
  const make = async (tok: string, body: unknown = { name: "Cursor on my laptop" }) => call("POST", "/api/keys", tok, body);

  // ---------- 1. create, name, list; shown once, hash only ----------
  let keyM = "", idM = 0;
  {
    const r = await make(memberA, { name: "  Cursor\u202e on <my> laptop  ", expires_in_days: 30 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    keyM = r.body.key; idM = r.body.id;
    assert.match(keyM, /^oct_[A-Za-z0-9_-]{32}$/, "a key of the shell's form");
    assert.equal(r.body.name, "Cursor on my laptop", "the name is one line of plain text");
    assert.equal(r.body.kind, "member"); assert.equal(r.body.state, "active");
    const days = (Date.parse(r.body.expires_at) - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days <= 30, `it expires in 30 days: ${days}`);
    assert.equal(r.headers.get("cache-control"), "no-store");
    // Its setup: every client the profile offers, the key only in a header, never in an address.
    const setup = r.body.setup;
    for (const id of ["claude", "chatgpt", "claude-code", "cursor", "vscode", "windsurf", "codex", "gemini-cli"]) assert.ok(setup.clients.some((c: any) => c.id === id), `setup for ${id}`);
    for (const c of setup.clients) {
      if (c.auth === "token") assert.ok(`${c.command ?? ""}${c.snippet ?? ""}`.includes(keyM), `${c.id}: its snippet carries the key`);
      for (const u of `${c.command ?? ""} ${c.snippet ?? ""} ${c.steps}`.match(/(https?|cursor|vscode):\/\/[^\s"'\\]+/g) ?? []) assert.ok(!u.includes(keyM) && !u.includes("oct_"), `${c.id}: no key in an address: ${u}`);
    }
    assert.equal(setup.clients.find((c: any) => c.id === "claude").auth, "oauth", "Claude's app signs in (it cannot send a header)");
    // Only the hash is stored, nowhere the key.
    const [row] = await db.query<{ key_hash: string; scoped: boolean; user_id: string; label: string }>("SELECT key_hash, scoped, user_id, label FROM api_keys WHERE id = $1", [idM]);
    assert.equal(row!.key_hash, sha256(keyM)); assert.equal(row!.scoped, true); assert.equal(row!.user_id, claims(memberA).sub);
    assert.ok(!JSON.stringify(await db.query("SELECT * FROM api_keys")).includes(keyM), "the key itself is in no row");
    const list = await call("GET", "/api/keys", memberA);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.keys.map((k: any) => k.id), [idM], "the member lists their own key");
    assert.ok(!JSON.stringify(list.body).includes(keyM), "never its value again");
    assert.equal(list.body.can_manage_all, false); assert.equal(list.body.all, undefined, "a member sees only their own");
    for (const [what, body] of [["no name", { name: " " }], ["an expiry not offered", { name: "x", expires_in_days: 3650 }], ["no expiry at all", { name: "x", expires_in_days: 0 }]] as const) {
      const bad = await make(memberA, body);
      assert.equal(bad.status, 400, `${what} is refused: ${JSON.stringify(bad.body)}`);
    }
    assert.equal((await call("POST", "/api/keys", null, { name: "x" })).status, 401, "signed out: no key");
    console.log("✓ a member makes, names and lists their own keys; the value is answered once with each client's header setup; only its hash is stored");
  }

  // ---------- 2. header only ----------
  {
    const listed = await tools(keyM);
    assert.ok(listed.includes("review_create_review_items"), "Authorization: Bearer works");
    const viaX = await rpc({ "x-api-key": keyM }, "tools/list");
    assert.equal(viaX.status, 200, "X-API-Key works");
    const inUrl = await rpc({}, "tools/list", {}, `/mcp/${keyM}`);
    assert.equal(inUrl.status, 401, `a member key in the address is refused: ${inUrl.status}`);
    console.log("✓ a member key works in a header only (Authorization or X-API-Key), never in the address");
  }

  // ---------- 3. scoped to the member's role ----------
  {
    const v = await make(viewerA, { name: "viewer's key" });
    assert.equal(v.status, 201, "a viewer makes a key too");
    const vt = await tools(v.body.key);
    assert.ok(vt.includes("review_list_review_items") && !vt.includes("review_create_review_items") && !vt.includes("review_start_review_pass"), `a viewer's key is offered no write: ${vt.filter((x) => x.startsWith("review_"))}`);
    const write = await tool(v.body.key, "review_create_review_items", { key: "item-v", data: { url: "https://v.example" } });
    assert.ok(!okCall(write), `a viewer's key cannot write even when it calls the tool by name: ${JSON.stringify(write.body).slice(0, 200)}`);
    assert.ok(!okCall(await tool(v.body.key, "save_to_memory", { body: "x" })), "nor through a shell tool that writes");
    assert.equal((await db.query("SELECT 1 FROM workspace_records WHERE key = 'item-v'")).length, 0, "nothing was written");
    // The member's key writes.
    assert.ok(okCall(await tool(keyM, "review_create_review_items", { key: "item-a", data: { url: "https://a.example" } })), "a member's key writes");
    // A role change holds on the next call: the viewer becomes a member.
    const { sub: viewerUser, o } = claims(viewerA);
    await clerk.memberships.setRole(o!.id, viewerUser, "member", { octillion_role: "member" });
    assert.ok((await tools(v.body.key)).includes("review_create_review_items"), "after the role change the key may write");
    await clerk.memberships.setRole(o!.id, viewerUser, "member", { octillion_role: "viewer" });
    assert.ok(!(await tools(v.body.key)).includes("review_create_review_items"), "and back");
    // Suspended, then removed: the person's keys stop working.
    await clerk.memberships.setSuspended(o!.id, viewerUser, true);
    assert.equal((await rpc(bearer(v.body.key), "tools/list")).status, 401, "a suspended member's key is refused");
    await clerk.memberships.setSuspended(o!.id, viewerUser, false);
    assert.equal((await rpc(bearer(v.body.key), "tools/list")).status, 200, "restored");
    await clerk.memberships.remove(o!.id, viewerUser);
    assert.equal((await rpc(bearer(v.body.key), "tools/list")).status, 401, "a removed member's key is refused");
    console.log("✓ a member key acts with its person's current role: a viewer's key cannot write; role changes, suspension and removal hold on the next call");
  }

  // ---------- 4. revoked or expired ----------
  {
    const r = await make(memberA, { name: "to revoke" });
    assert.equal((await rpc(bearer(r.body.key), "tools/list")).status, 200);
    const rv = await call("POST", `/api/keys/${r.body.id}/revoke`, memberA, {});
    assert.equal(rv.status, 200); assert.equal(rv.body.key.state, "revoked");
    assert.equal((await rpc(bearer(r.body.key), "tools/list")).status, 401, "revoked: refused on the next call");
    assert.equal((await call("POST", `/api/keys/${r.body.id}/revoke`, memberA, {})).status, 409, "revoked once");
    const e = await make(memberA, { name: "to expire", expires_in_days: 7 });
    assert.equal((await rpc(bearer(e.body.key), "tools/list")).status, 200);
    await db.query("UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE id = $1", [e.body.id]);
    assert.equal((await rpc(bearer(e.body.key), "tools/list")).status, 401, "expired: refused on the next call");
    assert.equal((await call("GET", "/api/keys", memberA)).body.keys.find((k: any) => k.id === e.body.id).state, "expired");
    console.log("✓ a revoked or expired key is refused on the next call");
  }

  // ---------- 5. A's key never reaches B ----------
  {
    const kB = await make(memberB, { name: "B's key" });
    assert.ok(okCall(await tool(kB.body.key, "review_create_review_items", { key: "item-b", data: { url: "https://b.example" } })));
    const listedA = await tool(keyM, "review_list_review_items", {});
    const keysA = (listedA.body.result.structuredContent.records as { key: string }[]).map((x) => x.key);
    assert.ok(keysA.includes("item-a") && !keysA.includes("item-b"), `A's key lists A's records only: ${keysA}`);
    assert.ok(!okCall(await tool(keyM, "review_get_review_items", { key: "item-b" })), "and cannot read B's by key");
    assert.equal((await call("POST", `/api/keys/${kB.body.id}/revoke`, ownerA, {})).status, 404, "A's owner cannot revoke B's key");
    assert.ok(!(await call("GET", "/api/keys", ownerA)).body.all.some((k: any) => k.id === kB.body.id), "nor sees it");
    assert.ok(!(await call("GET", "/api/keys", ownerB)).body.all.some((k: any) => k.id === idM), "B's owner does not see A's");
    await new Promise((r) => setTimeout(r, 300));
    const ev = await db.query<{ org_id: number; key_id: number; user_id: string }>("SELECT org_id, key_id, user_id FROM mcp_events WHERE key_id = $1", [idM]);
    assert.ok(ev.length && ev.every((x) => x.org_id === A.org.orgId && x.user_id === claims(memberA).sub), "A's key's calls are A's, as its member");
    console.log("✓ workspace A's key reaches only A: its records, its usage; B's keys are not A's to see or revoke");
  }

  // ---------- 6. owners see and revoke every key; members only their own ----------
  let accountKeyId = 0;
  {
    const [acct] = await db.query<{ id: number }>("SELECT id FROM api_keys WHERE org_id = $1 AND user_id IS NULL", [A.org.orgId]);
    accountKeyId = acct!.id;
    const all = (await call("GET", "/api/keys", ownerA)).body;
    assert.equal(all.can_manage_all, true);
    const kinds = new Map(all.all.map((k: any) => [k.id, k]));
    assert.equal((kinds.get(accountKeyId) as any).kind, "account", "the workspace's own key is listed");
    assert.equal((kinds.get(idM) as any).kind, "member"); assert.notEqual((kinds.get(idM) as any).owner_label, undefined);
    const other = await make(memberA, { name: "second" });
    assert.equal((await call("POST", `/api/keys/${accountKeyId}/revoke`, memberA, {})).status, 404, "a member cannot revoke the workspace's key");
    const ownersKey = await make(ownerA, { name: "owner's" });
    assert.equal((await call("POST", `/api/keys/${ownersKey.body.id}/revoke`, memberA, {})).status, 404, "nor another person's");
    assert.equal((await call("POST", `/api/keys/${other.body.id}/revoke`, ownerA, {})).status, 200, "an owner revokes a member's key");
    assert.equal((await rpc(bearer(other.body.key), "tools/list")).status, 401);
    const [by] = await db.query<{ revoked_by: string }>("SELECT revoked_by FROM api_keys WHERE id = $1", [other.body.id]);
    assert.equal(by!.revoked_by, `owner:${claims(ownerA).sub}`, "who revoked it is kept");
    console.log("✓ owners see every key of the workspace (the older ones too) and revoke any; a member revokes only their own");
  }

  // ---------- 7. existing keys keep working ----------
  {
    assert.equal((await rpc(bearer(A.key), "tools/list")).status, 200, "the workspace's own key, in a header");
    assert.equal((await rpc({}, "tools/list", {}, `/mcp/${A.key}`)).status, 200, "and in the deprecated address, as before");
    assert.ok((await tools(A.key)).includes("review_create_review_items"), "with no role limits, as before");
    const older = await createApiKey(A.org.orgId, "someone@example.org", claims(memberA).sub);
    assert.equal((await rpc(bearer(older), "tools/list")).status, 200, "an older person key works as before");
    console.log("✓ existing keys keep working unchanged: the workspace's own (header and the deprecated URL) and older person keys");
  }

  // ---------- 8. limits and CSRF ----------
  {
    // A fresh member (the counts are per minute), with two keys.
    const fresh = await http.signIn(A.org);
    const k1 = await make(fresh, { name: "one" }), k2 = await make(fresh, { name: "two" });
    process.env.OCTILLION_LIMIT_MCP_PER_MEMBER_PER_MINUTE = "3";
    try {
      const statuses: number[] = [];
      for (const k of [k1.body.key, k2.body.key, k1.body.key, k2.body.key]) statuses.push((await rpc(bearer(k), "tools/list")).status);
      assert.deepEqual(statuses, [200, 200, 200, 429], `the member's limit counts all their keys together: ${statuses}`);
      const other = await make(ownerA, { name: "owner's other" });
      assert.equal((await rpc(bearer(other.body.key), "tools/list")).status, 200, "another member is not limited by it");
    } finally { delete process.env.OCTILLION_LIMIT_MCP_PER_MEMBER_PER_MINUTE; }
    process.env.OCTILLION_LIMIT_ENDPOINTS_KEYS_PER_HOUR_PER_WORKSPACE = "1";
    try {
      const someone = await http.signIn(B.org, "viewer");
      for (let i = 0; i < 3; i++) assert.equal((await make(someone, { name: " " })).status, 400, "a refused request does not count");
      assert.equal((await make(someone, { name: "first" })).status, 201);
      const r = await make(someone, { name: "over" });
      assert.equal(r.status, 429, `key creation is limited per person: ${r.status}`);
      // A member using up their count does not stop staff issuing the workspace's keys (its own bucket).
      const staff = await http.adminToken("owner");
      const issued = await call("POST", `/api/admin/onboarding/orgs/${B.org.slug}/keys`, staff, { label: "emergency" });
      assert.equal(issued.status, 201, `staff still issue a key: ${issued.status} ${JSON.stringify(issued.body).slice(0, 200)}`);
    } finally { delete process.env.OCTILLION_LIMIT_ENDPOINTS_KEYS_PER_HOUR_PER_WORKSPACE; }
    // Staff cannot rotate a member key into an unscoped one; they revoke it, and who did is kept.
    const staff = await http.adminToken("owner");
    const mk = await make(ownerB, { name: "leaked" });
    const rot = await call("POST", `/api/admin/onboarding/orgs/${B.org.slug}/keys/${mk.body.id}/rotate`, staff, {});
    assert.equal(rot.status, 409, `a member key is not rotated by staff: ${rot.status}`);
    assert.equal((await db.query("SELECT 1 FROM api_keys WHERE org_id = $1 AND scoped = false AND user_id = $2", [B.org.orgId, claims(ownerB).sub])).length, 0, "no unscoped copy was made");
    assert.equal((await call("POST", `/api/admin/onboarding/orgs/${B.org.slug}/keys/${mk.body.id}/revoke`, staff, {})).status, 204);
    assert.equal((await rpc(bearer(mk.body.key), "tools/list")).status, 401, "revoked by staff: refused");
    assert.match((await db.query<{ revoked_by: string }>("SELECT revoked_by FROM api_keys WHERE id = $1", [mk.body.id]))[0]!.revoked_by, /^staff:/);
    const viaCookie = await http.req("POST", "/api/keys", { cookie: `__session=${memberA}` }, { name: "csrf" });
    assert.equal(viaCookie.status, 403, "a cookie-borne change needs the X-Pack-Request header");
    const withHeader = await http.req("POST", "/api/keys", { cookie: `__session=${memberA}`, "x-pack-request": "1" }, { name: "csrf ok" });
    assert.equal(withHeader.status, 201, "with it, the change goes through");
    console.log("✓ the member's rate limit counts all their keys; key creation is limited per person apart from staff's; staff revoke (never rotate) a member key; cookie writes need the CSRF header");
  }
  // ---------- 9. member keys off ----------
  {
    const { setMemberKeysForTest } = await import("../src/profile.js");
    const someone = await http.signIn(A.org);
    const made = await make(someone, { name: "before the switch" });
    assert.equal(made.status, 201);
    assert.equal((await rpc(bearer(made.body.key), "tools/list")).status, 200, "it works while keys are on");
    setMemberKeysForTest(false);
    try {
      for (const [m, p, body] of [["GET", "/api/keys", undefined], ["POST", "/api/keys", { name: "after" }], ["POST", `/api/keys/${made.body.id}/revoke`, {}]] as const) {
        const r = await call(m, p, someone, body);
        assert.equal(r.status, 403, `${m} ${p} is refused: ${r.status}`);
        assert.equal(r.body.code, "member_keys_off");
        assert.match(r.body.error, /API keys are turned off .*sign in/, "it says how to connect instead");
      }
      assert.equal((await call("POST", "/api/keys", null, { name: "x" })).status, 401, "signed out: still a sign-in answer first");
      const refused = await rpc(bearer(made.body.key), "tools/list");
      assert.equal(refused.status, 401, `a key made before is refused: ${refused.status}`);
      assert.equal(refused.body.error.data.reason, "member_keys_off");
      assert.match(refused.body.error.message, /API keys are turned off .* This key no longer works\./, "the client is told why");
      const unknown = await rpc(bearer("oct_" + "x".repeat(32)), "tools/list");
      assert.equal(unknown.status, 401);
      assert.ok(!/API key/.test(unknown.body.error.message), `the plain refusal names sign-in only: ${unknown.body.error.message}`);
      assert.equal((await rpc(bearer(A.key), "tools/list")).status, 200, "the account's own key (staff issued) is not a member key and still works");
      assert.equal((await db.query("SELECT 1 FROM api_keys WHERE label = 'after'")).length, 0, "nothing was made");
    } finally { setMemberKeysForTest(null); }
    assert.equal((await rpc(bearer(made.body.key), "tools/list")).status, 200, "on again: the key that was not revoked or expired works again");
    console.log("✓ member keys off: /api/keys refuses (403, member_keys_off) with how to connect instead; a key made before is refused on /mcp saying why; the account's key works; on again, as before");
  }
  await http.close();
  console.log("member-keys: all checks passed");
  process.exit(0);
} finally {
  cleanup();
}
