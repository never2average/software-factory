// MCP follow-ups (mold_v0-067; src/mcp-withheld.ts, src/shell-tools.ts, src/mcp-tools.ts adminGeneratedTools,
// src/limits.ts checkAccountRun), offline: an embedded database, the declarative fixture packs, two workspaces.
//   npm run test:mcp-followups
//
// 1. gen-packs knows the shell's own tool names: a pack whose generated tool (by rename or prefix) or own tool takes
//    one is refused at build, not only when the server starts; the build's list is the servers' own.
// 2. A staff call for a workspace (an admin_only tool on the admin MCP) is written to that workspace's activity log, as
//    "staff:<pseudonym>" (never the staff member's identity), failures included; the other workspace's log gets
//    nothing; the usage report labels it Staff and does not count it as one of the workspace's people.
// 3. A run staff start for a workspace passes the account's own launch rules (the buffer it holds back): refused when
//    the account's launches are blocked, started (and attributed to staff) when they are not.
// 4. A tool a pack excludes or marks admin_only also withholds its route: the data API (each verb, batches), the
//    console's record data, the metrics and runs it reads, list_records/get_record, and the staff routes of an excluded
//    staff tool; what is not withheld answers as before; staff still use an admin_only tool. gen-packs leaves the
//    withheld area's tab out of the sidebar.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanup, connect, startHttp, STAMP, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.OCTILLION_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];

