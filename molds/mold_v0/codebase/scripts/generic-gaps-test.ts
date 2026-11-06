// mold_v0-260, the generic gaps batch, offline: an embedded database, a fake sign-in, the fixture
// scripts/fixtures/packs/fixture_gaps, two workspaces. Each item behind its flag (src/features.json), off by default.
//   npm run test:generic-gaps
//   0. Off (the default): every new route answers nothing, the start tool takes no record, get_usage is not listed,
//      the record rules and credential sets are not applied.
//   1. A run reads its input from the record it runs on: the start tool's record (a value that disagrees refused, another
//      workspace's record not found, a viewer refused) and the record page's start_run (the record's values, not the
//      browser's); the run carries the record.
//   2. A shared catalog from a private repository: staff set a deploy key or the GitHub App's installation (owners of the
//      platform only, never read back); a fetch over SSH with that key alone and the host's own key, a fetch over HTTPS
//      with a token for that one repository (revoked after); each pinned to its commit; refused while off or unset.
//   3. A sections tab of up to 8 tabs (9 refused). 4. Lists of up to 12 columns (13 refused; past 8 asks for wide_lists).
//   5. A reference limited by a condition on its target (every write and the picker) and checks run on save (refused
//      with their message, through the data API and the MCP tools).
//   6. A credential of several labelled values, bound to a tenant record: set per label by owners, listed on the tenant's
//      page (never another workspace's), delivered to a run on that tenant as one JSON object, each value redacted.
//   7. The home page's Recent runs and Needs attention cards, per workspace and role. 8. Run analytics by record, person,
//      model, tool and failure reason (a workspace's billing managers and owners; staff across workspaces).
//   10. get_usage over MCP: the caller's workspace, the whole of it for owners, their own runs for members.
//   (9, the dashboards' filters in the address, is the console's: the lane world's shots load a view from its address.)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ok = (m: string) => console.log(`✓ ${m}`);
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_gaps", "pack.json"), "utf8"));
const ALL = { record_pages: true, record_run_inputs: true, private_catalogs: true, wide_lists: true, record_rules: true, credential_sets: true, overview_cards: true, run_analytics: true, filters_in_address: true, usage_tool: true } as const;

// ---------- a private repository, served over a stand-in ssh ----------
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" }).trim();
const SRV = path.join(TMP, "git-server"), WORK = path.join(TMP, "git-work");
mkdirSync(path.join(SRV, "acme"), { recursive: true }); mkdirSync(WORK, { recursive: true });
git(WORK, "init", "-q");
writeFileSync(path.join(WORK, "runbooks.json"), JSON.stringify([{ id: "rb-db", title: "Database failover", service: "db", summary: "Promote the replica." }, { id: "rb-cache", title: "Cache flush", service: "cache", summary: "Flush and warm." }]));
git(WORK, "add", "."); git(WORK, "commit", "-q", "-m", "runbooks");
const PIN = git(WORK, "rev-parse", "HEAD");
git(SRV, "clone", "-q", "--bare", WORK, path.join(SRV, "acme", "runbooks.git"));
// The stand-in ssh: records how it was called (the key file's text, the options), then serves the repository locally.
const BIN = path.join(TMP, "bin"); mkdirSync(BIN);
const SSH_LOG = path.join(TMP, "ssh.log");
writeFileSync(path.join(BIN, "ssh"), `#!/bin/bash
key=""; args="$*"; prev=""
for a in "$@"; do [ "$prev" = "-i" ] && key="$a"; prev="$a"; done
{ echo "ARGS $args"; echo "MODE $(stat -c %a "$key" 2>/dev/null)"; echo "KEY $(head -1 "$key" 2>/dev/null)"; } >> ${SSH_LOG}
cmd="\${@: -1}"; cmd="\${cmd//\\'\\//\\'${SRV}/}"
exec sh -c "$cmd"
`);
chmodSync(path.join(BIN, "ssh"), 0o755);
FIXTURE.upstream.commit = PIN;
const DEPLOY_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACBexampleexampleexampleexampleexampleexampleAAAA=\n-----END OPENSSH PRIVATE KEY-----\n";
const KNOWN = "git.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleHostKeyExampleHostKeyExampleHost";

