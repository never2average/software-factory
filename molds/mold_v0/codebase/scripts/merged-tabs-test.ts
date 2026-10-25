// A merged tab's rows (mold_v0-135; src/record-merge.ts, src/record-routes.ts, molds/mold_v0/MOLD.md "Console tabs").
//   npm run test:merged-tabs     offline: an embedded database in a temporary directory, a fake Clerk
//
// The fixture (scripts/fixtures/packs/fixture_status, a pack.json alone) merges three areas in its tab "ours": the
// workspace's status of each requirement it tracks (req_status, its own area), its own requirements (req_own, rows: all,
// "Our own") and the shared library's (req_library, rows: matched, "Shared": only the entries the workspace tracks).
// 1. The rows: the status rows first, then the own requirements with no status; each with the fields of every area that
//    holds its key (the first area with a value gives each), its title, its latest time and its areas; the library's
//    other entries are not listed; lookups of more than 100 keys.
// 2. Paging: any page size gives the same rows, each once, in the same order; a cursor names its stage.
// 3. Two workspaces: each sees its own rows (and the shared entries it tracks), never the other's, whatever the cursor.
// 4. HTTP (/api/records/tabs/<pack>/<tab>): signed out 401; a role that may not read one of the areas 403; a tab that is
//    not a merged one, or not declared, 404; a bad cursor or limit 400.
// 5. A matched area before a later area's rows still adds its fields to them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIX = path.join(ROOT, "scripts", "fixtures", "packs", "fixture_status");
const json = JSON.parse(readFileSync(path.join(FIX, "pack.json"), "utf8"));

