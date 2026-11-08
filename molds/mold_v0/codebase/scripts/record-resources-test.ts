// Record-owned resources (mold_v0-282, flag record_resources; src/record-resources.ts, src/github-app.ts
// readRecordRepository), offline: an embedded database, the HTTP server, a declared pack with a shared area whose records
// own a GitHub repository and a Neon database, a stand-in for Neon's API v2 and a stand-in for GitHub's.
//   npm run test:record-resources
//
// 1. The declaration: a repository or database field only on a shared area written by staff (never a workspace area, a
//    repository-fed area or a run's argument); a database field names its provider and takes no value; with the flag off
//    the record's resources answer not found.
// 2. No Neon key: the New form leaves the database field out and says the key is missing and where it is added; Health
//    says the same; a record added anyway is stored, its database failed with that reason and a Retry.
// 3. The Neon key in the key vault (a direct-mode key, accepted: the server's own; never given to a session or a run):
//    Retry creates one Neon project for the record; its connection string is sealed in record_resources (never in the
//    record's fields, never in an answer), opened only by the server's own code; a new record gets its database at once;
//    an import's records each get theirs after the batch commits; a database value written by hand is refused.
// 4. Repositories: one the platform's GitHub App can read is saved and shown with its default branch and last commit (an
//    empty one with none); one the app is not installed on, or may not read, refuses the write in plain words naming
//    where to fix it; an unchanged repository is not read again on save; no GitHub App: the words say where to set it.
// 5. Neon failing: the record is stored and its database failed with Neon's words (never a connection string); Retry
//    makes it. Delete: confirmed by the caller, the Neon project is deleted first; Neon refusing keeps the record and its
//    database ("nothing was deleted"); then the delete goes through and the project and its row are gone; one Neon no
//    longer knows counts as deleted. In a batch a database-owning record's delete is refused.
// 6. Rotating the vault's master key re-seals the connection strings; Health is ok once the key is there.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";

const ok = (m: string) => console.log(`✓ ${m}`);
const NEON_KEY = `neon_test_${randomBytes(8).toString("hex")}`;
const SECRET_PW = `pw${randomBytes(6).toString("hex")}`;

// ---------- the stand-in Neon API v2 ----------
const projects = new Map<string, { name: string }>();
const neonCalls: string[] = [];
let neonFail: { create?: number; del?: number } = {};
const neon = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const send = (s: number, b?: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(b === undefined ? "" : JSON.stringify(b)); };
    if (req.headers.authorization !== `Bearer ${NEON_KEY}`) return send(401, { message: "authentication required" });
    const url = new URL(String(req.url), "http://neon");
    neonCalls.push(`${req.method} ${url.pathname}`);
    if (req.method === "POST" && url.pathname === "/projects") {
      if (neonFail.create) { const s = neonFail.create; neonFail.create = undefined; return send(s, { message: `boom at postgresql://x:${SECRET_PW}@leak/db` }); }
      const b = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const id = `proj-${randomBytes(5).toString("hex")}`;
      projects.set(id, { name: b.project?.name });
      return send(201, { project: { id, name: b.project?.name, region_id: "aws-us-east-2" },
        connection_uris: [{ connection_uri: `postgresql://neondb_owner:${SECRET_PW}@ep-${id}.us-east-2.aws.neon.tech/neondb?sslmode=require`,
          connection_parameters: { database: "neondb", role: "neondb_owner", host: `ep-${id}.us-east-2.aws.neon.tech`, password: SECRET_PW } }] });
    }
    const m = /^\/projects\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && m) {
      if (neonFail.del) { const s = neonFail.del; neonFail.del = undefined; return send(s, { message: "project is locked" }); }
      if (!projects.has(m[1]!)) return send(404, { message: "project not found" });
      projects.delete(m[1]!);
      return send(200, { project: { id: m[1] } });
    }
    send(404, { message: "no such route" });
  });
});

