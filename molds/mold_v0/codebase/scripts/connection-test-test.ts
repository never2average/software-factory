// A record page's "Test connection" (mold_v0-312; src/connection-test.ts, src/connection-test-config.ts, the page action
// test_connection in src/record-page-routes.ts), offline: an embedded database and a stand-in service on 127.0.0.1
// (APP_CONNECTION_TEST_STANDIN, honoured outside production only). No real host is called.
//   npx tsx scripts/connection-test-test.ts
//
// Proves:
//   1. the declaration is checked: templates name the area's fields, a secret only in a header, https only, a public
//      host by its name, statuses 2xx, a timeout of at most 15 seconds, by an enum whose options key the probes, the
//      status and tested fields set_by "action", a workspace area whose contract reveals nothing
//   2. the host check: an address, an internal name, a name resolving to a private, link-local or metadata address
//      are each refused; a public name passes
//   3. the action: an owner's only (a member neither sees nor takes it); it works (200 in N ms), the token refused
//      (401, its echo cut out), a POST with a body read at json_path, a timeout, a redirect to a private address and
//      an endpoint at an internal name refused (nothing sent there), an empty field said; status working or failing
//      and the date written as the app's action, which a person's edit may not change
//   4. no secret anywhere: every HTTP answer, every line printed, the record's history, the data trail, the stored row
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

const printed: string[] = [];
for (const m of ["log", "error", "warn", "info"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...a: unknown[]) => { printed.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); orig(...a); };
}
const ok = (m: string) => console.log(`✓ ${m}`);

const GOOD = `tok-CANARY-${randomBytes(16).toString("hex")}`, BAD = `bad-CANARY-${randomBytes(16).toString("hex")}`, DBKEY = `db-CANARY-${randomBytes(12).toString("hex")}`;
const SECRETS = [GOOD, BAD, DBKEY];
const canary = (w: string) => `${w}-CANARY-${randomBytes(10).toString("hex")}`;

// ---------- the stand-in service: /<host><path> ----------
const seen: { host: string; path: string; method: string; auth: string | null; body: string }[] = [];
const standin = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const [, host, ...rest] = (req.url ?? "/").split("/");
    const path = `/${rest.join("/")}`;
    const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] as string : null;
    seen.push({ host: host!, path, method: req.method!, auth, body: Buffer.concat(chunks).toString() });
    const json = (status: number, v: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (host === "api.paas.example" && path.startsWith("/v1/accounts/")) {
      if (auth === `Bearer ${GOOD}`) return json(200, { account: { id: path.split("/")[3], state: "active" } });
      return json(401, { message: `invalid token ${auth?.replace(/^Bearer /, "")}` });
    }
    if (host === "db.example" && path === "/v1/query") {
      const b = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (auth !== DBKEY) return json(403, { error: { message: "key not allowed" } });
      return json(200, { results: [{ ok: b.database === "orders" ? 1 : 0 }] });
    }
    if (host === "net.example" && path.startsWith("/v2/networks/slow")) return; // never answers
    if (host === "net.example" && path.startsWith("/v2/networks/away")) { res.writeHead(302, { location: "https://collector.evil.example/grab" }); return res.end(); }
    if (host === "net.example" && path.startsWith("/v2/networks/eu")) { res.writeHead(302, { location: "https://eu.net.example/v2/networks/landed" }); return res.end(); }
    if (host === "net.example" && path.startsWith("/v2/networks/hop")) { res.writeHead(302, { location: "https://10.0.0.7/latest/meta-data" }); return res.end(); }
    if (host === "net.example" && path.startsWith("/v2/networks/")) return json(200, { network: { status: "available" } });
    json(404, { message: "not here" });
  });
});
await new Promise<void>((r) => standin.listen(0, "127.0.0.1", r));
process.env.APP_CONNECTION_TEST_STANDIN = `http://127.0.0.1:${(standin.address() as AddressInfo).port}`;