try {
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const rec = await import("../src/record-areas.js");
  const { mergedPage, mergeRow } = await import("../src/record-merge.js");
  const { createOrg } = await import("../src/auth.js");
  setPacksForTest([{ manifest: { id: "fixture_status", name: "fixture_status", version: "1", entry: null, migrations: null, words: {}, dir: FIX }, declared: compileDeclarations(json), definition: null }]);
  const A = (await createOrg(`Merged A ${STAMP}`)).org, B = (await createOrg(`Merged B ${STAMP}`)).org;
  const owner = (org: typeof A) => rec.workspaceRecords("fixture_status", org.orgId, { role: "owner", userId: "user_owner" });
  const n3 = (i: number) => String(i).padStart(3, "0");

  // The shared library: 120 entries, and one keyed like an own requirement (for 5).
  for (let i = 1; i <= 120; i++) await rec.putPlatform(null, "req_library", `lib:${n3(i)}`, { title: `Library ${n3(i)}`, data: { code: `L-${n3(i)}`, topic: i % 2 ? "access" : "data", weight: "high" } });
  await rec.putPlatform(null, "req_library", "own:a3", { title: "Library entry keyed own:a3", data: { code: "L-own", weight: "low" } });
  // A tracks 110 library entries and one of its own; it has three own requirements.
  for (let i = 1; i <= 110; i++) await owner(A).put("req_status", `lib:${n3(i)}`, { data: { state: i % 3 ? "done" : "planned", due: `2026-11-${String((i % 28) + 1).padStart(2, "0")}` } });
  await owner(A).put("req_status", "own:a1", { title: "Status of A-1", data: { state: "partial", note: "half way" } });
  for (const [k, code, topic] of [["own:a1", "A-1", "vendor"], ["own:a2", "A-2", "access"], ["own:a3", "A-3", "vendor"]] as const)
    await owner(A).put("req_own", k, { title: `Own ${code}`, data: { code, topic, origin: "contract" } });
  // B tracks one library entry and has one own requirement, with A's key names nowhere.
  await owner(B).put("req_status", "lib:002", { data: { state: "planned" } });
  await owner(B).put("req_own", "own:b1", { title: "Own B-1", data: { code: "B-1", topic: "access" } });

  const tab = json.tabs.find((t: { id: string }) => t.id === "ours");
  const all = async (org: typeof A, limit: number, t = tab) => {
    const rows: Awaited<ReturnType<typeof mergedPage>>["records"] = [];
    let after: string | null = null, pages = 0;
    do {
      const p = await mergedPage(org.orgId, t, { limit, ...(after ? { after } : {}) }, { role: "member", userId: "u_m" });
      rows.push(...p.records); after = p.next; pages++;
      assert.ok(pages < 500, "paging ends");
    } while (after);
    return { rows, pages };
  };

  // ---------- 1. the rows ----------
  {
    const { rows, pages } = await all(A, 200);
    assert.equal(pages, 1, "one page of 200 holds them");
    assert.equal(rows.length, 113, "111 tracked (110 shared, 1 own) and 2 own with no status: the library's other 10 entries are not listed");
    assert.deepEqual(rows.slice(-2).map((r) => r.key).sort(), ["own:a2", "own:a3"], "the own requirements with no status come after the status rows");
    assert.deepEqual(new Set(rows.slice(0, 111).map((r) => r.key)), new Set([...Array.from({ length: 110 }, (_, i) => `lib:${n3(i + 1)}`), "own:a1"]), "the status rows first");
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    assert.deepEqual([by["lib:001"]!.areas, by["lib:001"]!.title, by["lib:001"]!.data], [["req_status", "req_library"], "Library 001",
      { state: "done", due: "2026-11-02", code: "L-001", topic: "access", weight: "high" }], "a shared entry the workspace tracks: its status and the library's fields and title");
    assert.deepEqual([by["lib:110"]!.data.code, by["lib:110"]!.data.state], ["L-110", "done"], "fields looked up past the first 100 keys");
    assert.deepEqual([by["own:a1"]!.areas, by["own:a1"]!.title, by["own:a1"]!.data], [["req_status", "req_own"], "Status of A-1",
      { state: "partial", note: "half way", code: "A-1", topic: "vendor", origin: "contract" }], "its own requirement with a status: the first area with a title gives it");
    assert.deepEqual([by["own:a2"]!.areas, by["own:a2"]!.data.state], [["req_own"], undefined], "its own requirement with no status yet");
    assert.deepEqual(by["own:a3"]!.areas, ["req_own", "req_library"], "a matched area adds its fields to a later area's row too");
    assert.equal(by["own:a3"]!.data.code, "A-3", "the earlier area in the tab's order wins a field both hold");
    assert.ok(!("lib:111" in by), "a library entry the workspace does not track is not listed");
    assert.ok(rows.every((r) => !Object.keys(r.data).some((k) => k.startsWith("$"))), "no internal key of a row's data");
    // mergeRow on its own: empty values never hide a later area's value; the latest time.
    const row = (area: string, data: Record<string, unknown>, title: string | null, at: string) => ({ area, key: "k", title, data, version: null, updated_at: at });
    assert.deepEqual(mergeRow("k", [{ area: "a", record: row("a", { x: "", y: [] }, null, "2026-01-01T00:00:00.000Z") }, { area: "b", record: undefined }, { area: "c", record: row("c", { x: "c", y: ["c"] }, "C", "2026-02-01T00:00:00.000Z") }]),
      { key: "k", title: "C", data: { x: "c", y: ["c"] }, updated_at: "2026-02-01T00:00:00.000Z", areas: ["a", "c"] });
    assert.equal(mergeRow("k", [{ area: "a", record: undefined }]), null);
    console.log("✓ rows: the status rows first, then the own requirements with no status; each with every holding area's fields (the first with a value), title and areas; the library's untracked entries are not listed; lookups past 100 keys");
  }

  // ---------- 2. paging ----------
  {
    const whole = (await all(A, 200)).rows.map((r) => r.key);
    for (const limit of [1, 7, 50, 111, 112]) {
      const { rows } = await all(A, limit);
      assert.deepEqual(rows.map((r) => r.key), whole, `pages of ${limit}: the same rows, each once, in the same order`);
    }
    const first = await mergedPage(A.orgId, tab, { limit: 111 }, rec.SYSTEM_ACTOR);
    assert.match(first.next ?? "", /^~m/, "a merged cursor");
    assert.deepEqual(JSON.parse(Buffer.from(first.next!.slice(2), "base64url").toString("utf8")), [1, null], "it names the next stage (the own requirements), from the start");
    console.log("✓ paging: pages of 1, 7, 50, 111 and 112 give the same 113 rows, each once, in the same order; a cursor names its stage");
  }

  // ---------- 3. two workspaces ----------
  {
    for (const limit of [1, 50]) {
      const { rows } = await all(B, limit);
      assert.deepEqual(rows.map((r) => [r.key, r.areas]), [["lib:002", ["req_status", "req_library"]], ["own:b1", ["req_own"]]], "B sees its own rows and the shared entry it tracks");
    }
    // A's cursor in B's hands reads B's rows only.
    const aNext = (await mergedPage(A.orgId, tab, { limit: 1 }, rec.SYSTEM_ACTOR)).next!;
    const fromB = await mergedPage(B.orgId, tab, { limit: 50, after: aNext }, rec.SYSTEM_ACTOR);
    assert.ok(fromB.records.every((r) => ["lib:002", "own:b1"].includes(r.key)), "a cursor from A's list reaches only B's own rows in B");
    console.log("✓ two workspaces: each its own rows and the shared entries it tracks; a cursor from one reaches nothing of the other");
  }

  // ---------- 4. HTTP ----------
  const http = await startHttp();
  try {
    const ma = await http.signIn(A, "member"), va = await http.signIn(A, "viewer"), mb = await http.signIn(B, "member");
    const getJ = async (p: string, tok?: string) => { const r = await http.req("GET", p, tok ? { authorization: `Bearer ${tok}` } : {}); return { status: r.status, body: await r.json().catch(() => null) as any }; };
    const url = "/api/records/tabs/fixture_status/ours";
    assert.equal((await getJ(`${url}?limit=200`)).status, 401, "signed out: 401");
    const a = await getJ(`${url}?limit=200`, ma);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.records.length, 113);
    assert.equal(a.body.next, null);
    const b = await getJ(`${url}?limit=5`, mb);
    assert.deepEqual(b.body.records.map((r: any) => r.key), ["lib:002", "own:b1"], "B's member: B's rows");
    const v = await getJ(url, va);
    assert.equal(v.status, 403, "a viewer may not read the own requirements: refused");
    assert.match(v.body.error, /Own requirements/);
    assert.equal((await getJ("/api/records/tabs/fixture_status/library", ma)).status, 404, "a one-area tab has no merged page");
    assert.equal((await getJ("/api/records/tabs/fixture_status/nope", ma)).status, 404, "an undeclared tab: 404");
    assert.equal((await getJ("/api/records/tabs/other_pack/ours", ma)).status, 404, "another pack's tab id: 404");
    for (const q of ["after=lib:001", "after=~mnotjson", `after=~m${Buffer.from(JSON.stringify([9, null])).toString("base64url")}`, "limit=0", "limit=201", "limit=x"])
      assert.equal((await getJ(`${url}?${q}`, ma)).status, 400, `${q}: 400`);
    const paged = await getJ(`${url}?limit=60`, ma);
    const rest = await getJ(`${url}?limit=60&after=${encodeURIComponent(paged.body.next)}`, ma);
    assert.equal(paged.body.records.length + rest.body.records.length, 113, "two pages over HTTP");
    console.log("✓ HTTP: 401 signed out, 403 for a role that may not read one of the areas, 404 for a tab that is not merged or not declared, 400 for a bad cursor or limit; each workspace its own rows");
  } finally { await http.close(); }

  // ---------- 5. a matched area before a later area ----------
  {
    const t = { kind: "area" as const, areas: [{ area: "req_status" }, { area: "req_library", rows: "matched" as const }, { area: "req_own" }] };
    const { rows } = await all(A, 20, t);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    assert.deepEqual(by["own:a3"]!.areas, ["req_library", "req_own"], "a later area's row gets the earlier matched area's fields");
    assert.equal(by["own:a3"]!.data.code, "L-own", "in the tab's order");
    await assert.rejects(mergedPage(A.orgId, { kind: "area", area: "req_status" }, {}), /Not found/, "a one-area tab is not merged");
    console.log("✓ a matched area listed before a later area adds its fields to that area's rows, in the tab's order");
  }
  console.log("MERGED TABS TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