// ---------- GitHub's stand-in: the installation token, its revoke ----------
const TOKEN = "ghs_catalogtokenexample0123456789";
const gh: { asked: unknown[]; revoked: number } = { asked: [], revoked: 0 };
const ghServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "POST" && /^\/app\/installations\/4242\/access_tokens$/.test(req.url ?? "")) {
      gh.asked.push(JSON.parse(body || "{}"));
      res.writeHead(201, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ token: TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { contents: "read", metadata: "read" }, repositories: [{ id: 7, full_name: "example-org/standards" }] }));
    }
    if (req.method === "DELETE" && req.url === "/installation/token") { gh.revoked++; res.writeHead(204); return void res.end(); }
    res.writeHead(404); res.end("{}");
  });
});
ghServer.listen(0, "127.0.0.1");
await new Promise((r) => ghServer.once("listening", r));
const GH = `http://127.0.0.1:${(ghServer.address() as AddressInfo).port}`;
const STD_PIN = FIXTURE.repositories.standards.upstream.commit as string;
const ghSeen: string[] = [];
const fakeGithub: typeof fetch = async (url, init) => {
  const u = String(url), auth = new Headers(init?.headers).get("authorization");
  ghSeen.push(`${u.replace(/^https:\/\/[^/]+/, "")} ${auth ?? "-"}`);
  if (auth !== `token ${TOKEN}`) return new Response("Not Found", { status: 404 });
  if (u.endsWith(`/repos/example-org/standards/commits/${STD_PIN}`)) return Response.json({ sha: STD_PIN });
  if (u.endsWith(`/example-org/standards/${STD_PIN}/standards.json`)) return new Response(JSON.stringify([{ id: "std-1", title: "Access reviews", family: "access", summary: "Quarterly." }]));
  return new Response("Not Found", { status: 404 });
};