const ALL = ["viewer", "member", "billing", "owner"];
const PROBE = {
  by: "provider",
  probes: {
    paas: { label: "the hosting account's API", method: "GET", url: "https://api.paas.example/v1/accounts/{account_id}", headers: { Authorization: "Bearer {api_token}" },
      expect: { status: "2xx", json_path: "account.state", equals: "active" }, timeout_seconds: 5 },
    database: { label: "the database's HTTP API", method: "POST", url: "{endpoint}/v1/query", headers: { "X-Api-Key": "{api_token}" },
      body: { database: "{database}", sql: "select 1" }, expect: { status: [200], json_path: "results.0.ok", equals: 1 }, timeout_seconds: 5, hosts: ["db.example"] },
    network: { label: "the network API", method: "GET", url: "https://net.example/v2/networks/{account_id}", headers: { Authorization: "Bearer {api_token}" },
      expect: { json_path: "network.status", equals: "available" }, timeout_seconds: 1, hosts: ["*.net.example"] },
  },
  status: "status", tested: "last_tested",
};
const AREA = {
  name: "fx_connections", label: "Connections", role: "source", scope: "workspace",
  fields: [
    { name: "provider", label: "Kind", type: "enum", options: ["paas", "database", "network", "other"] },
    { name: "account_id", label: "Account ID", type: "text" },
    { name: "endpoint", label: "Endpoint", type: "url" },
    { name: "database", label: "Database", type: "text" },
    { name: "api_token", label: "API token", type: "text", encrypted: true },
    { name: "status", label: "Last test", type: "enum", options: ["untested", "working", "failing"], set_by: "action" },
    { name: "last_tested", label: "Tested on", type: "date", set_by: "action" },
  ],
  // Visible to the workspace unless a record says private (the L4 test hides one from a member).
  visibility: { modes: ["workspace", "private"], default: "workspace" },
  permissions: { read: ALL, create: ["owner"], update: ["owner", "member"], delete: ["owner"] },
  contract: { provenance: ["people"], actions: { read: ALL, export: { none: "secrets" }, create: ["owner"], update: ["owner", "member"], move: { none: "no lifecycle" }, delete: ["owner"],
    reveal: { none: "A token is never shown again once saved" }, import: { none: "secrets are typed" } }, primary_action: "create_record" },
  detail: { tabs: [{ label: "Details", sections: [{ title: "Where", fields: ["provider", "account_id", "endpoint", "database"] }] }, { label: "History", sections: [{ title: "Changes", history: {} }] }],
    actions: [{ kind: "test_connection", place: "primary", label: "Test connection", roles: ["owner"], probe: PROBE }, { kind: "edit", place: "secondary" }] },
};
// mold_v0-305's storage area, for the same binding: its endpoint binds both keys.
const STORAGE = { name: "fx_storage", label: "Storage", role: "source", scope: "workspace",
  fields: [{ name: "bucket", label: "Bucket", type: "text" }, { name: "endpoint", label: "Endpoint", type: "url" },
    { name: "access_key_id", label: "Access key ID", type: "text", encrypted: true }, { name: "secret_access_key", label: "Secret access key", type: "text", encrypted: true },
    { name: "use_for_files", label: "In use", type: "boolean" }],
  permissions: { read: ALL, create: ["owner"], update: ["owner", "member"], delete: ["owner"] },
  contract: { provenance: ["people"], actions: { read: ALL, export: { none: "keys" }, create: ["owner"], update: ["owner", "member"], move: { none: "no lifecycle" }, delete: ["owner"],
    reveal: { none: "keys" }, import: { none: "keys" } }, primary_action: "create_record" } };
