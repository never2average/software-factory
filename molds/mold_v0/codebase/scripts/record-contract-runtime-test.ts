// The record contract at run time (mold_v0-234, mold_v0-235, mold_v0-236; src/record-areas.ts, src/record-import.ts,
// src/data-routes.ts, src/record-routes.ts, src/record-export.ts; the factory's docs/RECORDS.md), offline: an embedded
// database, the fake Clerk, two workspaces, people signed in as viewer, member and owner.
//   npm run test:record-contract-runtime
//
// 1. Import (234): an area whose contract grants import takes a CSV or JSON file's rows into the workspace's own
//    records, for its roles only (a viewer refused; an area with no contract takes none, today's behaviour): a preview
//    writes nothing and says what each row would do (create, update, unchanged, invalid with its problems, a lifecycle
//    state other than the record's own refused); the import writes the valid rows in one transaction as the person, in
//    the person's workspace only; the same file again writes nothing; a field the file leaves out keeps its value.
// 2. Export (235): its own permission. An area whose contract narrows export below read: a member reads the list but
//    its export pages (?audit=export), export_<area> and the tool's offer are refused or withheld; an owner exports. An
//    area with no contract exports as it reads (a viewer too); {none} exports to nobody, an account key included.
// 3. Reveal (235): the area's. A field with no reveal_roles takes the contract's reveal roles (not the update roles), a
//    field's own reveal_roles narrow them; {none} reveals nothing to anyone, an account key included.
// 4. Writers (236): each workspace row records where it came from and who last wrote it: people through the data API
//    (the person's sign-in id) and the import, run through the pack's own tool; a later write keeps where it came from
//    and names its own writer; a record's detail carries it; staff see each area's rows counted by provenance across
//    workspaces, with the ones its declared contract leaves out (here run), never a key or a value.
import assert from "node:assert/strict";
import { cleanup, connect, STAMP, startHttp } from "./lib/test-world.js";

