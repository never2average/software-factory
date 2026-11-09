// Record-owned resources (mold_v0-282, flag record_resources; src/record-resources.ts, src/github-app.ts
// readRecordRepository), offline: an embedded database, the HTTP server, a declared pack with a shared area whose records
// own a GitHub repository and a database of their own (mold_v0-285: a schema in the app's own database, provider core),
// and a stand-in for GitHub's API.
//   npm run test:record-resources
//
// 1. The declaration: a repository or database field only on a shared area written by staff (never a workspace area, a
//    repository-fed area or a run's argument); a database field's provider is core, the default; "neon" is refused in
//    words saying databases live in the app's own database; it takes no value; with the flag off the record's resources
//    answer not found; Key vault offers no Neon key.
// 2. A new record gets its schema and its own LOGIN role at once: the role is limited to its schema (USAGE and CREATE,
//    every privilege on what is made in it, search_path the schema, no membership, no CREATEDB/CREATEROLE/BYPASSRLS) and,
//    proved by acting as it (SET ROLE), reads none of the app's tables, creates nothing in public and cannot reach
//    another record's schema; its connection string is sealed (never in the fields or an answer), opened by the
//    server's own code; a database value written by hand is refused; an import's records each get theirs after the
//    batch commits; an edit keeps it.
// 3. Refusals, through the database itself (the DDL run as a role that may not): CREATE SCHEMA refused: the record is
//    stored, its database failed with the reason, Health says so in plain words; Retry, once allowed, makes it. CREATE
//    ROLE refused: the schema alone, "schema only, no own login: the app's connection is used" on the record's page,
//    its sealed connection string the app's own with search_path the schema; Health says so.
// 4. Repositories: one the platform's GitHub App can read is saved and shown with its default branch and last commit (an
//    empty one with none); one the app is not installed on, or may not read, refuses the write in plain words naming
//    where to fix it; an unchanged repository is not read again on save; no GitHub App: the words say where to set it.
// 5. Delete: the caller confirms; a role the database will not drop (something else still depends on it) keeps the
//    record, its schema and its role ("nothing was deleted"); then the delete drops the schema (CASCADE) and the role
//    and its row; a schema-only database drops its schema; in a batch a database-owning record's delete is refused.
// 6. Rotating the vault's master key re-seals the connection strings; Health says nothing of record databases once
//    nothing is refused.
// 7. operator:import-records (src/record-import-cli.ts, the staff Import's own path): a dry run counts new, updated and
//    invalid (with reasons) and writes nothing; the real run writes, logs IMPORT lines naming who imported and makes each
//    new record's database; a rerun is idempotent (unchanged, nothing written); a changed row is updated, not duplicated;
//    bad arguments, a workspace area and a locked vault are refused (exit 2).
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";

const ok = (m: string) => console.log(`✓ ${m}`);

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
      { name: "database", label: "Database", type: "database" }] },
    { name: "fx_notes", label: "Notes", role: "source", scope: "platform", fields: [{ name: "note", label: "Note", type: "text" }] },
    { name: "fx_own", label: "Own", role: "source", scope: "workspace", fields: [{ name: "note", label: "Note", type: "text" }] },
  ],
};

