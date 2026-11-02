// The developer surface of an embedded app (mold_v0-193; src/developer-*.ts), offline: an embedded database, a fake
// Clerk, local webhook receivers.
//   npm run test:developer-surface
//
//  1. Off (zero packs, and every kind: tool build): /v1, /openapi.json and /api/developer answer nothing of ours, the
//     MCP surface is the shell's, no record change queues anything.
//  2. The declaration: build checks (unknown events, areas, fields, pointers, scopes, languages); the guide's
//     Developers pages pass the guide's rules; the OpenAPI document is 3.1 with each area's typed paths and the events.
//  3. Keys: an owner makes them (shown once, prefix, scopes, expiry), a member cannot; integration keys hold one scope;
//     rotation keeps the old key for its grace; revoked and expired keys are refused; a key is refused on /mcp.
//  4. Scopes, X-Scope narrowing, X-Actor (on the audit hook and in the events), API-Version, problem+json, cursor
//     pages, rate limits per key, the lifecycle, runs, two workspaces kept apart.
//  5. Idempotency-Key: the same request answers the same (Idempotent-Replayed), another request with the key is 422.
//  6. Client sessions: minted with a key holding sessions, never beyond the app's or the key's scopes, ttl capped; CORS
//     for allowed origins only (the app's and the workspace's), a key from a browser refused, preflights.
//  7. Webhooks out: signed deliveries (Standard Webhooks), events filtered per endpoint and area, the sealed rule, a
//     batch rolled back sends nothing, test ping, retries with backoff and the delivery log, disable after repeated
//     failure and enable, the secret's audited reveal and rotation (two signatures), run.finished from the runs table.
//  8. Webhooks in: a signed payload written into the receiver's area (each item), once per webhook-id; a bad signature,
//     an old timestamp and another type refused or skipped.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { cleanup, connect, STAMP, startHttp } from "./lib/test-world.js";
import { installEmbedded } from "./lib/embedded-fixture.js";

