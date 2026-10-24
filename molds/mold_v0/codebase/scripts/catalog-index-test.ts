// Upstream catalogs index themselves (mold_v0-128, mold_v0-129; src/repository-index.ts), offline: an embedded database,
// a local git repository standing in for the upstream (never the network), the fixture catalog pack.
//   npm run test:catalog-index
//
// 1. First read: an empty catalog area, read, starts the index and answers with its rows; the state records the pin,
//    when, and the rows per area.
// 2. The same pin: nothing is fetched again (no attempt, no row touched), from any trigger.
// 3. One at a time: two passes at once index once (the other finds the lease held); a lease another instance holds is
//    left alone, and staff's Index now is refused (409) while it is held.
// 4. A failure (a pin the upstream lacks) is recorded (last error, the old rows kept and still read), a request never
//    breaks, the automatic retry waits, the deploy's retry tries again; then a good pin clears the error.
// 5. Startup: the first request of an instance indexes a new pin in the background, once.
// 6. index: "manual" opts out: no trigger indexes it; staff still can.
// 7. Staff over REST: the repositories list with pins, state and rows (read); Index now needs library (a viewer is
//    refused, an operator indexes, recorded as staff's), forcing needs delete; a customer's session is refused.
// 8. The deploy's script (npm run catalogs:index) prints the counts and its summary line.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";
import { catalogPack, catalogRepo, fixtureJson } from "./lib/catalog-fixture.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.APP_DATA_ALLOW_FILE_UPSTREAM = "1";
process.env.APP_CATALOG_AUTOINDEX = "on";

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const rec = await import("../src/record-areas.js");
  const idx = await import("../src/repository-index.js");
  const up = catalogRepo(fixtureJson().repositories.catalogs);
  const pin = async (commit: string, edit?: (j: any) => void) => { const p = await catalogPack((j) => { j.upstream = { repo: up.url, commit }; edit?.(j); }); setPacksForTest([p]); return p; };
  const state = async () => (await db.query<any>("SELECT pin, indexed_at::text, rows, attempted_at::text, attempted_by, attempted_pin, last_error, lease_until, lease_owner FROM repository_index WHERE pack = 'fixture_catalog' AND name = 'catalogs'"))[0];
  const shared = async (area: string) => db.query<{ key: string; updated_at: string; version: string }>("SELECT key, updated_at::text, version FROM platform_records WHERE pack = 'fixture_catalog' AND area = $1 ORDER BY key", [area]);
  const read = (area: string) => rec.listPlatform(rec.areaOrThrow(area), { limit: 200 });

  // ---------- 1. the first read of an empty area ----------
  {
    await pin(up.c1);
    assert.equal((await shared("controls")).length, 0, "nothing indexed yet");
    assert.equal(await state(), undefined, "no state before the first index");
    const page = await read("controls");
    assert.equal(page.records.length, 15, "the first read answers with the catalog's rows: it waited for the index");
    const s = await state();
    assert.deepEqual([s.pin, s.rows, s.attempted_by, s.last_error, s.lease_until], [up.c1, { regulators: 5, controls: 15 }, "first_read", null, null]);
    assert.ok(s.indexed_at, "when it was indexed");
    assert.ok((await shared("regulators")).every((r) => r.version === up.c1), "every row at the pin");
    console.log("✓ first read: an empty catalog area starts the index and answers with its 15 rows; the pin, the time and the rows per area are recorded");
  }

  // ---------- 2. the same pin: nothing fetched again ----------
  {
    const before = await state(), rows = JSON.stringify(await shared("controls"));
    for (const by of ["startup", "deploy", "first_read"] as const) {
      const r = await idx.ensureCatalogs(by, { retry: by === "deploy" });
      assert.deepEqual(r.map((x) => x.outcome), ["current"], `${by}: already at the pin`);
    }
    idx.resetCatalogIndexingForTest();
    assert.equal(await idx.onEmptyCatalogArea(rec.areaOrThrow("controls")), false, "an area indexed at its pin is not indexed again");
    const after = await state();
    assert.deepEqual([after.attempted_at, after.indexed_at], [before.attempted_at, before.indexed_at], "no attempt was made");
    assert.equal(JSON.stringify(await shared("controls")), rows, "no row touched");
    console.log("✓ the same pin: startup, the deploy and a read find it current; no fetch, no attempt, no row touched");
  }

  // ---------- 3. one at a time ----------
  {
    await pin(up.c2);
    const [a, b] = await Promise.all([idx.ensureCatalogs("startup"), idx.ensureCatalogs("startup")]);
    const outcomes = [a[0]!.outcome, b[0]!.outcome].sort();
    assert.deepEqual(outcomes, ["held", "indexed"], "two passes at once: one indexes, the other finds the lease held");
    assert.equal((await state()).pin, up.c2);
    assert.equal((await shared("controls")).length, 16);
    // Another instance holds the lease (its fetch is running): left alone, and staff are told to wait.
    await pin(up.c1);
    await db.query("UPDATE repository_index SET lease_until = now() + interval '5 minutes', lease_owner = 'another-instance' WHERE pack = 'fixture_catalog' AND name = 'catalogs'");
    assert.deepEqual((await idx.ensureCatalogs("deploy", { retry: true })).map((x) => x.outcome), ["held"]);
    await assert.rejects(idx.indexNow("fixture_catalog", "catalogs"), (e: any) => e.status === 409 && /being indexed right now/.test(e.message));
    assert.equal((await state()).lease_owner, "another-instance", "the other instance's lease is untouched");
    // A lease past its time (an instance that died mid-index) is taken over.
    await db.query("UPDATE repository_index SET lease_until = now() - interval '1 second' WHERE pack = 'fixture_catalog' AND name = 'catalogs'");
    assert.deepEqual((await idx.ensureCatalogs("startup")).map((x) => x.outcome), ["indexed"]);
    assert.deepEqual([(await state()).pin, (await state()).lease_owner], [up.c1, null]);
    console.log("✓ one at a time: two passes at once index once (lease under an advisory lock); another instance's lease is left alone (staff get 409); an expired lease is taken over");
  }

  // ---------- 4. a failure is recorded, never breaks a request ----------
  {
    const missing = "f".repeat(40);
    await pin(missing);
    const r = await idx.ensureCatalogs("startup");
    assert.equal(r[0]!.outcome, "failed");
    let s = await state();
    assert.equal(s.pin, up.c1, "the last good pin stays");
    assert.match(s.last_error, /could not be fetched at f{40}/);
    assert.deepEqual([s.attempted_pin, s.lease_until], [missing, null], "the attempt is recorded and the lease released");
    const page = await read("controls");
    assert.equal(page.records.length, 15, "the area still reads its rows");
    const status = await idx.repositoryStatus();
    const cat = status.repositories.find((x: any) => x.name === "catalogs") as any;
    assert.deepEqual([cat.state.current, !!cat.state.last_error, cat.upstream.commit, cat.index], [false, true, missing, "automatic"], "staff see the error and the pin it is not at");
    // The automatic retry waits; the deploy tries again at once.
    const t0 = s.attempted_at;
    assert.deepEqual((await idx.ensureCatalogs("startup")).map((x) => x.outcome), ["backoff"]);
    assert.equal((await state()).attempted_at, t0, "no new attempt while it waits");
    assert.deepEqual((await idx.ensureCatalogs("deploy", { retry: true })).map((x) => x.outcome), ["failed"]);
    assert.notEqual((await state()).attempted_at, t0, "the deploy tried again");
    // An empty area read during a failing pin: answers (empty), never an error.
    await db.query("DELETE FROM platform_records WHERE pack = 'fixture_catalog' AND area = 'regulators'");
    idx.resetCatalogIndexingForTest();
    assert.equal((await read("regulators")).records.length, 0, "an empty area with a failing catalog answers empty, without an error");
    // A good pin clears the error.
    await pin(up.c2);
    assert.deepEqual((await idx.ensureCatalogs("startup")).map((x) => x.outcome), ["indexed"]);
    s = await state();
    assert.deepEqual([s.pin, s.last_error, s.rows], [up.c2, null, { regulators: 5, controls: 16 }]);
    console.log("✓ a failure: recorded (last error, the pin attempted), the old rows kept and read, the lease released; the automatic retry waits, the deploy retries; a good pin clears it");
  }

  // ---------- 5. startup: the first request of an instance ----------
  const http = await startHttp();
  try {
    await pin(up.c1);
    idx.resetCatalogIndexingForTest();
    const h = await http.req("GET", "/healthz");
    assert.equal(h.status, 200, "the first request is answered at once");
    for (let i = 0; i < 300 && (await state()).pin !== up.c1; i++) await new Promise((r) => setTimeout(r, 100));
    const s = await state();
    assert.deepEqual([s.pin, s.attempted_by], [up.c1, "startup"], "indexed in the background from the instance's first request");
    const t = s.attempted_at;
    await pin(up.c2);
    await http.req("GET", "/healthz");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await state()).attempted_at, t, "once per instance: the next request starts nothing");
    console.log("✓ startup: the instance's first request is answered at once and the new pin indexed in the background, once per instance");

    // ---------- 6. index: "manual" ----------
    await pin(up.c2, (j) => { j.repositories.catalogs.index = "manual"; });
    idx.resetCatalogIndexingForTest();
    assert.deepEqual((await idx.ensureCatalogs("deploy", { retry: true })).map((x) => x.outcome), ["manual"]);
    await db.query("DELETE FROM platform_records WHERE pack = 'fixture_catalog'");
    assert.equal((await read("controls")).records.length, 0, "a read does not index a manual catalog");
    assert.equal((await state()).pin, up.c1, "nothing indexed it");
    const st = (await idx.repositoryStatus()).repositories.find((x: any) => x.name === "catalogs") as any;
    assert.equal(st.index, "manual");

    // ---------- 7. staff over REST ----------
    const viewer = await http.adminToken("viewer"), operator = await http.adminToken("operator"), owner = await http.adminToken("owner");
    const list = await http.req("GET", "/api/admin/data/_repositories", { authorization: `Bearer ${viewer}` });
    assert.equal(list.status, 200);
    const body = await list.json() as any;
    const cat = body.repositories.find((x: any) => x.name === "catalogs");
    assert.deepEqual([cat.upstream.commit, cat.index, cat.state.pin, cat.area_rows.map((a: any) => [a.name, a.rows])], [up.c2, "manual", up.c1, [["regulators", 0], ["controls", 0]]]);
    assert.equal(typeof body.automatic, "boolean");
    const sync = (tok: string, b: unknown) => http.req("POST", "/api/admin/data/_repositories/fixture_catalog/catalogs/sync", { authorization: `Bearer ${tok}` }, b);
    assert.equal((await sync(viewer, {})).status, 403, "Index now needs library");
    const s1 = await sync(operator, {});
    assert.equal(s1.status, 200, await s1.clone().text());
    assert.deepEqual((await s1.json() as any).index.areas.map((a: any) => [a.area, a.created]), [["regulators", 5], ["controls", 16]]);
    const s2 = await state();
    assert.deepEqual([s2.pin, s2.attempted_by, s2.rows], [up.c2, "staff", { regulators: 5, controls: 16 }], "staff's index is recorded like any other");
    assert.equal((await sync(operator, { force: true })).status, 403, "forcing needs delete");
    assert.equal((await sync(owner, { force: true })).status, 200);
    const org = (await (await import("../src/auth.js")).createOrg(`Catalogs ${STAMP}`)).org;
    const member = await http.signIn(org, "owner");
    assert.ok([401, 403].includes((await http.req("GET", "/api/admin/data/_repositories", { authorization: `Bearer ${member}` })).status), "a customer is no staff");
    assert.ok([401, 403].includes((await http.req("POST", "/api/admin/data/_repositories/fixture_catalog/catalogs/sync", { authorization: `Bearer ${member}` }, {})).status), "nor may a customer index");
    // The admin MCP's tool goes the same way (adminDataApi.sync -> indexNow): a held lease refuses it too.
    await db.query("UPDATE repository_index SET lease_until = now() + interval '5 minutes', lease_owner = 'x' WHERE pack = 'fixture_catalog' AND name = 'catalogs'");
    const { adminDataApi } = await import("../src/data-api.js");
    await assert.rejects(adminDataApi.sync("fixture_catalog", "catalogs"), (e: any) => e.status === 409);
    await db.query("UPDATE repository_index SET lease_until = NULL, lease_owner = NULL WHERE pack = 'fixture_catalog' AND name = 'catalogs'");
    console.log("✓ index: manual opts out of every automatic trigger; staff: the list (pins, state, rows), Index now needs library and is recorded, forcing needs delete, customers refused, the admin MCP's path is the same");
  } finally { await http.close(); }

  // ---------- 8. the deploy's script ----------
  {
    // The script runs in its own process over the generated registry: here, the fixture written by gen-packs into a
    // throwaway copy is more than this test needs; its no-catalog answer and its summary format are what the factory reads.
    const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(ROOT, "scripts", "catalogs-index.ts")],
      { cwd: ROOT, encoding: "utf8", env: { ...process.env, PGLITE_DIR: path.join(TMP, "deploy-db") } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^CATALOGS INDEX: /m, "the summary line the deploy reads");
    console.log(`✓ the deploy's script answers with its summary line (${r.stdout.trim().split("\n").pop()})`);
  }
  await db.close();
  console.log("CATALOG INDEX TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