try {
  await new Promise<void>((r) => gh.listen(0, "127.0.0.1", r));
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
  const health = async () => (await call("GET", "/api/admin/onboarding/health/status")).body;
  const dbCheck = async () => (await health()).checks?.find((c: { id: string }) => c.id === "record_databases");
  /** What the role may do, by acting as it: the rows, or the error's code. */
  const asRole = async (role: string, sql: string) => {
    try { return await db.transaction(async (tx) => { await tx.query(`SET LOCAL ROLE "${role}"`); return tx.query(sql); }); }
    catch (e) { return (e as { code?: string }).code ?? String(e); }
  };
  const schemaOf = async (key: string) => (await db.query<{ external_id: string | null; details: { role?: string | null; login?: boolean } }>(
    "SELECT external_id, details FROM record_resources WHERE area = 'fx_molds' AND record_key = $1", [key]))[0];
  const schemaThere = async (s: string) => (await db.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [s])).length === 1;
  const roleThere = async (s: string) => (await db.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [s])).length === 1;
  const passwordOf = (url: string | null) => (url ? decodeURIComponent(new URL(url).password) : "");
  const secrets: string[] = [];
  const noSecret = (what: string, v: unknown) => { for (const s of secrets) assert.ok(!JSON.stringify(v).includes(s), `${what}: no connection string or password in it`); };

  // ---------- 1. the declaration, and the flag ----------
  {
    const bad = (a: unknown) => RecordAreaSchema.safeParse(a);
    assert.match(JSON.stringify(bad({ name: "w", label: "W", role: "source", scope: "workspace", fields: [{ name: "r", label: "R", type: "repository" }] }).error?.issues), /shared \(platform\) area/);
    assert.match(JSON.stringify(bad({ name: "w", label: "W", role: "source", scope: "platform", repository: "cat", fields: [{ name: "d", label: "D", type: "database" }] }).error?.issues), /written through the record store/);
    assert.ok(bad({ name: "ww", label: "W", role: "source", scope: "platform", fields: [{ name: "dd", label: "D", type: "database" }] }).success, "a database field needs no provider: core is the default");
    assert.ok(bad({ name: "ww", label: "W", role: "source", scope: "platform", fields: [{ name: "dd", label: "D", type: "database", provider: "core" }] }).success, "provider core is right");
    assert.match(JSON.stringify(bad({ name: "w", label: "W", role: "source", scope: "platform", fields: [{ name: "d", label: "D", type: "database", provider: "neon" }] }).error?.issues),
      /provider \\"neon\\" is gone.*lives in the app's own database/, "neon is refused, saying where databases live now");
    assert.match(JSON.stringify(bad({ name: "w", label: "W", role: "source", scope: "platform", fields: [{ name: "d", label: "D", type: "database", provider: "rds" }] }).error?.issues), /not a database provider.*core/);
    assert.match(JSON.stringify(bad({ name: "w", label: "W", role: "source", scope: "platform", fields: [{ name: "d", label: "D", type: "database", required: true }] }).error?.issues), /cannot be required/);
    assert.match(JSON.stringify(bad({ name: "w", label: "W", role: "source", scope: "platform", fields: [{ name: "t", label: "T", type: "text", provider: "core" }] }).error?.issues), /provider is for a database field/);
    assert.ok(JobKindSchema.safeParse({ name: "kk", label: "K", runner: "workspace-harness", entry: "packs/x/run.mjs", args: [{ name: "aa", label: "A", type: "text" }] }).success, "a kind with a text argument is right");
    assert.match(JSON.stringify(JobKindSchema.safeParse({ name: "kk", label: "K", runner: "workspace-harness", entry: "packs/x/run.mjs", args: [{ name: "rr", label: "R", type: "repository" }] }).error?.issues), /repository and database are a shared record area's fields, not a job kind's arguments/);
    assert.ok(bad(PACK.record_areas[0]).success, "the fixture's shared area with both fields is declared right");
    // The admin MCP's generated tools: a repository is owner/name; a database is no input at all.
    const { generateCatalog } = await import("../src/mcp-catalog.js");
    const cat = generateCatalog([{ id: "fixture_resources", name: "Fixture resources", definition: compileDeclarations(PACK) as never }]);
    const create = cat.tools.find((t) => t.op === "admin_create" && t.area === "fx_molds") as unknown as { input: { data: { shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }> } } };
    assert.deepEqual(Object.keys(create.input.data.shape), ["summary", "repo"], "the admin MCP's create tool takes no database value");
    assert.ok(create.input.data.shape.repo!.safeParse("acme/widgets").success && !create.input.data.shape.repo!.safeParse("not a repo").success, "its repository is owner/name");
    F.setFeatureForTest("record_resources", false);
    assert.equal((await call("POST", "/api/admin/data/fx_molds", { key: "off-one", title: "Off", data: { summary: "x" } })).status, 201, "flag off: the area writes as any other");
    assert.equal((await resourcesOf("off-one")).status, 404, "flag off: a record's resources answer not found");
    assert.equal((await db.query("SELECT 1 FROM record_resources")).length, 0, "flag off: no database is made");
    F.setFeatureForTest("record_resources", true);
    assert.equal(await (await import("../src/vault-providers.js")).providerInBuild("neon", 0), false, "flag on: Key vault offers no Neon key (no outside database provider)");
    assert.equal((await db.query("SELECT 1 FROM vault_providers WHERE slug = 'neon'")).length, 0, "and 0062 took Neon's provider row out");
    assert.equal(F.featureOn("record_resources"), true);
    ok("the declaration: repository and database fields only on a shared area written by staff, never a run's argument; a database's provider is core (the default), neon refused in words; never required; the flag alone shows the resources; no Neon on Key vault");
  }

  // ---------- 2. a record's own schema and role ----------
  let alpha = "", alphaRole = "";
  {
    const form = (await call("GET", "/api/admin/records/_console/fx_molds/form")).body;
    assert.deepEqual(form.fields.map((f: { name: string }) => f.name), ["summary", "repo"], "the New form leaves the database field out (the platform creates it)");
    assert.deepEqual(form.resources.databases, [{ field: "database", label: "Database", provider: "core" }]);
    assert.equal(form.resources.database_key_missing, undefined, "no key is asked for");
    assert.equal((await call("GET", "/api/admin/records/_console/fx_notes/form")).body.resources, undefined, "an area with no resource field says nothing of them");
    assert.equal(await dbCheck(), undefined, "Health: nothing to say of record databases yet");
    const c = await call("POST", "/api/admin/data/fx_molds", { key: "alpha", title: "Alpha", data: { summary: "a mold" } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.record.data.database, undefined, "the record's fields hold no database value");
    const res = (await resourcesOf("alpha")).body;
    const d = res.databases[0];
    assert.equal(d.status, "ready", JSON.stringify(d)); assert.equal(d.provider, "core"); assert.equal(d.login, true); assert.equal(d.note, null);
    assert.match(d.schema, /^rec_fx_molds_[0-9a-f]{10}$/, "the schema is named for the record");
    alpha = d.schema; alphaRole = d.role;
    assert.equal(alphaRole, alpha, "its own login role, of the same name");
    assert.ok(await schemaThere(alpha) && await roleThere(alphaRole), "the schema and the role are in the app's own database");
    const url = await RR.recordDatabaseUrl(area, "alpha", "database");
    assert.ok(url && new URL(url).username === alphaRole && passwordOf(url).length >= 32, "the server's own code opens the sealed connection string: the role's own login");
    secrets.push(url!, passwordOf(url));
    noSecret("the create's answer", c.body); noSecret("the resources answer", res);
    const [row] = await db.query<{ secret_ciphertext: string; details: unknown }>("SELECT secret_ciphertext, details FROM record_resources WHERE record_key = 'alpha'");
    assert.ok(row && !row.secret_ciphertext.includes(passwordOf(url))); noSecret("the stored details", row.details);
    const [stored] = await db.query<{ data: unknown }>("SELECT data FROM platform_records WHERE area = 'fx_molds' AND key = 'alpha'");
    noSecret("the record's stored fields", stored);
    for (const p of ["/api/admin/data/fx_molds/alpha", "/api/admin/records/fx_molds/alpha", "/api/admin/data/fx_molds"]) noSecret(p, (await call("GET", p)).body);
    // The role, as the catalog says it is.
    const [r] = await db.query<{ rolcanlogin: boolean; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean; rolinherit: boolean; rolconfig: string[] | null }>(
      "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit, rolconfig FROM pg_roles WHERE rolname = $1", [alphaRole]);
    assert.deepEqual({ ...r, rolconfig: undefined }, { rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, rolinherit: false, rolconfig: undefined });
    assert.ok(r!.rolconfig?.some((x) => x === `search_path=${alpha}` || x === `search_path="${alpha}"`), `its search_path is its schema (${r!.rolconfig})`);
    assert.equal((await db.query("SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1", [alphaRole])).length, 0, "it is a member of no role");
    const [g] = await db.query<Record<string, boolean>>(
      `SELECT has_schema_privilege($1, $2, 'USAGE') AS own_usage, has_schema_privilege($1, $2, 'CREATE') AS own_create,
              has_schema_privilege($1, 'public', 'CREATE') AS public_create, has_table_privilege($1, 'public.platform_records', 'SELECT') AS app_table,
              has_table_privilege($1, 'public.record_resources', 'SELECT') AS resources_table, has_table_privilege(app_tenant_role(), 'public.record_resources', 'SELECT') AS tenant_resources`, [alphaRole, alpha]);
    assert.deepEqual(g, { own_usage: true, own_create: true, public_create: false, app_table: false, resources_table: false, tenant_resources: false }, "its grants: its schema only");
    // A second record: its own schema and role, which the first cannot reach.
    assert.equal((await call("POST", "/api/admin/data/fx_molds", { key: "beta", title: "Beta", data: { summary: "b" } })).status, 201);
    const beta = (await resourcesOf("beta")).body.databases[0].schema as string;
    assert.ok(beta && beta !== alpha);
    await db.exec(`CREATE TABLE "${beta}".secrets (x int); INSERT INTO "${beta}".secrets VALUES (7); CREATE TABLE "${alpha}".made_by_app (x int); INSERT INTO "${alpha}".made_by_app VALUES (3)`);
    // Acting as the role (SET ROLE: the embedded database has one connection, so the role is taken on it).
    for (const t of ["public.platform_records", "public.record_resources", "public.organizations", "public.vault_credentials"])
      assert.equal(await asRole(alphaRole, `SELECT * FROM ${t} LIMIT 1`), "42501", `as the record's role: ${t} is refused`);
    assert.equal(await asRole(alphaRole, `SELECT * FROM "${beta}".secrets`), "42501", "as the record's role: another record's schema is refused");
    assert.equal(await asRole(alphaRole, "CREATE TABLE public.sneaky (x int)"), "42501", "as the record's role: nothing is made in public");
    // (SET ROLE does not apply the role's own search_path, a login's setting: checked above in pg_roles; named here.)
    assert.deepEqual(await asRole(alphaRole, `CREATE TABLE "${alpha}".own_t (x int)`), [], "as the record's role: a table in its own schema");
    assert.deepEqual(await asRole(alphaRole, `SELECT x FROM "${alpha}".made_by_app`), [{ x: 3 }], "and what the app makes in its schema is its to use (default privileges)");
    assert.deepEqual(await db.query("SELECT tableowner FROM pg_tables WHERE schemaname = $1 AND tablename = 'own_t'", [alpha]), [{ tableowner: alphaRole }], "the table it made is its own (dropped with the schema, below)");
    // A value for the database field is refused.
    const v = await call("POST", "/api/admin/data/fx_molds", { key: "gamma", data: { database: "postgresql://x" } });
    assert.equal(v.status, 400); assert.match(v.body.error, /creates the record's database itself/);
    // An import: each record its database, after the batch commits.
    const imp = await call("POST", "/api/admin/records/_console/fx_molds/import", { dry_run: false, rows: [{ key: "imp-1", title: "One", data: { summary: "1" } }, { key: "imp-2", title: "Two", data: { summary: "2" } }] });
    assert.equal(imp.status, 200, JSON.stringify(imp.body));
    for (const k of ["imp-1", "imp-2"]) assert.equal((await resourcesOf(k)).body.databases[0].status, "ready");
    const before = (await db.query("SELECT 1 FROM pg_namespace WHERE nspname LIKE 'rec\\_%'")).length;
    assert.equal((await call("PUT", "/api/admin/data/fx_molds/alpha", { title: "Alpha 2", data: { summary: "edited" } })).status, 200);
    assert.equal((await db.query("SELECT 1 FROM pg_namespace WHERE nspname LIKE 'rec\\_%'")).length, before, "an edit makes no second schema");
    ok("a new record gets its own schema and LOGIN role in the app's own database; acting as the role, the app's tables, public and another record's schema are refused, its own schema is its; the connection string is sealed, opened only by the server's code; a database value is refused; imported records get theirs; an edit keeps it");
  }

  // ---------- 3. refusals: CREATE SCHEMA, CREATE ROLE ----------
  {
    // Roles the DDL runs as (the seam), so the database itself refuses: one with no right to create schemas, one that may
    // create schemas but not roles.
    await db.exec(`CREATE ROLE rr_no_schema NOLOGIN; CREATE ROLE rr_no_role NOLOGIN;
      DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO rr_no_role', current_database()); END $$;`);
    RR.setDdlRoleForTest("rr_no_schema");
    let r = await call("POST", "/api/admin/data/fx_molds", { key: "noschema", title: "No schema", data: { summary: "x" } });
    assert.equal(r.status, 201, "the record is stored whatever the database says");
    let d = (await resourcesOf("noschema")).body.databases[0];
    assert.equal(d.status, "failed"); assert.match(d.reason, /refused to create this record's schema \(CREATE SCHEMA\).*press Retry/); assert.equal(d.retry, true);
    let h = await health();
    let check = h.checks.find((c: { id: string }) => c.id === "record_databases");
    assert.equal(check?.state, "bad"); assert.match(check.detail, /refuses to create schemas \(CREATE SCHEMA\), so 1 record database could not be made/);
    assert.match(h.database_refused?.text ?? "", /refuses to create schemas/, "Health's line, in plain words");
    RR.setDdlRoleForTest(null);
    r = await call("POST", "/api/admin/records/_resources/fx_molds/noschema/database/retry", {});
    assert.equal(r.status, 200); assert.equal(r.body.database.status, "ready", "Retry makes it once the database allows it");
    assert.equal(await dbCheck(), undefined, "and Health has nothing more to say");
    assert.equal((await call("POST", "/api/admin/records/_resources/fx_molds/noschema/database/retry", {})).status, 409, "a ready database is not retried");
    assert.equal((await call("POST", "/api/admin/records/_resources/fx_molds/noschema/database/retry", {}, viewer)).status, 403, "a staff viewer cannot retry");
    // CREATE ROLE refused: the schema alone, said in words.
    RR.setDdlRoleForTest("rr_no_role");
    r = await call("POST", "/api/admin/data/fx_molds", { key: "norole", title: "No role", data: { summary: "x" } });
    RR.setDdlRoleForTest(null);
    assert.equal(r.status, 201);
    d = (await resourcesOf("norole")).body.databases[0];
    assert.equal(d.status, "ready", JSON.stringify(d)); assert.equal(d.login, false); assert.equal(d.role, null);
    assert.match(d.note, /^Schema only, no own login: the app's connection is used \(the database refused a login of its own: .*permission denied/);
    assert.ok(await schemaThere(d.schema) && !(await roleThere(d.schema)), "the schema is made, no role");
    const url = await RR.recordDatabaseUrl(area, "norole", "database");
    assert.equal(new URL(url!).searchParams.get("options"), `-c search_path=${d.schema}`, "its connection string is the app's own, search_path the schema");
    h = await health();
    check = h.checks.find((c: { id: string }) => c.id === "record_databases");
    assert.equal(check?.state, "warn"); assert.match(check.detail, /refuses to create logins \(CREATE ROLE\), so 1 record database is a schema only.*app's own connection is used/);
    assert.match(h.database_refused?.text ?? "", /CREATE ROLE/);
    ok("refusals: CREATE SCHEMA refused, the record is stored, its database failed with the reason, Health says it in plain words, Retry makes it once allowed; CREATE ROLE refused, the schema alone, \"schema only, no own login: the app's connection is used\" on the page and on Health, the app's connection with search_path the schema");
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


  // ---------- 5. delete ----------
  {
    // A role the database will not drop (something outside its schema still grants it a right): nothing is deleted.
    await db.exec(`CREATE TABLE public.rr_block (x int); GRANT SELECT ON public.rr_block TO "${alphaRole}"`);
    let r = await call("DELETE", "/api/admin/data/fx_molds/alpha");
    assert.equal(r.status, 502, JSON.stringify(r.body)); assert.match(r.body.error, /could not be dropped.*nothing was deleted, the record stays/);
    noSecret("the refusal", r.body);
    assert.ok((await call("GET", "/api/admin/data/fx_molds/alpha")).status === 200 && await schemaThere(alpha) && await roleThere(alphaRole), "the record, its schema and its role stay");
    assert.ok(await schemaOf("alpha"), "and its row");
    await db.exec(`REVOKE ALL ON public.rr_block FROM "${alphaRole}"; DROP TABLE public.rr_block`);
    assert.equal((await call("DELETE", "/api/admin/data/fx_molds/alpha", undefined, viewer)).status, 403, "a staff viewer deletes nothing");
    r = await call("DELETE", "/api/admin/data/fx_molds/alpha");
    assert.equal(r.status, 204, JSON.stringify(r.body));
    assert.ok(!(await schemaThere(alpha)) && !(await roleThere(alphaRole)), "the schema (with its tables) and the role are dropped with the record");
    assert.equal(await schemaOf("alpha"), undefined, "and its row");
    // A schema-only database: its schema goes.
    const s = (await schemaOf("norole"))!.external_id!;
    assert.equal((await call("DELETE", "/api/admin/data/fx_molds/norole")).status, 204);
    assert.ok(!(await schemaThere(s)), "a schema-only database's schema is dropped");
    assert.equal(await dbCheck(), undefined, "Health: nothing refused any more, nothing said");
    // In a batch, a database-owning record's delete is refused (its database is dropped with it, one at a time).
    r = await call("POST", "/api/admin/data/_batch", { operations: [{ op: "delete", area: "fx_molds", key: "imp-2" }] });
    assert.equal(r.status, 409); assert.match(r.body.error, /delete imp-2 on its own/);
    assert.ok((await call("GET", "/api/admin/data/fx_molds/imp-2")).status === 200, "nothing of the batch was deleted");
    ok("delete: a role the database will not drop keeps the record, its schema and role (nothing deleted); then the schema (CASCADE) and role go with the record and its row; a schema-only one drops its schema; a batch delete is refused");
  }

  // ---------- 6. rekey ----------
  {
    const before = await RR.recordDatabaseUrl(area, "beta", "database");
    process.env.APP_VAULT_KEY_PREVIOUS = process.env.APP_VAULT_KEY;
    process.env.APP_VAULT_KEY = randomBytes(32).toString("base64");
    const { rekey } = await import("../src/keyvault.js");
    await rekey();
    delete process.env.APP_VAULT_KEY_PREVIOUS;
    assert.ok(before && await RR.recordDatabaseUrl(area, "beta", "database") === before, "after a master key rotation the connection strings open with the new key alone");
    assert.equal((await health()).database_refused, undefined);
    ok("rotating the vault's master key re-seals the connection strings; Health says nothing of record databases while nothing is refused");
  }

  // ---------- 7. operator:import-records ----------
  {
    const { importRecordsCommand } = await import("../src/record-import-cli.js");
    const file = path.join(TMP, "import.json");
    writeFileSync(file, JSON.stringify({ $comment: "a staff Import file", records: [
      { key: "op-1", title: "Op one", data: { summary: "first" } },
      { key: "imp-1", title: "One", data: { summary: "1, changed" } },
      { key: "not a key!", title: "Bad", data: { summary: "x" } },
      { key: "op-2", title: "Op two", data: { nope: 1 } }] }));
    const logs = async () => (await db.query<{ actor: string; path: string }>("SELECT actor, path FROM admin_access_log WHERE method = 'IMPORT' AND actor = 'ops-person' ORDER BY id"));
    let r = await importRecordsCommand(["--area", "fx_molds", "--file", file, "--dry-run", "--json"]);
    const j = r.json as { counts: Record<string, number>; written: number; invalid: { key: string; reasons: string[] }[] };
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(j.counts, { new: 1, updated: 1, unchanged: 0, invalid: 2 }, "a dry run: new, updated, invalid counted");
    assert.equal(j.written, 0);
    assert.deepEqual(j.invalid.map((x) => x.key), ["not a key!", "op-2"]);
    assert.match(j.invalid[0]!.reasons[0]!, /is not a record key/); assert.match(j.invalid[1]!.reasons[0]!, /has no field "nope"/);
    assert.match(r.out, /a dry run, nothing written[\s\S]*new 1, updated 1, unchanged 0, invalid 2/);
    assert.equal((await rec.getPlatform(area, "op-1")), null, "the dry run wrote nothing");
    // The real run: through the staff Import's own path.
    r = await importRecordsCommand(["--area", "fx_molds", "--file", file, "--by", "ops-person", "--json"]);
    const k = r.json as { counts: Record<string, number>; written: number; databases: { key: string; status: string }[] };
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(k.counts, { new: 1, updated: 1, unchanged: 0, invalid: 2 }); assert.equal(k.written, 2, "the two valid rows are written, the invalid skipped");
    assert.deepEqual(k.databases, [{ key: "op-1", status: "ready", reason: null, login: true }], "the new record's database is made, as the console's import makes it");
    assert.equal((await rec.getPlatform(area, "imp-1"))?.data.summary, "1, changed", "an existing record is updated");
    assert.deepEqual((await logs()).map((x) => x.path), ["/api/admin/records/fx_molds/op-1 create", "/api/admin/records/fx_molds/imp-1 update"], "the staff access log names who imported each row");
    // Rerun: idempotent.
    r = await importRecordsCommand(["--area", "fx_molds", "--file", file, "--by", "ops-person", "--json"]);
    assert.deepEqual((r.json as { counts: unknown }).counts, { new: 0, updated: 0, unchanged: 2, invalid: 2 }, "a rerun writes nothing: unchanged");
    assert.equal((r.json as { written: number }).written, 0);
    assert.equal((await db.query("SELECT 1 FROM platform_records WHERE area = 'fx_molds' AND key = 'op-1'")).length, 1, "never duplicated");
    assert.equal((await db.query("SELECT 1 FROM record_resources WHERE record_key = 'op-1'")).length, 1, "one database for it");
    assert.equal((await logs()).length, 2, "and logs nothing more");
    // Refusals.
    assert.equal((await importRecordsCommand(["--area", "fx_molds"])).code, 2, "no --file");
    assert.equal((await importRecordsCommand(["--area", "fx_molds", "--file", file, "--force"])).code, 2, "an unknown argument");
    assert.equal((await importRecordsCommand(["--area", "fx_own", "--file", file])).code, 2, "a workspace area");
    assert.equal((await importRecordsCommand(["--area", "nothing", "--file", file])).code, 2, "an unknown area");
    assert.equal((await importRecordsCommand(["--area", "fx_molds", "--file", path.join(TMP, "none.json")])).code, 2, "a missing file");
    const key = process.env.APP_VAULT_KEY; delete process.env.APP_VAULT_KEY;
    r = await importRecordsCommand(["--area", "fx_molds", "--file", file]);
    process.env.APP_VAULT_KEY = key;
    assert.equal(r.code, 2); assert.match(r.out, /sealed with the key vault's master key.*APP_VAULT_KEY.*nothing was written/);
    // The door itself: a plain node line (as provision.py --operator runs it); bad arguments exit 2 before any database.
    const door = spawnSync(process.execPath, ["--import=tsx", "scripts/operator/import-records.ts", "--area", "fx_molds"], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
    assert.equal(door.status, 2, door.stderr); assert.match(door.stderr, /--area and --file are both needed/);
    const pkg = JSON.parse((await import("node:fs")).readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts["operator:import-records"], "node --env-file-if-exists=.env --import=tsx scripts/operator/import-records.ts", "listed where provision.py --operator reads the mold's operator:* scripts");
    ok("operator:import-records: a dry run counts new, updated and invalid (with reasons) and writes nothing; the real run takes the staff Import's path (each row checked, the new record's database made, IMPORT lines naming who imported); a rerun writes nothing; bad arguments, a workspace area, a missing file and a locked vault are refused");
  }
  await http_.close();
  console.log(`record resources: all checks passed (${STAMP})`);
} finally {
  gh.close();
  cleanup();
}
process.exit(0);
