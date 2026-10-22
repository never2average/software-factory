// Sealed areas, keys with ( and ), and batch writes (mold_v0-066; src/record-areas.ts, molds/mold_v0/MOLD.md).
//   npm run test:record-batch        offline: an embedded database in a temporary directory
//
// 1. Declarations: `sealed` on any workspace area (not a shared one; an asset area is always sealed; no `due` on one).
// 2. Keys may hold ( and ): through put, get, list paging (plain and sorted cursors), a key filter, references and
//    links, delete, a batch, a credential bound to such an asset, a schedule's asset keys; the cursor's encoding
//    round-trips every key; other characters are still refused.
// 3. Sealed at rest: a sealed non-asset area's title and data are ciphertext in the table (a canary is nowhere in a
//    dump of it), open for the workspace's own reads (list views, filters and sorts on the opened rows), nothing for
//    another workspace's; a write while the vault is locked is refused and writes nothing.
// 4. Batches are one transaction: a refusal at any operation (a field, a permission, an existing key, a reference to a
//    record deleted earlier in the batch, a database error) leaves nothing of the batch; operations see the batch's
//    earlier writes; a shared-area batch the same; limits.
import assert from "node:assert/strict";
import { cleanup, connect, STAMP } from "./lib/test-world.js";
import { catalogPack } from "./lib/catalog-fixture.js";

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const rec = await import("../src/record-areas.js");
  const { definePack, ScheduleSchema, RECORD_KEY } = await import("../src/pack-api.js");
  const { cursorOf } = await import("../src/record-query.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const fx = await catalogPack();
  setPacksForTest([fx]);
  const A = (await createOrg(`Batch A ${STAMP}`)).org, B = (await createOrg(`Batch B ${STAMP}`)).org;
  const as = (org: typeof A, role: "viewer" | "member" | "owner" | null = "member") => rec.workspaceRecords("fixture_catalog", org.orgId, { role, userId: role ? `user_${role}` : null });

  // ---------- 1. declarations ----------
  {
    const area = (extra: Record<string, unknown>) => ({ name: "sx", label: "S", role: "check" as const, scope: "workspace" as const, fields: [{ name: "dd", label: "D", type: "date" as const }], ...extra });
    assert.ok(definePack({ id: "pk", recordAreas: [area({ sealed: true })] }), "a sealed check area of a workspace");
    assert.throws(() => definePack({ id: "pk", recordAreas: [area({ sealed: true, scope: "platform" })] }), /no workspace key to seal it with/);
    assert.throws(() => definePack({ id: "pk", recordAreas: [area({ sealed: false, role: "asset" })] }), /an asset area is always sealed/);
    // mold_v0-076: a sealed area may carry due dates (the daily check opens its rows in code: scripts/record-gaps-test.ts).
    assert.ok(definePack({ id: "pk", recordAreas: [area({ sealed: true, due: { field: "dd" } })] }), "a sealed check area with due dates");
    console.log("✓ declarations: sealed for any workspace area (due dates too); refused on a shared one, unset on an asset");
  }

  // Shared rows to refer to (hand rows of an upstream-fed area: staff may add them).
  for (const k of ["alpha-rules-2024:7(2)(b)", "alpha-rules-2024:34(vii)", "alpha-rules-2024:PR.MA.S3"])
    await rec.putPlatform(null, "controls", k, { title: `Control ${k}`, data: { control_id: k.split(":")[1], mandatory: true } });

  // ---------- 2. keys with ( and ) ----------
  {
    for (const k of ["alpha-rules-2024:7(2)(b)", "34(vii)", "a_(b)", "x)(y", "7(3)"]) assert.equal(rec.checkKey(k), k, `${k} is a key`);
    for (const k of ["(a", ")a", "a b", "a/b", "~a", "a%28", "a\u0000", "a,b", "a'b", "a\"b", "", "x".repeat(201)])
      assert.throws(() => rec.checkKey(k), /a record key is 1-200 letters, digits, \. _ : \( \) or -/, `${JSON.stringify(k)} is refused`);
    const m = as(A);
    const keys = ["t(1)", "t(1)(a)", "t(10)", "t(2)", "t:x(y)"];
    for (const k of keys) await m.put("tasks", k, { title: `Task ${k}`, data: { summary: `S ${k}`, control: "alpha-rules-2024:7(2)(b)", score: keys.indexOf(k) } });
    assert.equal((await m.get("tasks", "t(1)(a)"))!.key, "t(1)(a)", "get by a key with ( and )");
    // Paging by key (the plain cursor is the key itself) and by a sort (the encoded cursor) both walk every key once.
    for (const sort of [undefined, "score", "-score", "title"]) {
      const seen: string[] = [];
      let after: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await m.list("tasks", { limit: 2, sort, after });
        seen.push(...page.records.map((r) => r.key));
        if (!page.next) break;
        if (sort) assert.ok(page.next.startsWith("~"), "a sorted page's cursor is encoded");
        after = page.next;
      }
      assert.deepEqual([...seen].sort(), [...keys].sort(), `every key once, paged ${sort ?? "by key"}`);
    }
    assert.deepEqual((await m.list("tasks", { filter: { key: { prefix: "t(1)" } } })).records.map((r) => r.key), ["t(1)", "t(1)(a)"], "a key prefix holding (");
    const d = await rec.detailFor(A.orgId, "tasks", "t(1)");
    assert.deepEqual(d!.links.find((l) => l.field === "control")!.records.map((r) => r.key), ["alpha-rules-2024:7(2)(b)"], "a reference to a key with ( and ) resolves");
    await m.put("tasks", "t(child)", { data: { summary: "child", parent: "t(1)(a)" } });
    await assert.rejects(m.put("tasks", "bad", { data: { summary: "x", parent: "(t1" } }), /field parent of area tasks must be the key of a tasks record/);
    // The cursor's encoding round-trips any key: the JSON inside base64url, never cursor syntax.
    const s = { target: "field" as const, name: "score", desc: false, text: "score" };
    for (const k of ["a(b)", "x)(y:z", "t(1)(a)", "7.(2)-_:"]) {
      const c = cursorOf(s, k);
      assert.match(c, /^~[A-Za-z0-9_-]+$/, "the cursor is URL-safe");
      assert.deepEqual(JSON.parse(Buffer.from(c.slice(1), "base64url").toString()), ["score", k], `${k} round-trips (the cursor carries no value of the row)`);
    }
    assert.ok(RECORD_KEY.test("alpha:7(2)(b)"));
    assert.ok(ScheduleSchema.safeParse({ name: "nightly", job_kind: "k1", cron: "0 2 * * *", assets: { area: "applications", keys: ["web(1)"] } }).success, "a schedule's asset keys may hold ( and )");
    assert.equal(await as(A, "owner").delete("tasks", "t:x(y)"), true, "delete by such a key");
    console.log("✓ keys with ( and ): put, get, plain and sorted paging, key prefix, references and links, delete; cursors round-trip; other characters refused");
  }

  // ---------- 3. sealed at rest ----------
  const CANARY = `canary-${STAMP}-sealed`;
  {
    const ownerA = as(A, "owner");
    await ownerA.put("notes", "n(1)", { title: `Title ${CANARY}`, data: { body: `Body ${CANARY}`, severity: "high", score: 70, control: "alpha-rules-2024:34(vii)" } });
    await ownerA.put("notes", "n2", { title: "Second", data: { body: "plain words", severity: "low", score: 10 } });
    await ownerA.put("notes", "n3", { title: "Third", data: { body: "more words", severity: "high", score: 40 } });
    await as(B, "owner").put("notes", "n(1)", { title: "B's own", data: { body: "B body", severity: "medium", score: 99 } });
    const raw = await db.query<{ title: string; data: any; sealed: boolean }>("SELECT title, data, sealed FROM workspace_records WHERE area = 'notes' AND org_id = $1", [A.orgId]);
    assert.ok(raw.length === 3 && raw.every((r) => r.sealed && /^enc:v1:/.test(r.title) && Object.keys(r.data).join() === "_sealed"), "every row's title and data are ciphertext");
    const dump = JSON.stringify(await db.query("SELECT w.* FROM workspace_records w"));
    assert.ok(!dump.includes(CANARY) && !dump.includes("plain words"), "the canary is nowhere in the table");
    const tasksRaw = await db.query<{ data: any }>("SELECT data FROM workspace_records WHERE area = 'tasks' AND org_id = $1 AND key = 't(1)'", [A.orgId]);
    assert.equal(tasksRaw[0]!.data.summary, "S t(1)", "an area that is not sealed is stored as is (the control)");
    // The workspace's own reads open it; filters and sorts run on the opened rows.
    const got = await ownerA.get("notes", "n(1)");
    assert.equal(got!.data.body, `Body ${CANARY}`);
    assert.deepEqual((await ownerA.list("notes", { filter: { severity: "high" }, sort: "-score" })).records.map((r) => r.key), ["n(1)", "n3"], "filter and sort on a sealed area");
    assert.deepEqual((await ownerA.list("notes", { filter: { body: { contains: "WORDS" } }, sort: "title" })).records.map((r) => r.key), ["n2", "n3"], "text search on a sealed area");
    const p1 = await ownerA.list("notes", { sort: "score", limit: 2 });
    assert.deepEqual([p1.records.map((r) => r.key), (await ownerA.list("notes", { sort: "score", limit: 2, after: p1.next! })).records.map((r) => r.key)], [["n2", "n3"], ["n(1)"]], "sorted paging on a sealed area");
    // Another workspace: its own rows only, whatever it filters by.
    assert.deepEqual((await as(B).list("notes", { filter: { body: { contains: "Body" } } })).records.map((r) => [r.key, r.data.body]), [["n(1)", "B body"]], "B's filter sees B's rows only");
    assert.equal((await as(B).list("notes", { filter: { score: { gte: 0 } }, sort: "-score" })).records.length, 1);
    // The list view (MCP list_records): the workspace's own, opened; nothing of it for B.
    const ca = await connect({ ...A, role: "owner", userId: "user_owner" }), cb = await connect({ ...B, role: "owner", userId: "user_owner_b" });
    const la = (await ca.call("list_records", { area: "notes" })).structuredContent;
    assert.deepEqual(la.records.map((r: any) => [r.key, r.severity]), [["n(1)", "high"], ["n2", "low"], ["n3", "high"]]);
    const lb = JSON.stringify((await cb.call("list_records", { area: "notes" })).structuredContent);
    assert.ok(!lb.includes(CANARY) && !lb.includes("plain words"), "B's list view holds nothing of A's");
    assert.ok((await cb.call("get_record", { area: "notes", key: "n2" })).isError, "B cannot get A's sealed record");
    await ca.close(); await cb.close();
    // The vault locked: a sealed write is refused and nothing is stored.
    const key = process.env.OCTILLION_VAULT_KEY;
    delete process.env.OCTILLION_VAULT_KEY;
    try {
      await assert.rejects(ownerA.put("notes", "n-locked", { data: { body: "should not be stored" } }), (e: any) => e.status === 503 && /sealed and the key vault is locked/.test(e.message));
      await assert.rejects(ownerA.batch([{ op: "put", area: "tasks", key: "lk1", data: { summary: "x" } }, { op: "put", area: "notes", key: "n-locked", data: { body: "x" } }]), (e: any) => e.status === 503);
    } finally { process.env.OCTILLION_VAULT_KEY = key; }
    assert.equal((await db.query("SELECT 1 FROM workspace_records WHERE key IN ('n-locked', 'lk1')")).length, 0, "nothing stored while locked");
    // A row written before its area was sealed still opens; the next write seals it.
    const plainDef = JSON.parse(JSON.stringify(fx.declared));
    plainDef.recordAreas.find((a: any) => a.name === "notes").sealed = false;
    setPacksForTest([{ ...fx, declared: plainDef }]);
    await ownerA.put("notes", "n-plain", { data: { body: "written unsealed" } });
    setPacksForTest([fx]);
    assert.equal((await ownerA.get("notes", "n-plain"))!.data.body, "written unsealed", "an unsealed row reads after the area is sealed");
    await ownerA.put("notes", "n-plain", { data: { body: "now sealed" } });
    assert.ok((await db.query<{ sealed: boolean }>("SELECT sealed FROM workspace_records WHERE key = 'n-plain'"))[0]!.sealed, "and the next write seals it");
    console.log("✓ sealed at rest: a non-asset area's titles and data are ciphertext (no canary in a dump), open for the workspace's own list views, filters and sorts, nothing for another workspace; refused while the vault is locked");
  }

  // ---------- 4. batches ----------
  {
    const m = as(A), owner = as(A, "owner");
    const count = async () => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_records WHERE org_id = $1", [A.orgId]))[0]!.n;
    const before = await count();
    // Operations see the batch's earlier writes: a reference to a record created earlier in it, a move of it.
    const ok = await m.batch([
      { op: "create", area: "tasks", key: "b(1)", title: "First", data: { summary: "first", severity: "high" } },
      { op: "create", area: "tasks", key: "b(2)", data: { summary: "second", parent: "b(1)" } },
      { op: "move", area: "tasks", key: "b(1)", to: "doing" },
      { op: "update", area: "tasks", key: "b(2)", data: { summary: "second, changed", parent: "b(1)" } },
      { op: "put", area: "notes", key: "bn", data: { body: "sealed in a batch" } },
    ]);
    assert.deepEqual(ok.map((r) => [r.op, r.key, r.record?.data.state ?? null]), [["create", "b(1)", "open"], ["create", "b(2)", "open"], ["move", "b(1)", "doing"], ["update", "b(2)", "open"], ["put", "bn", null]]);
    assert.equal(await count(), before + 3);
    const atomic = async (ops: any[], re: RegExp, status: number, what: string, who = m) => {
      const n0 = await count();
      const snapshot = JSON.stringify(await db.query("SELECT key, data, title, updated_at FROM workspace_records WHERE org_id = $1 ORDER BY key", [A.orgId]));
      await assert.rejects(who.batch(ops), (e: any) => e.status === status && re.test(e.message) && /Nothing of the batch was written/.test(e.message), what);
      assert.equal(await count(), n0, `${what}: no row added or removed`);
      assert.equal(JSON.stringify(await db.query("SELECT key, data, title, updated_at FROM workspace_records WHERE org_id = $1 ORDER BY key", [A.orgId])), snapshot, `${what}: no row changed`);
    };
    await atomic([{ op: "put", area: "tasks", key: "x1", data: { summary: "a" } }, { op: "update", area: "tasks", key: "b(2)", data: { summary: "changed again" } }, { op: "put", area: "tasks", key: "x3", data: { summary: "c", severity: "urgent" } }],
      /operation 3 \(put tasks x3\): field severity of area tasks must be one of/, 400, "a bad field at the last operation");
    await atomic([{ op: "put", area: "tasks", key: "x1", data: { summary: "a" } }, { op: "create", area: "tasks", key: "b(1)", data: { summary: "again" } }],
      /operation 2 \(create tasks b\(1\)\): Tasks record b\(1\) already exists/, 409, "creating a key that exists");
    await atomic([{ op: "update", area: "tasks", key: "nope", data: { summary: "a" } }], /no tasks record nope/, 404, "updating a key that does not exist");
    await atomic([{ op: "delete", area: "tasks", key: "b(1)" }, { op: "put", area: "tasks", key: "x2", data: { summary: "orphan", parent: "b(1)" } }],
      /operation 2 .*no tasks record b\(1\) in this workspace/, 400, "a reference to a record deleted earlier in the batch", owner);
    await atomic([{ op: "put", area: "tasks", key: "x1", data: { summary: "a" } }, { op: "move", area: "tasks", key: "b(2)", to: "done" }], /cannot move from "open" to "done"/, 409, "a move off the transitions");
    await atomic([{ op: "put", area: "tasks", key: "x1", data: { summary: "a" } }, { op: "delete", area: "tasks", key: "b(2)" }], /can't delete Tasks records with the Member role/, 403, "a permission refusal mid-batch");
    await atomic([{ op: "put", area: "tasks", key: "x1", data: { summary: "a" } }, { op: "put", area: "regulators", key: "r", data: {} }], /shared by every workspace: read only here/, 403, "a shared area in a workspace batch");
    await atomic([{ op: "put", area: "tasks", key: "x1", data: { summary: "a" } }, { op: "put", area: "applications", key: "app", data: {} }], /come from the workspace's files .*read only here/, 409, "a read-only area in a batch");
    await atomic([{ op: "put", area: "tasks", key: "x1", data: { summary: "a" } }, { op: "put", area: "tasks", key: "x\u0000", data: { summary: "b" } }], /a record key is/, 400, "a bad key");
    // A database error mid-batch (forced: a check that fails inside the transaction) rolls everything back too.
    await db.exec("ALTER TABLE workspace_records ADD CONSTRAINT batch_test_no_boom CHECK (key <> 'boom')");
    try {
      const n0 = await count();
      await assert.rejects(m.batch([{ op: "put", area: "tasks", key: "x1", data: { summary: "a" } }, { op: "put", area: "tasks", key: "boom", data: { summary: "b" } }]), (e: any) => e.code === "23514", "the database's refusal");
      assert.equal(await count(), n0, "a database error mid-batch leaves nothing");
    } finally { await db.exec("ALTER TABLE workspace_records DROP CONSTRAINT batch_test_no_boom"); }
    // B's batch never reaches A's rows: the same keys are B's own.
    await as(B).batch([{ op: "create", area: "tasks", key: "b(1)", data: { summary: "B's" } }]);
    assert.equal((await m.get("tasks", "b(1)"))!.data.summary, "first", "A's b(1) is untouched by B's batch");
    await assert.rejects(as(B).batch([{ op: "update", area: "tasks", key: "b(2)", data: { summary: "x" } }]), (e: any) => e.status === 404, "B cannot update A's record in a batch");
    await assert.rejects(m.batch([]), /1 or more operations/);
    await assert.rejects(m.batch(Array.from({ length: rec.MAX_BATCH + 1 }, (_, i) => ({ op: "put" as const, area: "tasks", key: `k${i}`, data: { summary: "x" } }))), (e: any) => e.status === 413);
    await assert.rejects(rec.inTransaction(A.orgId, () => m.batch([{ op: "put", area: "tasks", key: "n1", data: { summary: "x" } }])), /a batch inside a batch/);
    // A query that leaves the batch's workspace is refused, never run outside the transaction.
    await assert.rejects(rec.inTransaction(A.orgId, () => withTenant(B.orgId, () => rec.getFor(B.orgId, "tasks", "b(1)"))), /left its batch's scope/);
    // Shared areas: a staff batch is all-or-nothing too.
    const shared = async () => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM platform_records WHERE area = 'controls'"))[0]!.n;
    const s0 = await shared();
    await assert.rejects(rec.adminRecords.batch([{ op: "put", area: "controls", key: "c(9)", data: { mandatory: true } }, { op: "put", area: "controls", key: "c(10)", data: { mandatory: "yes" } }]), /operation 2 .*field mandatory .* must be a boolean/);
    assert.equal(await shared(), s0, "a refused staff batch leaves nothing");
    const sb = await rec.adminRecords.batch([{ op: "put", area: "controls", key: "c(9)", data: { mandatory: true } }, { op: "delete", area: "controls", key: "alpha-rules-2024:PR.MA.S3" }]);
    assert.deepEqual(sb.map((r) => r.deleted ?? r.record!.key), ["c(9)", true]);
    assert.equal(await shared(), s0);
    console.log("✓ batches: one transaction; operations see earlier writes; a field, an existing key, a missing key, a reference to a deleted record, a move, a permission, a shared or read-only area, a bad key, a database error each leave nothing; workspaces stay apart; staff batches too");
  }
  await db.close();
  console.log("RECORD BATCH TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
