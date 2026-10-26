// The pack seam, end to end, inside a build copy that holds the fixture pack (mold_v0-038). scripts/packs-test.ts
// makes that copy (the codebase plus scripts/fixtures/packs/fixture_notes at packs/fixture_notes and a fixture
// profile.json), runs scripts/gen-packs.mjs there, then runs this file there on a throwaway embedded database. Not
// meant to run in the codebase itself: it refuses when the fixture pack is not installed.
//
// Proves: the pack's tool is on the customer MCP server (after the shell's own) and works for the calling workspace
// only; its migrated table exists with row-level security, passes the catalog check and the live probe, and a query
// that forgets its workspace filter still sees only the caller's rows; its routes answer at /api/packs/<id> (a
// signed-in person of the workspace, the role's permission, the CSRF header on cookie writes) and /api/admin/packs/<id>
// (platform admins, need(permission) on changes); its page is in the console's generated navigation and its data
// route answers; the profile drives the MCP server name, the email sender and the console title.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NS_KEYS } from "../src/namespace.js";

process.env.APP_VAULT_KEY ??= (await import("node:crypto")).randomBytes(32).toString("base64");
const { packs, packRegistry } = await import("../src/packs.js");
assert.deepEqual(packs().map((p) => p.id), ["fixture_notes"], "run inside a build copy with the fixture pack (scripts/packs-test.ts)");
const PACK = "fixture_notes";
const { getDb } = await import("../src/db.js");
const db = await getDb();
const stamp = Date.now().toString(36);

// ---------- migrations: after the shell's, recorded per pack, the table under row-level security ----------
{
  const [rec] = await db.query<{ pack: string; version: number; name: string }>("SELECT pack, version, name FROM pack_schema_migrations");
  assert.deepEqual({ ...rec }, { pack: PACK, version: 1, name: "notes" }, "the pack's migration is recorded");
  const [rel] = await db.query<{ on: boolean }>("SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'fixture_notes_notes'");
  assert.equal(rel?.on, true, "the pack table has row-level security");
  const pol = await db.query<{ policyname: string; qual: string }>("SELECT policyname, qual FROM pg_policies WHERE tablename = 'fixture_notes_notes' ORDER BY 1");
  assert.deepEqual(pol.map((p) => p.policyname), ["pack_tenant_isolation"], "its policy is the shell's");
  const { rlsCatalogProblems, rlsProbe, tenantTables } = await import("../src/rls.js");
  assert.ok((await tenantTables(db)).includes("fixture_notes_notes"), "the RLS check counts it as a tenant table");
  assert.deepEqual(await rlsCatalogProblems(db), [], "catalog check passes with the pack table");
  const probe = await rlsProbe(db);
  assert.deepEqual(probe.problems, [], "live probe passes with the pack table");
  const { migrationStatus, runMigrations } = await import("../src/migrate.js");
  const st = await migrationStatus(db);
  assert.equal(st.packs.length, 1);
  assert.equal(st.packs[0]!.pending.length, 0, "nothing pending for the pack");
  assert.deepEqual((await runMigrations(db)).applied, [], "migrating again applies nothing");
  // A policy that would open the pack table to every workspace is caught by the catalog check (then put back).
  await db.exec("ALTER POLICY pack_tenant_isolation ON fixture_notes_notes USING (true)");
  assert.ok((await rlsCatalogProblems(db)).some((p) => p.includes("fixture_notes_notes")), "an opened pack policy fails the RLS check");
  await db.query("SELECT shell_pack_tenant_table('fixture_notes_notes'::regclass)");
  assert.deepEqual(await rlsCatalogProblems(db), [], "secured again");
  // Whatever the build let through, the runner refuses a pack migration that touches anything but its own tables
  // (the review's exploit: a policy on a shell table), and rolls it back.
  const { mkdtempSync, writeFileSync: write } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const evil = mkdtempSync(`${tmpdir()}/evil-pack-`);
  write(`${evil}/0001_leak.sql`, "CREATE TABLE evil_t (id SERIAL PRIMARY KEY, org_id INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE);\n" +
    "SELECT shell_pack_tenant_table('evil_t');\nCREATE POLICY leak ON mcp_events FOR SELECT USING (org_id = app_tenant_org() OR org_id = 1);\n");
  await assert.rejects(runMigrations(db, { packDirs: [{ pack: "fixture_notes", dir: "packs/fixture_notes/migrations" }, { pack: "evil", dir: evil }] }),
    /may change only their own tables: refused, they changed policy leak on mcp_events/, "a policy on a shell table is refused at apply time");
  assert.equal((await db.query("SELECT 1 FROM pg_policies WHERE policyname = 'leak'")).length, 0, "and rolled back");
  assert.equal((await db.query("SELECT to_regclass('evil_t') AS t"))[0]?.t ?? null, null, "with the pack's table");
  write(`${evil}/0001_leak.sql`, "CREATE TABLE evil_t (id INT, org_id INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE);\nSELECT shell_pack_tenant_table('evil_t');\nCREATE FUNCTION evil_f() RETURNS int LANGUAGE sql AS 'SELECT 1';\n");
  await assert.rejects(runMigrations(db, { packDirs: [{ pack: "evil", dir: evil }] }), /function evil_f\(\)/, "a new function is refused");
  write(`${evil}/0001_leak.sql`, "CREATE TABLE evil_t (version INT NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), org_id INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE);\nSELECT shell_pack_tenant_table('evil_t');\nALTER TABLE evil_t INHERIT schema_migrations;\n");
  await assert.rejects(runMigrations(db, { packDirs: [{ pack: "evil", dir: evil }] }), /inheritance evil_t -> schema_migrations/, "a pack table attached under a shell table is refused");
  // A policy outside any migration that opens a shell table to a fixed organization fails the RLS check.
  await db.exec("CREATE POLICY leak ON mcp_events FOR SELECT USING (org_id = app_tenant_org() OR org_id = 1)");
  assert.ok((await rlsCatalogProblems(db)).some((p) => p.includes("unexpected policy leak")), "an extra PUBLIC policy fails the RLS check");
  await db.exec("DROP POLICY leak ON mcp_events");
  assert.deepEqual(await rlsCatalogProblems(db), []);
  console.log(`✓ pack migration applied after the shell's, table under row-level security (catalog check, live probe ${probe.checked} checks)`);
}