const PACK = { id: "fixture_connections", name: "Fixture connections", version: "1", record_areas: [AREA, STORAGE],
  object_storage: { area: "fx_storage", fields: { bucket: "bucket", endpoint: "endpoint", access_key_id: "access_key_id", secret_access_key: "secret_access_key", use: "use_for_files" } } };

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const F = await import("../src/features.js");
  const api = await import("../src/pack-api.js");
  const { connectionTestProblems } = await import("../src/connection-test-config.js");
  const ra = await import("../src/record-areas.js");
  const C = await import("../src/connection-test.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations, PackJsonSchema } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  const { TMP } = await import("./lib/test-world.js");

  // ---------- 1. the declaration ----------
  {
    const parsed = PackJsonSchema.safeParse(PACK);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    const problems = (patch: (a: any, p: any) => void) => {
      const a = structuredClone(AREA) as any; patch(a, a.detail.actions[0].probe);
      const r = api.RecordAreaSchema.safeParse(a);
      return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    };
    assert.deepEqual(problems(() => {}), [], "the fixture's area");
    const bad = (patch: (a: any, p: any) => void, re: RegExp, what: string) => {
      const p = problems(patch);
      assert.ok(p.some((m) => re.test(m)), `${what}: ${JSON.stringify(p)}`);
    };
    bad((_a, p) => { p.probes.paas.url = "https://api.paas.example/v1/{api_token}"; }, /api_token\} is encrypted: a secret goes only in a header/, "a secret in the address");
    bad((_a, p) => { p.probes.database.body.sql = "select '{api_token}'"; }, /api_token\} is encrypted: a secret goes only in a header, never in a body/, "a secret in the body");
    bad((_a, p) => { p.probes.paas.url = "http://api.paas.example/v1"; }, /https:\/\/ addresses only/, "http");
    bad((_a, p) => { p.probes.paas.url = "https://169.254.169.254/latest"; }, /an address or an internal name/, "the metadata address");
    bad((_a, p) => { p.probes.paas.url = "https://metadata.internal/x"; }, /an address or an internal name/, "an internal name");
    bad((_a, p) => { p.probes.paas.url = "{account_id}/x"; }, /starts the address: it is a url field/, "a text field as the address");
    bad((_a, p) => { p.probes.paas.url = "https://{account_id}/x"; }, /names only its first label/, "a field as the whole host");
    bad((_a, p) => { p.probes.paas.headers.Authorization = "Bearer {nope}"; }, /\{nope\} is not one of the area's fields/, "an unknown field");
    bad((_a, p) => { p.probes.paas.headers.Host = "x"; }, /set by the connection itself/, "a Host header");
    bad((_a, p) => { p.probes.paas.timeout_seconds = 30; }, /at most 15 seconds/, "a long timeout");
    bad((_a, p) => { p.probes.paas.expect.status = [301]; }, /200 to 299/, "a redirect as working");
    bad((_a, p) => { delete p.probes.paas.expect.json_path; }, /equals compares the value at json_path/, "equals alone");
    bad((_a, p) => { p.probes.paas.method = "HEAD"; delete p.probes.paas.expect; p.probes.paas.body = { a: 1 }; }, /a HEAD sends no body/, "a HEAD's body");
    bad((_a, p) => { p.probes.cloud = p.probes.paas; }, /cloud is not one of provider's options/, "a probe for no option");
    bad((_a, p) => { p.by = "account_id"; }, /not a plain single-choice enum field/, "by a text field");
    bad((a) => { delete a.fields[5].set_by; }, /declare it set_by "action"/, "a status a person sets");
    bad((a) => { a.fields[5].options = ["a", "b"]; }, /options working and failing/, "a status without working and failing");
    bad((a) => { a.fields[6].type = "text"; }, /is a date field/, "tested as text");
    bad((a) => { a.contract.actions.reveal = ["owner"]; }, /reveals nothing/, "a token an owner could reveal");
    bad((a) => { delete a.detail.actions[0].probe; }, /declares its probe/, "no probe");
    bad((a) => { a.detail.actions[1].probe = PROBE; }, /probe is for a test_connection action/, "a probe on an edit");
    bad((a) => { a.detail.actions[0].roles = ["viewer"]; }, /viewer is read-only/, "a viewer's test");
    bad((_a, p) => { delete p.probes.database.hosts; }, /record decides the host: list the hosts/, "an address from the record with no hosts");
    bad((_a, p) => { p.probes.paas.url = "https://{account_id}.paas.example/v1"; }, /lets the record decide it: list the hosts/, "a host label from the record with no hosts");
    bad((_a, p) => { p.probes.paas.url = "https://api.paas.example:8443/v1"; }, /port 443 only/, "another port");
    bad((_a, p) => { p.probes.database.hosts = ["metadata.google.internal"]; }, /internal name/, "an internal host listed");
    bad((_a, p) => { p.probes.database.hosts = ["10.0.0.1"]; }, /a host's name/, "an address listed");
    for (const w of ["*.amazonaws.com", "*.on.aws", "*.vercel.app", "*.workers.dev", "*.github.io", "*.herokuapp.com", "*.cloudfront.net", "*.azurewebsites.net", "*.appspot.com", "*.netlify.app", "*.pages.dev", "*.fly.dev", "*.onrender.com", "*.co.uk"])
      bad((_a, p) => { p.probes.database.hosts = [w]; }, /a wildcard over a name anyone can host under/, `the wildcard ${w}`);
    assert.deepEqual(problems((_a, p) => { p.probes.database.hosts = ["my-db.vercel.app", "*.db.example.com"]; }), [], "an exact host under a shared suffix, and a wildcard of one's own: fine");
    // The lifecycle's field never decides a destination (a move changes it without the secret's binding).
    const lcArea = { ...structuredClone(AREA), lifecycle: { field: "provider" } } as any;
    assert.ok(connectionTestProblems(lcArea, PROBE).some((p) => /provider is the lifecycle's field: a move would change which probe runs/.test(p.message)), "by as the lifecycle's field");
    const lcArea2 = { ...structuredClone(AREA), lifecycle: { field: "endpoint" } } as any;
    assert.ok(connectionTestProblems(lcArea2, PROBE).some((p) => /\{endpoint\} is the lifecycle's field/.test(p.message)), "an address field as the lifecycle's");
    ok("the declaration: fields named exist, a secret only in a header, https to a public name, 2xx, at most 15 s, probes keyed by an enum's options, status and date set_by action, reveal none");
  }

  // ---------- 2. the host check ----------
  {
    C.setResolverForTest(async (h) => (h === "rebind.example" ? ["10.0.0.9"] : h === "meta.example" ? ["169.254.169.254"] : h === "six.example" ? ["::1"] : ["93.184.216.34"]));
    const refused = async (url: string, re: RegExp, allowed?: string[]) => assert.rejects(C.checkAddress(new URL(url), allowed), re, url);
    await refused("https://10.1.2.3/x", /is an address, not a name/);
    await refused("https://[::1]/x", /is an address, not a name/);
    await refused("https://localhost/x", /private or internal/);
    await refused("https://metadata.google.internal/x", /private or internal/);
    await refused("https://rebind.example/x", /private or internal/);
    await refused("https://meta.example/x", /private or internal/);
    await refused("https://six.example/x", /private or internal/);
    await refused("http://api.paas.example/x", /https only/);
    await refused("https://api.paas.example:8443/x", /port 443 only/);
    await refused("https://evil.example/x", /not one of the hosts this test may call/, ["api.paas.example"]);
    await C.checkAddress(new URL("https://eu.net.example/v1"), ["*.net.example"]);
    process.env.APP_GATEWAY_URL = "https://gw.paas.example";
    await refused("https://gw.paas.example/x", /this app's own address/);
    await refused("https://gw.paas.example./x", /this app's own address/);
    delete process.env.APP_GATEWAY_URL;
    await C.checkAddress(new URL("https://api.paas.example/v1"));
    // The connection's own lookup (DNS rebinding: the name answered public to the check, private to the connection).
    const look = (addrs: string[]) => new Promise<string>((res) => { C.setResolverForTest(async () => addrs); C.publicLookupForTest("x.example", {}, (e: any, a: any) => res(e ? `refused ${e.code}` : `ok ${a}`)); });
    for (const a of [["10.0.0.1"], ["93.184.216.34", "127.0.0.1"], ["::ffff:127.0.0.1"], ["::ffff:7f00:1"], ["fd00::1"], ["fe80::1"], ["::1"], ["169.254.169.254"], ["100.64.0.1"]])
      assert.equal(await look(a), "refused EPRIVATE", `rebinding to ${a.join(", ")}`);
    assert.equal(await look(["93.184.216.34"]), "ok 93.184.216.34");
    assert.equal(await look(["2606:2800:220:1:248:1893:25c8:1946"]), "ok 2606:2800:220:1:248:1893:25c8:1946");
    C.setResolverForTest(async (h) => (h === "rebind.example" ? ["10.0.0.9"] : ["93.184.216.34"]));
    // The stand-in is honoured only in a test world.
    assert.equal(C.standinActiveForTest(), true);
    delete process.env.APP_TEST_WORLD; assert.equal(C.standinActiveForTest(), false, "outside a test world: no stand-in"); process.env.APP_TEST_WORLD = "1";
    ok("the host check: an address, an internal name, a name resolving to a private, metadata or loopback address refused; a public name passes");
  }

  setPacksForTest([{ manifest: { id: "fixture_connections", name: "x", version: "1", entry: null, migrations: null, words: {}, dir: TMP }, declared: compileDeclarations(PACK) } as never]);
  F.setFeaturesForTest({ record_pages: true, teams: true });
  const A = (await createOrg(`Connections A ${STAMP}`)).org;
  const owner = { role: "owner" as const, userId: "user_owner_a" };
  const recA = ra.workspaceRecords("fixture_connections", A.orgId, owner);
  const add = (key: string, data: Record<string, unknown>) => ra.asWriter({ by: "people", id: "owner" }, () => recA.create("fx_connections", key, { title: key, data }));
  await add("paas-good", { provider: "paas", account_id: "acc 42/x", api_token: GOOD });
  await add("paas-bad", { provider: "paas", account_id: "acc-43", api_token: BAD });
  await add("db", { provider: "database", endpoint: "https://db.example/", database: "orders", api_token: DBKEY });
  await add("db-internal", { provider: "database", endpoint: "https://db.internal:8443", database: "orders", api_token: DBKEY });
  await add("net-slow", { provider: "network", account_id: "slow", api_token: GOOD });
  await add("net-hop", { provider: "network", account_id: "hop", api_token: GOOD });
  await add("net-rebind", { provider: "network", account_id: "x", api_token: GOOD });
  await add("paas-empty", { provider: "paas", api_token: GOOD });
  await add("other", { provider: "other", api_token: GOOD });

  // ---------- 3. the action ----------
  const answers: string[] = [];
  {
    const web = await startHttp();
    const ownerTok = await web.signIn(A, "owner"), memberTok = await web.signIn(A, "member");
    const call = async (method: string, tok: string, p: string, body?: unknown) => {
      const r = await web.req(method, p, { authorization: `Bearer ${tok}`, "x-pack-request": "1" }, body);
      const text = await r.text(); answers.push(text);
      return { status: r.status, body: (() => { try { return JSON.parse(text); } catch { return {}; } })() as any };
    };
    const test = (key: string, tok = ownerTok) => { C.resetTestRateForTest(); return call("POST", tok, `/api/records/_page/fx_connections/${key}/actions/test_connection`); };
    const stored = async (key: string) => (await ra.getFor(A.orgId, "fx_connections", key, owner))!.data;
    const today = new Date().toISOString().slice(0, 10);

    const page = await call("GET", ownerTok, "/api/records/_page/fx_connections/paas-good");
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.ok(page.body.actions.some((x: any) => x.kind === "test_connection" && x.label === "Test connection"), "an owner is offered Test connection");
    assert.ok(!JSON.stringify(page.body).includes("Bearer"), "the page never carries the probe");
    const mPage = await call("GET", memberTok, "/api/records/_page/fx_connections/paas-good");
    assert.ok(!mPage.body.actions.some((x: any) => x.kind === "test_connection"), "a member is not");
    assert.equal((await test("paas-good", memberTok)).status, 403, "nor may take it");

    // It works.
    const t = await test("paas-good");
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.ok, true, t.body.words);
    assert.match(t.body.words, /^It works: the hosting account's API at api\.paas\.example answered 200 in \d+ ms\.$/);
    assert.equal(t.body.host, "api.paas.example"); assert.ok(!JSON.stringify(t.body).includes("/v1/accounts"), "the path is never returned");
    const s0 = seen.at(-1)!;
    assert.equal(s0.path, "/v1/accounts/acc%2042%2Fx", "a plain field escaped in the address"); assert.equal(s0.auth, `Bearer ${GOOD}`, "the token opened on the server, in its header");
    assert.equal((await stored("paas-good")).status, "working"); assert.equal((await stored("paas-good")).last_tested, today);

    // The token refused: 401, its echo cut out.
    const r401 = await test("paas-bad");
    assert.equal(r401.body.ok, false); assert.equal(r401.body.outcome, "refused");
    assert.match(r401.body.words, /^It does not work yet: the hosting account's API at api\.paas\.example answered 401: the token was refused \(it said: "invalid token …"\)\.$/, r401.body.words);
    assert.equal((await stored("paas-bad")).status, "failing");

    // A POST with a body, read at json_path; the endpoint's trailing slash.
    const rdb = await test("db");
    assert.equal(rdb.body.ok, true, rdb.body.words);
    const sdb = seen.at(-1)!;
    assert.equal(sdb.method, "POST"); assert.equal(sdb.path, "/v1/query"); assert.deepEqual(JSON.parse(sdb.body), { database: "orders", sql: "select 1" }); assert.equal(sdb.auth, DBKEY);

    // An endpoint at an internal name: refused before any call.
    const before = seen.length;
    const rin = await test("db-internal");
    assert.equal(rin.body.outcome, "private_address"); assert.match(rin.body.words, /^It can't be tested: db\.internal (is a private or internal address|on port 8443: a test calls port 443 only)/);
    assert.equal(seen.length, before, "nothing was sent");
    assert.equal((await stored("db-internal")).status, "failing");

    // A timeout (1 second).
    const t0 = Date.now();
    const rslow = await test("net-slow");
    assert.equal(rslow.body.outcome, "timeout"); assert.match(rslow.body.words, /^It does not work yet: the network API at net\.example did not answer within 1 second\.$/);
    assert.ok(Date.now() - t0 < 4000, "it gave up at its timeout");

    // A redirect to a private address: refused, not followed.
    const n = seen.length;
    const rhop = await test("net-hop");
    assert.equal(rhop.body.outcome, "private_address", rhop.body.words); assert.match(rhop.body.words, /10\.0\.0\.7 is an address, not a name/);
    assert.equal(seen.length, n + 1, "only the first call was made");

    // A name that resolves to a private address (the redirect's own check covers names too).
    C.setResolverForTest(async (h) => (h === "net.example" ? ["10.0.0.9"] : ["93.184.216.34"]));
    const rreb = await test("net-rebind");
    assert.equal(rreb.body.outcome, "private_address"); assert.match(rreb.body.words, /net\.example is a private or internal address/);
    C.setResolverForTest(async () => ["93.184.216.34"]);

    // An empty field; a kind with no test.
    const remp = await test("paas-empty");
    assert.equal(remp.body.outcome, "not_ready"); assert.equal(remp.body.words, `It can't be tested yet: "Account ID" is empty.`);
    const roth = await test("other");
    assert.equal(roth.body.words, `It can't be tested yet: this app has no test for "Kind" other.`);

    // set_by "action": a person's edit may not set the status.
    const edit = await call("POST", ownerTok, "/api/records/_page/fx_connections/paas-bad/actions/edit", { title: "paas-bad", data: { provider: "paas", account_id: "acc-43", api_token: "", status: "working" } });
    assert.equal(edit.status, 409, JSON.stringify(edit.body)); assert.match(edit.body.error, /set by the app's own actions/);
    assert.equal((await stored("paas-bad")).status, "failing", "still the test's own");
    const edit2 = await call("POST", ownerTok, "/api/records/_page/fx_connections/paas-bad/actions/edit", { title: "paas-bad", data: { provider: "paas", account_id: "acc-43", api_token: GOOD } });
    assert.equal(edit2.status, 200, JSON.stringify(edit2.body));
    assert.equal((await test("paas-bad")).body.ok, true, "a new token, the test works");
    // ---------- 3b. the attacks ----------
    const memberActor = { role: "member" as const, userId: "user_member_a" };
    const storedRow = async (area: string, key: string) => (await ra.workspaceStored(A.orgId, ra.findArea(area)!, [key])).get(key)!.data;
    // H1: an owner points db's endpoint at their own host, leaving the token blank (the edit keeps a blank secret):
    // the token is cleared, and Test sends nothing anywhere.
    await add("db-x", { provider: "database", endpoint: "https://db.example", database: "orders", api_token: DBKEY });
    const e1 = await call("POST", ownerTok, "/api/records/_page/fx_connections/db-x/actions/edit", { title: "db-x", data: { provider: "database", endpoint: "https://collector.evil.example", database: "orders", api_token: "" } });
    assert.equal(e1.status, 200, JSON.stringify(e1.body));
    assert.equal((await storedRow("fx_connections", "db-x")).api_token, undefined, "the endpoint changed without the token: the token is cleared");
    let sent = seen.length;
    const r1 = await test("db-x");
    assert.equal(r1.body.outcome, "not_ready", r1.body.words); assert.match(r1.body.words, /"API token" is empty/);
    assert.equal(seen.length, sent, "nothing was sent");
    // Typed again to the other host: refused by the probe's hosts, on its first hop.
    await ra.asWriter({ by: "people", id: "owner" }, () => recA.update("fx_connections", "db-x", { title: "db-x", data: { provider: "database", endpoint: "https://collector.evil.example", database: "orders", api_token: DBKEY } }));
    const r2 = await test("db-x");
    assert.equal(r2.body.outcome, "private_address"); assert.match(r2.body.words, /collector\.evil\.example is not one of the hosts this test may call \(db\.example\)/);
    assert.equal(seen.length, sent, "still nothing sent");
    // A member who may update (not test) does the same through the data API: cleared too.
    await add("db-m", { provider: "database", endpoint: "https://db.example", database: "orders", api_token: DBKEY });
    await ra.asWriter({ by: "people", id: "user_member_a" }, () => ra.workspaceRecords("fixture_connections", A.orgId, memberActor).update("fx_connections", "db-m",
      { title: "db-m", data: { provider: "database", endpoint: "https://db.example.evil.example", database: "orders" } }));
    assert.equal((await storedRow("fx_connections", "db-m")).api_token, undefined, "a member's endpoint change clears the token");
    // The `by` flipped onto a probe whose host the record decides: cleared.
    await add("flip", { provider: "paas", account_id: "acc-1", api_token: GOOD });
    await ra.asWriter({ by: "people", id: "owner" }, () => recA.update("fx_connections", "flip", { title: "flip", data: { provider: "database", account_id: "acc-1", endpoint: "https://collector.evil.example", database: "x" } }));
    assert.equal((await storedRow("fx_connections", "flip")).api_token, undefined, "the kind changed without the token: cleared");
    // A change that keeps the destination keeps the token (the database's name is not where it goes).
    await ra.asWriter({ by: "people", id: "owner" }, () => recA.update("fx_connections", "db", { title: "db", data: { provider: "database", endpoint: "https://db.example/", database: "orders" } }));
    assert.ok((await storedRow("fx_connections", "db")).api_token, "the same endpoint: the token kept");
    // mold_v0-305's storage: its endpoint changed without the keys clears both.
    await ra.asWriter({ by: "people", id: "owner" }, () => recA.create("fx_storage", "s1", { title: "s1", data: { bucket: "ws-files", endpoint: "https://storage.example.com", access_key_id: canary("id"), secret_access_key: canary("key"), use_for_files: false } }));
    await ra.asWriter({ by: "people", id: "user_member_a" }, () => ra.workspaceRecords("fixture_connections", A.orgId, memberActor).update("fx_storage", "s1",
      { title: "s1", data: { bucket: "ws-files", endpoint: "https://collector.evil.example", use_for_files: false } }));
    const st = await storedRow("fx_storage", "s1");
    assert.deepEqual([st.access_key_id, st.secret_access_key], [undefined, undefined], "a storage's endpoint changed without its keys: both cleared");
    // A redirect off the probe's hosts is refused; one to another of its hosts drops the secret's header.
    sent = seen.length;
    await add("net-away", { provider: "network", account_id: "away", api_token: GOOD });
    const r3 = await test("net-away");
    assert.equal(r3.body.outcome, "private_address"); assert.match(r3.body.words, /collector\.evil\.example is not one of the hosts/);
    assert.equal(seen.length, sent + 1, "only the first hop was made");
    await add("net-eu", { provider: "network", account_id: "eu", api_token: GOOD });
    await test("net-eu");
    const landed = seen.at(-1)!;
    assert.deepEqual([landed.host, landed.auth], ["eu.net.example", null], "the cross-host hop carries no token");
    // N2: Test twice in a row: its status write-back is no destination change, the token survives.
    const t1 = await test("db"), t2 = await test("db");
    assert.deepEqual([t1.body.ok, t2.body.ok], [true, true], `${t1.body.words} / ${t2.body.words}`);
    assert.ok((await storedRow("fx_connections", "db")).api_token, "the token survives two tests");
    // L4: a record the person cannot see (private to its owner) is never tested for them, though their role may update.
    await ra.asWriter({ by: "people", id: "owner" }, () => recA.create("fx_connections", "hidden", { title: "hidden", data: { provider: "database", endpoint: "https://db.example", database: "orders", api_token: DBKEY }, visibility: { mode: "private" } }));
    const CT = await import("../src/connection-test.js");
    C.resetTestRateForTest();
    await assert.rejects(CT.testConnectionRecord(A.orgId, ra.findArea("fx_connections")!, "hidden", PROBE as never, memberActor), /no fx_connections record hidden/, "hidden: refused");
    const seenOwner = await ra.asAction(() => CT.testConnectionRecord(A.orgId, ra.findArea("fx_connections")!, "hidden", PROBE as never, owner));
    assert.equal(seenOwner.ok, true, "its owner may test it");
    // L2: a value never climbs the address.
    for (const v of ["..", "."]) {
      await ra.asWriter({ by: "people", id: "owner" }, () => recA.update("fx_connections", "paas-good", { title: "paas-good", data: { provider: "paas", account_id: v } }));
      const r = await test("paas-good");
      assert.equal(r.body.outcome, "not_ready", `${v}: ${r.body.words}`); assert.match(r.body.words, /"Account ID" is not a value an address takes/);
    }
    // (the account changed: not a destination of the paas probe, so its token is kept)
    assert.ok((await storedRow("fx_connections", "paas-good")).api_token, "a path value changed: the token kept");
    // L3: a token a header cannot carry: said in words, never a 500.
    await add("latin", { provider: "paas", account_id: "acc-9", api_token: "tökenvalue-1234567" });
    const r4 = await test("latin");
    assert.equal(r4.status, 200); assert.match(r4.body.words, /"API token" holds a character a header cannot carry/);
    // M2: a secret shorter than 8 characters is refused, never sent.
    await add("short", { provider: "paas", account_id: "acc-9", api_token: "abc12" });
    sent = seen.length;
    const r5 = await test("short");
    assert.match(r5.body.words, /"API token" is too short to be a secret/); assert.equal(seen.length, sent);
    // L1: failures carry no timing; a network failure reads the same whatever the cause.
    assert.equal(r3.body.ms, 0);
    // L1: at most 10 tests a minute per workspace.
    C.resetTestRateForTest();
    for (let i = 0; i < C.TESTS_PER_MINUTE; i++) assert.equal((await call("POST", ownerTok, "/api/records/_page/fx_connections/paas-empty/actions/test_connection")).status, 200);
    const limited = await call("POST", ownerTok, "/api/records/_page/fx_connections/paas-empty/actions/test_connection");
    assert.equal(limited.status, 429); assert.match(limited.body.error, /tested 10 connections in the last minute/);
    C.resetTestRateForTest();
    await web.close();
    ok("the attacks: an endpoint or kind changed without the token clears it (an owner's edit, a member's API write, storage's keys too), so Test sends nothing; a host off the probe's list refused on every hop, a cross-host hop without the token; '.' and '..', a non-header character and a short secret said in words; failures without timing; 10 tests a minute");
    ok("the action: an owner's only; works (200 in N ms), 401 refused with its echo cut out, a POST read at json_path, an internal endpoint and a private redirect refused (nothing sent), a timeout, an empty field said; status and date written as the action, never by a person's edit");
  }

  // ---------- 4. no secret anywhere ----------
  {
    const { recordHistory } = await import("../src/record-history.js");
    const { withTenant } = await import("../src/tenant-scope.js");
    const area = ra.findArea("fx_connections")!;
    const lines = (await Promise.all(["paas-good", "paas-bad", "db", "net-slow"].map((k) => withTenant(A.orgId, () => recordHistory(A.orgId, area, k, { limit: 50 }))))).flatMap((h) => h.lines);
    const history = JSON.stringify(lines) + JSON.stringify(await db.query("SELECT * FROM record_changes WHERE org_id = $1", [A.orgId]));
    const trail = JSON.stringify(await db.query("SELECT * FROM audit_data_events WHERE org_id = $1", [A.orgId]).catch(() => []));
    const rows = JSON.stringify(await db.query("SELECT data FROM workspace_records WHERE org_id = $1 AND area = 'fx_connections'", [A.orgId]));
    for (const s of SECRETS) {
      assert.ok(!answers.some((a) => a.includes(s)), "no HTTP answer carries a secret");
      assert.ok(!printed.some((p) => p.includes(s)), "nothing printed carries a secret");
      assert.ok(!history.includes(s), "the history carries none"); assert.ok(!trail.includes(s), "nor the data trail"); assert.ok(!rows.includes(s), "stored sealed");
    }
    assert.ok(lines.some((l) => l.changes.some((c) => JSON.stringify(c).includes("working"))), `the history has the test's status change: ${JSON.stringify(lines).slice(0, 400)}`);
    ok("no secret in any HTTP answer, anything printed, the record's history, the data trail or the stored row");
  }
  console.log("connection-test-test: all passed");
} finally {
  standin.close();
  cleanup();
}
process.exit(0);
