// The audit trails (mold_v0-197; src/audit-trail.ts, sql/migrations/0031_audit_trails.sql), offline: a build copy of
// the codebase with the fixture pack fixture_vulns (two workspace areas, one of them sealed), the API on an embedded
// database behind a stand-in Clerk, and the built-in sign-in for the sign-in entries.
//   npm run test:audit-trail
//
// 1. gen-packs: profile.json `audit` is checked (booleans, days) and compiled into both profile modules; without it the
//    generated profiles are unchanged.
// 2. The toggles, each with a fresh app: both off (nothing written, no route, no MCP or admin tool), the data trail
//    alone, the platform trail alone, both on.
// 3. The data trail: a list is one entry however many rows it reads (never one per row), a detail one (a sealed
//    area's a reveal), an export one, writes one each (a refused batch none), with actor, action, area, key, channel;
//    entries numbered 1, 2, 3, ... per workspace; no field value or title anywhere in either trail.
// 4. Tenant isolation: a workspace's owners read their own entries only (route, MCP tool, and the tenant role itself);
//    members are refused; tenant work cannot write, change or remove an entry.
// 5. The platform trail: API and MCP requests with key id and prefix, actor, scopes, status and latency; staff actions
//    (the admin API on an account, an admin MCP tool) in the operator's view and in that workspace's slice (staff as a
//    pseudonym there); a sign-in (built-in).
// 6. Retention: entries past the profile's days are pruned; the tables refuse UPDATE and DELETE otherwise.
// 7. Performance: writes are batched (a 250-operation batch is at most two INSERTs of the trail), not one per row.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const INNER = process.argv.includes("--inner") ? process.argv[process.argv.indexOf("--inner") + 1] : null;
let n = 0;
const ok = (what: string) => { n++; console.log(`✓ ${what}`); };
const SECRET = "SECRET-VALUE-7f3a";

if (INNER === "main") await inner();
else if (INNER === "signin") await signIn();
else await outer();
process.exit(0);

async function outer() {
  const TMP = mkdtempSync(path.join(tmpdir(), "audit-trail-"));
  try {
    const copyOf = (name: string, profile: Record<string, unknown> | null, pack = true) => {
      const copy = path.join(TMP, name);
      const skip = new Set(["node_modules", ".pglite", ".git", ".next"]);
      cpSync(ROOT, copy, { recursive: true, filter: (src) => !skip.has(path.basename(src)) && src !== path.join(ROOT, "packs") });
      for (const nm of ["node_modules", "web/node_modules", "orchestrator/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(realpathSync(path.join(ROOT, nm)), path.join(copy, nm), "dir");
      mkdirSync(path.join(copy, "packs"), { recursive: true });
      cpSync(path.join(ROOT, "packs", "pack.schema.json"), path.join(copy, "packs", "pack.schema.json"));
      if (pack) cpSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_vulns"), path.join(copy, "packs", "fixture_vulns"), { recursive: true });
      if (profile) {
        const f = path.join(copy, "profile.json");
        writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), ...profile }, null, 2));
      }
      return { copy, gen: spawnSync(process.execPath, ["scripts/gen-packs.mjs"], { cwd: copy, encoding: "utf8" }) };
    };
    // ---------- 1. gen-packs ----------
    const generated = (copy: string) => [readFileSync(path.join(copy, "src", "profile.generated.ts"), "utf8"), readFileSync(path.join(copy, "web", "src", "config", "profile.generated.ts"), "utf8")];
    const plain = copyOf("plain", null, false);
    assert.equal(plain.gen.status, 0, plain.gen.stderr);
    assert.deepEqual(generated(plain.copy), generated(ROOT), "no audit in the profile: the generated profiles are as before");
    const on = copyOf("on", { audit: { data: true, platform: false, retention_days: 30 } }, false);
    assert.equal(on.gen.status, 0, on.gen.stderr);
    for (const g of generated(on.copy)) assert.match(g, /"audit": \{\s*"data": true,\s*"platform": false,\s*"retention_days": 30\s*\}/);
    for (const [bad, why] of [[{ data: "yes" }, /audit: data: true or false/], [{ retention_days: 0 }, /retention_days: a whole number of days/], [{ chain: true }, /chain: not a setting/], [true, /audit: an object/]] as const) {
      const b = copyOf(`bad-${n}-${String(why).length}`, { audit: bad }, false);
      assert.notEqual(b.gen.status, 0, `refused: ${JSON.stringify(bad)}`);
      assert.match(b.gen.stderr, why);
    }
    ok("gen-packs: profile.json audit checked (booleans, 1 to 3650 days, known keys) and compiled into both profile modules; absent, the generated profiles are unchanged");

    // ---------- 2 to 7: inside a build copy with a fixture pack ----------
    const one = copyOf("one", null);
    assert.equal(one.gen.status, 0, one.gen.stderr);
    for (const phase of ["main", "signin"]) {
      const r = spawnSync(TSX, ["scripts/audit-trail-test.ts", "--inner", phase], { cwd: one.copy, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, ...(phase === "signin" ? { AUTH_PROVIDER: "builtin" } : {}) } });
      assert.equal(r.status, 0, `the ${phase} checks inside the build copy`);
    }
  } finally { rmSync(TMP, { recursive: true, force: true }); }
  console.log(`AUDIT TRAIL TEST PASS (${n} checks here, the rest above)`);
}

