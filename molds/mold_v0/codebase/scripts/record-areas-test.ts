// Record areas (mold_v0-047; src/record-areas.ts, molds/mold_v0/MOLD.md "Pack and record-area contract").
//   npm run test:record-areas        offline: an embedded database in a temporary directory, a fake Clerk
//
// 1. Zero packs: no record tools, no record routes; the MCP server lists exactly the shell's tools.
// 2. The registry refuses areas that clash across packs, links to an undeclared area and a pack tool named list_records.
// 3. A fixture pack that declares four areas and no record code gets list_records and get_record on the MCP server, a
//    list and a detail page's data at /api/records, and (for its shared areas) the staff pages' data at /api/admin/records.
// 4. Workspace areas: two workspaces each see only their own rows, through MCP, HTTP, ctx.records and a raw tenant
//    query that forgets its filter; an asset area's title and data are sealed with the workspace's data key at rest.
// 5. Platform areas are read-only to customers: the tenant role cannot write them (the database refuses), ctx.records
//    refuses, and no customer route or tool writes them; staff need "library" to write them.
// 6. The row-level security check and live probe pass with the new tables; deleting a workspace removes its records.
// 7. gen-packs reads the areas from definePack and writes the console's registry and sidebar groups; it refuses clashes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const { TOOL_NAMES } = await import("../src/server.js");
  const { setPacksForTest, installPacks, packRegistry } = await import("../src/packs.js");
  const { definePack, defineTool, z, PackError } = await import("../src/pack-api.js");
  const rec = await import("../src/record-areas.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const A = (await createOrg(`Areas A ${STAMP}`)).org, B = (await createOrg(`Areas B ${STAMP}`)).org;

  // ---------- 1. zero packs ----------
  {
    assert.deepEqual(rec.recordAreas(), [], "no packs, no areas");
    assert.deepEqual(rec.recordTools(), [], "no record tools");
    const c = await connect(A);
    assert.deepEqual((await c.client.listTools()).tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort(), "the MCP server lists exactly the shell's tools");
    await c.close();
    const { recordAppRouter, recordAdminRouter } = await import("../src/record-routes.js");
    assert.equal((recordAppRouter() as unknown as { stack: unknown[] }).stack.length, 0, "no /api/records routes are mounted");
    assert.equal((recordAdminRouter() as unknown as { stack: unknown[] }).stack.length, 0, "no /api/admin/records routes are mounted");
    console.log("✓ zero packs: no record areas, no record tools or routes; the MCP surface is the shell's");
  }

  // ---------- 2. the registry refuses clashes ----------
  const manifest = (id: string) => ({ id, name: id, version: "1", entry: "index.ts", migrations: null, words: {} });
  const area = (name: string, extra: Record<string, unknown> = {}) => ({ name, label: name, role: "check" as const, scope: "platform" as const, fields: [{ name: "xx", label: "X" }], ...extra });
  {
    assert.throws(() => installPacks([{ manifest: manifest("pk"), definition: { id: "pk", recordAreas: [area("dup")] } }, { manifest: manifest("qk"), definition: { id: "qk", recordAreas: [area("dup")] } }]),
      /record area dup is already pack pk's/);
    assert.throws(() => installPacks([{ manifest: manifest("pk"), definition: { id: "pk", recordAreas: [area("a1", { links: [{ field: "xx", area: "nowhere" }] })] } }]), /which no pack declares/);
    assert.throws(() => installPacks([{ manifest: manifest("pk"), definition: { id: "pk", tools: [{ name: "list_records", description: "d", handler: () => null }] } }]), /already a shell tool/);
    assert.throws(() => definePack({ id: "pk", recordAreas: [area("a1", { list_columns: ["nope"] })] }), /list_columns must name declared fields/);
    assert.throws(() => definePack({ id: "pk", recordAreas: [area("a1", { role: "asset" })] }), /workspace scope only/);
    console.log("✓ the registry refuses clashing area names, links to undeclared areas, a pack tool named list_records and bad columns");
  }

  // ---------- 3. a fixture pack that declares areas and writes nothing but definitions ----------
  const fixture = definePack({
    id: "fixture_audit",
    recordAreas: [
      { name: "fixture_sources", label: "Sources", role: "source", scope: "platform", fields: [{ name: "body", label: "Requirement" }, { name: "issuer", label: "Issuer" }] },
      { name: "fixture_checks", label: "Checks", role: "check", scope: "platform", list_columns: ["summary"],
        fields: [{ name: "summary", label: "Summary" }, { name: "source", label: "Source", type: "link" }], links: [{ field: "source", area: "fixture_sources" }] },
      { name: "fixture_apps", label: "Applications", role: "asset", scope: "workspace",
        fields: [{ name: "url", label: "Address" }, { name: "secret_note", label: "Private note" }, { name: "checks", label: "Checks", type: "link" }], links: [{ field: "checks", area: "fixture_checks" }] },
      { name: "fixture_state", label: "Check state", role: "check", scope: "workspace", fields: [{ name: "status", label: "Status" }, { name: "score", label: "Score", type: "number" }] },
    ],
    // Only to write records (a real pack's indexer or runner does this): the pages and list/get tools need no code.
    tools: [
      defineTool({ name: "fixture_put_app", description: "Save an application (test).", inputSchema: { key: z.string(), url: z.string(), note: z.string() },
        handler: async (_ws, { key, url, note }, { records }) => records.put("fixture_apps", key, { title: `App ${key}`, data: { url, secret_note: note, checks: ["c1"] } }) }),
      defineTool({ name: "fixture_put_shared", description: "Try to write a shared record (test).", inputSchema: {},
        handler: async (_ws, _a, { records }) => records.put("fixture_sources", "evil", { data: { body: "x" } }) }),
      defineTool({ name: "fixture_count_raw", description: "Count application rows with no workspace filter (test).", annotations: { readOnlyHint: true },
        handler: async (_ws, _a, { db }) => (await db.query<{ n: number }>("/* tenant: on purpose, row-level security alone scopes it */ SELECT count(*)::int AS n FROM workspace_records"))[0] }),
    ],
    routes: [
      { scope: "admin", method: "post", path: "/index", needs: "library", handler: async ({ records, body }) => records.put("fixture_sources", String((body as { key?: string }).key), { title: "Indexed", data: { body: "indexed" }, version: "v2" }) },
      { scope: "admin", method: "get", path: "/peek", handler: async ({ records }) => records.list("fixture_apps") },
    ],
  });
  setPacksForTest([{ manifest: manifest("fixture_audit"), definition: fixture }]);
  assert.deepEqual(rec.recordAreas().map((a) => a.name), ["fixture_sources", "fixture_checks", "fixture_apps", "fixture_state"]);
  assert.equal(packRegistry().recordAreas.length, 4, "listed in the registry");

  // Shared records, written as platform staff would.
  await rec.putPlatform(null, "fixture_sources", "s1", { title: "Requirement one", data: { body: "Keep logs for a year", issuer: "Regulator X" }, version: "2026-10" });
  await rec.putPlatform(null, "fixture_checks", "c1", { title: "Logs are kept", data: { summary: "Retention is configured", source: "s1" } });
  await assert.rejects(rec.putPlatform(null, "fixture_checks", "c2", { data: { nope: 1 } }), /has no field "nope"/, "unknown fields refused");
  await assert.rejects(rec.putPlatform(null, "fixture_apps", "x", { data: {} }), /written by the workspace/, "a workspace area is not written as shared");

  const ca = await connect(A), cb = await connect(B);
  {
    const names = (await ca.client.listTools()).tools.map((t) => t.name);
    assert.deepEqual(names.slice(0, TOOL_NAMES.length).sort(), [...TOOL_NAMES].sort(), "the shell's tools first, unchanged");
    assert.deepEqual(names.slice(TOOL_NAMES.length), ["fixture_put_app", "fixture_put_shared", "fixture_count_raw", "list_records", "get_record"], "then the pack's, then the record tools");
    const listTool = (await ca.client.listTools()).tools.find((t) => t.name === "list_records")!;
    assert.equal(listTool.annotations?.readOnlyHint, true, "read only");
    assert.deepEqual((listTool.inputSchema.properties as any).area.enum, ["fixture_sources", "fixture_checks", "fixture_apps", "fixture_state"], "area is one of the declared areas");
    console.log("✓ a pack that only declares areas gets list_records and get_record on the MCP server");
  }

  // ---------- 4. workspace areas: each workspace sees its own ----------
  {
    assert.ok(!(await ca.call("fixture_put_app", { key: "app-a", url: "https://a.example", note: `A private ${STAMP}` })).isError);
    assert.ok(!(await cb.call("fixture_put_app", { key: "app-b", url: "https://b.example", note: `B private ${STAMP}` })).isError);
    assert.ok(!(await cb.call("fixture_put_app", { key: "app-shared-key", url: "https://b2.example", note: "B two" })).isError);
    assert.ok(!(await ca.call("fixture_put_app", { key: "app-shared-key", url: "https://a2.example", note: "A two" })).isError, "the same key in two workspaces is two records");
    const la = (await ca.call("list_records", { area: "fixture_apps" })).structuredContent;
    assert.deepEqual(la.records.map((r: any) => r.key), ["app-a", "app-shared-key"], "A lists its own applications only");
    assert.equal(la.records[1].url, "https://a2.example", "and its own copy of a shared key");
    const lb = (await cb.call("list_records", { area: "fixture_apps" })).structuredContent;
    assert.deepEqual(lb.records.map((r: any) => r.key), ["app-b", "app-shared-key"]);
    const cross = await ca.call("get_record", { area: "fixture_apps", key: "app-b" });
    assert.ok(cross.isError && /no record app-b/.test(cross.content[0]!.text), "A cannot get B's application by key");
    const own = (await ca.call("get_record", { area: "fixture_apps", key: "app-a" })).structuredContent;
    assert.equal(own.record.data.secret_note, `A private ${STAMP}`, "A reads its own private note");
    assert.deepEqual(own.links, [{ field: "checks", area: "fixture_checks", records: [{ key: "c1", title: "Logs are kept" }] }], "links resolve to the shared check");
    const chk = (await cb.call("get_record", { area: "fixture_checks", key: "c1" })).structuredContent;
    assert.deepEqual(chk.links[0].records, [{ key: "s1", title: "Requirement one" }], "a shared check links to its shared source, for every workspace");
    assert.equal((await ca.call("fixture_count_raw")).structuredContent.n, 2, "a pack query without a workspace filter sees A's rows only (row-level security)");
    // Raw: as the tenant role for A, nothing of B's is visible or reachable.
    const seen = await withTenant(A.orgId, () => db.query<{ org_id: number }>("/* tenant: test, on purpose */ SELECT DISTINCT org_id FROM workspace_records"));
    assert.deepEqual(seen.map((r) => r.org_id), [A.orgId], "the tenant role sees only its workspace's records");
    const moved = await withTenant(A.orgId, () => db.query("/* tenant: test, on purpose */ UPDATE workspace_records SET title = 'hijacked' WHERE key = 'app-b' RETURNING id"));
    assert.equal(moved.length, 0, "A cannot change B's record");
    await assert.rejects(withTenant(A.orgId, () => db.query("INSERT INTO workspace_records (org_id, pack, area, key) VALUES ($1, 'fixture_audit', 'fixture_apps', 'planted')", [B.orgId])),
      (e: { code?: string }) => e.code === "42501", "A cannot plant a record in B's workspace");
    // Sealed at rest: the raw row holds ciphertext only; B's key cannot open A's.
    const [raw] = await db.query<{ title: string; data: any; sealed: boolean }>("SELECT title, data, sealed FROM workspace_records WHERE org_id = $1 AND key = 'app-a'", [A.orgId]);
    assert.ok(raw!.sealed && typeof raw!.data._sealed === "string" && raw!.data._sealed.startsWith("enc:v1:") && raw!.title.startsWith("enc:v1:"), "an asset's title and data are sealed");
    assert.ok(!JSON.stringify(raw).includes("A private") && !JSON.stringify(raw).includes("a.example"), "no plain text at rest");
    const { open } = await import("../src/orgcrypto.js");
    await assert.rejects(open(B.orgId, raw!.data._sealed), "B's data key cannot open A's record");
    const [st] = await db.query<{ data: any; sealed: boolean }>("SELECT data, sealed FROM workspace_records WHERE org_id = $1 AND area = 'fixture_state' LIMIT 1", [A.orgId]);
    assert.equal(st, undefined);
    await withTenant(A.orgId, () => rec.workspaceRecords("fixture_audit", A.orgId).put("fixture_state", "c1", { data: { status: "pass", score: 1 } }));
    const [st2] = await db.query<{ data: any; sealed: boolean }>("SELECT data, sealed FROM workspace_records WHERE org_id = $1 AND area = 'fixture_state'", [A.orgId]);
    assert.deepEqual([st2!.sealed, st2!.data], [false, { status: "pass", score: 1 }], "a check's per-workspace state is not an asset: stored as is");
    await assert.rejects(rec.workspaceRecords("fixture_audit", A.orgId).put("fixture_state", "c1", { data: { score: "high" } }), /must be a number/, "field types are checked");
    await assert.rejects(rec.workspaceRecords("other_pack", A.orgId).put("fixture_state", "c1", { data: {} }), /belongs to pack fixture_audit/, "another pack cannot write this pack's area");
    console.log("✓ workspace areas: each workspace sees only its own rows (MCP, raw tenant query, writes refused across); assets sealed with the workspace key");
  }

  // ---------- 5. platform areas are read-only to customers ----------
  {
    const shared = await ca.call("fixture_put_shared");
    assert.ok(shared.isError && /read only here/.test(shared.content[0]!.text), `ctx.records cannot write a shared area: ${shared.content[0]?.text}`);
    for (const sql of ["INSERT INTO platform_records (pack, area, key) VALUES ('fixture_audit', 'fixture_sources', 'evil')",
      "UPDATE platform_records SET title = 'evil'", "DELETE FROM platform_records"])
      await assert.rejects(withTenant(A.orgId, () => db.query(sql)), (e: { code?: string }) => e.code === "42501", `the tenant role is refused: ${sql}`);
    assert.equal((await db.query("SELECT 1 FROM platform_records WHERE key = 'evil' OR title = 'evil'")).length, 0, "nothing changed");
    assert.ok((await ca.call("list_records", { area: "fixture_sources" })).structuredContent.records.length === 1, "but every workspace reads them");
    console.log("✓ platform areas: the tenant role is refused by the database, ctx.records refuses, every workspace reads them");
  }

  // ---------- HTTP: the console's data ----------
  const http = await startHttp();
  try {
    const sa = await http.signIn(A), sb = await http.signIn(B), sv = await http.signIn(A, "viewer");
    const get = async (p: string, tok?: string) => { const r = await http.req("GET", p, tok ? { authorization: `Bearer ${tok}` } : {}); return { status: r.status, body: await r.json().catch(() => null) }; };
    assert.equal((await get("/api/records/fixture_apps")).status, 401, "no session: 401");
    const areas = await get("/api/records/areas", sa);
    assert.deepEqual(areas.body.areas.map((a: any) => [a.name, a.scope]), [["fixture_sources", "platform"], ["fixture_checks", "platform"], ["fixture_apps", "workspace"], ["fixture_state", "workspace"]]);
    const listA = await get("/api/records/fixture_apps", sa);
    assert.deepEqual(listA.body.records.map((r: any) => r.key), ["app-a", "app-shared-key"], "the list page's data is A's");
    assert.deepEqual((await get("/api/records/fixture_apps", sb)).body.records.map((r: any) => r.key), ["app-b", "app-shared-key"], "and B's for B");
    assert.equal((await get("/api/records/fixture_apps/app-b", sa)).status, 404, "A's detail page for B's record: 404");
    const detail = await get("/api/records/fixture_apps/app-a", sv);
    assert.equal(detail.status, 200, "a viewer reads");
    assert.equal(detail.body.record.data.url, "https://a.example");
    assert.equal(detail.body.links[0].records[0].key, "c1", "the detail page's links");
    assert.equal((await get("/api/records/no_such_area", sa)).status, 404);
    assert.equal((await get("/api/records/fixture_apps?limit=500", sa)).status, 400, "limits are checked");
    const p1 = await get("/api/records/fixture_apps?limit=1", sa);
    assert.deepEqual([p1.body.records.length, p1.body.next], [1, "app-a"], "paged");
    assert.deepEqual((await get(`/api/records/fixture_apps?limit=1&after=${p1.body.next}`, sa)).body.records.map((r: any) => r.key), ["app-shared-key"]);
    for (const m of ["PUT", "POST", "DELETE"])
      assert.equal((await http.req(m, "/api/records/fixture_sources/s1", { authorization: `Bearer ${sa}` }, { data: { body: "x" } })).status, 404, `no customer route writes a record (${m})`);
    // Staff: shared areas only; writes need "library", deletes "delete".
    const viewerTok = await http.adminToken("viewer"), operatorTok = await http.adminToken("operator"), ownerTok = await http.adminToken("owner");
    assert.equal((await get("/api/admin/records/fixture_sources", sa)).status, 403, "a customer session is not staff");
    assert.equal((await get("/api/admin/records/fixture_sources", viewerTok)).body.records[0].version, "2026-10", "staff read shared areas");
    assert.equal((await get("/api/admin/records/fixture_apps", viewerTok)).status, 404, "a workspace area is not listed across workspaces here");
    const put = (tok: string, body: unknown) => http.req("PUT", "/api/admin/records/fixture_sources/s2", { authorization: `Bearer ${tok}` }, body);
    assert.equal((await put(viewerTok, { title: "Two", data: { body: "b" } })).status, 403, "a viewer cannot write");
    assert.equal((await put(operatorTok, { title: "Two", data: { body: "b" }, version: "2026-11" })).status, 200, "an operator (library) writes");
    assert.equal((await put(operatorTok, { data: { nope: 1 } })).status, 400, "fields are checked");
    assert.equal((await http.req("DELETE", "/api/admin/records/fixture_sources/s2", { authorization: `Bearer ${operatorTok}` })).status, 403, "deleting needs the owner");
    assert.equal((await http.req("DELETE", "/api/admin/records/fixture_sources/s2", { authorization: `Bearer ${ownerTok}` })).status, 204);
    // A pack's admin route writes its shared areas through ctx.records, and cannot read workspace areas that way.
    assert.equal((await http.req("POST", "/api/admin/packs/fixture_audit/index", { authorization: `Bearer ${operatorTok}` }, { key: "s3" })).status, 200);
    assert.equal((await rec.getFor(A.orgId, "fixture_sources", "s3"))?.version, "v2");
    assert.equal((await get("/api/admin/packs/fixture_audit/peek", viewerTok)).status, 403, "a pack admin route cannot list workspace areas through ctx.records");
    console.log("✓ HTTP: list and detail data per workspace (401 signed out, 404 across workspaces), no customer writes; staff write shared areas with library");
  } finally {
    await http.close();
  }

  // ---------- 6. RLS check and probe; deleting a workspace ----------
  {
    const { rlsCatalogProblems, rlsProbe } = await import("../src/rls.js");
    assert.deepEqual(await rlsCatalogProblems(db), [], "the catalog check passes with the record tables");
    const probe = await rlsProbe(db);
    assert.deepEqual(probe.problems, [], "the live probe passes");
    // A policy opened on the workspace table fails the check.
    await db.exec("ALTER POLICY tenant_isolation ON workspace_records USING (true)");
    assert.ok((await rlsCatalogProblems(db)).some((p) => p.includes("workspace_records")), "an opened workspace_records policy fails the RLS check");
    await db.exec("ALTER POLICY tenant_isolation ON workspace_records USING (org_id = octillion_tenant_org())");
    // A write grant on the shared table fails it too.
    const [{ r }] = await db.query<{ r: string }>("SELECT octillion_tenant_role() AS r");
    await db.exec(`GRANT INSERT ON platform_records TO ${r}`);
    assert.ok((await rlsCatalogProblems(db)).some((p) => p.includes("platform_records")), "a write grant on platform_records fails the RLS check");
    await db.exec(`REVOKE INSERT ON platform_records FROM ${r}`);
    assert.deepEqual(await rlsCatalogProblems(db), []);
    await db.query("DELETE FROM organizations WHERE id = $1", [B.orgId]);
    assert.equal((await db.query("SELECT 1 FROM workspace_records WHERE org_id = $1", [B.orgId])).length, 0, "a deleted workspace's records go with it");
    console.log(`✓ row-level security: catalog check and live probe (${probe.checked} checks) pass; opened policies and write grants are caught; records go with their workspace`);
  }
  await ca.close(); await cb.close();
  void PackError;

  // ---------- 7. gen-packs: the console's registry and sidebar from definePack ----------
  {
    const dir = path.join(TMP, "packs-gen");
    const api = (pdir: string) => path.relative(pdir, path.join(ROOT, "src", "pack-api.js")).split(path.sep).join("/");
    const write = (id: string, areas: string) => {
      const pdir = path.join(dir, id);
      mkdirSync(pdir, { recursive: true });
      writeFileSync(path.join(pdir, "pack.json"), JSON.stringify({ id, name: id, version: "1", entry: "index.ts" }));
      writeFileSync(path.join(pdir, "index.ts"), `import { definePack } from "${api(pdir)}";\nexport default definePack({ id: "${id}", recordAreas: ${areas} });\n`);
    };
    const gen = () => spawnSync(process.execPath, [path.join(ROOT, "scripts", "gen-packs.mjs"), "--packs", dir, "--out", path.join(TMP, "packs-gen-out"), "--profile", path.join(dir, "none.json")], { cwd: ROOT, encoding: "utf8" });
    write("gp", JSON.stringify([
      { name: "gp_sources", label: "Sources", role: "source", scope: "platform", fields: [{ name: "body", label: "Body" }] },
      { name: "gp_apps", label: "Apps", role: "asset", scope: "workspace", fields: [{ name: "url", label: "URL" }, { name: "src", label: "Source", type: "link" }], links: [{ field: "src", area: "gp_sources" }] },
    ]));
    const ok = gen();
    assert.equal(ok.status, 0, `gen-packs with record areas: ${ok.stderr}`);
    assert.match(ok.stdout, /1 pack\(s\) \(gp\), 0 page\(s\), 2 record area\(s\)/);
    const text = readFileSync(path.join(TMP, "packs-gen-out", "web", "src", "config", "pack-nav.generated.ts"), "utf8");
    const exp = (name: string) => JSON.parse(new RegExp(`export const ${name}[^=]*= ([\\s\\S]*?);\\n`).exec(text)![1]!);
    assert.deepEqual(exp("recordAreas").map((a: any) => [a.name, a.scope, a.fields[0].type, a.list_columns]), [["gp_sources", "platform", "text", ["body"]], ["gp_apps", "workspace", "text", ["url", "src"]]], "defaults filled in");
    assert.deepEqual(exp("recordPortalNav"), [{ label: "Records", items: [{ title: "Sources", url: "/app/records/gp_sources", items: [] }, { title: "Apps", url: "/app/records/gp_apps", items: [] }] }], "the /app sidebar lists every area");
    assert.deepEqual(exp("recordAdminNav"), [{ label: "Records", items: [{ title: "Sources", url: "/admin/records/gp_sources", items: [] }] }], "the /admin sidebar lists shared areas only");
    write("gq", JSON.stringify([{ name: "gp_sources", label: "Again", role: "source", scope: "platform", fields: [{ name: "bb", label: "B" }] }]));
    const dup = gen();
    assert.equal(dup.status, 1);
    assert.match(dup.stderr, /record area gp_sources is already pack gp's/, "duplicate area names across packs are refused at build");
    write("gq", JSON.stringify([{ name: "gq_x", label: "X", role: "check", scope: "platform", fields: [{ name: "bb", label: "B" }], links: [{ field: "bb", area: "missing" }] }]));
    assert.match(gen().stderr, /links field bb to area missing, which no pack declares/, "a link to an undeclared area is refused at build");
    write("gq", `[{ name: "gq_x", label: "X", role: "asset", scope: "platform", fields: [{ name: "bb", label: "B" }] }]`);
    assert.match(gen().stderr, /workspace scope only/, "definePack's own checks fail the build");
    console.log("✓ gen-packs writes the console's record areas and Records sidebar groups from definePack, and refuses clashes");
  }
  await db.close();
  console.log("RECORD AREAS TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