// ---------- MCP: the pack's tools, for the calling workspace only ----------
const { createOrg } = await import("../src/auth.js");
const A = (await createOrg(`Pack A ${stamp}`)).org, B = (await createOrg(`Pack B ${stamp}`)).org;
{
  const { createServer, ownToolNames } = await import("../src/server.js");
  const TOOL_NAMES = ownToolNames();
  const connect = async (org: import("../src/auth.js").Org) => {
    const server = createServer(org);
    const client = new Client({ name: "packs-check", version: "1" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    return client;
  };
  const ca = await connect(A), cb = await connect(B);
  assert.equal(ca.getServerVersion()?.name, "fixture-desk", "the MCP server's name is the profile's");
  const names = (await ca.listTools()).tools.map((t) => t.name);
  assert.deepEqual(names.slice(0, TOOL_NAMES.length).sort(), [...TOOL_NAMES].sort(), "the shell's tools come first, unchanged");
  assert.deepEqual(names.slice(TOOL_NAMES.length, TOOL_NAMES.length + 6), ["fixture_notes_get_started", "add_note", "list_notes", "count_every_note", "list_records", "get_record"],
    "then the get_started generated from its onboarding step (mold_v0-105), the pack's own, in its order, then the record areas' tools (the pack declares an area, mold_v0-047)");
  assert.ok(names.slice(TOOL_NAMES.length + 6).every((n) => n.startsWith("fixture_notes_")), "then the tools generated from its declarations, under its id (mold_v0-060)");
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
  assert.ok(!(await call(ca, "add_note", { body: `alpha ${stamp}` })).isError);
  assert.ok(!(await call(cb, "add_note", { body: `beta ${stamp}` })).isError);
  const la = await call(ca, "list_notes");
  assert.deepEqual(la.structuredContent.notes.map((n: any) => n.body), [`alpha ${stamp}`], "A lists only its own note");
  const [{ n: total }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM fixture_notes_notes");
  assert.equal(total, 2, "two notes exist");
  assert.equal((await call(ca, "count_every_note")).structuredContent.n, 1, "a pack query without a workspace filter still sees only the caller's rows (RLS)");
  assert.equal((await call(cb, "count_every_note")).structuredContent.n, 1);
  const bad = await call(ca, "add_note", { body: "" });
  assert.ok(bad.isError, "input is validated against the tool's schema");
  // A viewer's connector reads but cannot change anything (the tool needs "edit").
  const viewer = await connect({ ...A, userId: "user_viewer", role: "viewer" });
  const refused = await call(viewer, "add_note", { body: "nope" });
  assert.ok(refused.isError && /Viewers/.test(refused.content[0]!.text), `a viewer is refused: ${refused.content[0]?.text}`);
  assert.ok(!(await call(viewer, "list_notes")).isError, "a viewer can read");
  const [ev] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM mcp_events WHERE org_id = $1 AND name = 'add_note'", [A.orgId]);
  assert.ok(ev!.n >= 1, "pack tool calls are in the activity log");
  for (const c of [ca, cb, viewer]) await c.close();
  console.log("✓ pack tools on the MCP server after the shell's; each workspace reaches only its own rows; permissions apply");
}

// ---------- HTTP: /api/packs/<id> (customer session) and /api/admin/packs/<id> (platform admins) ----------
{
  const { startMockProviders } = await import("./lib/mock-providers.js");
  const mock = await startMockProviders();
  const { pem } = await (await fetch(`${mock.url}/_mock/public-key`)).json();
  Object.assign(process.env, { CLERK_SECRET_KEY: "sk_test_mock", CLERK_API_URL: mock.url, CLERK_FRONTEND_API_URL: mock.url, CLERK_JWT_KEY: pem });
  const { createApp } = await import("../src/http.js");
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const clerk = async (p: string, body: unknown) => (await fetch(`${mock.url}${p}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk_test_mock" }, body: JSON.stringify(body) })).json();
    const mockPost = async (p: string, body: unknown) => (await fetch(`${mock.url}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    const corg = await clerk("/v1/organizations", { name: A.name });
    await db.query("UPDATE organizations SET clerk_org_id = $1 WHERE id = $2", [corg.id, A.orgId]);
    const member = await mockPost("/_mock/clerk/users", { email: `member+${stamp}@example.org` });
    const viewerUser = await mockPost("/_mock/clerk/users", { email: `viewer+${stamp}@example.org` });
    await mockPost("/_mock/clerk/memberships", { org_id: corg.id, user_id: member.id, role: "org:member" });
    await mockPost("/_mock/clerk/memberships", { org_id: corg.id, user_id: viewerUser.id, role: "org:member", public_metadata: { [NS_KEYS.role]: "viewer" } });
    const session = async (u: string) => (await mockPost("/_mock/session", { user_id: u, org_id: corg.id })).token as string;
    const sm = await session(member.id), sv = await session(viewerUser.id);
    const req = (method: string, p: string, h: Record<string, string> = {}, body?: unknown) =>
      fetch(`${base}${p}`, { method, headers: { ...h, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const url = `/api/packs/${PACK}/notes`;
    assert.equal((await req("GET", url)).status, 401, "no session: 401");
    const got = await req("GET", url, { authorization: `Bearer ${sm}` });
    assert.equal(got.status, 200);
    assert.deepEqual((await got.json()).rows.map((r: any) => r.body), [`alpha ${stamp}`], "the page's data route answers with the workspace's rows only");
    assert.equal((await req("POST", url, { authorization: `Bearer ${sm}` }, { body: `gamma ${stamp}` })).status, 200, "a member adds a note (bearer: no CSRF header needed)");
    assert.equal((await req("POST", url, { cookie: `__session=${sm}` }, { body: "x" })).status, 403, "a cookie write without X-Pack-Request is refused");
    assert.equal((await req("POST", url, { cookie: `__session=${sm}`, "x-pack-request": "1" }, { body: `delta ${stamp}` })).status, 200, "with it, it works");
    assert.equal((await req("POST", url, { authorization: `Bearer ${sm}` }, {})).status, 400, "a PackError reaches the caller with its status");
    const v = await req("POST", url, { authorization: `Bearer ${sv}` }, { body: "nope" });
    assert.equal(v.status, 403, "a viewer cannot change anything (edit)");
    assert.equal((await req("GET", url, { authorization: `Bearer ${sv}` })).status, 200, "a viewer reads");
    assert.equal((await req("GET", `/api/packs/no_such_pack/notes`, { authorization: `Bearer ${sm}` })).status, 404, "an unknown pack is a 404");
    const [{ n: bNotes }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM fixture_notes_notes WHERE org_id = $1", [B.orgId]);
    assert.equal(bNotes, 1, "nothing written through A's session reached B");

    const { createAdminToken } = await import("../src/admin-tokens.js");
    const viewerTok = (await createAdminToken({ label: `packs-viewer-${stamp}`, role: "viewer", days: 1, createdBy: "packs-check" })).token;
    const ownerTok = (await createAdminToken({ label: `packs-owner-${stamp}`, role: "owner", days: 1, createdBy: "packs-check" })).token;
    const admin = `/api/admin/packs/${PACK}/notes`;
    assert.equal((await req("GET", admin)).status, 401, "admin route: no credential, 401");
    assert.equal((await req("GET", admin, { authorization: `Bearer ${sm}` })).status, 403, "a customer session is not a platform admin");
    const all = await req("GET", admin, { authorization: `Bearer ${viewerTok}` });
    assert.equal(all.status, 200);
    const counts = Object.fromEntries((await all.json()).rows.map((r: any) => [r.org_id, r.notes]));
    assert.equal(counts[A.orgId], 3, "the admin page sees every workspace");
    assert.equal(counts[B.orgId], 1);
    const [{ id: noteB }] = await db.query<{ id: number }>("SELECT id FROM fixture_notes_notes WHERE org_id = $1", [B.orgId]);
    assert.equal((await req("DELETE", `${admin}/${noteB}`, { authorization: `Bearer ${viewerTok}` })).status, 403, "a viewer admin cannot delete (needs delete)");
    assert.equal((await req("DELETE", `${admin}/${noteB}`, { authorization: `Bearer ${ownerTok}` })).status, 204, "an owner can");
    assert.equal((await req("DELETE", `${admin}/${noteB}`, { authorization: `Bearer ${ownerTok}` })).status, 404);
    const [log] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM admin_access_log WHERE path LIKE $1", [`/api/admin/packs/${PACK}/%`]);
    assert.ok(log!.n >= 3, "admin pack requests are in the access log");
    console.log("✓ pack routes: /api/packs (session, role, CSRF header, workspace scope) and /api/admin/packs (admin roles, need on changes, access log)");
  } finally {
    server.close();
    await mock.close();
  }
}

// ---------- the console page, the declared-only fields, the profile ----------
{
  // The console's generated files are read as text (they belong to the web app's own TypeScript project).
  const generated = (file: string, name: string) => {
    const text = readFileSync(new URL(`../web/src/config/${file}`, import.meta.url), "utf8");
    const m = new RegExp(`export const ${name}(?:: [^=]+)? = ([\\s\\S]*?)(?: as const)?;\\n`).exec(text);
    assert.ok(m, `${file} exports ${name}`);
    return JSON.parse(m[1]!);
  };
  const nav = { packPages: generated("pack-nav.generated.ts", "packPages"), packPortalNav: generated("pack-nav.generated.ts", "packPortalNav"), packAdminNav: generated("pack-nav.generated.ts", "packAdminNav") };
  const page = nav.packPages.find((p: { pack: string; id: string }) => p.pack === PACK && p.id === "notes");
  assert.ok(page && page.area === "app" && page.data === "/notes", "the pack's page is in the console registry");
  assert.deepEqual(nav.packPortalNav, [{ label: "Notes", items: [{ title: "Notes", url: "/app/notes", items: [] }] }], "and in the /app sidebar");
  assert.equal(nav.packAdminNav[0]?.items[0]?.url, `/admin/packs/${PACK}/all-notes`, "its admin page is in the /admin sidebar");
  const navConfig = readFileSync(new URL("../web/src/config/nav-config.ts", import.meta.url), "utf8");
  assert.ok(navConfig.includes("...packPortalNav") && navConfig.includes("...packAdminNav"), "the sidebar appends the packs' groups");

  const reg = packRegistry();
  assert.deepEqual([reg.jobKinds.length, reg.recordAreas.length, reg.credentials.length, reg.schedules.length, reg.onboarding.length], [1, 1, 1, 1, 1], "declared fields are validated and listed");
  assert.deepEqual(reg.words, { [PACK]: { workspace: "team" } }, "profile words are carried");

  const { PROFILE } = await import("../src/profile.js");
  assert.equal(PROFILE.mcp_server_name, "fixture-desk");
  const { SETTINGS } = await import("../src/settings.js");
  assert.equal(SETTINGS.find((s) => s.key === "EMAIL_FROM")?.default, "Fixture Desk <desk@example.org>", "the email sender is the profile's");
  assert.equal(generated("profile.generated.ts", "profile").console_title, "Fixture Desk", "the console title is the profile's");
  const layout = readFileSync(new URL("../web/src/app/layout.tsx", import.meta.url), "utf8");
  assert.ok(/title: \{ default: profile\.console_title/.test(layout), "the console's layout takes its title from the profile");
  console.log("✓ pack page in the console registry and sidebar; jobKinds/recordAreas/credentials/schedules/onboarding declared and listed; profile drives the names");
}

// ---------- deleting a workspace takes its pack rows with it ----------
{
  await db.query("DELETE FROM organizations WHERE id = $1", [A.orgId]);
  const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM fixture_notes_notes WHERE org_id = $1", [A.orgId]);
  assert.equal(n, 0, "a deleted workspace's pack rows go with it (ON DELETE CASCADE)");
  console.log("✓ deleting a workspace removes its pack rows");
}
await db.close();
console.log("PACK FIXTURE CHECK PASS");
process.exit(0);