type Org = import("../src/auth.js").Org;
const fixture = (id: string) => JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", id, "pack.json"), "utf8"));
const gen = (args: string[]) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "gen-packs.mjs"), ...args], { cwd: ROOT, encoding: "utf8" });

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const TOOL_NAMES = (await import("../src/server.js")).ownToolNames(); // the host packs' (none here, mold_v0-039)
  const { adminToolNames, createAdminServer } = await import("../src/admin-mcp.js");
  const ADMIN_TOOL_NAMES = adminToolNames();
  const { SHELL_TOOL_NAMES, ADMIN_SHELL_TOOL_NAMES, RECORD_TOOL_NAMES } = await import("../src/shell-tools.js");
  const { RECORD_TOOL_NAMES: fromAreas } = await import("../src/record-areas.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  const { staffId } = await import("../src/analytics.js");
  const { dataApi } = await import("../src/data-api.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  const declared = (id: string, mcp?: unknown) => {
    const j = fixture(id);
    if (mcp !== undefined) j.mcp = mcp;
    return { manifest: { id, name: j.name, version: j.version, entry: null, migrations: null, words: j.words ?? {}, dir: path.join(ROOT, "scripts", "fixtures", "packs", id) },
      declared: compileDeclarations(j) };
  };
  const adminClient = async (role: "viewer" | "support" | "operator" | "owner", actor = `test-${role}`) => {
    const server = createAdminServer({ actor, role, userId: null });
    const client = new Client({ name: "mcp-followups-test", version: "1" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    return { client, call: async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any; content: { text: string }[] } };
  };
  const text = (r: { content: unknown[] }) => r.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
  /** Fire-and-forget records land shortly after the call. */
  const settle = () => new Promise((r) => setTimeout(r, 300));

  // ---------- 1. the build knows the shell's tool names ----------
  {
    const sorted = (x: readonly string[]) => [...x].sort();
    assert.deepEqual(sorted(SHELL_TOOL_NAMES), sorted(TOOL_NAMES), "the build's list is the customer MCP's own tools");
    assert.deepEqual(sorted(ADMIN_SHELL_TOOL_NAMES), sorted(ADMIN_TOOL_NAMES), "and the admin MCP's");
    assert.deepEqual([...RECORD_TOOL_NAMES], [...fromAreas], "and the record tools'");
    const dir = path.join(TMP, "clash-packs");
    const tryPack = (name: string, json: Record<string, unknown>, files: Record<string, string> = {}) => {
      const d = path.join(dir, name), pd = path.join(d, String(json.id));
      mkdirSync(pd, { recursive: true });
      writeFileSync(path.join(pd, "pack.json"), JSON.stringify(json));
      for (const [f, t] of Object.entries(files)) writeFileSync(path.join(pd, f), t);
      return gen(["--packs", d, "--out", path.join(d, "out")]);
    };
    const area = { name: "pc_things", label: "Things", role: "asset", scope: "workspace", fields: [{ name: "body", label: "Body", type: "text" }] };
    const good = tryPack("good", { id: "pc", name: "P", version: "1", record_areas: [area] });
    assert.equal(good.status, 0, `a pack without a clash builds: ${good.stderr}`);
    const renamed = tryPack("renamed", { id: "pc", name: "P", version: "1", record_areas: [area], mcp: { rename: { pc_list_pc_things: "list_records" } } }); // the shell's own customer tools are the record tools (mold_v0-039)
    assert.equal(renamed.status, 1, `a generated tool renamed to a shell tool's name is refused at build: ${renamed.stdout}`);
    assert.match(renamed.stderr, /pc_list_pc_things\) clashes with the shell's or a pack's own tool on the customer MCP/);
    const recordName = tryPack("record", { id: "pc", name: "P", version: "1", record_areas: [area], mcp: { rename: { pc_get_pc_things: "get_record" } } });
    assert.match(recordName.stderr, /clashes with the shell's or a pack's own tool/, "the record tools' names too");
    const adminName = tryPack("admin", { id: "pc", name: "P", version: "1", record_areas: [{ ...area, role: "source", scope: "platform" }], mcp: { rename: { pc_admin_get_pc_things: "list_accounts" } } });
    assert.match(adminName.stderr, /clashes with an admin MCP tool of the shell on the admin MCP/, "and the admin MCP's");
    const api = path.relative(path.join(dir, "own", "pc"), path.join(ROOT, "src", "pack-api.js")).split(path.sep).join("/");
    const own = tryPack("own", { id: "pc", name: "P", version: "1", entry: "index.ts" }, { "index.ts":
      `import { definePack, defineTool, z } from "${api}";\nexport default definePack({ id: "pc", tools: [defineTool({ name: "list_records", description: "x", inputSchema: { q: z.string() }, annotations: { readOnlyHint: true }, handler: async () => ({}) })] });\n` });
    assert.equal(own.status, 1, `a pack's own tool of a shell tool's name is refused at build: ${own.stdout}`);
    assert.match(own.stderr, /pack pc: tool list_records is already a shell tool/);
    console.log("✓ gen-packs refuses a pack tool (generated, renamed or its own) that takes a shell tool's name, on either MCP; its list is the servers' own");
  }

  // ---------- 2 and 3. staff calls in the workspace's log; staff runs under the account's launch rules ----------
  const A = await createOrg(`Follow A ${STAMP}`), B = await createOrg(`Follow B ${STAMP}`);
  {
    // fixture_review with its start tool also moved to the admin MCP.
    setPacksForTest([declared("fixture_tracker"), declared("fixture_review", { ...fixture("fixture_review").mcp, admin_only: ["review_cancel_review", "review_start_review_pass"] })]);
    const ca = await connect({ ...A.org, userId: "user_owner_a", role: "owner" });
    const made = await ca.call("review_create_review_items", { key: "item-a", data: { url: "https://a.example" } });
    assert.ok(!made.isError, text(made));
    await ca.close();
    const operator = await adminClient("operator", "ops@platform.example");
    const countB = async () => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM mcp_events WHERE org_id = $1", [B.org.orgId]))[0]!.n;
    const beforeB = await countB();

    // 3. The account holds its whole allowance back from launches (Budget rules' buffer): a person could not launch, so
    // neither may staff for it. checkRunStart alone (the allowance against spend) would let this run start.
    const { setPolicy } = await import("../src/limits.js");
    const { withTenant } = await import("../src/tenant-scope.js");
    await withTenant(A.org.orgId, () => setPolicy(A.org.orgId, { label: "test", user: null }, { reserve_usd: 1000 }));
    const blocked = await operator.call("review_start_review_pass", { workspace: A.org.slug, item: "item-a" });
    assert.ok(blocked.isError, `staff cannot start a run the account's launch rules refuse: ${text(blocked)}`);
    assert.match(text(blocked), /allowance|hold back|held back|buffer|reserve|set aside/i, text(blocked));
    assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM runs WHERE org_id = $1", [A.org.orgId]))[0]!.n, 0, "no run was queued");
    await withTenant(A.org.orgId, () => setPolicy(A.org.orgId, { label: "test", user: null }, { reserve_usd: 0 }));
    const started = await operator.call("review_start_review_pass", { workspace: A.org.slug, item: "item-a" });
    assert.ok(!started.isError, `with the account's launches open, staff start it: ${text(started)}`);
    const runId = started.structuredContent.run.id as string;
    const [run] = await db.query<{ requested_by: string }>("SELECT requested_by FROM runs WHERE id = $1", [runId]);
    assert.equal(run!.requested_by, staffId("ops@platform.example", A.org.orgId), "the run is attributed to staff, under a pseudonym");
    const { createHash } = await import("node:crypto");
    assert.notEqual(staffId("ops@platform.example", A.org.orgId), staffId("ops@platform.example", B.org.orgId), "a different one in each workspace");
    assert.ok(!staffId("ops@platform.example", A.org.orgId).includes(createHash("sha256").update("staff-actor:ops@platform.example").digest("hex").slice(0, 12)), "keyed: a guessed email cannot be checked");
    console.log("✓ a run staff start for a workspace passes the account's launch rules (refused while its launches are held back, started when open)");

    // 2. The calls above, a cancel and a failure are in A's own log, under the staff pseudonym; B's log has nothing.
    const ok = await operator.call("review_cancel_review", { workspace: A.org.slug, run_id: runId });
    assert.ok(!ok.isError, text(ok));
    const failed = await operator.call("review_cancel_review", { workspace: A.org.slug, run_id: "run_doesnotexist" });
    assert.ok(failed.isError);
    await settle();
    const rows = await db.query<{ org_id: number; user_id: string | null; name: string; ok: boolean; error_class: string | null; client_name: string | null; key_id: number | null }>(
      "SELECT org_id, user_id, name, ok, error_class, client_name, key_id FROM mcp_events WHERE org_id = ANY($1) AND method = 'tools/call' AND name LIKE 'review_%' AND user_id LIKE 'staff:%' ORDER BY id",
      [[A.org.orgId, B.org.orgId]]);
    assert.ok(rows.every((r) => r.org_id === A.org.orgId), "only A's log has the staff calls");
    assert.deepEqual(rows.map((r) => [r.name, r.ok]), [["review_start_review_pass", false], ["review_start_review_pass", true], ["review_cancel_review", true], ["review_cancel_review", false]],
      `every staff call for A, refused and failed ones included: ${JSON.stringify(rows)}`);
    assert.ok(rows.every((r) => r.user_id === staffId("ops@platform.example", A.org.orgId) && r.client_name === "admin-mcp" && r.key_id === null), "as staff, never a member or a key");
    assert.ok(!JSON.stringify(await db.query("SELECT * FROM mcp_events WHERE org_id = $1", [A.org.orgId])).includes("ops@platform.example"), "the staff member's identity is not in the workspace's log");
    assert.equal(await countB(), beforeB, "B's log is untouched");
    const { workspaceUsageReport } = await import("../src/usage-report.js");
    const report = await withTenant(A.org.orgId, () => workspaceUsageReport(A.org.orgId, {}));
    assert.ok(report.tools.some((t) => t.name === "review_cancel_review"), "the workspace's usage shows the staff calls");
    // The one person is A's owner, who added the item above: staff are not counted as one of the workspace's people.
    assert.equal(report.totals.people, 1, `staff are not counted as one of the workspace's people: ${report.totals.people}`);
    assert.equal(report.active.wau, 1, "nor in its weekly active people");
    assert.ok(report.members.some((m) => m.user_id?.startsWith("staff:")), "they show as their own line");
    await operator.client.close();
    console.log("✓ staff calls for a workspace are in that workspace's own activity log (pseudonymous, failures included), never another's, and not counted as its people");
  }

  // ---------- 4. withheld tools withhold their routes too ----------
  {
    const MCP = { prefix: "review", rename: { review_list_review_notes: "review_notes" },
      exclude: ["review_list_review_items", "review_create_review_notes", "review_get_metrics", "review_admin_delete_review_guides", "review_get_review_results", "review_start_review_pass"],
      admin_only: ["review_update_review_notes", "review_list_reviews", "review_cancel_review"] };
    setPacksForTest([declared("fixture_tracker"), declared("fixture_review", MCP)]);
    const http = await startHttp();
    const ownerA = await http.signIn(A.org, "owner");
    const call = async (method: string, p: string, tok: string | null, body?: unknown) => {
      const r = await http.req(method, p, tok ? { authorization: `Bearer ${tok}` } : {}, body);
      const t = await r.text();
      let json: any = null;
      try { json = t ? JSON.parse(t) : null; } catch { json = t; }
      return { status: r.status, body: json };
    };
    const caller = { orgId: A.org.orgId, role: "owner" as const, userId: null };
    const { withTenant } = await import("../src/tenant-scope.js");
    await withTenant(A.org.orgId, () => dataApi.create(caller, "review_notes", "n1", { data: { body: "first", item: "item-a" } }));
    // The workspace's routes of each withheld operation answer as if they did not exist; the others as before.
    const expect = async (what: string, method: string, p: string, status: number, body?: unknown, tok: string | null = ownerA) => {
      const r = await call(method, p, tok, body);
      assert.equal(r.status, status, `${what}: ${method} ${p} answers ${status} (got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)})`);
      return r;
    };
    await expect("list excluded", "GET", "/api/data/review_items", 404);
    await expect("get kept", "GET", "/api/data/review_items/item-a", 200);
    await expect("list kept", "GET", "/api/data/review_notes", 200);
    await expect("list excluded (console data)", "GET", "/api/records/review_items", 404);
    await expect("list kept (console data)", "GET", "/api/records/review_notes", 200);
    await expect("create excluded", "POST", "/api/data/review_notes", 404, { key: "n2", data: { body: "x", item: "item-a" } });
    await expect("update admin_only", "PUT", "/api/data/review_notes/n1", 404, { data: { body: "changed", item: "item-a" } });
    await expect("move kept", "POST", "/api/data/review_notes/n1/move", 200, { to: "done" });
    await expect("a batch creating in a withheld area", "POST", "/api/data/_batch", 404, { operations: [{ op: "create", area: "review_notes", key: "n3", data: { body: "x", item: "item-a" } }] });
    await expect("a batch putting into it (a create or an update)", "POST", "/api/data/_batch", 404, { operations: [{ op: "put", area: "review_notes", key: "n1", data: { body: "x", item: "item-a" } }] });
    await expect("a batch elsewhere", "POST", "/api/data/_batch", 200, { operations: [{ op: "create", area: "review_items", key: "item-b", data: { url: "https://b.example" } }] });
    assert.equal((await withTenant(A.org.orgId, () => dataApi.get(caller, "review_notes", "n1")))!.record.data.body, "first", "the withheld update changed nothing");
    await expect("metrics excluded", "GET", "/api/metrics?names=notes_by_state", 404);
    // The pack's runs, whose list tool is admin_only, are not listed for the workspace; another pack's are.
    const { startRun } = await import("../src/runs.js");
    await withTenant(A.org.orgId, () => startRun(A.org.orgId, "fixture_review", "review_pass", { scope: { item: "item-a" } }));
    const rid = (await db.query<{ id: string }>("SELECT id FROM runs WHERE org_id = $1 AND pack = 'fixture_review' ORDER BY created_at DESC LIMIT 1", [A.org.orgId]))[0]!.id;
    await db.query("INSERT INTO run_results (run_id, org_id, check_area, check_key, status) VALUES ($1, $2, 'review_notes', 'n1', 'fail')", [rid, A.org.orgId]);
    const runs = await expect("runs list", "GET", "/api/runs", 200);
    assert.ok(!runs.body.runs.some((r: any) => r.pack === "fixture_review"), "the withheld pack's runs are not listed");
    const one = await expect("a run whose status tool is kept", "GET", `/api/runs/${rid}`, 200);
    assert.equal(one.body.run.status, "queued", "its status is shown");
    assert.deepEqual(one.body.results, [], "its results, whose tool is excluded, are not");
    // Deletes: no tool of their own; kept while any write of the area is, withheld when every write is.
    await expect("delete while a write (move) is kept", "DELETE", "/api/data/review_items/item-b", 204);
    const { areaOpWithheld, batchWithheld } = await import("../src/mcp-withheld.js");
    assert.equal(areaOpWithheld("review_notes", "delete"), false, "notes keep their move: deletes stay");
    assert.equal(batchWithheld([{ op: "constructor", area: "review_notes" }, { op: "__proto__", area: "x" }], "workspace"), null, "an op named like a built-in needs nothing (no crash)");
    assert.notEqual((await call("POST", "/api/data/_batch", ownerA, { operations: [{ op: "constructor", area: "review_notes", key: "n1" }] })).status, 500, "and answers without a server error");
    // A kind whose start tool is withheld cannot be scheduled by the workspace.
    await expect("scheduling a withheld kind", "POST", "/api/schedules", 404, { pack: "fixture_review", job_kind: "review_pass", name: "nightly", cron: "0 3 * * *" });
    // Staff routes of an excluded staff tool, for a platform owner.
    const staff = await http.adminToken("owner");
    await expect("staff create", "POST", "/api/admin/data/review_guides", 201, { key: "g1", data: { summary: "one" } }, staff);
    await expect("staff list kept", "GET", "/api/admin/data/review_guides", 200, undefined, staff);
    await expect("staff delete excluded", "DELETE", "/api/admin/data/review_guides/g1", 404, undefined, staff);
    await expect("staff delete excluded (records)", "DELETE", "/api/admin/records/review_guides/g1", 404, undefined, staff);
    await expect("staff batch delete excluded", "POST", "/api/admin/data/_batch", 404, { operations: [{ op: "delete", area: "review_guides", key: "g1" }] }, staff);
    assert.ok(await withTenant(A.org.orgId, () => dataApi.get(caller, "review_guides", "g1")), "the shared record is still there");
    // list_records and get_record do not reach a withheld area either.
    const c = await connect({ ...A.org, userId: "user_owner_a", role: "owner" });
    const tools = (await c.client.listTools()).tools;
    const lr = tools.find((t) => t.name === "list_records")!;
    assert.ok(!JSON.stringify(lr.inputSchema).includes("review_items") && !lr.description!.includes("review_items"), "list_records does not offer the withheld area");
    assert.ok(JSON.stringify(tools.find((t) => t.name === "get_record")!.inputSchema).includes("review_items"), "get_record still does (its get tool is kept)");
    const viaShell = await c.call("list_records", { area: "review_items" });
    assert.ok(viaShell.isError, "and refuses it when asked by name");
    assert.ok(!tools.some((t) => ["review_list_review_items", "review_create_review_notes", "review_get_metrics", "review_update_review_notes", "review_list_reviews"].includes(t.name)), "none of the withheld tools is offered");
    await c.close();
    // Staff still use an admin_only tool.
    const operator = await adminClient("operator");
    const upd = await operator.call("review_update_review_notes", { workspace: A.org.slug, key: "n1", data: { body: "by staff", item: "item-a" } });
    assert.ok(!upd.isError, `staff update through the admin MCP: ${text(upd)}`);
    await operator.client.close();
    // With every write of an area withheld, its deletes are too.
    setPacksForTest([declared("fixture_tracker"), declared("fixture_review", { ...MCP, admin_only: [...MCP.admin_only, "review_move_review_notes"] })]);
    assert.equal(areaOpWithheld("review_notes", "delete"), true, "no write of notes left to the workspace: no delete either");
    await expect("delete with every write withheld", "DELETE", "/api/data/review_notes/n1", 404);
    await expect("a batch delete there", "POST", "/api/data/_batch", 404, { operations: [{ op: "delete", area: "review_notes", key: "n1" }] });
    await http.close();
    // gen-packs leaves the withheld area out of the sidebar (Records and tabs), and keeps the rest.
    const pdir = path.join(TMP, "withheld-packs");
    for (const id of ["fixture_review"]) {
      cpSync(path.join(ROOT, "scripts", "fixtures", "packs", id), path.join(pdir, id), { recursive: true });
      writeFileSync(path.join(pdir, id, "pack.json"), JSON.stringify({ ...fixture(id), mcp: MCP, tabs: [
        { id: "items", kind: "area", label: "Items", area: "review_items" }, { id: "notes", kind: "area", label: "Notes", area: "review_notes" }, { id: "reviews", kind: "runs", label: "Reviews" }] }));
    }
    const g = gen(["--packs", pdir, "--out", path.join(pdir, "out")]);
    assert.equal(g.status, 0, g.stderr);
    const nav = readFileSync(path.join(pdir, "out", "web", "src", "config", "pack-nav.generated.ts"), "utf8");
    const records = nav.slice(nav.indexOf("export const recordPortalNav"), nav.indexOf("export const recordAdminNav"));
    assert.ok(!records.includes("/app/records/review_items") && records.includes("/app/records/review_notes"), `the Records group leaves the withheld area out: ${records}`);
    const tabs = nav.slice(nav.indexOf("export const tabPortalNav"));
    assert.ok(!tabs.includes('"Items"') && tabs.includes('"Notes"') && !tabs.includes('"Reviews"'), `the withheld area's and runs' tabs are not in the sidebar: ${tabs}`);
    assert.ok(nav.slice(nav.indexOf("export const recordAdminNav")).includes("/admin/records/review_guides"), "staff keep the shared area (its list is not withheld)");
    console.log("✓ an excluded or admin_only tool withholds its data API route (each verb and batches), console data, metrics, runs list, list_records and the sidebar tab; excluded staff tools their staff routes; the rest answers as before");
  }
  console.log("mcp-followups: all checks passed");
  process.exit(0);
} finally {
  cleanup();
}
