// Staff rows on shared areas and their import (mold_v0-221; src/record-import.ts, src/record-routes.ts, src/record-areas.ts),
// offline: an embedded database, the data fixture's upstream catalog in a local git repository, admin tokens per role.
//   npm run test:record-import
//
// 1. A cell as its field stores it: numbers, yes or no, JSON, an option by its value or label, lists; a blank keeps the
//    stored value; a bad one is that row's problem.
// 2. The staff page's offer on a repository's area: create, edit and import with "library" (an operator, an owner),
//    remove with "delete" (an owner), the repository named; a viewer gets none. Every row of the list and the detail
//    says where it comes from.
// 3. The preview (dry run, the default): per row create, update, override, unchanged or invalid with its problems
//    (a bad key, a key given twice, an unknown field, a value of the wrong type, no key); nothing written.
// 4. The import: the valid rows only, as staff rows, in one transaction; a repository's row overridden (its version kept
//    behind); every row it wrote an IMPORT line of the staff access log; the same file again writes nothing
//    (idempotent by key); a field the file leaves out keeps its value; the repository's next index keeps every staff
//    row. A viewer is refused, more than 1000 rows refused, a body over the admin router's 64 KB accepted.
import assert from "node:assert/strict";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";
import { catalogPack, catalogRepo, fixtureJson } from "./lib/catalog-fixture.js";