async function inner() {
  const { cleanup, startHttp, STAMP } = await import("./lib/test-world.js");
  try {
    const http = await startHttp();
    const { getDb } = await import("../src/db.js");
    const db = await getDb();
    const audit = await import("../src/audit-trail.js");
    const { createApp } = await import("../src/http.js");
    const { createApiKey } = await import("../src/auth.js");
    const { runResults } = await import("../src/runs.js");
    const { runAdminTool } = await import("../src/admin-mcp.js");
    const { withTenant } = await import("../src/tenant-scope.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const adminH = { authorization: `Bearer ${await http.adminToken("owner")}` };

    // Two workspaces, each with an owner and a member signed in (the stand-in Clerk), and an account key.
    const mkOrg = async (tag: string) => {
      const r = await http.req("POST", "/api/admin/onboarding/orgs", adminH, { name: `Audit ${tag} ${STAMP}`, email: `owner-${tag}-${STAMP}@${tag}.example` });
      assert.equal(r.status, 201);
      const slug = (await r.json()).org.slug as string;
      const [o] = await db.query<{ id: number; name: string }>("SELECT id, name FROM organizations WHERE slug = $1", [slug]);
      const org = { orgId: o!.id, name: o!.name, slug };
      return { org, slug, owner: { authorization: `Bearer ${await http.signIn(org as any, "owner")}`, "x-pack-request": "1" },
        member: { authorization: `Bearer ${await http.signIn(org as any, "member")}`, "x-pack-request": "1" }, key: await createApiKey(org.orgId) };
    };
    const A = await mkOrg("a"), B = await mkOrg("b");
    const count = async (t: string) => Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n);
    const dataRows = async (orgId: number) => db.query<any>("SELECT * FROM audit_data_events WHERE org_id = $1 ORDER BY seq", [orgId]);

    // A fresh app per setting (the routes are mounted when the app is made, as at a deploy).
    const appWith = async (s: { data: boolean; platform: boolean }) => {
      audit.setAuditForTest(s);
      const server = createApp().listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
      const req = async (method: string, p: string, h: Record<string, string> = {}, body?: unknown) => {
        const r = await fetch(`${base}${p}`, { method, headers: { ...h, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
        const t = await r.text();
        let json: any = t; try { json = JSON.parse(t); } catch { /* text */ }
        return { status: r.status, body: json, text: t };
      };
      const mcp = async (key: string) => {
        const c = new Client({ name: "audit-test", version: "1" });
        await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
        return c;
      };
      return { req, mcp, close: () => new Promise((r) => server.close(r)) };
    };
    // One round of work in workspace o: creates, a list, a detail of each area, an export, an MCP list and the run results.
    const envField = JSON.parse(readFileSync(path.join("packs", "fixture_vulns", "pack.json"), "utf8")).record_areas.find((a: any) => a.name === "audit_apps").fields.find((f: any) => f.name === "environment");
    const ENV0 = typeof envField.options[0] === "string" ? envField.options[0] : envField.options[0].value;
    let round = 0;
    const work = async (app: Awaited<ReturnType<typeof appWith>>, o: typeof A) => {
      round++;
      const f = `f-${round}`, appKey = `app-${round}`;
      assert.equal((await app.req("POST", "/api/data/audit_apps", o.owner, { key: appKey, title: `App ${SECRET}`, data: { url: `https://${SECRET}.example`, environment: ENV0 } })).status, 201);
      assert.equal((await app.req("POST", "/api/data/audit_findings", o.owner, { key: f, title: `Finding ${SECRET}`, data: { severity: "high", app: appKey } })).status, 201);
      assert.equal((await app.req("GET", "/api/records/audit_findings", o.owner)).status, 200);
      assert.equal((await app.req("GET", `/api/records/audit_findings/${f}`, o.owner)).status, 200);
      assert.equal((await app.req("GET", `/api/records/audit_apps/${appKey}`, o.owner)).status, 200);
      assert.equal((await app.req("GET", "/api/records/audit_findings?audit=export&limit=200", o.owner)).status, 200);
      const c = await app.mcp(o.key);
      const tools = (await c.listTools()).tools.map((t) => t.name);
      const listed = await c.callTool({ name: "fixture_vulns_list_audit_findings", arguments: {} });
      assert.ok(!listed.isError, JSON.stringify(listed).slice(0, 300));
      await c.close();
      await runResults(o.org.orgId, "run-none");
      await audit.flushAudit();
      return tools;
    };

    // ---------- both off ----------
    {
      const app = await appWith({ data: false, platform: false });
      const tools = await work(app, A);
      assert.ok(!tools.includes("read_audit_trail"), "off: no MCP tool");
      assert.ok(!Object.keys((await import("../src/admin-mcp.js")).adminTools()).some((t) => t.includes("trail")), "off: no admin MCP tool");
      for (const p of ["/api/audit", "/api/audit/data", "/api/audit/platform"]) assert.equal((await app.req("GET", p, A.owner)).status, 404, `off: ${p} is not there`);
      assert.equal((await app.req("GET", "/api/admin/audit/platform", adminH)).status, 404, "off: the admin route is not there");
      assert.deepEqual([await count("audit_data_events"), await count("audit_platform_events"), await count("audit_sequences")], [0, 0, 0], "off: nothing written");
      const { dataMap } = await import("../src/data-map.js");
      assert.ok(!JSON.stringify(dataMap()).includes("trail"), "off: DATA-MAP.md says nothing of a trail");
      await app.close();
      ok("both off: nothing written (no entry, no sequence), no /api/audit or admin route, no MCP or admin MCP tool, nothing in the data map");
    }

    // ---------- the data trail alone ----------
    {
      const app = await appWith({ data: true, platform: false });
      const before = (await dataRows(A.org.orgId)).length;
      const tools = await work(app, A);
      assert.ok(tools.includes("read_audit_trail"), "on: the owner's key sees the MCP tool");
      const rows = (await dataRows(A.org.orgId)).slice(before);
      const shape = rows.map((r) => `${r.channel}:${r.actor_kind}:${r.action}:${r.target}:${r.area ?? "-"}:${r.record_key ?? "-"}:${r.rows ?? "-"}`);
      const f = `f-${round}`, appKey = `app-${round}`;
      for (const want of [`console:user:create:record:audit_apps:${appKey}:-`, `console:user:create:record:audit_findings:${f}:-`,
        `console:user:list:record:audit_findings:-:${round}`, `console:user:read:record:audit_findings:${f}:-`, `console:user:reveal:record:audit_apps:${appKey}:-`,
        `console:user:export:record:audit_findings:-:${round}`, `mcp:key:list:record:audit_findings:-:${round}`, `system:system:read:run_result:-:run-none:0`])
        assert.ok(shape.includes(want), `entry ${want} in ${JSON.stringify(shape)}`);
      assert.equal(shape.filter((s) => s.includes(":list:")).length, 2, "a list read is one entry, never one per row (console and MCP)");
      assert.equal(rows.length, 8, `exactly the eight entries: ${JSON.stringify(shape)}`);
      assert.equal(await count("audit_platform_events"), 0, "the platform trail stays off");
      const all = (await dataRows(A.org.orgId)).map((r) => Number(r.seq));
      assert.deepEqual(all, all.map((_, i) => i + 1), "numbered 1, 2, 3, ... per workspace, no gap");
      assert.ok(rows.filter((r) => r.actor_kind !== "system").every((r) => r.actor_id), "every person's and key's entry names them");
      // Members are refused; the owner reads their own trail, as JSON and CSV.
      assert.equal((await app.req("GET", "/api/audit/data", A.member)).status, 403, "a member does not read the access log");
      const page = await app.req("GET", "/api/audit/data?limit=3", A.owner);
      assert.equal(page.status, 200);
      assert.equal(page.body.entries.length, 3); assert.ok(page.body.next);
      const next = await app.req("GET", `/api/audit/data?limit=3&before=${page.body.next}`, A.owner);
      assert.ok(next.body.entries[0].seq < page.body.entries[2].seq + 0 || next.body.entries[0].seq === page.body.entries[2].seq - 1, "pages continue from before");
      const csv = await app.req("GET", "/api/audit/data.csv", A.owner);
      assert.equal(csv.status, 200);
      // Action and Actor (mold_v0-209): what was done, and who in words, after the time; then the raw fields.
      assert.match(csv.text, /^(\ufeff)?seq,at,action,actor,actor_kind,actor_id,key_id,target,pack,area,record_key,rows,channel\r\n/);
      const listed = (await app.req("GET", "/api/audit/data?limit=500", A.owner)).body.entries as any[];
      assert.ok(listed.length && listed.every((e: any) => typeof e.actor === "string" && (e.actor_kind === "system" ? e.actor === "System" : e.actor.startsWith({ user: "User", key: "Key", staff: "Staff", agent_run: "Agent run" }[e.actor_kind as string]!))),
        "each entry's Actor: its kind and display in words");
      assert.equal(csv.text.trim().split("\r\n").length, all.length + 1, "the CSV holds every entry");
      assert.equal((await app.req("GET", "/api/audit/platform", A.owner)).status, 404, "the platform trail's route is not there");
      // The Access log's four cards (mold_v0-205): this week's counts and twelve weeks, owners only, counts never contents.
      assert.equal((await app.req("GET", "/api/audit/data/sparklines", A.member)).status, 403, "a member does not read the cards");
      const cards = await app.req("GET", "/api/audit/data/sparklines", A.owner);
      assert.equal(cards.status, 200);
      assert.equal(cards.body.weeks, 12); assert.equal(cards.body.buckets.length, 12);
      assert.deepEqual(cards.body.cards.map((c: any) => c.id), ["entries", "changes", "exports", "actors"]);
      const card = (id: string) => cards.body.cards.find((c: any) => c.id === id);
      assert.equal(card("entries").value, all.length, "entries this week: every entry written above");
      assert.equal(card("exports").value, (await dataRows(A.org.orgId)).filter((r: any) => r.action === "export" || r.action === "reveal").length, "exports and reveals");
      assert.ok(cards.body.cards.every((c: any) => c.series.length === 12 && c.series.at(-1) === c.value), "each card's last week is its value");
      assert.equal((await app.req("GET", "/api/audit/platform/sparklines", A.owner)).status, 404, "the platform trail's cards are not there");
      await app.close();
      ok("data trail alone: create, list (one entry for the page), read, a sealed record's read as a reveal, export, MCP list and run results, each with actor, area, key, rows and door; numbered 1..n; owners read it as JSON pages and CSV, members are refused; platform trail untouched");
    }

    // ---------- tenant isolation and no values ----------
    {
      const app = await appWith({ data: true, platform: true });
      await work(app, B);
      const a = await app.req("GET", "/api/audit/data?limit=500", A.owner), b = await app.req("GET", "/api/audit/data?limit=500", B.owner);
      assert.ok(a.body.entries.length && b.body.entries.length);
      const aKeys = new Set((await dataRows(A.org.orgId)).map((r) => `${r.seq}`)), bRows = await dataRows(B.org.orgId);
      assert.equal(b.body.entries.length, bRows.length, "B's owner reads exactly B's entries");
      assert.equal(a.body.entries.length, aKeys.size, "and A's exactly A's");
      // The tenant role itself: as A, none of B's rows in either trail, whatever the query asks.
      const seen = await withTenant(A.org.orgId, async () => (await getDb()).query<{ d: number; p: number }>(
        "/* tenant: rls proof, on purpose */ SELECT (SELECT count(*) FROM audit_data_events WHERE org_id <> $1)::int AS d, (SELECT count(*) FROM audit_platform_events WHERE org_id IS DISTINCT FROM $1)::int AS p", [A.org.orgId]));
      assert.deepEqual(seen[0], { d: 0, p: 0 }, "row-level security: A's tenant work sees none of B's entries, nor the platform's own");
      await assert.rejects(withTenant(A.org.orgId, async () => (await getDb()).query("INSERT INTO audit_data_events (org_id, seq, actor_kind, action, target, channel) VALUES ($1, 99999, 'system', 'read', 'record', 'system')", [A.org.orgId])),
        (e: any) => e.code === "42501", "tenant work cannot write an entry");
      // MCP: the tool reads the caller's own workspace only.
      const c = await app.mcp(B.key);
      const r = await c.callTool({ name: "read_audit_trail", arguments: { limit: 500 } }) as any;
      assert.ok(!r.isError);
      assert.equal(r.structuredContent.entries.length, bRows.length + 0 || r.structuredContent.entries.length, "the tool answers");
      assert.ok(r.structuredContent.entries.every((e: any) => bRows.some((x) => Number(x.seq) === e.seq)), "the MCP tool reads B's own entries only");
      // The Access log's cards (mold_v0-205): each workspace's own counts only.
      const ca = await app.req("GET", "/api/audit/data/sparklines", A.owner), cb = await app.req("GET", "/api/audit/data/sparklines", B.owner);
      assert.equal(ca.body.cards[0].value, (await dataRows(A.org.orgId)).length, "A's cards count A's entries only");
      assert.equal(cb.body.cards[0].value, bRows.length, "B's cards count B's entries only");
      await c.close();
      await audit.flushAudit();
      // No value: neither the titles nor the fields written above appear anywhere in either trail.
      const dump = JSON.stringify([await db.query("SELECT * FROM audit_data_events"), await db.query("SELECT * FROM audit_platform_events")]);
      assert.ok(!dump.includes(SECRET), "no field value or title is in either trail");
      await app.close();
      ok("tenant isolation: each owner's route and MCP tool read their own workspace's entries only; the tenant role sees none of another's and cannot write one; no field value or title in either trail");
    }

    // ---------- both trails as one Access log (mold_v0-270) ----------
    {
      const app = await appWith({ data: true, platform: true });
      await work(app, A);
      await audit.flushAudit();
      // The owner's merged cards and CSV: both trails, newest first, a Kind column.
      const cards = await app.req("GET", "/api/audit/all/sparklines", A.owner);
      assert.equal(cards.status, 200);
      assert.deepEqual(cards.body.cards.map((c: any) => c.label), ["Platform calls this week", "Data access this week", "Changes this week", "Refused or failed"]);
      assert.equal(cards.body.cards[1].value, (await dataRows(A.org.orgId)).length, "data access: A's entries");
      assert.equal((await app.req("GET", "/api/audit/all/sparklines", A.member)).status, 403, "owners only");
      await audit.flushAudit();
      const platformBefore = (await db.query("SELECT 1 FROM audit_platform_events WHERE org_id = $1", [A.org.orgId])).length;
      const csv = await app.req("GET", "/api/audit/all.csv", A.owner);
      assert.equal(csv.status, 200);
      const lines = csv.text.replace(/^\ufeff/, "").trim().split("\r\n");
      assert.match(lines[0]!, /^kind,at,action,actor,/, "Kind first, then the time, Action and Actor");
      const kinds = new Set(lines.slice(1).map((l) => l.split(",")[0]));
      assert.deepEqual([...kinds].sort(), ["Data access", "Platform call"], "both trails in one file");
      const ats = lines.slice(1).map((l) => l.split(",")[1]!);
      assert.deepEqual(ats, [...ats].sort().reverse(), "newest first");
      assert.equal(lines.length - 1, (await dataRows(A.org.orgId)).length + platformBefore, "every entry of both, up to the file's own request");
      // Staff: every workspace's data trail, named, and the fleet's merged cards and CSV.
      const fleet = await app.req("GET", "/api/admin/audit/data?limit=500", adminH);
      assert.equal(fleet.status, 200);
      assert.ok(fleet.body.entries.length >= (await dataRows(A.org.orgId)).length && fleet.body.entries.every((e: any) => "workspace" in e), "every workspace's data entries, each naming its workspace");
      assert.ok(fleet.body.entries.some((e: any) => e.workspace === A.slug));
      assert.equal((await app.req("GET", "/api/admin/audit/all/sparklines", adminH)).status, 200);
      const fcsv = await app.req("GET", "/api/admin/audit/all.csv", adminH);
      assert.match(fcsv.text.replace(/^\ufeff/, ""), /^kind,at,workspace,action,actor,/, "staff's file names the workspace");
      assert.ok(!fcsv.text.includes(SECRET), "no value in the file");
      await app.close();
      ok("both trails as one Access log: the owner's and staff's cards (platform calls, data access, changes, refused), one CSV newest first with a Kind column; staff read every workspace's data entries");
    }

    // ---------- the platform trail alone, staff ----------
    {
      const app = await appWith({ data: false, platform: true });
      const dBefore = await count("audit_data_events"), pBefore = await count("audit_platform_events");
      await work(app, A);
      assert.equal(await count("audit_data_events"), dBefore, "the data trail stays off");
      // Staff: the admin API on A's account, and an admin MCP tool naming it.
      assert.equal((await app.req("GET", `/api/admin/onboarding/orgs/${A.slug}`, adminH)).status, 200);
      await runAdminTool({ actor: "ops@platform.example", role: "owner", userId: null, ip: "203.0.113.9" }, "get_account", { slug: A.slug });
      await audit.flushAudit();
      const rows = (await db.query<any>("SELECT * FROM audit_platform_events ORDER BY at, scope_id, seq")).slice(pBefore);
      const mcpCall = rows.find((r) => r.channel === "mcp" && r.path.includes("tools/call:fixture_vulns_list_audit_findings"));
      assert.ok(mcpCall, "an MCP tool call, by its tool's name");
      assert.equal(mcpCall.org_id, A.org.orgId); assert.equal(mcpCall.actor_kind, "key"); assert.ok(mcpCall.key_id, "with the key's id");
      assert.equal(mcpCall.status, 200); assert.ok(mcpCall.latency_ms >= 0);
      assert.ok(String(mcpCall.scopes).includes("workspace_key"), "the scopes it acted with");
      const api = rows.find((r) => r.channel === "console" && r.path === "/api/data/audit_findings" && r.method === "POST");
      assert.ok(api && api.actor_kind === "user" && api.status === 201 && String(api.scopes).includes("role:owner"), "a console request: the person, their role, the result");
      const staff = rows.filter((r) => r.kind === "staff");
      assert.ok(staff.some((r) => r.channel === "admin_console" && r.org_id === A.org.orgId && r.actor_id.startsWith("token:")), "the admin API on an account: a staff entry in that workspace");
      assert.ok(staff.some((r) => r.channel === "admin_mcp" && r.path === "/admin/mcp/get_account" && r.org_id === A.org.orgId && r.actor_id === "ops@platform.example"), "an admin MCP tool: a staff entry naming the account");
      // The operator reads it fleet-wide (with the key's prefix); the workspace's owners their slice, staff as a pseudonym.
      const fleet = await app.req("GET", "/api/admin/audit/platform?limit=500", adminH);
      assert.equal(fleet.status, 200);
      assert.ok(fleet.body.entries.some((e: any) => e.workspace === B.slug) && fleet.body.entries.some((e: any) => e.workspace === A.slug), "fleet-wide");
      assert.ok(fleet.body.entries.some((e: any) => e.key_prefix?.startsWith("oct_")), "the key's prefix, never the key");
      const slice = await app.req("GET", "/api/audit/platform?limit=500", A.owner);
      assert.equal(slice.status, 200);
      assert.ok(slice.body.entries.length && slice.body.entries.every((e: any) => e.org_id === A.org.orgId), "a workspace's owners read their own slice only");
      const staffSeen = slice.body.entries.filter((e: any) => e.actor_kind === "staff");
      assert.ok(staffSeen.length >= 2 && staffSeen.every((e: any) => e.actor_id.startsWith("staff:") && !("ip" in e)), "staff appear in the slice as a pseudonym, without addresses");
      // Action and Actor (mold_v0-209): the platform trail's Kind became the two columns.
      assert.ok(staffSeen.every((e: any) => e.actor === `Staff · ${e.actor_id}`), "staff's Actor: Staff and the pseudonym");
      const toolCall = slice.body.entries.find((e: any) => e.path.includes("tools/call:fixture_vulns_list_audit_findings"));
      assert.ok(toolCall && toolCall.action === "tool call" && /^Key · oct_.*…$/.test(toolCall.actor), `an MCP tool call: Action "tool call", Actor the key's prefix (${toolCall?.action}, ${toolCall?.actor})`);
      const posted = slice.body.entries.find((e: any) => e.path === "/api/data/audit_findings" && e.method === "POST");
      assert.ok(posted && posted.action === "change" && posted.actor.startsWith("User · "), "a console write: Action change, Actor the person");
      const pcsv = await app.req("GET", "/api/audit/platform.csv", A.owner);
      assert.equal(pcsv.status, 200);
      assert.match(pcsv.text, /^(\ufeff)?seq,at,workspace,action,actor,channel,method,path,key_prefix,actor_kind,actor_id,scopes,status,latency_ms\r\n/, "the CSV: Action and Actor columns");
      assert.equal((await app.req("GET", "/api/audit/data", A.owner)).status, 404, "the data trail's route is not there");
      // The cards (mold_v0-205): the owner's slice counts its own requests; staff read the fleet's.
      const sc = await app.req("GET", "/api/audit/platform/sparklines", A.owner);
      assert.equal(sc.status, 200);
      assert.ok(sc.body.cards.find((c: any) => c.id === "requests").value >= slice.body.entries.filter((e: any) => e.kind === "request").length, "the slice's requests this week (and the reads since)");
      const fc = await app.req("GET", "/api/admin/audit/platform/sparklines", adminH);
      assert.equal(fc.status, 200);
      assert.ok(fc.body.cards.find((c: any) => c.id === "requests").value >= sc.body.cards.find((c: any) => c.id === "requests").value, "the fleet's cards cover every workspace");
      assert.equal((await app.req("GET", "/api/audit/platform/sparklines", A.member)).status, 403, "members do not read them");
      const admin = (await import("../src/admin-mcp.js")).adminTools();
      assert.ok("read_platform_trail" in admin && !("read_audit_trail" in admin), "the admin MCP lists the platform trail's tool only");
      const viaTool = await runAdminTool({ actor: "ops@platform.example", role: "viewer", userId: null }, "read_platform_trail", { org: A.slug, kind: "staff" }) as any;
      assert.ok(!viaTool.isError && viaTool.structuredContent.entries.length >= 2, "read_platform_trail reads staff actions on an account");
      await app.close();
      ok("platform trail alone: API and MCP requests (tool by name, key id and prefix, actor, scopes, status, latency); staff actions through the admin API and the admin MCP, in the operator's fleet-wide view and the workspace's slice (as a pseudonym); data trail untouched");
    }

    // ---------- both on: performance, append-only, retention ----------
    {
      const app = await appWith({ data: true, platform: true });
      // A 250-operation batch: one entry per operation, in at most two INSERTs of the trail (batched, not one per row);
      // a refused batch writes none.
      let inserts = 0;
      const tx0 = db.transaction.bind(db);
      (db as any).transaction = (fn: any) => tx0((tx: any) => fn({ ...tx, query: (sql: string, p?: unknown[]) => { if (sql.includes("INSERT INTO audit_data_events")) inserts++; return tx.query(sql, p); } }));
      const before = await count("audit_data_events");
      const ops = Array.from({ length: 250 }, (_, i) => ({ op: "create", area: "audit_findings", key: `bulk-${i}`, title: SECRET, data: { severity: "low", app: "app-1" } }));
      const done = await app.req("POST", "/api/data/_batch", A.owner, { operations: ops });
      assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
      const refused = [...ops.slice(0, 2).map((o) => ({ ...o, key: `${o.key}-x` })), { op: "create", area: "audit_findings", key: "bulk-0", data: {} }];
      assert.notEqual((await app.req("POST", "/api/data/_batch", A.owner, { operations: refused })).status, 200, "a batch with a duplicate is refused whole");
      await audit.flushAudit();
      (db as any).transaction = tx0;
      assert.equal(await count("audit_data_events") - before, 250, "one entry per operation of the committed batch; none of the refused one");
      assert.ok(inserts >= 1 && inserts <= 2, `batched writes: ${inserts} INSERT(s) for 250 entries`);
      const t0 = performance.now();
      assert.equal((await app.req("GET", "/api/records/audit_findings?limit=200", A.owner)).status, 200);
      await audit.flushAudit();
      ok(`performance: a 250-operation batch is ${inserts} INSERT(s) of the trail, a 200-row list one entry (${Math.round(performance.now() - t0)} ms with its write)`);

      // Append-only: no update, no delete (but the prune's).
      await assert.rejects(db.query("UPDATE audit_data_events SET action = 'list' WHERE org_id = $1", [A.org.orgId]), /append-only/);
      await assert.rejects(db.query("DELETE FROM audit_data_events WHERE org_id = $1", [A.org.orgId]), /append-only/);
      await assert.rejects(db.query("DELETE FROM audit_platform_events WHERE org_id IS NULL"), /append-only/);
      // Retention: entries past the days are pruned; the rest stay.
      await db.query("INSERT INTO audit_sequences (scope_id, trail, last_seq) VALUES ($1, 'data', 1000000) ON CONFLICT (scope_id, trail) DO UPDATE SET last_seq = 1000000", [B.org.orgId]);
      await db.query("INSERT INTO audit_data_events (org_id, seq, at, actor_kind, action, target, channel) VALUES ($1, 999990, now() - interval '401 days', 'system', 'read', 'record', 'system'), ($1, 999991, now() - interval '399 days', 'system', 'read', 'record', 'system')", [B.org.orgId]);
      await db.query("INSERT INTO audit_platform_events (scope_id, seq, org_id, at, kind, channel, method, path, actor_kind) VALUES (0, 999990, NULL, now() - interval '401 days', 'request', 'api', 'GET', '/old', 'system')");
      const kept = await count("audit_data_events");
      const pruned = await audit.pruneAudit();
      assert.deepEqual(pruned, { data: 1, platform: 1 }, "the default 400 days: one entry of each trail past it");
      assert.equal(await count("audit_data_events"), kept - 1);
      audit.setAuditForTest({ data: true, platform: true, retention_days: 30 });
      assert.equal((await audit.pruneAudit()).data, 1, "retention_days 30: the 399-day entry goes too");
      assert.ok((await dataRows(A.org.orgId)).length > 250, "recent entries stay");
      await app.close();
      ok("append-only: UPDATE and DELETE refused on both trails; retention prunes past the profile's days (default 400, then 30), recent entries kept");
    }
    audit.setAuditForTest(null);
    await http.close();
  } finally { cleanup(); }
}

/** The built-in sign-in: a sign-in is a platform trail entry naming the person and the workspace. */
async function signIn() {
  process.env.APP_PROXY_HOPS = "1";
  const { cleanup, startHttp, STAMP } = await import("./lib/test-world.js");
  try {
    const audit = await import("../src/audit-trail.js");
    audit.setAuditForTest({ data: false, platform: true });
    const http = await startHttp();
    const { getDb } = await import("../src/db.js");
    const db = await getDb();
    process.env.RESEND_API_URL = http.mock.url;
    await (await import("../src/keyvault.js")).setCredential("resend", `re_test_${STAMP}_secret`);
    const adminH = { authorization: `Bearer ${await http.adminToken("owner")}` };
    const email = `owner-s-${STAMP}@s.example`;
    const made = await http.req("POST", "/api/admin/onboarding/orgs", adminH, { name: `Sign ${STAMP}`, email });
    assert.equal(made.status, 201);
    const slug = (await made.json()).org.slug;
    const emails = () => (http.mock.state.emails as any[]).filter((e) => e.to.includes(email) && e.tags?.some((t: any) => t.name === "kind" && t.value === "sign_in_code"));
    assert.equal((await http.req("POST", "/api/auth/email/request", { "x-forwarded-for": "198.51.100.7" }, { email })).status, 200);
    let code: string | null = null;
    for (let i = 0; i < 200 && !code; i++) { const m = emails().at(-1); code = m ? /sign-in code is (\d{8})/.exec(m.text)?.[1] ?? null : null; if (!code) await new Promise((r) => setTimeout(r, 20)); }
    assert.ok(code, "a code was emailed");
    const wrong = await http.req("POST", "/api/auth/email/verify", { "x-forwarded-for": "198.51.100.7" }, { email, code: code === "00000000" ? "11111111" : "00000000" });
    assert.equal(wrong.status, 401);
    const good = await http.req("POST", "/api/auth/email/verify", { "x-forwarded-for": "198.51.100.7" }, { email, code });
    assert.equal(good.status, 200);
    await audit.flushAudit();
    const rows = await db.query<any>("SELECT e.*, o.slug FROM audit_platform_events e LEFT JOIN organizations o ON o.id = e.org_id WHERE kind = 'sign_in' ORDER BY at");
    assert.ok(rows.some((r) => r.status === 401 && r.actor_kind === "system" && r.ip === "198.51.100.7"), "a refused code: a sign-in entry with its result and address");
    const ok200 = rows.find((r) => r.status === 200);
    assert.ok(ok200 && ok200.actor_kind === "user" && ok200.actor_id && String(ok200.scopes).includes("email_code"), "a sign-in: the person and how they signed in");
    assert.ok(ok200.slug === slug || ok200.org_id === null, "in the workspace it opened (when it opened one)");
    assert.ok(!JSON.stringify(rows).includes(code!), "never the code");
    audit.setAuditForTest(null);
    await http.close();
    ok("sign-in (built-in): a refused code and a sign-in are platform trail entries with result, address, the person and the method; never the code");
  } finally { cleanup(); }
}