// ---------- the stand-in GitHub ----------
// Installation 77 on acme reads acme/widgets and acme/empty, not acme/secret; nothing is installed on ghost.
const REPOS: Record<string, { installation: number | null; allowed: boolean; empty?: boolean }> = {
  "acme/widgets": { installation: 77, allowed: true }, "acme/empty": { installation: 77, allowed: true, empty: true },
  "acme/secret": { installation: 77, allowed: false },
};
const tokens = new Set<string>();
const ghCalls: string[] = [];
const gh = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const send = (s: number, b?: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(b === undefined ? "" : JSON.stringify(b)); };
    const url = new URL(String(req.url), "http://gh");
    ghCalls.push(`${req.method} ${url.pathname}`);
    const auth = String(req.headers.authorization ?? "");
    let m = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(url.pathname);
    if (m && req.method === "GET") {
      if (!auth.startsWith("Bearer ey")) return send(401, { message: "a JWT" });
      const r = REPOS[`${m[1]}/${m[2]}`];
      return r?.installation ? send(200, { id: r.installation }) : send(404, { message: "Not Found" });
    }
    m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (m && req.method === "POST") {
      const b = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const names: string[] = b.repositories ?? [];
      const full = names.map((n) => `acme/${n}`);
      if (!full.length || full.some((f) => !REPOS[f]?.allowed)) return send(422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
      const t = `ghs_${randomBytes(10).toString("hex")}`; tokens.add(t);
      return send(201, { token: t, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { contents: "read", metadata: "read" }, repositories: full.map((f, i) => ({ id: 100 + i, full_name: f })) });
    }
    if (url.pathname === "/installation/token" && req.method === "DELETE") { tokens.delete(auth.replace(/^token /, "")); return send(204); }
    const tok = auth.replace(/^token /, "");
    if (!tokens.has(tok)) return send(401, { message: "Bad credentials" });
    m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (m) return send(200, { full_name: `${m[1]}/${m[2]}`, default_branch: "main", private: true, html_url: `https://github.com/${m[1]}/${m[2]}` });
    m = /^\/repos\/([^/]+)\/([^/]+)\/commits\/main$/.exec(url.pathname);
    if (m) return REPOS[`${m[1]}/${m[2]}`]?.empty ? send(409, { message: "Git Repository is empty." })
      : send(200, { sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", commit: { message: "Add the widget\n\nlong body", author: { name: "Ada", date: "2026-11-01T10:00:00Z" } } });
    send(404, { message: "Not Found" });
  });
});

const PACK = {
  id: "fixture_resources", name: "Fixture resources", version: "0.1.0",
  record_areas: [
    { name: "fx_molds", label: "Molds", role: "source", scope: "platform", fields: [
      { name: "summary", label: "Summary", type: "text" },
      { name: "repo", label: "Repository", type: "repository" },
      { name: "database", label: "Database", type: "database", provider: "neon" }] },
    { name: "fx_notes", label: "Notes", role: "source", scope: "platform", fields: [{ name: "note", label: "Note", type: "text" }] },
  ],
};