process.env.APP_DATA_ALLOW_FILE_UPSTREAM = "1";
process.env.APP_CATALOG_AUTOINDEX = "off";

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const repos = await import("../src/data-repositories.js");
  const { coerceCell, IMPORT_MAX_ROWS } = await import("../src/record-import.js");
  void STAMP;

  // ---------- 1. cells ----------
  {
    const f = (type: string, extra: Record<string, unknown> = {}) => ({ name: "x", label: "X", type, ...extra }) as never;
    assert.deepEqual(coerceCell(f("number"), " 12.5 "), { value: 12.5 });
    assert.match(coerceCell(f("number"), "twelve").problem!, /X is not a number/);
    assert.deepEqual([coerceCell(f("boolean"), "Yes").value, coerceCell(f("boolean"), "0").value, coerceCell(f("boolean"), "true").value], [true, false, true]);
    assert.match(coerceCell(f("boolean"), "maybe").problem!, /X is not yes or no/);
    assert.deepEqual(coerceCell(f("json"), '{"a": [1]}'), { value: { a: [1] } });
    assert.match(coerceCell(f("json"), "{a").problem!, /not valid JSON/);
    const sev = f("enum", { options: [{ value: "high", label: "High" }, "low"] });
    assert.deepEqual([coerceCell(sev, "High").value, coerceCell(sev, "low").value, coerceCell(sev, "nope").value], ["high", "low", "nope"], "an option by its value or label (anything else left for the store's check)");
    assert.deepEqual(coerceCell(f("enum", { options: ["a", "b"], multiple: true }), "a; b").value, ["a", "b"]);
    assert.deepEqual([coerceCell(f("link"), "k1, k2").value, coerceCell(f("link"), "k1").value], [["k1", "k2"], "k1"]);
    assert.deepEqual([coerceCell(f("text"), "  "), coerceCell(f("text"), null), coerceCell(f("number"), 3)], [{}, {}, { value: 3 }], "a blank keeps the stored value; JSON values pass as they are");
    console.log("✓ cells: numbers, yes or no, JSON, options by value or label, lists; blanks keep the stored value; bad values are the row's problems");
  }

  // The fixture's catalog at c1, indexed: regulators and controls are the repository's.
  const up = catalogRepo(fixtureJson().repositories.catalogs);
  setPacksForTest([await catalogPack((j) => { j.upstream = { repo: up.url, commit: up.c1 }; })]);
  await repos.syncUpstreamCatalog("fixture_catalog", "catalogs");
  const repoKey = "alpha-rules-2024:7(2)(b)";
  const [repoRow] = await db.query<{ title: string; data: any }>("SELECT title, data FROM platform_records WHERE area = 'controls' AND key = $1", [repoKey]);
  assert.ok(repoRow, "the repository's row is there");

  const http = await startHttp();
  try {
    const viewer = await http.adminToken("viewer"), support = await http.adminToken("support"), operator = await http.adminToken("operator"), owner = await http.adminToken("owner");
    const call = async (method: string, p: string, tok: string, body?: unknown) => { const r = await http.req(method, p, { authorization: `Bearer ${tok}` }, body); return { status: r.status, body: await r.json().catch(() => null) }; };

    // ---------- 2. the offer, and where each row comes from ----------
    {
      const form = async (tok: string) => (await call("GET", "/api/admin/records/_console/controls/form", tok)).body;
      const pick = (f: any) => [f.create, f.edit, f.import, f.remove];
      assert.deepEqual(pick(await form(viewer)), [false, false, false, false], "a viewer: nothing");
      assert.deepEqual(pick(await form(support)), [false, false, false, false], "support: nothing (the library is an operator's)");
      const op = await form(operator);
      assert.deepEqual([...pick(op), op.repository], [true, true, true, false, { name: "catalogs", kind: "upstream_catalog" }], "an operator: New, Edit (Override) and Import on a repository's area; Remove is an owner's");
      assert.deepEqual(pick(await form(owner)), [true, true, true, true], "an owner: all four");
      const list = (await call("GET", "/api/admin/records/controls", viewer)).body.records;
      assert.ok(list.length && list.every((r: any) => r.provenance?.by === "repository" && r.provenance.repository === "catalogs"), "every listed row says it is the repository's");
      assert.deepEqual((await call("GET", `/api/admin/records/controls/${encodeURIComponent(repoKey)}`, viewer)).body.record.provenance, { by: "repository", repository: "catalogs", overrides: null });
      console.log("✓ the staff page on a repository's area: create, edit and import with library, remove with delete, the repository named; each row's provenance");
    }

    const url = "/api/admin/records/_console/controls/import";
    const count = async () => Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM platform_records WHERE area = 'controls'"))[0]!.n);
    const file = [
      { key: "staff:one", title: "Staff's first", data: { control_id: "S1", mandatory: "yes", prose: "Keep a register" } },
      { key: repoKey, title: "Staff's version", data: { mandatory: "no" } },
      { key: "staff:two", data: { control_id: "S2", mandatory: "maybe" } },
      { key: "bad key!", data: { control_id: "x" } },
      { key: "staff:one", data: { control_id: "again" } },
      { key: "staff:three", data: { nope: "x" } },
      { data: { control_id: "keyless" } },
      { key: "alpha-rules-2024:34(vii)", title: null, data: {} },
    ];

    // ---------- 3. the preview ----------
    {
      const before = await count();
      const p = await call("POST", url, operator, { rows: file });
      assert.equal(p.status, 200, JSON.stringify(p.body));
      assert.equal(p.body.dry_run, true, "a preview unless dry_run is false");
      assert.deepEqual(p.body.rows.map((r: any) => r.action), ["create", "override", "invalid", "invalid", "invalid", "invalid", "invalid", "unchanged"]);
      const errs = (n: number) => p.body.rows[n].errors.join(" | ");
      assert.match(errs(2), /Mandatory is not yes or no \(maybe\)/);
      assert.match(errs(3), /is not a record key/);
      assert.match(errs(4), /the key staff:one is also on row 1/);
      assert.match(errs(5), /has no field "nope"/);
      assert.match(errs(6), /no key/);
      assert.deepEqual(p.body.counts, { create: 1, update: 0, override: 1, unchanged: 1, invalid: 5 });
      assert.deepEqual([p.body.written, await count()], [0, before], "nothing written");
      assert.equal((await call("POST", url, viewer, { rows: file })).status, 403, "a viewer cannot import");
      assert.equal((await call("POST", url, operator, { rows: [] })).status, 400);
      const many = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => ({ key: `bulk:${i}`, data: { prose: "x".repeat(40) } }));
      assert.equal((await call("POST", url, operator, { rows: many })).status, 413, "more than 1000 rows refused");
      const big = await call("POST", url, operator, { rows: many.slice(0, IMPORT_MAX_ROWS) });
      assert.deepEqual([big.status, big.body.counts.create], [200, IMPORT_MAX_ROWS], "1000 rows (well over the admin router's 64 KB) previewed");
      console.log("✓ the preview: each row's outcome (create, override, unchanged) or its problems (type, key, duplicate, unknown field, no key); nothing written; library only; at most 1000 rows");
    }

    // ---------- 4. the import ----------
    {
      const before = await count();
      const log0 = Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM admin_access_log WHERE method = 'IMPORT'"))[0]!.n);
      const done = await call("POST", url, operator, { rows: file, dry_run: false });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.deepEqual([done.body.dry_run, done.body.written, await count()], [false, 2, before + 1], "the two valid rows that change something: one new, one override");
      const one = (await call("GET", "/api/admin/records/controls/staff:one", viewer)).body.record;
      assert.deepEqual([one.title, one.data.mandatory, one.data.prose, one.provenance], ["Staff's first", true, "Keep a register", { by: "staff", repository: null, overrides: null }], "a staff row, its cells typed");
      const over = (await call("GET", `/api/admin/records/controls/${encodeURIComponent(repoKey)}`, viewer)).body.record;
      assert.deepEqual([over.title, over.data.mandatory, over.data.control_id, over.provenance.by, over.provenance.overrides?.title], ["Staff's version", false, repoRow!.data.control_id, "staff", repoRow!.title],
        "the repository's row overridden: the file's fields over its own (control id kept), its version behind");
      // Every row it wrote is a line of the staff access log (the request's own line is the router's, after it answers).
      await new Promise((r) => setTimeout(r, 200));
      const lines = await db.query<{ method: string; path: string; actor: string }>("SELECT method, path, actor FROM admin_access_log WHERE method = 'IMPORT' ORDER BY id DESC LIMIT 2");
      assert.equal(Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM admin_access_log WHERE method = 'IMPORT'"))[0]!.n) - log0, 2, "one IMPORT line per row written");
      assert.deepEqual(lines.map((l) => l.path).sort(), [`/api/admin/records/controls/${repoKey} override`, "/api/admin/records/controls/staff:one create"]);
      assert.ok(lines.every((l) => l.actor.startsWith("token:")), "under the admin who imported");
      assert.ok((await db.query("SELECT 1 FROM admin_access_log WHERE method = 'POST' AND path = $1", [url])).length >= 1, "and the import's own request");
      // Idempotent by key: the same file again writes nothing.
      const again = await call("POST", url, operator, { rows: file, dry_run: false });
      assert.deepEqual([again.body.written, again.body.counts.unchanged, again.body.counts.invalid], [0, 3, 5], "the same file again: every valid row unchanged, nothing written");
      // The repository's next index keeps every staff row.
      await repos.syncUpstreamCatalog("fixture_catalog", "catalogs", { force: true });
      const kept = (await call("GET", "/api/admin/records/controls", viewer)).body.records;
      assert.deepEqual([kept.find((r: any) => r.key === "staff:one")?.provenance.by, kept.find((r: any) => r.key === repoKey)?.title], ["staff", "Staff's version"], "staff rows survive the repository's index, forced too");
      // Removing the override (an owner's) puts the repository's row back.
      assert.equal((await call("DELETE", `/api/admin/data/controls/${encodeURIComponent(repoKey)}`, operator)).status, 403, "removing needs delete");
      assert.equal((await call("DELETE", `/api/admin/data/controls/${encodeURIComponent(repoKey)}`, owner)).status, 204);
      const restored = (await call("GET", `/api/admin/records/controls/${encodeURIComponent(repoKey)}`, viewer)).body.record;
      assert.deepEqual([restored.title, restored.provenance], [repoRow!.title, { by: "repository", repository: "catalogs", overrides: null }], "the repository's row is back");
      assert.equal((await call("DELETE", `/api/admin/data/controls/${encodeURIComponent(repoKey)}`, owner)).status, 409, "and it is read only");
      console.log("✓ the import: valid rows only, as staff rows (a repository's row overridden); each written row an IMPORT line of the staff access log; the same file again writes nothing; the next index keeps them; removing an override restores the repository's row");
    }
  } finally {
    await http.close();
  }
  await db.close();
  console.log("RECORD IMPORT TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