let n = 0;
const ok = (what: string) => { n++; console.log(`✓ ${what}`); };

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack, defineTool, z } = await import("../src/pack-api.js");
  const rec = await import("../src/record-areas.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const A = (await createOrg(`Contract A ${STAMP}`)).org, B = (await createOrg(`Contract B ${STAMP}`)).org;

  type Role = "viewer" | "member" | "billing" | "owner";
  const ALL: Role[] = ["viewer", "member", "billing", "owner"], W: Role[] = ["member", "billing", "owner"];
  const none = (why: string) => ({ none: why });
  const fixture = definePack({
    id: "fixture_rt",
    recordAreas: [
      { name: "rt_items", label: "Items", role: "check", scope: "workspace",
        fields: [{ name: "name", label: "Name", required: true }, { name: "qty", label: "Quantity", type: "number" },
          { name: "state", label: "State", type: "enum", options: ["open", "done"] }],
        lifecycle: { field: "state", initial: "open", transitions: [{ from: "*", to: "done" }] },
        contract: { provenance: ["people"], primary_action: "create_record",
          actions: { read: ALL, export: ["owner"], create: W, update: W, move: W, delete: ["owner"], reveal: none("no encrypted field"), import: ["member", "owner"] } } },
      { name: "rt_plain", label: "Notes", role: "check", scope: "workspace", fields: [{ name: "body", label: "Body" }] },
      { name: "rt_secrets", label: "Secrets", role: "check", scope: "workspace",
        fields: [{ name: "label", label: "Label" }, { name: "pin", label: "PIN", encrypted: true }, { name: "code", label: "Code", encrypted: true, reveal_roles: ["owner"] }],
        contract: { provenance: ["people"], primary_action: "create_record",
          actions: { read: ALL, export: none("secrets never leave as a file"), create: W, update: W, move: none("no lifecycle"), delete: W, reveal: ["member", "owner"], import: none("encrypted") } } },
      { name: "rt_closed", label: "Sealed notes", role: "check", scope: "workspace",
        fields: [{ name: "label", label: "Label" }, { name: "secret", label: "Secret", encrypted: true }],
        contract: { provenance: ["people"], primary_action: "create_record",
          actions: { read: ALL, export: ALL, create: W, update: W, move: none("no lifecycle"), delete: W, reveal: none("never shown in this app"), import: none("encrypted") } } },
    ],
    tools: [defineTool({ name: "fixture_rt_put", description: "Save an item (test).", inputSchema: { key: z.string(), name: z.string() },
      handler: async (_ws, { key, name }, { records }) => records.put("rt_items", key, { title: name, data: { name } }) })],
  });
  setPacksForTest([{ manifest: { id: "fixture_rt", name: "Fixture", version: "1", entry: "index.ts", migrations: null, words: {} }, definition: fixture } as never]);

  const http = await startHttp();
  try {
    const viewer = await http.signIn(A, "viewer"), member = await http.signIn(A, "member"), owner = await http.signIn(A, "owner"), memberB = await http.signIn(B, "member");
    const call = async (method: string, p: string, tok?: string, body?: unknown) => {
      const r = await http.req(method, p, tok ? { authorization: `Bearer ${tok}` } : {}, body);
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const rows = async (org: number, area: string) => db.query<{ key: string; title: string | null; data: any; provenance: string | null; written_by: string | null; updated_by: string | null }>(
      "SELECT key, title, data, provenance, written_by, updated_by FROM workspace_records WHERE org_id = $1 AND area = $2 ORDER BY key", [org, area]);
    const meId = async (tok: string) => (await call("GET", "/api/app/me", tok)).body?.user_id ?? null;

    // ---------- 1. import (mold_v0-234) ----------
    {
      assert.deepEqual((await call("GET", "/api/data/rt_plain/_import", owner)).body.import, false, "an area with no contract offers no import");
      const plain = await call("POST", "/api/data/rt_plain/_import", owner, { rows: [{ key: "n1", data: { body: "x" } }] });
      assert.equal(plain.status, 403); assert.match(plain.body.error, /Notes takes no import: its contract grants none/);
      assert.equal((await call("GET", "/api/data/rt_secrets/_import", owner)).body.import, false, "{none}: no import");
      assert.equal((await call("GET", "/api/data/rt_items/_import", viewer)).body.import, false, "a viewer is not offered it");
      const offer = (await call("GET", "/api/data/rt_items/_import", member)).body;
      assert.equal(offer.import, true); assert.deepEqual(offer.fields.map((f: any) => f.name), ["name", "qty"], "the lifecycle's field is never mapped");
      const v = await call("POST", "/api/data/rt_items/_import", viewer, { rows: [{ key: "i1", data: { name: "x" } }] });
      assert.equal(v.status, 403); assert.match(v.body.error, /You can't import Items records with the Viewer role \(member, owner can\)/);
      const summary = (await call("GET", "/api/data", member)).body.areas.find((a: any) => a.name === "rt_items");
      assert.deepEqual([summary.import, summary.export], [["member", "owner"], ["owner"]], "the area's summary says who may import and export");
      ok("import: only where the contract grants it, for its roles (a viewer refused, no contract or {none}: no import); the lifecycle's field is never offered");

      const file = [
        { key: "i1", title: "First", data: { name: "Bolt", qty: "12" } },
        { key: "i2", data: { name: "Nut", qty: "many" } },
        { key: "i3", data: { name: "Washer", state: "done" } },
        { key: "i4", data: { qty: "3" } },
        { key: "i1", data: { name: "again" } },
        { key: "i5", data: { name: "Gear", state: "open" } },
      ];
      const preview = await call("POST", "/api/data/rt_items/_import", member, { rows: file });
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.deepEqual(preview.body.rows.map((r: any) => [r.key, r.action]), [["i1", "create"], ["i2", "invalid"], ["i3", "invalid"], ["i4", "invalid"], ["i1", "invalid"], ["i5", "create"]]);
      assert.match(preview.body.rows[1].errors.join(" "), /Quantity is not a number/);
      assert.match(preview.body.rows[2].errors.join(" "), /a new Items record starts as "open"/);
      assert.match(preview.body.rows[3].errors.join(" "), /field name of row 4 is required/);
      assert.match(preview.body.rows[4].errors.join(" "), /also on row 1/);
      assert.deepEqual([preview.body.dry_run, preview.body.written, (await rows(A.orgId, "rt_items")).length], [true, 0, 0], "a preview writes nothing");
      const done = await call("POST", "/api/data/rt_items/_import", member, { rows: file, dry_run: false });
      assert.deepEqual([done.body.written, done.body.counts], [2, { create: 2, update: 0, unchanged: 0, invalid: 4 }]);
      const after = await rows(A.orgId, "rt_items");
      assert.deepEqual(after.map((r) => [r.key, r.title, r.data.name, r.data.qty, r.data.state]), [["i1", "First", "Bolt", 12, "open"], ["i5", null, "Gear", undefined, "open"]], "the valid rows, typed, in their initial state");
      const mid = await meId(member);
      assert.ok(after.every((r) => r.provenance === "people" && r.written_by === (mid ? `people:${mid}` : r.written_by) && /^people:/.test(r.written_by ?? "")), `written as the member: ${JSON.stringify(after.map((r) => r.written_by))}`);
      assert.deepEqual(await rows(B.orgId, "rt_items"), [], "never another workspace's");
      assert.equal((await call("POST", "/api/data/rt_items/_import", member, { rows: file, dry_run: false })).body.written, 0, "the same file again writes nothing");
      // A field the file leaves out keeps its value; a state equal to the record's own passes; another is refused.
      await withTenant(A.orgId, () => rec.workspaceRecords("fixture_rt", A.orgId).move("rt_items", "i5", "done"));
      const upd = await call("POST", "/api/data/rt_items/_import", owner, { rows: [{ key: "i1", data: { qty: 15 } }, { key: "i5", data: { name: "Gear 2", state: "done" } }, { key: "i1x", data: { name: "B", state: "done" } }], dry_run: false });
      assert.deepEqual(upd.body.rows.map((r: any) => r.action), ["update", "update", "invalid"]);
      const i1 = (await rows(A.orgId, "rt_items")).find((r) => r.key === "i1")!;
      assert.deepEqual([i1.data.name, i1.data.qty, i1.title, i1.provenance], ["Bolt", 15, "First", "people"], "merged over the stored row; where it came from is kept");
      assert.equal((await rows(A.orgId, "rt_items")).find((r) => r.key === "i5")!.data.state, "done", "an existing record keeps its state");
      const memberB0 = await call("POST", "/api/data/rt_items/_import", memberB, { rows: [{ key: "i1", data: { name: "B's own" } }], dry_run: false });
      assert.deepEqual(memberB0.body.rows.map((r: any) => r.action), ["create"], "B's import of the same key is B's own record");
      assert.equal((await rows(A.orgId, "rt_items")).find((r) => r.key === "i1")!.data.name, "Bolt", "A's untouched");
      ok("import: a preview says what each row would do and writes nothing; the import writes the valid rows as the person in one transaction, in their workspace only; idempotent; merged over stored rows; a lifecycle's state never comes from a file");
    }

    // ---------- 2. export (mold_v0-235) ----------
    {
      const { exportArea } = await import("../src/record-export.js");
      const mt = await import("../src/mcp-tools.js");
      assert.equal((await call("GET", "/api/records/rt_items", member)).status, 200, "a member reads the list");
      const refused = await call("GET", "/api/records/rt_items?audit=export", member);
      assert.equal(refused.status, 403); assert.match(refused.body.error, /You can't export Items records with the Member role \(owner can\)/);
      const exported = await call("GET", "/api/records/rt_items?audit=export", owner);
      assert.equal(exported.status, 200); assert.equal(exported.body.records.length, 2);
      await assert.rejects(withTenant(A.orgId, () => exportArea({ orgId: A.orgId, role: "member", userId: null }, "rt_items")), /You can't export Items records/);
      const csv = await withTenant(A.orgId, () => exportArea({ orgId: A.orgId, role: "owner", userId: null }, "rt_items"));
      assert.equal(csv.records, 2);
      const tool = mt.generatedTools().find((t) => t.op === "export" && t.area === "rt_items")!;
      assert.deepEqual([mt.permitted(tool, "member"), mt.permitted(tool, "owner")], [false, true], "export_<area> is offered to the export roles only");
      // No contract: export as read (a viewer too). {none}: nobody, an account key included.
      assert.equal((await call("GET", "/api/records/rt_plain?audit=export", viewer)).status, 200, "no contract: a viewer exports what it reads");
      assert.equal((await call("GET", "/api/records/rt_secrets?audit=export", owner)).status, 403);
      await assert.rejects(withTenant(A.orgId, () => exportArea({ orgId: A.orgId, role: null, userId: null }, "rt_secrets")), /Secrets records are not exported \(secrets never leave as a file\)/);
      assert.equal((await call("GET", "/api/records/rt_secrets", owner)).status, 200, "and still reads it");
      ok("export: its own permission (a member reads but may not export what the contract keeps to owners: the pages, the tool and its offer); no contract exports as it reads; {none} exports to nobody");
    }

    // ---------- 3. reveal (mold_v0-235) ----------
    {
      const put = (area: string, key: string, data: Record<string, unknown>) => withTenant(A.orgId, () => rec.workspaceRecords("fixture_rt", A.orgId).put(area, key, { data }));
      await put("rt_secrets", "s1", { label: "Door", pin: "1234", code: "XYZ" });
      await put("rt_closed", "c1", { label: "Vault", secret: "hidden" });
      const reveal = (area: string, key: string, role: "member" | "billing" | "owner" | null, fields?: string[]) =>
        withTenant(A.orgId, () => rec.revealFor(A.orgId, area, key, fields, { role, userId: null }));
      assert.deepEqual((await reveal("rt_secrets", "s1", "member", ["pin"])).fields, { pin: "1234" }, "a member reveals a field with no reveal_roles: the area's roles");
      await assert.rejects(reveal("rt_secrets", "s1", "billing", ["pin"]), /You can't reveal pin of Secrets with the Billing manager role \(member, owner can\)/, "billing may update, but the area's reveal leaves it out");
      await assert.rejects(reveal("rt_secrets", "s1", "member", ["code"]), /You can't reveal code of Secrets with the Member role \(owner can\)/, "the field's own reveal_roles narrow the area's");
      assert.deepEqual((await reveal("rt_secrets", "s1", "owner")).fields, { pin: "1234", code: "XYZ" });
      for (const role of ["owner", null] as const) await assert.rejects(reveal("rt_closed", "c1", role), /Sealed notes's encrypted fields are never revealed \(never shown in this app\)/, `{none}: not even ${role ?? "an account key"}`);
      const area = rec.findArea("rt_closed")!;
      assert.deepEqual(rec.revealRoles(area, area.fields[1]!), [], "nobody's");
      const data = (await call("GET", "/api/data/rt_closed/c1", owner)).body.record.data;
      assert.equal(data.secret, "[encrypted]", "still masked on every read");
      ok("reveal: the area's (the contract's roles for a field without its own, a field's reveal_roles narrowing them); {none} reveals nothing to anyone");
    }

    // ---------- 4. writers (mold_v0-236) ----------
    {
      const created = await call("POST", "/api/data/rt_items", member, { key: "p1", data: { name: "By hand" } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const c = await connect({ ...A, role: "member", userId: `user_tool_${STAMP}` } as never);
      const t = await c.call("fixture_rt_put", { key: "r1", name: "By code" });
      assert.ok(!t.isError, JSON.stringify(t.content));
      await c.close();
      let all = await rows(A.orgId, "rt_items");
      const mark = (k: string) => { const r = all.find((x) => x.key === k)!; return [r.provenance, r.written_by, r.updated_by]; };
      const mid = await meId(member);
      assert.equal(mark("p1")[0], "people"); assert.match(String(mark("p1")[1]), /^people:/); assert.equal(mark("p1")[1], mark("p1")[2]);
      if (mid) assert.equal(mark("p1")[1], `people:${mid}`, "the person's sign-in id");
      assert.deepEqual(mark("r1"), ["run", "run:tool:fixture_rt_put", "run:tool:fixture_rt_put"], "the pack's own tool writes as the pack's code");
      // A person changes the code's row: it still came from the run; the last writer is the person. A move too.
      assert.equal((await call("PUT", "/api/data/rt_items/r1", owner, { data: { name: "Edited" } })).status, 200);
      assert.equal((await call("POST", "/api/data/rt_items/r1/move", member, { to: "done" })).status, 200);
      all = await rows(A.orgId, "rt_items");
      assert.equal(mark("r1")[0], "run"); assert.equal(mark("r1")[1], "run:tool:fixture_rt_put"); assert.match(String(mark("r1")[2]), /^people:/);
      const detail = (await call("GET", "/api/data/rt_items/r1", member)).body;
      assert.equal(detail.provenance.by, "run"); assert.equal(detail.provenance.written_by, "run:tool:fixture_rt_put");
      assert.equal((await call("GET", "/api/records/rt_items/r1", member)).body.provenance.by, "run", "the console's record page too");
      // A row written before 0042 has no mark, and its detail says none.
      await db.query("UPDATE workspace_records SET provenance = NULL, written_by = NULL, updated_by = NULL WHERE org_id = $1 AND key = 'i5'", [A.orgId]);
      assert.equal((await call("GET", "/api/data/rt_items/i5", member)).body.provenance, undefined);
      // Staff: counts per area and provenance across workspaces; the contract says people only, the rows say run too.
      const staff = await http.adminToken("viewer");
      const seen = (await call("GET", "/api/admin/records/_provenance", staff)).body.areas.find((a: any) => a.area === "rt_items");
      assert.deepEqual(seen, { pack: "fixture_rt", area: "rt_items", declared: ["people"], rows: { people: 3, run: 1, unknown: 1 }, undeclared: ["run"] }, JSON.stringify(seen));
      assert.ok([401, 403].includes((await call("GET", "/api/admin/records/_provenance", member)).status), "staff only");
      ok("writers: people through the data API (the person's id) and the import, run through the pack's own tool; a later write keeps the origin and names its writer; the detail carries it; staff count each area's rows by provenance across workspaces and see what the contract leaves out");
    }
  } finally { await http.close(); }
  console.log(`record-contract-runtime: ${n} checks passed`);
} finally {
  cleanup();
}
process.exit(0);