try {
  await new Promise<void>((r) => neon.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => gh.listen(0, "127.0.0.1", r));
  process.env.NEON_API_URL = `http://127.0.0.1:${(neon.address() as AddressInfo).port}`;
  const F = await import("../src/features.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { RecordAreaSchema, JobKindSchema } = await import("../src/pack-api.js");
  setPacksForTest([{ manifest: { id: "fixture_resources", name: "Fixture resources", version: "0.1.0", entry: null, migrations: null, words: {}, dir: "." }, declared: compileDeclarations(PACK) } as never]);
  const http_ = await startHttp();
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const owner = await http_.adminToken("owner"), viewer = await http_.adminToken("viewer");
  const staff = (tok: string) => ({ authorization: `Bearer ${tok}`, "x-app-admin": "1", "x-pack-request": "1" });
  const json = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t }; } };
  const call = async (method: string, p: string, body?: unknown, tok = owner) => { const r = await http_.req(method, p, staff(tok), body); return { status: r.status, body: await json(r) }; };
  const resourcesOf = (key: string) => call("GET", `/api/admin/records/_resources/fx_molds/${key}`);
  const rec = await import("../src/record-areas.js");
  const RR = await import("../src/record-resources.js");
  const area = rec.findArea("fx_molds")!;
  const noSecret = (what: string, v: unknown) => assert.ok(!JSON.stringify(v).includes(SECRET_PW), `${what}: no connection string or password in it`);

  // ---------- 1. the declaration, and the flag ----------
  {
    const bad = (a: unknown) => RecordAreaSchema.safeParse(a);
    assert.match(JSON.stringify(bad({ name: "w", label: "W", role: "source", scope: "workspace", fields: [{ name: "r", label: "R", type: "repository" }] }).error?.issues), /shared \(platform\) area/);
    assert.match(JSON.stringify(bad({ name: "w", label: "W", role: "source", scope: "platform", repository: "cat", fields: [{ name: "d", label: "D", type: "database", provider: "neon" }] }).error?.issues), /written through the record store/);
    assert.match(JSON.stringify(bad({ name: "w", label: "W", role: "source", scope: "platform", fields: [{ name: "d", label: "D", type: "database" }] }).error?.issues), /names its provider/);
    assert.match(JSON.stringify(bad({ name: "w", label: "W", role: "source", scope: "platform", fields: [{ name: "d", label: "D", type: "database", provider: "neon", required: true }] }).error?.issues), /cannot be required/);
    assert.match(JSON.stringify(bad({ name: "w", label: "W", role: "source", scope: "platform", fields: [{ name: "t", label: "T", type: "text", provider: "neon" }] }).error?.issues), /provider is for a database field/);
    assert.ok(JobKindSchema.safeParse({ name: "kk", label: "K", runner: "workspace-harness", entry: "packs/x/run.mjs", args: [{ name: "aa", label: "A", type: "text" }] }).success, "a kind with a text argument is right");
    assert.match(JSON.stringify(JobKindSchema.safeParse({ name: "kk", label: "K", runner: "workspace-harness", entry: "packs/x/run.mjs", args: [{ name: "rr", label: "R", type: "repository" }] }).error?.issues), /repository and database are a shared record area's fields, not a job kind's arguments/);
    assert.ok(bad(PACK.record_areas[0]).success, "the fixture's shared area with both fields is declared right");
    F.setFeatureForTest("record_resources", false);
    assert.equal((await call("POST", "/api/admin/data/fx_molds", { key: "off-one", title: "Off", data: { summary: "x" } })).status, 201, "flag off: the area writes as any other");
    assert.equal((await resourcesOf("off-one")).status, 404, "flag off: a record's resources answer not found");
    assert.equal((await db.query("SELECT 1 FROM record_resources")).length, 0, "flag off: no database is made");
    assert.equal(await (await import("../src/vault-providers.js")).providerInBuild("neon", 0), false, "flag off: Key vault does not list Neon");
    F.setFeatureForTest("record_resources", true);
    assert.equal(await (await import("../src/vault-providers.js")).providerInBuild("neon", 0), true, "flag on, an area owns a database: Key vault lists Neon");
    assert.equal(F.featureOn("record_resources"), true);
    ok("the declaration: repository and database fields only on a shared area written by staff, never a run's argument; a database names its provider and is never required; the flag alone shows the resources and Neon on Key vault");
  }

  // ---------- 2. no Neon key ----------
  {
    const form = (await call("GET", "/api/admin/records/_console/fx_molds/form")).body;
    assert.deepEqual(form.fields.map((f: { name: string }) => f.name), ["summary", "repo"], "the New form leaves the database field out (the platform creates it)");
    assert.match(form.resources.database_key_missing, /No Neon key.*Admin › Key vault/, "it says the Neon key is missing and where it is added");
    assert.equal((await call("GET", "/api/admin/records/_console/fx_notes/form")).body.resources, undefined, "an area with no resource field says nothing of them");
    const health = (await call("GET", "/api/admin/onboarding/health/status")).body;
    const check = health.checks?.find((c: { id: string }) => c.id === "record_databases");
    assert.equal(check?.state, "bad", `Health: the record databases check is bad (${JSON.stringify(health.checks?.map((c: { id: string }) => c.id))})`);
    assert.match(health.database_key_missing?.text ?? "", /No Neon key.*Admin › Key vault/, "Health says where to add it");
    const r = await call("POST", "/api/admin/data/fx_molds", { key: "nokey", title: "No key", data: { summary: "added without a key" } });
    assert.equal(r.status, 201, `the record is stored (${JSON.stringify(r.body)})`);
    const [d] = (await resourcesOf("nokey")).body.databases;
    assert.equal(d.status, "failed"); assert.match(d.reason, /No Neon key/); assert.equal(d.retry, true);
    assert.equal(neonCalls.length, 0, "Neon was never called without a key");
    ok("no Neon key: the New form and Health say it is missing and where to add it; a record added anyway is stored, its database failed with that reason and a Retry");
  }

  // ---------- 3. the key, Retry, a new record, an import ----------
  {
    const { setCredential } = await import("../src/keyvault.js");
    await setCredential("neon", NEON_KEY);
    const { KEYS_NEVER_INJECTED } = await import("../src/agent-profiles.js");
    const { ORCHESTRATOR_ONLY_PROVIDERS } = await import("../src/gateway.js");
    assert.ok((KEYS_NEVER_INJECTED as readonly string[]).includes("neon") && ORCHESTRATOR_ONLY_PROVIDERS.has("neon"), "the Neon key is never given to a session or brokered to a run");
    assert.equal((await call("POST", "/api/admin/records/_resources/fx_molds/nokey/database/retry", {}, viewer)).status, 403, "a staff viewer cannot retry");
    const r = await call("POST", "/api/admin/records/_resources/fx_molds/nokey/database/retry", {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.database.status, "ready"); noSecret("the retry's answer", r.body);
    assert.match(r.body.database.project_id, /^proj-/); assert.equal(r.body.database.database, "neondb"); assert.equal(r.body.database.region, "aws-us-east-2");
    assert.equal(projects.get(r.body.database.project_id)?.name, "fixture_resources-fx_molds-nokey", "one Neon project, named for the record");
    assert.equal((await call("POST", "/api/admin/records/_resources/fx_molds/nokey/database/retry", {})).status, 409, "a ready database is not retried");
    // A new record gets its database at once.
    const c = await call("POST", "/api/admin/data/fx_molds", { key: "alpha", title: "Alpha", data: { summary: "a mold" } });
    assert.equal(c.status, 201); noSecret("the create's answer", c.body);
    assert.equal(c.body.record.data.database, undefined, "the record's fields hold no database value");
    const res = (await resourcesOf("alpha")).body; noSecret("the resources answer", res);
    assert.equal(res.databases[0].status, "ready");
    const [row] = await db.query<{ secret_ciphertext: string; details: unknown; external_id: string }>("SELECT secret_ciphertext, details, external_id FROM record_resources WHERE record_key = 'alpha'");
    assert.ok(row && !row.secret_ciphertext.includes(SECRET_PW)); noSecret("the stored details", row.details);
    const [stored] = await db.query<{ data: unknown }>("SELECT data FROM platform_records WHERE area = 'fx_molds' AND key = 'alpha'");
    noSecret("the record's stored fields", stored);
    assert.match(String(await RR.recordDatabaseUrl(area, "alpha", "database")), new RegExp(`^postgresql://neondb_owner:${SECRET_PW}@ep-${row.external_id}`), "the server's own code opens the sealed connection string");
    for (const p of ["/api/admin/data/fx_molds/alpha", "/api/admin/records/fx_molds/alpha", "/api/admin/data/fx_molds"]) noSecret(p, (await call("GET", p)).body);
    // A value for the database field is refused.
    const v = await call("POST", "/api/admin/data/fx_molds", { key: "beta", data: { database: "postgresql://x" } });
    assert.equal(v.status, 400); assert.match(v.body.error, /creates the record's database itself/);
    // An import: each record its database, after the batch commits.
    const before = projects.size;
    const imp = await call("POST", "/api/admin/records/_console/fx_molds/import", { dry_run: false, rows: [{ key: "imp-1", title: "One", data: { summary: "1" } }, { key: "imp-2", title: "Two", data: { summary: "2" } }] });
    assert.equal(imp.status, 200, JSON.stringify(imp.body));
    assert.equal(projects.size, before + 2, "two Neon projects for the two imported records");
    for (const k of ["imp-1", "imp-2"]) assert.equal((await resourcesOf(k)).body.databases[0].status, "ready");
    // An edit keeps the record's database (no second project).
    assert.equal((await call("PUT", "/api/admin/data/fx_molds/alpha", { title: "Alpha 2", data: { summary: "edited" } })).status, 200);
    assert.equal(projects.size, before + 2, "an edit makes no second database");
    ok("the Neon key: Retry creates one Neon project per record; a new record and each imported one get theirs; the connection string is sealed, never in the fields or an answer, opened only by the server's code; a database value is refused; an edit keeps it");
  }

  // ---------- 4. repositories ----------
  {
    // No GitHub App yet: plain words, where to set it.
    let r = await call("POST", "/api/admin/data/fx_molds", { key: "repo-1", data: { repo: "acme/widgets" } });
    assert.equal(r.status, 400); assert.match(r.body.error, /GitHub App is not set up.*Admin › Key vault, GitHub App/);
    const { setAppConfig, setGithubEndpointsForTest } = await import("../src/github-app.js");
    setGithubEndpointsForTest({ api: `http://127.0.0.1:${(gh.address() as AddressInfo).port}`, web: "https://github.com" });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    await setAppConfig({ app_id: "12345", slug: "example-platform", client_id: "Iv1.abcdef0123", client_secret: "s".repeat(20), private_key: privateKey, webhook_secret: "w".repeat(20) });
    r = await call("POST", "/api/admin/data/fx_molds", { key: "repo-1", title: "Repo one", data: { repo: "acme/widgets" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const res = (await resourcesOf("repo-1")).body;
    assert.deepEqual([res.repositories[0].repository, res.repositories[0].default_branch, res.repositories[0].last_commit?.sha.slice(0, 7), res.repositories[0].last_commit?.message],
      ["acme/widgets", "main", "a1b2c3d", "Add the widget"], "its page: the default branch and the last commit's first line");
    assert.equal(tokens.size, 0, "every token minted to read it was revoked");
    r = await call("POST", "/api/admin/data/fx_molds", { key: "repo-2", data: { repo: "acme/empty" } });
    assert.equal(r.status, 201); assert.equal((await resourcesOf("repo-2")).body.repositories[0].last_commit, null, "an empty repository: no commit yet");
    r = await call("POST", "/api/admin/data/fx_molds", { key: "repo-3", data: { repo: "acme/secret" } });
    assert.equal(r.status, 400); assert.match(r.body.error, /Repository: The platform's GitHub App is installed on acme but may not read acme\/secret.*example-platform.*give it access to secret/);
    r = await call("POST", "/api/admin/data/fx_molds", { key: "repo-4", data: { repo: "ghost/nothing" } });
    assert.equal(r.status, 400); assert.match(r.body.error, /does not exist, or the app is not installed.*install it there first/);
    assert.equal((await db.query("SELECT 1 FROM platform_records WHERE key IN ('repo-3', 'repo-4')")).length, 0, "a repository the app cannot read stores nothing");
    r = await call("POST", "/api/admin/data/fx_molds", { key: "repo-5", data: { repo: "not a repo" } });
    assert.equal(r.status, 400); assert.match(r.body.error, /owner\/name/);
    const n = ghCalls.length;
    assert.equal((await call("PUT", "/api/admin/data/fx_molds/repo-1", { title: "Repo one, renamed", data: { repo: "acme/widgets" } })).status, 200);
    assert.equal(ghCalls.length, n, "an unchanged repository is not read again on save");
    ok("repositories: one the platform's GitHub App reads is saved and shown with its default branch and last commit (an empty one with none); one it is not installed on or may not read refuses the write in plain words, naming where to fix it; no app: where to set it; an unchanged one is not read again");
  }

  // ---------- 5. Neon failing, and delete ----------
  {
    neonFail.create = 500;
    let r = await call("POST", "/api/admin/data/fx_molds", { key: "flaky", title: "Flaky", data: { summary: "x" } });
    assert.equal(r.status, 201, "the record is stored whatever Neon says");
    let d = (await resourcesOf("flaky")).body.databases[0];
    assert.equal(d.status, "failed"); assert.match(d.reason, /Neon answered 500: boom/); noSecret("a failed database's reason", d);
    r = await call("POST", "/api/admin/records/_resources/fx_molds/flaky/database/retry", {});
    assert.equal(r.body.database.status, "ready", "Retry makes it");
    const project = r.body.database.project_id as string;
    // Delete: Neon refusing keeps everything.
    neonFail.del = 500;
    r = await call("DELETE", "/api/admin/data/fx_molds/flaky");
    assert.equal(r.status, 502); assert.match(r.body.error, /could not be deleted at Neon.*nothing was deleted, the record stays/);
    assert.ok(projects.has(project) && (await call("GET", "/api/admin/data/fx_molds/flaky")).status === 200, "the record and its project stay");
    assert.equal((await call("DELETE", "/api/admin/data/fx_molds/flaky", undefined, viewer)).status, 403, "a staff viewer deletes nothing");
    r = await call("DELETE", "/api/admin/data/fx_molds/flaky");
    assert.equal(r.status, 204, JSON.stringify(r.body));
    assert.ok(!projects.has(project), "the Neon project is deleted with the record");
    assert.equal((await db.query("SELECT 1 FROM record_resources WHERE record_key = 'flaky'")).length, 0, "and its row");
    // A project Neon no longer knows counts as deleted.
    const gone = (await resourcesOf("imp-1")).body.databases[0].project_id as string;
    projects.delete(gone);
    assert.equal((await call("DELETE", "/api/admin/data/fx_molds/imp-1")).status, 204, "a project Neon no longer knows: the record is deleted");
    // In a batch, a database-owning record's delete is refused (its database is deleted with it, one at a time).
    r = await call("POST", "/api/admin/data/_batch", { operations: [{ op: "delete", area: "fx_molds", key: "imp-2" }] });
    assert.equal(r.status, 409); assert.match(r.body.error, /delete imp-2 on its own/);
    assert.ok((await call("GET", "/api/admin/data/fx_molds/imp-2")).status === 200, "nothing of the batch was deleted");
    // With no Neon key a record with a database is not deleted.
    await db.query("UPDATE vault_credentials SET enabled = false WHERE provider = 'neon'");
    r = await call("DELETE", "/api/admin/data/fx_molds/imp-2");
    assert.equal(r.status, 409); assert.match(r.body.error, /with no Neon key it cannot be deleted, so the record stays/);
    await db.query("UPDATE vault_credentials SET enabled = true WHERE provider = 'neon'");
    ok("Neon failing: the record is stored, its database failed with Neon's words (a connection string cut out), Retry makes it; delete removes the Neon project first, Neon refusing (or no key) keeps the record and its database, a project Neon no longer knows counts as deleted, a batch delete is refused");
  }

  // ---------- 6. rekey, Health ----------
  {
    const before = await RR.recordDatabaseUrl(area, "alpha", "database");
    process.env.APP_VAULT_KEY_PREVIOUS = process.env.APP_VAULT_KEY;
    process.env.APP_VAULT_KEY = randomBytes(32).toString("base64");
    const { rekey } = await import("../src/keyvault.js");
    await rekey();
    delete process.env.APP_VAULT_KEY_PREVIOUS;
    assert.equal(await RR.recordDatabaseUrl(area, "alpha", "database"), before, "after a master key rotation the connection strings open with the new key alone");
    const health = (await call("GET", "/api/admin/onboarding/health/status")).body;
    assert.equal(health.checks.find((c: { id: string }) => c.id === "record_databases")?.state, "ok", "Health: record databases ok");
    assert.equal(health.database_key_missing, undefined);
    ok("rotating the vault's master key re-seals the connection strings; Health is ok with the key there and every database made");
  }
  await http_.close();
  console.log(`record resources: all checks passed (${STAMP})`);
} finally {
  neon.close(); gh.close();
  cleanup();
}
process.exit(0);