process.env.APP_PREVIEW = "1"; // local webhook receivers and origins (a preview server's rule)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A local webhook receiver: records each request (headers, raw body); answers `status()`. */
async function receiver(status: () => number = () => 200) {
  const got: { headers: IncomingMessage["headers"]; body: string; at: number }[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { got.push({ headers: req.headers, body: b, at: Date.now() }); res.writeHead(status()).end("ok"); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`, got, close: () => srv.close() };
}

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const { createOrg } = await import("../src/auth.js");
  const TOOL_NAMES = (await import("../src/server.js")).ownToolNames();
  const { developerApiRouter } = await import("../src/developer-api.js");
  const { developerAppRouter } = await import("../src/developer-routes.js");
  const hooks = await import("../src/developer-webhooks.js");
  const cfgMod = await import("../src/developer-config.js");
  const { setPlatformAuditSink } = await import("../src/developer-audit.js");

  // ---------- 1. off ----------
  {
    await installEmbedded(null);
    assert.equal((developerApiRouter() as unknown as { stack: unknown[] }).stack.length, 0, "no /v1 or /openapi.json with zero packs");
    assert.equal((developerAppRouter() as unknown as { stack: unknown[] }).stack.length, 0, "no /api/developer with zero packs");
    const c = await connect((await createOrg(`Dev zero ${STAMP}`)).org);
    assert.deepEqual((await c.client.listTools()).tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort(), "the MCP surface is the shell's");
    await c.close();
    assert.deepEqual(await hooks.webhookTick(), null, "the tick does nothing");
    // A tool build with record areas (the fixture without its developer surface): still nothing, and a write queues nothing.
    const json = await installEmbedded((j) => { delete j.developer_surface; });
    assert.ok(json);
    assert.equal((developerApiRouter() as unknown as { stack: unknown[] }).stack.length, 0, "no /v1 in a tool build with areas");
    const T = (await createOrg(`Dev tool ${STAMP}`)).org;
    const { workspaceRecords } = await import("../src/record-areas.js");
    const { withTenant } = await import("../src/tenant-scope.js");
    await withTenant(T.orgId, () => workspaceRecords("fixture_embedded", T.orgId).create("tickets", "t-1", { data: { summary: "x" } }));
    assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_deliveries"))[0]!.n, 0, "nothing queued");
    const http0 = await startHttp();
    try {
      for (const p of ["/openapi.json", "/v1/areas", "/api/developer/keys"]) {
        const r = await http0.req("GET", p, { authorization: "Bearer sk_x", accept: "application/json" });
        assert.ok(r.status === 404 || r.status === 401, `${p}: not ours (${r.status})`);
        assert.ok(!(r.headers.get("content-type") ?? "").includes("problem+json"), `${p}: no developer API answered`);
      }
    } finally { await http0.close(); }
    console.log("✓ off: zero packs and a tool build mount nothing, list the shell's MCP tools, queue nothing");
  }

  // ---------- 2. the declaration ----------
  {
    const areas = [{ name: "tickets", scope: "workspace", fields: ["summary", "state"] }, { name: "shared", scope: "platform", fields: ["a"] }];
    const base = { events: [{ name: "record.created", description: "x" }], sdk_languages: ["typescript"], client_sessions: { ttl_seconds: 60, allowed_origins: ["https://app.example.com"] } };
    assert.deepEqual(cfgMod.developerSurfaceProblems(base, areas), []);
    const bad = cfgMod.developerSurfaceProblems({ ...base, events: [{ name: "record.exploded", description: "x" }, { name: "run.finished", description: "x", areas: ["tickets"] }],
      sdk_languages: ["cobol"], client_sessions: { ttl_seconds: 60, allowed_origins: ["http://app.example.com"], scopes: ["webhooks"] },
      webhooks_in: [{ name: "x", area: "shared", key: "id", fields: { nope: "/a" } }], api_version: "1999-01-01" }, areas);
    for (const want of [/record.exploded is not an event/, /only a record event names areas/, /cobol/, /https origin/, /webhooks is not a scope a client session/, /shared \(platform\) area/,
      /key: id is not a JSON Pointer/, /fields.nope: not a field/, /api_version/]) assert.ok(bad.some((b) => want.test(b)), `refused: ${want} (${bad.join(" | ")})`);
    const { checkPackJson } = await import("../src/pack-manifest.js");
    const { embeddedJson } = await import("./lib/embedded-fixture.js");
    assert.doesNotThrow(() => checkPackJson(embeddedJson()), "the fixture's pack.json passes the pack schema");
    assert.throws(() => checkPackJson({ ...embeddedJson(), developer_surface: { ...embeddedJson().developer_surface, events: [{ name: "nope.x", description: "x" }] } }), /developer_surface.events/);
    await installEmbedded();
    const { developerGuidePages } = await import("../src/developer-docs.js");
    const { pageProblems } = await import("../src/pack-guide.js");
    const { recordAreas } = await import("../src/record-areas.js");
    const { developerSurface } = await import("../src/developer-surface.js");
    const pages = developerGuidePages(developerSurface()!, recordAreas() as never, [{ name: "triage" }], cfgMod.LATEST_API_VERSION);
    assert.deepEqual(pages.map((p) => p.title), ["API overview", "Records and runs API", "Client sessions", "Webhooks", "Webhooks in", "SDKs"]);
    for (const p of pages) assert.deepEqual(pageProblems(p.body, p.title), [], `${p.title}: a guide page by the guide's rules`);
    const { openApiDocument } = await import("../src/developer-openapi.js");
    const doc = openApiDocument("https://api.example.com") as any;
    assert.equal(doc.openapi, "3.1.0");
    for (const p of ["/v1/records/tickets", "/v1/records/tickets/{key}", "/v1/records/tickets/{key}/move", "/v1/records/findings", "/v1/runs", "/v1/client_sessions", "/v1/webhook_endpoints", "/v1/inbound/{id}"])
      assert.ok(doc.paths[p], `the document has ${p}`);
    assert.deepEqual(doc.components.schemas.TicketsData.properties.severity.enum, ["low", "medium", "high"], "enums typed");
    assert.deepEqual(doc.paths["/v1/records/tickets/{key}/move"].post.requestBody.content["application/json"].schema.properties.to.enum, ["open", "in_progress", "closed"], "lifecycle states");
    assert.deepEqual(Object.keys(doc.webhooks).sort(), ["record.created", "record.deleted", "record.state_changed", "record.updated", "run.finished", "webhook.test"]);
    assert.ok(Object.values<any>(doc.paths).every((item) => Object.values<any>(item).every((op) => op.operationId && op.responses.default)), "every operation has an id and a problem answer");
    console.log("✓ the declaration: build checks refuse what does not fit; the Developers pages pass the guide's rules; the OpenAPI 3.1 document types each area and lists the events");
  }

  // ---------- 3-8 over HTTP ----------
  const A = (await createOrg(`Dev A ${STAMP}`)).org, B = (await createOrg(`Dev B ${STAMP}`)).org;
  const http = await startHttp();
  const audit: any[] = [];
  setPlatformAuditSink((e) => void audit.push(e));
  try {
    const ownerA = await http.signIn(A, "owner"), memberA = await http.signIn(A, "member"), ownerB = await http.signIn(B, "owner");
    const call = async (method: string, p: string, tok: string | null, body?: unknown, h: Record<string, string> = {}) => {
      const r = await http.req(method, p, { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...h }, body);
      const text = await r.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: r.status, json, headers: r.headers };
    };
    const consoleCall = (method: string, p: string, tok: string, body?: unknown) => call(method, `/api/developer${p}`, tok, body, method === "GET" ? {} : { "x-pack-request": "1" });

    // ---------- 3. keys ----------
    const made = await consoleCall("POST", "/keys", ownerA, { name: "Backend", expires_in_days: 30 });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const KEY = made.json.key as string;
    assert.match(KEY, /^sk_[A-Za-z0-9_-]{40,}$/);
    assert.equal(made.json.data.key_prefix, KEY.slice(0, 9));
    assert.deepEqual(made.json.data.scopes, ["read", "write", "run", "sessions", "webhooks"], "a secret key holds every scope by default");
    assert.equal((await consoleCall("POST", "/keys", memberA, { name: "Mine" })).status, 403, "a member cannot make keys");
    const listed = await consoleCall("GET", "/keys", memberA);
    assert.equal(listed.status, 200);
    assert.ok(!JSON.stringify(listed.json).includes(KEY) && !JSON.stringify(listed.json).includes(KEY.slice(12)), "a key is never shown again");
    assert.equal((await consoleCall("POST", "/keys", ownerA, { name: "Two", kind: "integration", scopes: ["read", "write"] })).status, 400, "an integration key holds one scope");
    assert.equal((await consoleCall("POST", "/keys", ownerA, { name: "Bad", scopes: ["read:nowhere"] })).status, 400, "a scope narrowed to an unknown area");
    const integ = await consoleCall("POST", "/keys", ownerA, { name: "Ticket reader", kind: "integration", scopes: ["read:tickets"] });
    assert.equal(integ.status, 201);
    const READER = integ.json.key as string;
    const keyB = (await consoleCall("POST", "/keys", ownerB, { name: "B backend" })).json.key as string;
    assert.equal((await call("POST", "/mcp", KEY, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { accept: "application/json, text/event-stream" })).status, 401, "a developer key is no MCP key");
    console.log("✓ keys: an owner makes them (shown once, a prefix, scopes, an expiry); a member cannot; integration keys hold one scope; refused on /mcp");

    // ---------- 4. the API ----------
    const none = await call("GET", "/v1/areas", null);
    assert.equal(none.status, 401);
    assert.match(none.headers.get("content-type") ?? "", /application\/problem\+json/);
    assert.equal(none.json.code, "unauthenticated");
    assert.equal(none.json.type, "/problems/unauthenticated");
    assert.match(none.json.request_id, /^req_/);
    assert.equal((await call("GET", "/v1/areas", "sk_unknown")).status, 401);
    const areas = await call("GET", "/v1/areas", KEY);
    assert.equal(areas.status, 200);
    assert.equal(areas.headers.get("api-version"), cfgMod.LATEST_API_VERSION, "the answer names its version");
    assert.deepEqual(areas.json.data.map((a: any) => a.name).sort(), ["findings", "tickets"]);
    assert.equal((await call("GET", "/v1/areas", KEY, undefined, { "api-version": "1999-01-01" })).json.code, "unsupported_api_version");
    // Writes, the lifecycle, pages.
    for (let i = 1; i <= 5; i++) assert.equal((await call("POST", "/v1/records/tickets", KEY, { key: `T-${i}`, title: `Ticket ${i}`, data: { summary: `S${i}`, severity: "low", points: i } }, { "x-actor": "user-1" })).status, 201);
    assert.equal((await call("POST", "/v1/records/tickets", KEY, { key: "T-1", data: { summary: "again" } })).json.code, "conflict", "a key that exists is a 409 problem");
    assert.equal((await call("POST", "/v1/records/tickets", KEY, { key: "T-9", data: { severity: "huge" } })).status, 400, "the record store's rules hold");
    const seen: string[] = [];
    let after: string | null = null;
    do {
      const pg: any = await call("GET", `/v1/records/tickets?limit=2${after ? `&after=${encodeURIComponent(after)}` : ""}`, KEY);
      assert.equal(pg.status, 200);
      assert.ok(pg.json.data.length <= 2);
      seen.push(...pg.json.data.map((r: any) => r.key));
      after = pg.json.next;
    } while (after);
    assert.deepEqual(seen, ["T-1", "T-2", "T-3", "T-4", "T-5"], "cursor pages walk every record once");
    const moved = await call("POST", "/v1/records/tickets/T-1/move", KEY, { to: "in_progress" });
    assert.equal(moved.json.data.data.state, "in_progress");
    assert.equal((await call("POST", "/v1/records/tickets/T-1/move", KEY, { to: "open" })).status, 409, "the lifecycle holds");
    assert.equal((await call("DELETE", "/v1/records/tickets/T-5", KEY)).status, 204);
    assert.equal((await call("GET", "/v1/records/tickets/T-5", KEY)).status, 404);
    // Scopes and narrowing.
    assert.equal((await call("GET", "/v1/records/tickets", READER)).status, 200, "read:tickets reads tickets");
    const noFind = await call("GET", "/v1/records/findings", READER);
    assert.equal(noFind.status, 403);
    assert.equal(noFind.json.code, "insufficient_scope");
    assert.equal((await call("POST", "/v1/records/tickets", READER, { key: "R-1", data: { summary: "x" } })).status, 403, "an integration key with read cannot write");
    assert.equal((await call("POST", "/v1/records/tickets", KEY, { key: "N-1", data: { summary: "x" } }, { "x-scope": "read" })).status, 403, "X-Scope narrows a request");
    assert.equal((await call("GET", "/v1/records/tickets", READER, undefined, { "x-scope": "read" })).status, 403, "X-Scope cannot widen");
    assert.equal((await call("GET", "/v1/records/tickets", KEY, undefined, { "x-actor": "bad actor!" })).status, 400);
    // Two workspaces.
    assert.equal((await call("GET", "/v1/records/tickets/T-1", keyB)).status, 404, "B's key never reaches A's records");
    assert.deepEqual((await call("GET", "/v1/records/tickets", keyB)).json.data, []);
    // Runs.
    const run = await call("POST", "/v1/runs", KEY, { kind: "triage", scope: {} }, { "x-actor": "user-2" });
    assert.equal(run.status, 201, JSON.stringify(run.json));
    assert.equal(run.json.data.status, "queued");
    assert.equal((await call("GET", `/v1/runs/${run.json.data.id}`, KEY)).json.data.id, run.json.data.id);
    assert.equal((await call("GET", "/v1/runs", KEY)).json.data[0].id, run.json.data.id);
    assert.equal((await call("GET", `/v1/runs/${run.json.data.id}`, keyB)).status, 404);
    assert.equal((await call("POST", "/v1/runs", READER, { kind: "triage" })).status, 403);
    // Audit hook: the actor, the scopes, the answer.
    await sleep(50);
    const posts = audit.filter((e) => e.action === "api.request" && e.target === "POST /v1/records/tickets" && e.status === 201);
    assert.ok(posts.length >= 5 && posts.every((e) => e.actor === `key:${KEY.slice(0, 9)} as user-1` && e.orgId === A.orgId), "each request on the audit hook with its asserted actor");
    // Rate limits per key.
    {
      const { limitsFor } = await import("../src/rate-limits.js");
      const was = process.env.APP_LIMIT_MCP_PER_KEY_PER_MINUTE;
      process.env.APP_LIMIT_MCP_PER_KEY_PER_MINUTE = "3";
      assert.equal(limitsFor(null).mcp.per_key_per_minute, 3);
      const k = (await consoleCall("POST", "/keys", ownerA, { name: "Limited" })).json.key;
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await call("GET", "/v1/areas", k)).status);
      assert.deepEqual(codes, [200, 200, 200, 429, 429], "the fourth request of the minute is refused");
      const r = await call("GET", "/v1/areas", k);
      assert.equal(r.json.code, "rate_limited");
      assert.ok(Number(r.headers.get("retry-after")) > 0, "with Retry-After");
      if (was === undefined) delete process.env.APP_LIMIT_MCP_PER_KEY_PER_MINUTE; else process.env.APP_LIMIT_MCP_PER_KEY_PER_MINUTE = was;
    }
    // Rotation, revocation, expiry.
    {
      const k = await consoleCall("POST", "/keys", ownerA, { name: "Rotating" });
      const rot = await consoleCall("POST", `/keys/${k.json.data.id}/rotate`, ownerA, { grace_hours: 1 });
      assert.equal(rot.status, 200);
      assert.equal((await call("GET", "/v1/areas", rot.json.key)).status, 200, "the new key works");
      assert.equal((await call("GET", "/v1/areas", k.json.key)).status, 200, "the old key works through its grace");
      assert.equal(rot.json.data.rotated_from, k.json.data.id);
      const rot0 = await consoleCall("POST", `/keys/${rot.json.data.id}/rotate`, ownerA, { grace_hours: 0 });
      assert.equal((await call("GET", "/v1/areas", rot.json.key)).status, 401, "grace 0: the old key stops at once");
      assert.equal((await consoleCall("POST", `/keys/${rot0.json.data.id}/revoke`, ownerA)).status, 200);
      assert.equal((await call("GET", "/v1/areas", rot0.json.key)).status, 401, "a revoked key is refused");
      await db.query("UPDATE developer_keys SET expires_at = now() - interval '1 second' WHERE id = $1", [k.json.data.id]);
      assert.equal((await call("GET", "/v1/areas", k.json.key)).status, 401, "an expired key is refused");
    }
    console.log("✓ the API: problem+json errors, versions, the record store's rules, cursor pages, the lifecycle, runs, scopes and X-Scope, two workspaces apart, the actor on the audit hook, rate limits per key, rotation, revocation, expiry");

    // ---------- 5. idempotency ----------
    {
      const h = { "idempotency-key": `idem-${STAMP}` };
      const one = await call("POST", "/v1/records/tickets", KEY, { key: "I-1", data: { summary: "once" } }, h);
      const two = await call("POST", "/v1/records/tickets", KEY, { key: "I-1", data: { summary: "once" } }, h);
      assert.equal(one.status, 201);
      assert.equal(two.status, 201, "the replay answers as the first did (not a 409)");
      assert.deepEqual(two.json, one.json);
      assert.equal(two.headers.get("idempotent-replayed"), "true");
      assert.equal(one.headers.get("idempotent-replayed"), null);
      const other = await call("POST", "/v1/records/tickets", KEY, { key: "I-2", data: { summary: "other" } }, h);
      assert.equal(other.status, 422);
      assert.equal(other.json.code, "idempotency_key_reused");
      assert.equal((await call("GET", "/v1/records/tickets/I-2", KEY)).status, 404, "nothing written for the reused key");
      // A refusal is the answer too: the same request with the key answers the same refusal.
      const ref1 = await call("POST", "/v1/records/tickets", KEY, { key: "T-1", data: { summary: "dup" } }, { "idempotency-key": `idem2-${STAMP}` });
      const ref2 = await call("POST", "/v1/records/tickets", KEY, { key: "T-1", data: { summary: "dup" } }, { "idempotency-key": `idem2-${STAMP}` });
      assert.equal(ref1.status, 409); assert.equal(ref2.status, 409); assert.equal(ref2.headers.get("idempotent-replayed"), "true");
      // Another key's Idempotency-Key space is its own.
      assert.equal((await call("POST", "/v1/records/tickets", keyB, { key: "I-1", data: { summary: "B's" } }, h)).status, 201);
      assert.equal((await call("POST", "/v1/records/tickets", KEY, { key: "I-3", data: { summary: "x" } }, { "idempotency-key": "has space" })).status, 400);
    }
    console.log("✓ Idempotency-Key: a replay answers the first answer, another request with the key is 422, per credential");

    // ---------- 6. client sessions and CORS ----------
    {
      const ORIGIN = "https://app.example.com";
      const mint = await call("POST", "/v1/client_sessions", KEY, { subject: "user-7", scopes: ["read"], ttl_seconds: 300 });
      assert.equal(mint.status, 201, JSON.stringify(mint.json));
      const CS = mint.json.data.token as string;
      assert.match(CS, /^cs_/);
      assert.ok(Date.parse(mint.json.data.expires_at) - Date.now() <= 300_000 + 5000);
      assert.equal((await call("POST", "/v1/client_sessions", KEY, { subject: "u", ttl_seconds: 3600 })).status, 400, "ttl capped at the app's (900)");
      assert.equal((await call("POST", "/v1/client_sessions", KEY, { subject: "u", scopes: ["run"] })).json.code, "scope_not_allowed", "never beyond the app's session scopes");
      assert.equal((await call("POST", "/v1/client_sessions", READER, { subject: "u", scopes: ["read"] })).status, 403, "the key must hold sessions");
      const sKey = (await consoleCall("POST", "/keys", ownerA, { name: "Sessions only", scopes: ["sessions", "read:tickets"] })).json.key;
      assert.equal((await call("POST", "/v1/client_sessions", sKey, { subject: "u", scopes: ["read"] })).json.code, "scope_not_held", "never beyond the minting key's scopes");
      assert.equal((await call("POST", "/v1/client_sessions", sKey, { subject: "u", scopes: ["read:tickets"] })).status, 201, "narrowed like its key");
      // From a browser at an allowed origin.
      const fromApp = await call("GET", "/v1/records/tickets", CS, undefined, { origin: ORIGIN });
      assert.equal(fromApp.status, 200);
      assert.equal(fromApp.headers.get("access-control-allow-origin"), ORIGIN);
      assert.equal((await call("POST", "/v1/records/tickets", CS, { key: "C-1", data: { summary: "x" } }, { origin: ORIGIN })).status, 403, "a read session cannot write");
      assert.equal((await call("GET", "/v1/records/tickets", CS, undefined, { origin: "https://evil.example.net" })).json.code, "origin_not_allowed");
      assert.equal((await call("GET", "/v1/records/tickets", KEY, undefined, { origin: ORIGIN })).json.code, "secret_key_in_browser", "a key from a browser is refused");
      assert.equal((await call("POST", "/v1/client_sessions", CS, { subject: "u" })).status, 403, "a session mints no session");
      assert.equal((await call("GET", "/v1/records/tickets", CS, undefined, { "x-actor": "someone" })).status, 403, "a session acts as its subject only");
      // The workspace's own origins.
      const OWN = "https://portal.example.org";
      assert.equal((await call("GET", "/v1/records/tickets", CS, undefined, { origin: OWN })).status, 403);
      assert.equal((await call("POST", "/v1/allowed_origins", KEY, { origin: OWN })).status, 200);
      assert.equal((await call("POST", "/v1/allowed_origins", KEY, { origin: "http://insecure.example.org" })).status, 400);
      assert.equal((await call("GET", "/v1/records/tickets", CS, undefined, { origin: OWN })).status, 200, "an origin the workspace added");
      const csB = (await call("POST", "/v1/client_sessions", keyB, { subject: "b" })).json.data.token;
      assert.equal((await call("GET", "/v1/records/tickets", csB, undefined, { origin: OWN })).status, 403, "another workspace's origin is not B's");
      const pre = await http.req("OPTIONS", "/v1/records/tickets", { origin: OWN, "access-control-request-method": "POST" });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers.get("access-control-allow-origin"), OWN);
      assert.match(pre.headers.get("access-control-allow-headers") ?? "", /Idempotency-Key/);
      assert.equal((await http.req("OPTIONS", "/v1/records/tickets", { origin: "https://evil.example.net" })).status, 403);
      // Revoked: refused.
      assert.equal((await call("DELETE", `/v1/client_sessions/${mint.json.data.id}`, KEY)).status, 204);
      assert.equal((await call("GET", "/v1/records/tickets", CS, undefined, { origin: ORIGIN })).status, 401);
      await sleep(50);
      assert.ok(audit.some((e) => e.actor === `session:${mint.json.data.id} as user-7`), "a session's calls are its subject's");
    }
    console.log("✓ client sessions: minted with a key holding sessions, within the app's and the key's scopes and ttl; CORS for allowed origins only; a key from a browser refused; revocable");

    // ---------- 7. webhooks out ----------
    {
      hooks.setWebhookPolicyForTest({ schedule: [0, 0, 0], disableAfter: 6 });
      const ok = await receiver();
      const ep = await call("POST", "/v1/webhook_endpoints", KEY, { url: ok.url, description: "all events" });
      assert.equal(ep.status, 201, JSON.stringify(ep.json));
      const SECRET = ep.json.data.secret as string;
      assert.match(SECRET, /^whsec_[A-Za-z0-9+/=]{40,}$/);
      const epTickets = await call("POST", "/v1/webhook_endpoints", KEY, { url: `${ok.url}?only=state`, events: ["record.state_changed"] });
      assert.equal((await call("POST", "/v1/webhook_endpoints", KEY, { url: ok.url, events: ["clock.overdue"] })).json.code, "invalid_event", "only declared events");
      assert.equal((await call("POST", "/v1/webhook_endpoints", KEY, { url: "http://hooks.example.com/x" })).json.code, "invalid_url", "https only on the internet");
      assert.ok(!JSON.stringify((await call("GET", "/v1/webhook_endpoints", KEY)).json).includes(SECRET), "the list never shows a secret");
      // A change through the API: one signed delivery, with the actor.
      await call("POST", "/v1/records/tickets", KEY, { key: "W-1", data: { summary: "hooked" } }, { "x-actor": "user-9" });
      await hooks.settled();
      const created = ok.got.find((g) => JSON.parse(g.body).type === "record.created" && JSON.parse(g.body).data.key === "W-1");
      assert.ok(created, "record.created delivered");
      const v = hooks.verifySigned(SECRET, created!.headers as never, created!.body);
      assert.match(v.id, /^msg_/);
      assert.equal(JSON.parse(created!.body).data.actor, `key:${KEY.slice(0, 9)} as user-9`, "the event names the actor");
      assert.equal(JSON.parse(created!.body).data.data.summary, "hooked");
      assert.ok(!ok.got.some((g) => (g.headers["webhook-id"] === created!.headers["webhook-id"]) && g !== created), "once");
      // Filtered per endpoint; the move reaches both.
      await call("POST", "/v1/records/tickets/W-1/move", KEY, { to: "closed" });
      await hooks.settled();
      const moves = ok.got.filter((g) => JSON.parse(g.body).type === "record.state_changed" && JSON.parse(g.body).data.key === "W-1");
      assert.equal(moves.length, 2, "the state change to both endpoints");
      assert.deepEqual([JSON.parse(moves[0]!.body).data.from, JSON.parse(moves[0]!.body).data.to], ["open", "closed"]);
      // The area filter on a declared event: findings never raise state_changed (and have no lifecycle anyway); a batch rolled back sends nothing.
      const before = ok.got.length;
      const bad = await call("POST", "/v1/batch", KEY, { operations: [{ op: "create", area: "tickets", key: "BX-1", data: { summary: "a" } }, { op: "create", area: "tickets", key: "T-1", data: { summary: "dup" } }] });
      assert.equal(bad.status, 409);
      await hooks.settled(); await sleep(50);
      assert.equal(ok.got.length, before, "a batch rolled back sends nothing");
      const good = await call("POST", "/v1/batch", KEY, { operations: [{ op: "create", area: "tickets", key: "BX-2", data: { summary: "a" } }, { op: "create", area: "findings", key: "F-0", data: { severity: "low" } }] });
      assert.equal(good.status, 200);
      await hooks.settled();
      assert.equal(ok.got.length - before, 2, "a committed batch: one event per write");
      // A change from the console (not the API) is an event too, with no actor.
      // Test ping, delivery log.
      const ping = await call("POST", `/v1/webhook_endpoints/${ep.json.data.id}/test`, KEY);
      assert.equal(ping.status, 200);
      assert.equal(ping.json.data.status, "succeeded");
      assert.equal(ping.json.data.event_type, "webhook.test");
      const log = await call("GET", `/v1/webhook_endpoints/${ep.json.data.id}/deliveries?limit=2`, KEY);
      assert.equal(log.json.data.length, 2);
      assert.ok(log.json.next);
      assert.equal((await call("GET", `/v1/webhook_endpoints/${ep.json.data.id}/deliveries?after=${log.json.next}`, KEY)).status, 200);
      // Reveal (recorded) and rotation (both signatures for the grace).
      const rev = await call("GET", `/v1/webhook_endpoints/${ep.json.data.id}/secret`, KEY, undefined, { "x-actor": "admin-1" });
      assert.equal(rev.json.data.secret, SECRET);
      const after1 = (await call("GET", `/v1/webhook_endpoints/${ep.json.data.id}`, KEY)).json.data;
      assert.equal(after1.secret_reveals, 1);
      assert.ok(after1.secret_revealed_at);
      await sleep(50);
      assert.ok(audit.some((e) => e.action === "webhook.secret_reveal" && e.actor === `key:${KEY.slice(0, 9)} as admin-1`), "the reveal is on the audit hook");
      const rot = await call("POST", `/v1/webhook_endpoints/${ep.json.data.id}/rotate_secret`, KEY, { grace_hours: 1 });
      const NEW = rot.json.data.secret as string;
      assert.notEqual(NEW, SECRET);
      const ping2 = await call("POST", `/v1/webhook_endpoints/${ep.json.data.id}/test`, KEY);
      const last = ok.got.find((g) => g.headers["webhook-id"] === ping2.json.data.id)!;
      assert.equal(String(last.headers["webhook-signature"]).split(" ").length, 2, "two signatures while the old secret's grace lasts");
      assert.doesNotThrow(() => hooks.verifySigned(NEW, last.headers as never, last.body));
      assert.doesNotThrow(() => hooks.verifySigned(SECRET, last.headers as never, last.body));
      // Retries, failure and disable; enable again.
      let code = 500;
      const flaky = await receiver(() => code);
      const fe = await call("POST", "/v1/webhook_endpoints", KEY, { url: flaky.url });
      await call("PUT", "/v1/records/tickets/T-2", KEY, { data: { summary: "changed" } });
      await hooks.settled();
      for (let i = 0; i < 5; i++) { await hooks.deliverDue(); await hooks.settled(); }
      const fd = (await call("GET", `/v1/webhook_endpoints/${fe.json.data.id}/deliveries`, KEY)).json.data[0];
      assert.equal(fd.status, "failed", "four attempts (one and three retries), then failed");
      assert.equal(fd.attempts, 4);
      assert.equal(fd.attempt_log.length, 4);
      assert.equal(fd.attempt_log[0].status, 500);
      await call("PUT", "/v1/records/tickets/T-3", KEY, { data: { summary: "changed" } });
      for (let i = 0; i < 5; i++) { await hooks.deliverDue(); await hooks.settled(); }
      const fe2 = (await call("GET", `/v1/webhook_endpoints/${fe.json.data.id}`, KEY)).json.data;
      assert.equal(fe2.status, "disabled", "six failed attempts in a row disable the endpoint");
      assert.match(fe2.disabled_reason, /failed attempts in a row/);
      const n = flaky.got.length;
      await call("PUT", "/v1/records/tickets/T-4", KEY, { data: { summary: "changed" } });
      await hooks.settled(); await hooks.deliverDue();
      assert.equal(flaky.got.length, n, "a disabled endpoint is sent nothing");
      code = 200;
      assert.equal((await call("PATCH", `/v1/webhook_endpoints/${fe.json.data.id}`, KEY, { status: "enabled" })).json.data.failure_streak, 0);
      const retried = await call("POST", `/v1/webhook_deliveries/${fd.id}/retry`, KEY);
      assert.equal(retried.json.data.status, "succeeded", "a failed delivery sent again");
      assert.equal(retried.json.data.attempts, 5);
      // run.finished from the runs table.
      const { scanFinishedRuns } = hooks;
      assert.equal(await scanFinishedRuns(), 0, "the first scan sets its mark (no history is sent)");
      await db.query("UPDATE runs SET status = 'succeeded', ended_at = now() WHERE org_id = $1 AND status = 'queued'", [A.orgId]);
      await scanFinishedRuns();
      await hooks.settled();
      assert.ok(ok.got.some((g) => JSON.parse(g.body).type === "run.finished" && JSON.parse(g.body).data.run.status === "succeeded"), "run.finished delivered");
      const twice = ok.got.filter((g) => JSON.parse(g.body).type === "run.finished").length;
      await scanFinishedRuns(); await hooks.settled();
      assert.equal(ok.got.filter((g) => JSON.parse(g.body).type === "run.finished").length, twice, "a run's end is sent once");
      // The other workspace's endpoint hears nothing of A.
      const okB = await receiver();
      await call("POST", "/v1/webhook_endpoints", keyB, { url: okB.url });
      await call("POST", "/v1/records/tickets", KEY, { key: "W-2", data: { summary: "A only" } });
      await hooks.settled();
      assert.equal(okB.got.length, 0, "B's endpoint hears nothing of A");
      ok.close(); flaky.close(); okB.close();
      assert.ok(epTickets.json.data.events.includes("record.state_changed"));
      hooks.setWebhookPolicyForTest(null);
    }
    console.log("✓ webhooks out: Standard Webhooks signatures, events per endpoint, the actor, a rolled-back batch sends nothing, test ping, the delivery log, retries then failed, disabled after repeated failure, enable and redeliver, the audited reveal, rotation with two signatures, run.finished once, workspaces apart");

    // ---------- 8. webhooks in ----------
    {
      const src = await call("POST", "/v1/inbound_sources", KEY, { receiver: "scanner", description: "nightly scan" });
      assert.equal(src.status, 201, JSON.stringify(src.json));
      const { id, path: p, secret } = src.json.data;
      assert.equal(p, `/v1/inbound/${id}`);
      const payload = JSON.stringify({ type: "scan.completed", findings: [
        { id: "F-1", title: "Open port", severity: "high", where: { path: "/srv" } },
        { id: "F-2", title: "Old library", severity: "low", where: { path: "/app" } }] });
      const send = (body: string, msg: string, sec = secret, ts = Math.floor(Date.now() / 1000)) =>
        call("POST", p, null, body, { "content-type": "application/json", ...hooks.signedHeaders([sec], msg, ts, body) });
      const r1 = await send(payload, "msg_in_1");
      assert.equal(r1.status, 200, JSON.stringify(r1.json));
      assert.deepEqual(r1.json.keys, ["F-1", "F-2"]);
      const f1 = await call("GET", "/v1/records/findings/F-1", KEY);
      assert.equal(f1.json.data.title, "Open port");
      assert.deepEqual(f1.json.data.data, { severity: "high", location: "/srv" });
      const r2 = await send(payload, "msg_in_1");
      assert.equal(r2.json.replayed, true, "the same webhook-id is written once");
      assert.equal((await send(payload, "msg_in_2", "whsec_" + Buffer.from("wrong-secret-wrong-secret!").toString("base64"))).json.code, "invalid_signature");
      assert.equal((await send(payload, "msg_in_3", secret, Math.floor(Date.now() / 1000) - 3600)).json.code, "invalid_signature", "an old timestamp");
      const other = await send(JSON.stringify({ type: "scan.started" }), "msg_in_4");
      assert.equal(other.json.written, 0, "a type the receiver does not take is skipped");
      assert.equal((await send(JSON.stringify({ type: "scan.completed", findings: [{ title: "no id" }] }), "msg_in_5")).status, 422);
      assert.equal((await call("POST", "/v1/inbound/src_doesnotexist000", null, "{}")).status, 404);
      const srcB = (await call("GET", "/v1/inbound_sources", keyB)).json.data;
      assert.deepEqual(srcB, [], "B sees none of A's sources");
    }
    console.log("✓ webhooks in: a signed payload's items written into the receiver's area, once per webhook-id; bad signatures, old timestamps and other types refused or skipped");

    // ---------- 9. the platform audit trail (mold_v0-197), when audit.platform is on ----------
    {
      const trail = await import("../src/audit-trail.js");
      trail.setAuditForTest({ platform: true, data: true });
      try {
        assert.equal((await call("GET", "/v1/records/tickets/T-1", KEY, undefined, { "x-actor": "trail-user" })).status, 200);
        assert.equal((await call("GET", "/v1/records/tickets", READER)).status, 200);
        await sleep(100);
        await trail.flushAudit();
        const rows = await db.query<{ channel: string; path: string; actor_kind: string; actor_id: string; key_id: number | null; scopes: string[]; org_id: number; status: number }>(
          "SELECT channel, path, actor_kind, actor_id, key_id, scopes, org_id, status FROM audit_platform_events WHERE path LIKE '/v1/%' ORDER BY seq");
        const one = rows.find((r) => r.path === "/v1/records/tickets/T-1");
        assert.ok(one, `the request is in the platform trail (${JSON.stringify(rows)})`);
        assert.equal(one!.channel, "api");
        assert.equal(one!.actor_kind, "key");
        assert.equal(one!.actor_id, `key:${KEY.slice(0, 9)} as trail-user`, "the asserted actor");
        assert.equal(one!.org_id, A.orgId);
        assert.ok(one!.scopes.includes("webhooks"), "the scopes the key held");
        const two = rows.find((r) => r.path === "/v1/records/tickets" && r.actor_id === `key:${READER.slice(0, 9)}`);
        assert.ok(two && two.scopes.join() === "read:tickets", "an integration key's single scope");
        const data = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_data_events WHERE org_id = $1 AND actor_id = $2", [A.orgId, `key:${KEY.slice(0, 9)} as trail-user`]);
        assert.ok(data[0]!.n >= 1, "the data trail names the same actor");
      } finally { trail.setAuditForTest(null); }
    }
    console.log("✓ the platform audit trail: each /v1 request with the key, its asserted actor, its scopes and its workspace; the data trail names the same actor");
  } finally {
    setPlatformAuditSink(null);
    await http.close();
  }
  console.log("developer surface: all checks passed");
} finally {
  await (await import("../src/developer-webhooks.js")).settled().catch(() => {});
  cleanup();
}
process.exit(0);