try {
  const F = await import("../src/features.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  const ra = await import("../src/record-areas.js");
  const { getDb } = await import("../src/db.js");
  const { asPlatform } = await import("../src/tenant-scope.js");
  const { TabSchema, RecordAreaSchema } = await import("../src/pack-api.js");
  const db = await getDb();
  setPacksForTest([{ manifest: { id: "fixture_gaps", name: "Fixture gaps", version: "0.1.0", entry: null, migrations: null, words: {}, upstream: FIXTURE.upstream,
    dir: path.join(ROOT, "scripts", "fixtures", "packs", "fixture_gaps") }, declared: compileDeclarations(FIXTURE) } as never]);
  const A = (await createOrg(`Gaps A ${STAMP}`)).org, B = (await createOrg(`Gaps B ${STAMP}`)).org;
  const web = await startHttp();
  const owner = await web.signInAs(A, "owner"), member = await web.signInAs(A, "member"), viewer = await web.signInAs(A, "viewer"), ownerB = await web.signInAs(B, "owner");
  const h = (tok: string) => ({ authorization: `Bearer ${tok}`, "x-pack-request": "1" });
  const call = async (method: string, tok: string, p: string, body?: unknown) => { const r = await web.req(method, p, h(tok), body); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const get = (tok: string, p: string) => call("GET", tok, p);
  const staffOwner = await web.adminToken("owner"), staffOperator = await web.adminToken("operator");
  const staff = (method: string, tok: string, p: string, body?: unknown) => call(method, tok, `/api/admin/onboarding${p}`, body);
  const mcp = async (org: typeof A, userId: string | undefined, role: string | undefined) => connect({ ...org, userId, role } as never);
  const recA = ra.workspaceRecords("fixture_gaps", A.orgId), recB = ra.workspaceRecords("fixture_gaps", B.orgId);
  F.setFeaturesForTest(ALL);
  await ra.asWriter({ by: "people", id: owner.userId }, async () => {
    await recA.put("customers", "acme", { title: "Acme", data: { plan: "enterprise", status: "active", region: "eu-west" } });
    await recA.put("customers", "globex", { title: "Globex", data: { plan: "growth", status: "paused", region: "us-east" } });
    await recA.put("customers", "initech", { title: "Initech", data: { plan: "starter", status: "active", region: "eu-west" } });
    await recA.put("endpoints", "acme-api", { title: "Acme API", data: { customer: "acme", status: "live", address: "https://api.example.com" } });
    await recA.put("endpoints", "acme-old", { title: "Acme old API", data: { customer: "acme", status: "retired", address: "https://old.example.com" } });
    await recA.put("incidents", "inc-1", { title: "Checkout errors", data: { severity: "critical", customer: "acme", endpoint: "acme-api", opened: "2026-11-01", owner: "Payments", region: "eu-west" } });
  });
  await ra.asWriter({ by: "people", id: ownerB.userId }, () => recB.put("customers", "acme", { title: "Acme (B)", data: { plan: "growth", status: "active" } }));

  // ---------- 0. off ----------
  F.setFeaturesForTest(null);
  {
    for (const id of Object.keys(ALL)) assert.equal(F.featureOn(id as never), false, `${id} is off by default`);
    for (const p of ["/api/home/recent-runs", "/api/home/attention", "/api/analytics/runs?from=2026-11-01&to=2026-11-06"]) assert.equal((await get(owner.token, p)).status, 404, `off: ${p}`);
    assert.equal((await staff("GET", staffOwner, "/catalog-access")).status, 404, "off: no catalog access route");
    assert.equal((await staff("GET", staffOwner, "/run-analytics")).status, 404, "off: no staff run analytics");
    const c = await mcp(A, member.userId, "member");
    const tools = (await c.client.listTools()).tools;
    assert.ok(!tools.some((t) => t.name === "get_usage"), "off: get_usage is not listed");
    const start = tools.find((t) => t.name === "fixture_gaps_start_diagnose")!;
    assert.ok(start && !("record" in (start.inputSchema.properties ?? {})) && !("target_tenant" in (start.inputSchema.properties ?? {})), "off: the start tool takes no record and no tenant");
    await c.close();
    // Record rules off: a paused customer is not refused (the build refuses the declaration while off: gen-packs, lib/features.py).
    await ra.asWriter({ by: "people", id: owner.userId }, () => recA.put("incidents", "inc-off", { title: "Off", data: { severity: "low", customer: "globex" } }));
    await recA.delete("incidents", "inc-off");
    assert.equal((await call("PUT", owner.token, "/api/credentials", { pack: "fixture_gaps", name: "host_tokens", asset: "acme", entry: "db.acme.example.com", value: "tok-acme-db-0001" })).status, 404, "off: a credential set is not set");
    ok("off (the default): the routes answer nothing, the start tool takes no record or tenant, get_usage is not listed, rules and credential sets are not applied");
  }
  F.setFeaturesForTest(ALL);

  // ---------- 1. a run's input from its record ----------
  let runOnRecord = "";
  {
    const c = await mcp(A, member.userId, "member");
    const start = (await c.client.listTools()).tools.find((t) => t.name === "fixture_gaps_start_diagnose")!;
    assert.deepEqual((start.inputSchema.properties as any).record.properties.area.enum, ["incidents"], "the start tool's record: an area that has every field it reads");
    const r = await c.call("fixture_gaps_start_diagnose", { record: { area: "incidents", key: "inc-1" }, focus: "database" });
    assert.ok(!r.isError, JSON.stringify(r.content));
    runOnRecord = r.structuredContent.run.id;
    const [row] = await db.query<{ scope: Record<string, unknown>; record_area: string; record_key: string }>("SELECT scope, record_area, record_key FROM runs WHERE id = $1", [runOnRecord]);
    assert.deepEqual([row!.scope, row!.record_area, row!.record_key], [{ focus: "database", incident: "inc-1", severity: "critical", customer: "acme" }, "incidents", "inc-1"], "its arguments from the record, the run carries it");
    const bad = await c.call("fixture_gaps_start_diagnose", { record: { area: "incidents", key: "inc-1" }, severity: "low" });
    assert.ok(bad.isError && /severity comes from the record/.test(bad.content[0]!.text), "a value that disagrees with the record is refused");
    assert.ok((await c.call("fixture_gaps_start_diagnose", { record: { area: "incidents", key: "nope" } })).isError, "a record that is not there");
    const noRec = await c.call("fixture_gaps_start_diagnose", { focus: "x" });
    assert.ok(noRec.isError && /incident is required/.test(noRec.content[0]!.text), "without a record, a required argument it would give is required");
    assert.ok(!(await c.call("fixture_gaps_start_diagnose", { incident: "manual-1" })).isError, "without a record, given by hand as before");
    await c.close();
    const cb = await mcp(B, ownerB.userId, "owner");
    await ra.asWriter({ by: "people", id: ownerB.userId }, () => recB.put("incidents", "inc-b", { title: "B's", data: { severity: "low", customer: "acme" } }));
    assert.ok((await cb.call("fixture_gaps_start_diagnose", { record: { area: "incidents", key: "inc-1" } })).isError, "another workspace's record is not found");
    await cb.close();
    const cv = await mcp(A, viewer.userId, "viewer");
    assert.ok(!(await cv.client.listTools()).tools.some((t) => t.name === "fixture_gaps_start_diagnose"), "a viewer is not offered the start tool");
    await cv.close();
    // The record page's action: the record's values, never the browser's.
    const page = await get(member.token, "/api/records/_page/incidents/inc-1");
    const act = page.body.actions.find((a: any) => a.id === "start_run.diagnose");
    assert.deepEqual(act.run.from_record.sort(), ["customer", "incident", "severity"], "the page's form: what the record gives");
    const s = await call("POST", member.token, "/api/records/_page/incidents/inc-1/actions/start_run.diagnose", { input: { severity: "low", focus: "cache" } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const [p] = await db.query<{ scope: Record<string, unknown>; record_key: string }>("SELECT scope, record_key FROM runs WHERE id = $1", [s.body.run.id]);
    assert.deepEqual([p!.scope.severity, p!.scope.focus, p!.scope.incident, p!.record_key], ["critical", "cache", "inc-1", "inc-1"], "the page's run: the record's values, its own typed ones");
    ok("a run's input from its record: the start tool's record (disagreeing value refused, another workspace's record not found, a viewer not offered), the page's action (the record's values), the run carries the record");
  }

  // ---------- 2. private catalogs ----------
  {
    const { syncUpstreamCatalog } = await import("../src/data-repositories.js");
    const { setGithubEndpointsForTest, setAppConfig } = await import("../src/github-app.js");
    const list = await staff("GET", staffOperator, "/catalog-access");
    assert.deepEqual(list.body.catalogs.map((x: any) => [x.name, x.access, x.set]), [["runbooks", "deploy_key", false], ["standards", "github_app", false]], "staff read each private catalog and how it is read");
    await assert.rejects(syncUpstreamCatalog("fixture_gaps", "runbooks"), /deploy key is not set/, "not set: refused, saying where to set it");
    assert.equal((await staff("PUT", staffOperator, "/catalog-access/fixture_gaps/runbooks", { private_key: DEPLOY_KEY, known_hosts: KNOWN })).status, 403, "an operator may not set a key (owners: keys)");
    assert.equal((await staff("PUT", staffOwner, "/catalog-access/fixture_gaps/runbooks", { private_key: "nope", known_hosts: KNOWN })).status, 400, "not a key");
    assert.equal((await staff("PUT", staffOwner, "/catalog-access/fixture_gaps/runbooks", { private_key: DEPLOY_KEY, known_hosts: KNOWN.replace("git.example.com", "evil.example.com") })).status, 400, "a host key for another host");
    const set = await staff("PUT", staffOwner, "/catalog-access/fixture_gaps/runbooks", { private_key: DEPLOY_KEY, known_hosts: KNOWN });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const after = JSON.stringify((await staff("GET", staffOperator, "/catalog-access")).body);
    assert.ok(after.includes("deploy key ") && !after.includes("BEGIN OPENSSH") && !after.includes("b3BlbnNz"), "read back: a fingerprint, never the key");
    assert.equal((await get(owner.token, "/api/admin/onboarding/catalog-access")).status === 200, false, "a workspace's person never reads it");
    process.env.PATH = `${BIN}:${process.env.PATH}`;
    const rep = await syncUpstreamCatalog("fixture_gaps", "runbooks");
    assert.deepEqual([rep.version, rep.areas.map((x: any) => [x.area, x.created])], [PIN, [["runbooks", 2]]], "over SSH at the pin: indexed");
    const log = readFileSync(SSH_LOG, "utf8");
    assert.match(log, /IdentitiesOnly=yes/); assert.match(log, /StrictHostKeyChecking=yes/); assert.match(log, /BatchMode=yes/);
    assert.match(log, /MODE 600/, "the key file is the fetch's own, 0600"); assert.match(log, /KEY -----BEGIN OPENSSH PRIVATE KEY-----/, "with the key staff set");
    F.setFeaturesForTest({ ...ALL, private_catalogs: false });
    await assert.rejects(syncUpstreamCatalog("fixture_gaps", "runbooks"), /features\.private_catalogs/, "off: a private catalog is not fetched");
    F.setFeaturesForTest(ALL);
    // The GitHub App: the platform's own installation, a token for that one repository, revoked after.
    setGithubEndpointsForTest({ api: GH, web: GH });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    await setAppConfig({ app_id: "123", slug: "example-app", client_id: "Iv1.0123456789abcdef", client_secret: "s".repeat(20), webhook_secret: "w".repeat(20), private_key: privateKey });
    assert.equal((await staff("PUT", staffOwner, "/catalog-access/fixture_gaps/standards", { installation_id: "nope" })).status, 400);
    assert.equal((await staff("PUT", staffOwner, "/catalog-access/fixture_gaps/standards", { installation_id: "4242" })).status, 200);
    const rep2 = await syncUpstreamCatalog("fixture_gaps", "standards", { fetcher: fakeGithub });
    assert.deepEqual([rep2.version, rep2.areas.map((x: any) => [x.area, x.created])], [STD_PIN, [["standards", 1]]], "over HTTPS with the installation's token, at the pin");
    assert.deepEqual(gh.asked, [{ repositories: ["standards"], permissions: { contents: "read" } }], "a token for that one repository, read contents only");
    assert.ok(ghSeen.every((x) => x.endsWith(`token ${TOKEN}`)), "every request carries it in a header");
    assert.equal(gh.revoked, 1, "revoked when the fetch is done");
    assert.equal((await staff("DELETE", staffOwner, "/catalog-access/fixture_gaps/standards")).body.removed, true);
    await assert.rejects(syncUpstreamCatalog("fixture_gaps", "standards", { fetcher: fakeGithub }), /installation is not set/, "removed: refused again");
    ok("private catalogs: staff (owners) set a deploy key or the GitHub App's installation, read back only a fingerprint; SSH with that key alone and the host's key, HTTPS with a one-repository token revoked after; pinned; refused while off or unset");
  }

  // ---------- 3, 4. sections and columns ----------
  {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
    assert.ok(TabSchema.safeParse({ id: "s", kind: "sections", sections: ids(8) }).success, "a sections tab of 8 tabs");
    assert.ok(!TabSchema.safeParse({ id: "s", kind: "sections", sections: ids(9) }).success, "9 refused");
    const fields = Array.from({ length: 13 }, (_, i) => ({ name: `f${i}`, label: `F${i}` }));
    const area = (n: number) => RecordAreaSchema.safeParse({ name: "wide", label: "Wide", role: "check", scope: "workspace", fields, list_columns: fields.slice(0, n).map((f) => f.name) });
    assert.ok(area(12).success && !area(13).success, "a list of 12 columns, 13 refused");
    assert.equal(F.featureRequested("wide_lists"), true, "a list past 8 asks for wide_lists (off: gen-packs refuses it)");
    ok("a sections tab holds up to 8 tabs; a list up to 12 columns, past 8 with wide_lists");
  }

  // ---------- 5. references limited by a condition; checks on save ----------
  {
    const put = (key: string, data: Record<string, unknown>) => call("PUT", member.token, `/api/data/incidents/${key}`, { title: key, data: { severity: "high", ...data } });
    const paused = await call("POST", member.token, "/api/data/incidents", { key: "inc-2", title: "x", data: { severity: "high", customer: "globex" } });
    assert.equal(paused.status, 400, JSON.stringify(paused.body));
    assert.match(paused.body.error, /globex is not a Customers record whose status is active/, "a paused customer: refused, in words");
    assert.match((await call("POST", member.token, "/api/data/incidents", { key: "inc-2", title: "x", data: { severity: "high", customer: "acme", endpoint: "acme-old" } })).body.error, /acme-old is not a Endpoints record whose status is live/, "a retired endpoint: refused");
    const starter = await call("POST", member.token, "/api/data/incidents", { key: "inc-2", title: "x", data: { severity: "high", customer: "initech" } });
    assert.equal(starter.status, 409, JSON.stringify(starter.body));
    assert.equal(starter.body.error, "Incidents are opened for customers on a support plan only (growth or enterprise).", "a check on save: refused with its message");
    assert.equal((await call("POST", member.token, "/api/data/incidents", { key: "inc-2", title: "Slow search", data: { severity: "high", customer: "acme", endpoint: "acme-api", eta: "2026-01-01" } })).status, 201, "an active customer on a support plan, a live endpoint: saved");
    void put;
    const cm = await mcp(A, member.userId, "member");
    const viaMcp = await cm.call("fixture_gaps_create_incidents", { key: "inc-3", title: "x", data: { severity: "low", customer: "initech" } });
    assert.ok(viaMcp.isError && /support plan/.test(viaMcp.content[0]!.text), "the MCP tool refuses the same");
    await cm.close();
    const cB = await call("POST", ownerB.token, "/api/data/incidents", { key: "inc-9", title: "x", data: { severity: "low", customer: "initech" } });
    assert.match(cB.body.error, /no customers record initech in this workspace/, "another workspace's customer is not there");
    const pick = await get(member.token, `/api/records/_page/_pick/customers?q=&where=${encodeURIComponent(JSON.stringify({ field: "status", equals: "active" }))}`);
    assert.deepEqual(pick.body.records.map((x: any) => x.key).sort(), ["acme", "initech"], "the picker lists what the condition keeps");
    const form = await get(member.token, "/api/tab-actions/fixture_gaps/incidents");
    const cust = JSON.stringify(form.body).includes("whose status is active");
    assert.ok(cust, "the create form's field carries its condition in words");
    ok("references limited by a condition on their target (the data API, a retired endpoint, another workspace's key, the picker), checks on save refusing with their message (the data API, the MCP tool)");
  }

  // ---------- 6. credential sets and tenants ----------
  {
    const put = (tok: string, entry: unknown, value = "tok-0123456789") => call("PUT", tok, "/api/credentials", { pack: "fixture_gaps", name: "host_tokens", asset: "acme", entry, value });
    assert.equal((await put(member.token, "db.acme.example.com")).status, 403, "a member may not set one");
    assert.equal((await put(owner.token, undefined)).status, 400, "a value without its label is refused");
    assert.equal((await put(owner.token, "db.acme.example.com", "tok-acme-db-0001")).status, 200);
    assert.equal((await put(owner.token, "cache.acme.example.com", "tok-acme-cache-02")).status, 200);
    const page = await get(owner.token, "/api/credentials?area=customers&key=acme");
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.deepEqual(page.body.values.map((v: any) => [v.entry, v.last4]), [["cache.acme.example.com", "e-02"], ["db.acme.example.com", "0001"]], "the tenant's page: each host, its last 4 (owners)");
    assert.ok(page.body.fields[0].entries && page.body.fields[0].bound_to === "tenant");
    assert.ok((await get(viewer.token, "/api/credentials?area=customers&key=acme")).body.values.every((v: any) => v.last4 === null), "a viewer: which are set, never the last 4");
    assert.equal((await get(ownerB.token, "/api/credentials?area=customers&key=acme")).body.values.length, 0, "workspace B's acme has none of A's");
    const { runCredentials, runSecrets } = await import("../src/credentials.js");
    const run = { id: runOnRecord, org_id: A.orgId, pack: "fixture_gaps", spec: { credentials: ["host_tokens"] }, targets: { tenant: { area: "customers", key: "acme" } } };
    const got = await runCredentials(run);
    assert.deepEqual(JSON.parse(got.credentials[0]!.value), { "cache.acme.example.com": "tok-acme-cache-02", "db.acme.example.com": "tok-acme-db-0001" }, "a run on the tenant: one JSON object of its hosts");
    assert.deepEqual((await runCredentials({ ...run, targets: { tenant: { area: "customers", key: "globex" } } })).missing, ["host_tokens"], "another tenant: none of acme's");
    assert.deepEqual((await runCredentials({ ...run, org_id: B.orgId })).missing, ["host_tokens"], "another workspace's run: none");
    const secrets = (await runSecrets(run)).map((s) => s.value);
    assert.ok(secrets.includes("tok-acme-db-0001") && secrets.includes("tok-acme-cache-02"), "each value redacted on its own");
    const c = await mcp(A, owner.userId, "owner");
    const st = await c.call("fixture_gaps_start_diagnose", { incident: "manual-2", target_tenant: { area: "customers", key: "acme" } });
    assert.ok(!st.isError, JSON.stringify(st.content));
    const [tr] = await db.query<{ targets: any }>("SELECT targets FROM runs WHERE id = $1", [st.structuredContent.run.id]);
    assert.deepEqual(tr!.targets.tenant, { area: "customers", key: "acme" }, "the start tool's target_tenant");
    await c.close();
    assert.equal((await call("DELETE", owner.token, "/api/credentials", { pack: "fixture_gaps", name: "host_tokens", asset: "acme", entry: "cache.acme.example.com" })).status, 200);
    assert.deepEqual(Object.keys(JSON.parse((await runCredentials(run)).credentials[0]!.value)), ["db.acme.example.com"], "one host removed, the other kept");
    ok("credential sets on a tenant: owners set each labelled value, the tenant's page lists them (never another workspace's), a run on the tenant receives them as one JSON object (another tenant or workspace: none), each value redacted, one removed alone");
  }

  // ---------- 7. Overview cards ----------
  {
    await asPlatform(() => db.query("UPDATE runs SET status = 'failed', error_kind = 'run', error = 'Timed out after 1200 seconds', cost_usd = 0.42 WHERE id = $1", [runOnRecord]));
    const runs = await get(member.token, "/api/home/recent-runs");
    assert.ok(runs.body.runs.length >= 3 && runs.body.runs.every((r: any) => r.label === "Diagnose an incident"), "recent runs, in the pack's words");
    assert.ok(!(await get(ownerB.token, "/api/home/recent-runs")).body.runs.some((r: any) => r.id === runOnRecord), "B never sees A's");
    const att = await get(viewer.token, "/api/home/attention");
    assert.deepEqual(att.body.records.map((r: any) => [r.key, r.tone, r.notice]), [["inc-1", "danger", "Critical and open"], ["inc-2", "warning", "Past its fix-by date"], ["globex", "warning", "Paused"]], "needs attention: danger first, as a viewer reads");
    assert.ok(!(await get(ownerB.token, "/api/home/attention")).body.records.some((r: any) => r.key === "inc-1"), "B: its own records only");
    ok("the home page's Recent runs and Needs attention cards: per workspace, read as the person, danger first");
  }

  // ---------- 8. run analytics ----------
  {
    await asPlatform(async () => {
      await db.query("INSERT INTO run_events (run_id, org_id, attempt, type, data) VALUES ($1, $2, 1, 'agent_usage', $3)", [runOnRecord, A.orgId, JSON.stringify({ models: { "model-large": { provider: "anthropic", requests: 9, input_tokens: 120000, output_tokens: 4000, cost_usd: 0.4 } } })]);
      await db.query("INSERT INTO run_events (run_id, org_id, attempt, type, data) VALUES ($1, $2, 1, 'tool_call', $3), ($1, $2, 1, 'tool.read_logs', $4)", [runOnRecord, A.orgId, JSON.stringify({ name: "query_db" }), JSON.stringify({ error: "denied" })]);
    });
    const today = new Date().toISOString().slice(0, 10);
    const q = `/api/analytics/runs?from=${today}&to=${today}`;
    assert.equal((await get(member.token, q)).status, 403, "a member may not read it (billing managers and owners)");
    const a = (await get(owner.token, q)).body;
    assert.ok(a.totals.runs >= 4 && a.totals.failed === 1, JSON.stringify(a.totals));
    assert.deepEqual(a.by_record.find((r: any) => r.key === "inc-1")?.label, "Incidents · inc-1", "by record");
    assert.ok(a.by_person.some((p: any) => p.person === "You" || /@/.test(p.person)), "by person");
    assert.deepEqual(a.by_model.map((m: any) => [m.model, m.input_tokens]), [["model-large", 120000]], "tokens by model");
    assert.deepEqual(a.by_tool.map((t: any) => [t.tool, t.errors]).sort(), [["query_db", 0], ["read_logs", 1]], "by tool");
    assert.deepEqual(a.by_failure.map((f: any) => f.reason), ["run: Timed out after <n> seconds"], "by failure reason");
    assert.equal((await get(owner.token, `${q}&status=failed`)).body.totals.runs, 1, "filtered by status");
    const b = (await get(ownerB.token, q)).body;
    assert.ok(!b.by_record.some((r: any) => r.key === "inc-1") && b.by_model.length === 0, "B: its own runs only");
    const s = await staff("GET", staffOperator, `/run-analytics?from=${today}&to=${today}`);
    assert.ok(s.body.by_workspace.some((w: any) => w.slug === A.slug) && s.body.totals.runs >= a.totals.runs, "staff: every workspace's runs, by workspace");
    assert.equal((await staff("GET", staffOperator, `/run-analytics?from=${today}&to=${today}&workspace=${A.slug}`)).body.totals.runs, a.totals.runs, "staff: one workspace");
    assert.equal((await staff("GET", staffOperator, `/run-analytics?from=${today}&to=${today}&workspace=${B.slug}`)).body.totals.runs, b.totals.runs, "staff: another");
    assert.equal((await get(owner.token, `/api/admin/onboarding/run-analytics?from=${today}&to=${today}`)).status === 200, false, "a workspace's person never reads staff's");
    ok("run analytics by record, person, model (tokens), tool and failure reason; billing managers and owners; each workspace its own; staff across workspaces or one");
  }

  // ---------- 10. get_usage ----------
  {
    const co = await mcp(A, owner.userId, "owner"), cm = await mcp(A, member.userId, "member"), cb = await mcp(B, ownerB.userId, "owner");
    const u = (await co.call("get_usage", {})).structuredContent;
    assert.equal(u.scope, "workspace"); assert.ok(u.runs.total >= 4 && u.spend_usd >= 0.42 && u.tokens.by_model[0].model === "model-large", JSON.stringify(u));
    const m = (await cm.call("get_usage", {})).structuredContent;
    assert.equal(m.scope, "you"); assert.ok(m.runs.total >= 2 && m.runs.total < u.runs.total, "a member: their own runs");
    assert.equal((await cb.call("get_usage", {})).structuredContent.tokens.input, 0, "B: none of A's");
    assert.ok((await co.call("get_usage", { from: "2026-13-01" })).isError, "a bad date refused");
    await co.close(); await cm.close(); await cb.close();
    ok("get_usage over MCP: owners the whole workspace, members their own runs, each workspace its own");
  }

  await web.close();
  ghServer.close();
  console.log("generic gaps: all checks passed");
} finally {
  cleanup();
}
process.exit(0);
