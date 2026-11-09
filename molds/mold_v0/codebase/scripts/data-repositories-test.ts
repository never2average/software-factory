// Data repositories (mold_v0-059; src/data-repositories.ts), offline: an embedded database, a workspace's files, a local
// HTTP API, a fake Clerk.
//   npm run test:data-repositories
//   SECOND_APP_DECLARATION=<a declaration.json> npm run test:data-repositories   also runs a real declaration's shape
//
// 1. Declarations: gen-packs builds the fixture (shaped like the second app's declaration); the kinds' rules are
//    refused at build (scope per kind, writes on read-only areas, the store, the API's egress and credential, maps,
//    loaders, never_read, a reference into a live area); an upstream_catalog repository is refused in plain words, by
//    the server and by gen-packs (mold_v0-283).
//    (mold_v0-283 deleted what were sections 2 and 3, the upstream catalog at a pin over git and over GitHub, and the
//    staff route that indexed one: the kind is gone. A workspace_files repository's loader, which the catalog
//    fixture's loader used to prove, is proved in section 4.)
// 4. A workspace's files: the ledger (last line wins, other kinds left out), application folders (globs, never_read),
//    sealed rows keyed with the workspace's own fingerprint key; idempotent; pruned when a folder goes (the committed
//    files are the truth); two workspaces never touch each other's rows; re-indexed by the run engine
//    after a commit (results naming the indexed rows are accepted only then).
// 5. An external API, live: the workspace's own credential, each workspace its own items, filters and sorts, keys with
//    ( and ) encoded, read only, a redirect refused, private addresses refused, egress enforced, the token never shown.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";
import { catalogPack, catalogPackDir, fixtureJson, workspaceFiles } from "./lib/catalog-fixture.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
const listen = (h: http.RequestListener) => new Promise<{ port: number; close: () => void }>((ok) => { const s = http.createServer(h).listen(0, "127.0.0.1", () => ok({ port: (s.address() as AddressInfo).port, close: () => s.close() })); });

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest, installPacks } = await import("../src/packs.js");
  const { definePack } = await import("../src/pack-api.js");
  const repos = await import("../src/data-repositories.js");
  const rec = await import("../src/record-areas.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const A = (await createOrg(`Repos A ${STAMP}`)).org, B = (await createOrg(`Repos B ${STAMP}`)).org;

  // ---------- 1. declarations ----------
  {
    const dir = path.join(TMP, "gen", "packs");
    catalogPackDir(dir);
    const g = spawnSync(process.execPath, [path.join(ROOT, "scripts", "gen-packs.mjs"), "--packs", dir, "--out", path.join(TMP, "gen", "out"), "--profile", path.join(TMP, "none.json")], { cwd: ROOT, encoding: "utf8" });
    assert.equal(g.status, 0, `gen-packs builds the fixture: ${g.stderr}`);
    assert.match(g.stdout, /1 pack\(s\) \(fixture_catalog\), 0 page\(s\), 7 record area\(s\), 1 credential\(s\)/);
    const base = fixtureJson();
    const { compileDeclarations } = await import("../src/pack-manifest.js");
    const tryJson = (edit: (j: any) => void) => { const j = JSON.parse(JSON.stringify(base)); edit(j); return () => installPacks([{ manifest: { id: j.id, name: j.name, version: "1", entry: null, migrations: null, words: {} }, declared: compileDeclarations(j) }]); };
    const refused: [string, (j: any) => void, RegExp][] = [
      ["an API host outside its egress", (j) => { j.repositories.vendor_api.base_url = "https://elsewhere.example/v1"; }, /base_url's host elsewhere\.example is not in its egress list/],
      ["an API credential that is not declared", (j) => { j.repositories.vendor_api.credential = "nope"; }, /names credential nope, which this pack does not declare/],
      ["workspace files feeding a shared area", (j) => { j.record_areas[0].repository = "company_ledger"; }, /a workspace_files repository feeds a workspace's own areas/],
      ["an upstream catalog (mold_v0-283)", (j) => { j.repositories.catalogs = { kind: "upstream_catalog", upstream: "pack.json#upstream", files: { all: "c.json" } }; j.record_areas[0].repository = "catalogs"; },
        /repositories\.catalogs: the upstream_catalog repository kind was removed \(mold_v0-283\).*New, Edit and Import/],
      ["a lifecycle on a read-only area", (j) => { const t = j.record_areas.find((a: any) => a.name === "tasks"); t.repository = "company_ledger"; }, /read only\): it cannot have a lifecycle/],
      ["writes declared on a read-only area", (j) => { j.record_areas[2].permissions = { update: ["owner"] }; }, /read only\): it cannot declare update/],
      ["another pack's store", (j) => { j.repositories.company_ledger.store = "other_pack"; }, /store other_pack is not this pack's own store/],
      ["a map naming an undeclared field", (j) => { j.repositories.company_ledger.map.control_status.fields.nope = "id"; }, /names field nope, which control_status does not declare/],
      ["a never_read rule that is not one", (j) => { j.repositories.company_applications.never_read = ["credentials.json"]; }, /never_read/],
      ["a path leaving the files", (j) => { j.repositories.company_ledger.path = "../x/{company}.jsonl"; }, /no \. or \.\. part/],
      ["a branch as the pin", (j) => { j.upstream.commit = "main"; }, /a full commit id/],
      ["a reference into a live area", (j) => { j.record_areas.find((a: any) => a.name === "tasks").fields.push({ name: "item", label: "Item", type: "reference", to: "vendor_items" }); }, /refers to vendor_items, which is read live from an API/],
      ["an unknown kind", (j) => { j.repositories.company_ledger.kind = "ftp_site"; }, /repositories\.company_ledger/],
    ];
    for (const [what, edit, re] of refused) assert.throws(() => tryJson(edit)(), re, what);
    // A code pack declaring one is refused by the server as plainly (src/pack-api.ts validatePack).
    assert.throws(() => definePack({ id: "pk", repositories: { cat: { kind: "upstream_catalog" } } } as never), /repositories\.cat: the upstream_catalog repository kind was removed/);
    // gen-packs refuses a pack.json that still declares one, with the same plain words (no build).
    {
      const gone = path.join(TMP, "gen-gone", "packs");
      const d = catalogPackDir(gone);
      const j = fixtureJson();
      j.repositories.catalogs = { kind: "upstream_catalog", upstream: "pack.json#upstream", files: { all: "c.json" } };
      j.record_areas[0].repository = "catalogs";
      writeFileSync(path.join(d, "pack.json"), JSON.stringify(j, null, 2));
      const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "gen-packs.mjs"), "--packs", gone, "--out", path.join(TMP, "gen-gone", "out"), "--profile", path.join(TMP, "none.json")], { cwd: ROOT, encoding: "utf8" });
      assert.equal(r.status, 1, `gen-packs refuses an upstream catalog: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /repositories\.catalogs: the upstream_catalog repository kind was removed \(mold_v0-283\).*platform records .*New, Edit and Import/);
    }
    assert.throws(() => installPacks([{ manifest: { id: "pk", name: "pk", version: "1", entry: "index.ts", migrations: null, words: {} }, definition: definePack({ id: "pk", loaders: { nowhere: () => ({}) } }) }]), /loader nowhere names no repository/);
    console.log(`✓ declarations: gen-packs builds the fixture (7 areas, 3 repositories); ${refused.length + 1} broken declarations refused, each with its reason; an upstream catalog refused in plain words by the server and gen-packs`);
  }

  const counts = (r: { areas: { area: string; created: number; updated: number; unchanged: number; deleted: number }[] }) => Object.fromEntries(r.areas.map((a) => [a.area, [a.created, a.updated, a.unchanged, a.deleted]]));

  // ---------- 4. a workspace's files ----------
  const fx = await catalogPack();
  setPacksForTest([fx]);
  const ws = async (org: typeof A, area: string) => (await withTenant(org.orgId, () => rec.workspaceRecords("fixture_catalog", org.orgId).list(area, { limit: 200 }))).records;
  {
    const ra = await repos.indexWorkspaceFiles(A.orgId, "fixture_catalog", workspaceFiles("acme", "A"));
    assert.deepEqual(ra.map((r) => counts(r)), [{ control_status: [2, 0, 0, 0] }, { applications: [1, 0, 0, 0] }]);
    const cs = await ws(A, "control_status");
    assert.deepEqual(cs.map((r) => [r.key, r.data.implementation_status, r.data.company]), [["alpha-rules-2024:34(vii)", "implemented", "acme"], ["alpha-rules-2024:7(2)(b)", "implemented", "acme"]], "the last line of an id wins; findings are left out (where kind = control); keys keep ( and )");
    const app = (await ws(A, "applications"))[0]! as { data: any };
    assert.deepEqual(app.data.environments.map((e: any) => e.envId), ["prod", "staging"], "env/*.json: the files directly in env/");
    assert.equal(app.data.environments[0].dbPassword, null, "an ENC[...] value is never kept");
    assert.deepEqual(app.data.credential_refs, { entries: [{ key: "DB_PASSWORD" }] }, "credentials.json entries[].ref is never kept");
    assert.deepEqual(app.data.repos.map((r: any) => r.repoId), ["main"], "repos/*.json, not a checkout under repos/main/");
    const dump = JSON.stringify(await db.query("SELECT * FROM workspace_records"));
    assert.ok(!dump.includes("vault://") && !dump.includes("ENC[") && !dump.includes("prod-A"), "nothing of the never-read values, and the sealed application, in the table");
    const marks = await db.query<{ area: string; fingerprint: string; org_id: number }>("SELECT area, fingerprint, org_id FROM workspace_records WHERE area IN ('applications', 'control_status')");
    assert.ok(marks.every((x) => x.fingerprint.startsWith(x.area === "applications" ? "k1:" : "h1:")), "a sealed area's fingerprint is keyed");
    // Idempotent; B's index never touches A's rows; the same files in B fingerprint differently (B's own key).
    const again = await repos.indexWorkspaceFiles(A.orgId, "fixture_catalog", workspaceFiles("acme", "A"));
    assert.ok(again.every((r) => !r.written), "the same snapshot writes nothing");
    const aBefore = JSON.stringify(await db.query("SELECT key, data, title, updated_at FROM workspace_records WHERE org_id = $1 ORDER BY id", [A.orgId]));
    await repos.indexWorkspaceFiles(B.orgId, "fixture_catalog", workspaceFiles("acme", "A"));
    assert.equal(JSON.stringify(await db.query("SELECT key, data, title, updated_at FROM workspace_records WHERE org_id = $1 ORDER BY id", [A.orgId])), aBefore, "B's index leaves A's rows exactly as they were");
    const fpA = marks.find((x) => x.area === "applications")!.fingerprint;
    const fpB = (await db.query<{ fingerprint: string }>("SELECT fingerprint FROM workspace_records WHERE org_id = $1 AND area = 'applications'", [B.orgId]))[0]!.fingerprint;
    assert.notEqual(fpA, fpB, "the same sealed content fingerprints differently in each workspace");
    await repos.indexWorkspaceFiles(B.orgId, "fixture_catalog", workspaceFiles("globex", "B", { "applications/b-only/README.md": "# B only\n" }));
    assert.deepEqual((await ws(A, "applications")).map((r) => r.key), ["web-portal"], "A never sees B's application");
    assert.deepEqual((await ws(B, "control_status")).map((r) => r.data.company), ["globex", "globex"], "B's ledger replaced B's own rows");
    // A folder that goes is pruned; an empty snapshot is refused rather than emptying the areas.
    const r2 = await repos.indexWorkspaceFiles(B.orgId, "fixture_catalog", workspaceFiles("globex", "B"));
    assert.equal(r2.find((r) => r.repository === "company_applications")!.areas[0]!.deleted, 1);
    // The committed files are the truth: an empty snapshot empties the areas they feed (the guards are an upstream's).
    const emptied = await repos.indexWorkspaceFiles(B.orgId, "fixture_catalog", []);
    assert.deepEqual(emptied.map((r) => r.areas[0]!.deleted), [2, 1]);
    assert.equal((await ws(A, "control_status")).length, 2, "A's rows stay");
    assert.deepEqual(await repos.indexWorkspaceFiles(A.orgId, "fixture_catalog").then((r) => r.map((x) => x.source)), ["no snapshot yet", "no snapshot yet"], "with no committed snapshot there is nothing to index");
    console.log("✓ workspace files: ledger and application folders become rows (last line wins, globs, never_read), sealed rows keyed per workspace, idempotent, pruned (the files are the truth), two workspaces apart");

    // A workspace_files repository's loader (code, when the declared map is not enough): it reads the files only through
    // RepositoryInput and returns rows by area, each checked as any write; a row that breaks the area's types refuses the
    // whole index, which then writes nothing.
    {
      const def = (bad: boolean) => definePack({
        id: "fixture_loader",
        recordAreas: [{ name: "ld_items", label: "Items", role: "asset", scope: "workspace", repository: "files", fields: [{ name: "count", label: "Count", type: "number" }, { name: "names", label: "Names", type: "json" }] }] as never,
        repositories: { files: { kind: "workspace_files", path: "lists/{list}.json" } },
        loaders: {
          files: async (input) => {
            assert.deepEqual([input.kind, input.version, input.areas.map((a) => a.name)], ["workspace_files", null, ["ld_items"]]);
            const rows = [];
            for (const p of await input.list("lists")) {
              const doc = JSON.parse((await input.read(p))!);
              rows.push({ key: path.posix.basename(p, ".json"), title: doc.title, data: { count: doc.names.length, names: doc.names } });
            }
            if (bad) rows.push({ key: "broken", title: "Broken", data: { count: "many" } } as never);
            return { ld_items: rows };
          },
        },
      });
      const install = (bad: boolean) => setPacksForTest([{ manifest: { id: "fixture_loader", name: "Loader", version: "1", entry: "index.ts", migrations: null, words: {} }, definition: def(bad) }]);
      const lists = [{ path: "lists/one.json", body: JSON.stringify({ title: "List one", names: ["a", "b"] }) }, { path: "lists/two(2).json", body: JSON.stringify({ title: "List two", names: ["c"] }) }];
      install(false);
      const r1 = await repos.indexWorkspaceFiles(A.orgId, "fixture_loader", lists);
      assert.deepEqual(r1.map(counts), [{ ld_items: [2, 0, 0, 0] }]);
      const rows = (await withTenant(A.orgId, () => rec.workspaceRecords("fixture_loader", A.orgId).list("ld_items"))).records;
      assert.deepEqual(rows.map((r) => [r.key, r.title, r.data.count]), [["one", "List one", 2], ["two(2)", "List two", 1]], "the loader's rows, keys with ( and )");
      assert.equal((await repos.indexWorkspaceFiles(A.orgId, "fixture_loader", lists))[0]!.written, false, "idempotent");
      install(true);
      await assert.rejects(repos.indexWorkspaceFiles(A.orgId, "fixture_loader", [...lists, { path: "lists/three.json", body: JSON.stringify({ title: "Three", names: [] }) }]), (e: any) => e.status === 422 && /count/.test(e.message));
      assert.deepEqual((await withTenant(A.orgId, () => rec.workspaceRecords("fixture_loader", A.orgId).list("ld_items"))).records.map((r) => r.key), ["one", "two(2)"], "a refused index writes nothing");
      setPacksForTest([fx]);
      console.log("✓ a workspace_files repository's loader: rows from the files through RepositoryInput, checked, idempotent; a bad row refuses the whole index");
    }

    // Re-indexed by the run engine after a commit: results naming the indexed rows are accepted only then.
    const harness = await import("../src/run-harness.js");
    const store = await import("../src/workspace-store.js");
    const area = (name: string, extra: object) => ({ name, label: name, fields: [{ name: "url", label: "Address" }], ...extra });
    const hookless = (indexed: boolean) => definePack({
      id: "fixture_index",
      recordAreas: [area("ix_checks", { role: "check", scope: "platform" }), area("ix_apps", { role: "asset", scope: "workspace", ...(indexed ? { repository: "items" } : {}) })] as never,
      ...(indexed ? { repositories: { items: { kind: "workspace_files", path: "items/{name}.json", identity: "key" } } } : {}),
      jobKinds: [{ name: "items", runner: "workspace-harness", entry: "hooked.mjs", workspace: true, lease_seconds: 15, max_attempts: 1 }] as never,
    });
    const harnessRun = async (indexed: boolean, items: string[]) => {
      const def = hookless(indexed);
      // The fixture program names areas hook_checks/hook_apps: the same program, this pack's names.
      setPacksForTest([{ manifest: { id: "fixture_index", name: "Index", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(TMP, "ix-pack") }, definition: def }]);
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(TMP, "ix-pack"), { recursive: true });
      writeFileSync(path.join(TMP, "ix-pack", "hooked.mjs"), readFileSync(path.join(ROOT, "scripts", "fixtures", "runs", "hooked.mjs"), "utf8").replaceAll("hook_checks", "ix_checks").replaceAll("hook_apps", "ix_apps"));
      await rec.putPlatform(null, "ix_checks", "c1", { title: "A check", data: { url: "x" } });
      const { workspaceRuns } = await import("../src/runs.js");
      await withTenant(A.orgId, () => workspaceRuns("fixture_index", A.orgId, null).start("items", { targets: { items } }));
      const client = await harness.localRunnerClient(`w-ix-${indexed}`);
      const c = (await client.claim(["fixture_index/items"]))!;
      const view = await harness.runWorkspaceHarness(client, c, { allowSameUser: true, egress: "off" });
      const events = (await db.query<{ type: string }>("SELECT type FROM run_events WHERE run_id = $1 ORDER BY id", [c.run.id])).map((e) => e.type);
      return { view, events };
    };
    const without = await harnessRun(false, ["app-1"]);
    assert.equal(without.view?.status, "failed", "without the index, results naming app-1 are refused");
    await db.query("DELETE FROM workspace_snapshots WHERE store = 'fixture_index'");
    const withIndex = await harnessRun(true, ["app-1", "app(2)"]);
    assert.equal(withIndex.view?.status, "succeeded", JSON.stringify(withIndex.view));
    assert.deepEqual(withIndex.events.filter((t) => ["workspace_written", "workspace_indexed", "succeeded"].includes(t)), ["workspace_written", "workspace_indexed", "succeeded"], "commit, index, then the results");
    assert.deepEqual((await withTenant(A.orgId, () => rec.workspaceRecords("fixture_index", A.orgId).list("ix_apps"))).records.map((r) => r.key), ["app(2)", "app-1"]);
    void store;
    setPacksForTest([fx]);
    console.log("✓ the run engine re-indexes a pack's workspace files after each commit, before the results are checked");
  }

  // ---------- 5. an external API ----------
  {
    const tokens: Record<string, string> = { [`tok-A-${STAMP}`]: "A", [`tok-B-${STAMP}`]: "B" };
    const items: Record<string, { id: string; label: string; level: number; status: string }[]> = {
      A: [{ id: "it(1)", label: "Alpha one", level: 3, status: "ok" }, { id: "it2", label: "Alpha two", level: 9, status: "late" }, { id: "it3", label: "Alpha three", level: 5, status: "ok" }],
      B: [{ id: "it(1)", label: "B's own one", level: 1, status: "ok" }, { id: "b-only", label: "B secret item", level: 7, status: "ok" }],
    };
    const got: string[] = [];
    const api = await listen((q, s) => {
      got.push(q.url!);
      const who = tokens[String(q.headers.authorization ?? "").replace(/^Bearer /, "")];
      if (q.url === "/v1/redirect") { s.statusCode = 302; s.setHeader("location", "http://127.0.0.1:1/"); return s.end(); }
      if (!who) { s.statusCode = 401; return s.end(); }
      s.setHeader("content-type", "application/json");
      if (q.url === "/v1/items") return s.end(JSON.stringify({ items: items[who] }));
      const m = /^\/v1\/items\/(.+)$/.exec(q.url!);
      const it = m ? items[who]!.find((x) => x.id === decodeURIComponent(m[1]!)) : null;
      if (!it) { s.statusCode = 404; return s.end(); }
      s.end(JSON.stringify(it));
    });
    process.env.APP_DATA_ALLOW_PRIVATE = "1";
    repos.setResolverForTest(async (h) => (h === "vendor.test.example" ? [{ address: "127.0.0.1", family: 4 }] : []));
    const live = await catalogPack((j) => { j.repositories.vendor_api.base_url = `http://vendor.test.example:${api.port}/v1`; });
    setPacksForTest([live]);
    const httpSrv = await startHttp();
    try {
      const { setCredential } = await import("../src/credentials.js");
      const r = (org: typeof A) => rec.workspaceRecords("fixture_catalog", org.orgId, { role: "member", userId: "u" });
      await assert.rejects(withTenant(A.orgId, () => r(A).list("vendor_items")), (e: any) => e.status === 409 && /set the vendor_token credential first/.test(e.message));
      await setCredential(A.orgId, "test", { pack: "fixture_catalog", name: "vendor_token", value: `tok-A-${STAMP}` });
      await setCredential(B.orgId, "test", { pack: "fixture_catalog", name: "vendor_token", value: `tok-B-${STAMP}` });
      const la = await withTenant(A.orgId, () => r(A).list("vendor_items", { sort: "-level" }));
      assert.deepEqual(la.records.map((x) => [x.key, x.title, x.data.level, x.data.state]), [["it2", "Alpha two", 9, "late"], ["it3", "Alpha three", 5, "ok"], ["it(1)", "Alpha one", 3, "ok"]], "A's items, mapped, sorted");
      assert.deepEqual((await withTenant(B.orgId, () => r(B).list("vendor_items"))).records.map((x) => x.title), ["B secret item", "B's own one"], "B's own items with B's own credential");
      assert.deepEqual((await withTenant(A.orgId, () => r(A).list("vendor_items", { filter: { state: "ok", level: { gte: 4 } } }))).records.map((x) => x.key), ["it3"], "filters on live rows");
      assert.equal((await withTenant(A.orgId, () => r(A).get("vendor_items", "it(1)")))!.title, "Alpha one");
      assert.ok(got.includes("/v1/items/it%281%29"), "a key with ( and ) is encoded in the API's path");
      assert.equal(await withTenant(A.orgId, () => r(A).get("vendor_items", "b-only")), null, "A asking for B's item gets nothing (A's credential sees A's)");
      await assert.rejects(withTenant(A.orgId, () => r(A).put("vendor_items", "x", { data: { name: "x" } })), (e: any) => e.status === 409 && /from an external API .* read only/.test(e.message));
      // Over REST, as every area.
      const sa = await httpSrv.signIn(A), sb = await httpSrv.signIn(B);
      const restA = await (await httpSrv.req("GET", "/api/data/vendor_items", { authorization: `Bearer ${sa}` })).json();
      const restB = await (await httpSrv.req("GET", "/api/data/vendor_items/b-only", { authorization: `Bearer ${sb}` })).json();
      assert.deepEqual([restA.records.length, restB.record.title], [3, "B secret item"]);
      assert.equal((await httpSrv.req("GET", "/api/data/vendor_items/b-only", { authorization: `Bearer ${sa}` })).status, 404, "B's item over A's session: 404");
      assert.equal((await httpSrv.req("DELETE", "/api/data/vendor_items/it2", { authorization: `Bearer ${sa}` })).status, 409);
      const answers = JSON.stringify([la, restA, restB]);
      assert.ok(!answers.includes("tok-A") && !answers.includes("tok-B"), "no answer carries a token");
      // A redirect, a host outside the egress list, a private address: refused, the token in no message.
      const msg = async (edit: (j: any) => void) => {
        setPacksForTest([await catalogPack((j) => { j.repositories.vendor_api.base_url = `http://vendor.test.example:${api.port}/v1`; edit(j); })]);
        try { await withTenant(A.orgId, () => r(A).list("vendor_items")); return "listed"; } catch (e) { return `${(e as any).status} ${(e as Error).message}`; } finally { setPacksForTest([live]); }
      };
      assert.match(await msg((j) => { j.repositories.vendor_api.list.path = "/redirect"; }), /^502 the API redirected \(302\): refused/);
      repos.setResolverForTest(async (h) => (h === "vendor.test.example" ? [{ address: "10.1.2.3", family: 4 }] : []));
      delete process.env.APP_DATA_ALLOW_PRIVATE;
      assert.match(await msg(() => {}), /^502 an API repository is reached over https only/);
      assert.match(await msg((j) => { j.repositories.vendor_api.base_url = "https://vendor.test.example/v1"; }), /^502 the API host vendor\.test\.example resolves to a private address: refused/);
      assert.equal(await repos.apiGet("https://elsewhere.example/x", ["vendor.test.example"], {}).catch((e) => e.message), "the API host elsewhere.example is not in the repository's egress list: refused");
      for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "172.16.0.1", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::FFFF:10.0.0.1",
        "64:ff9b::10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1", "::10.0.0.1", "fec0::1", "198.18.0.1", "192.0.0.1", "2001:db8::1"]) assert.ok(repos.isPrivateAddress(ip), `${ip} is private`);
      assert.equal(await repos.apiGet("https://vendor.test.example:8443/x", ["vendor.test.example"], {}).catch((e) => e.message), "an API repository is reached on port 443 only");
      assert.throws(() => definePack({ id: "pk", recordAreas: [{ name: "pp", label: "P", role: "check", scope: "workspace", repository: "files", fields: [{ name: "xx", label: "X" }] }],
        repositories: { files: { kind: "workspace_files", path: "a/{n}.json", never_read: ["path __proto__.toString"] } } }), /no __proto__/, "never_read cannot reach an object's prototype");
      assert.throws(() => definePack({ id: "pk", recordAreas: [{ name: "pp", label: "P", role: "check", scope: "workspace", repository: "files", fields: [{ name: "xx", label: "X" }] }],
        repositories: { files: { kind: "workspace_files", path: "a/{n}.json", map: { pp: { key: "{@constructor}" } } } } }), /template/, "nor a template");
      assert.ok(!repos.isPrivateAddress("93.184.216.34"));
      process.env.APP_DATA_ALLOW_PRIVATE = "1";
      repos.setResolverForTest(async (h) => (h === "vendor.test.example" ? [{ address: "127.0.0.1", family: 4 }] : []));
      assert.ok(!got.some((u) => u.includes("tok-")), "the token never travels in a URL");
      console.log("✓ external API, live: each workspace's own credential and items, filters and sorts, keys encoded, read only, over REST; a redirect, a private address, plain http and a host outside egress refused; tokens in no answer");

    } finally { await httpSrv.close(); api.close(); }
  }

  // ---------- the second app's own declaration, when given ----------
  const real = process.env.SECOND_APP_DECLARATION;
  if (real && existsSync(real)) {
    const decl = JSON.parse(readFileSync(real, "utf8"));
    // mold_v0-283: an upstream catalog it may still declare is left out, and the areas it fed become staff-kept records.
    const gone = Object.keys(decl.repositories).filter((n) => decl.repositories[n].kind === "upstream_catalog");
    const repoNames = Object.keys(decl.repositories).filter((n) => !gone.includes(n));
    const json = { id: "second_app", name: "Second app", version: "1",
      record_areas: decl.record_areas.map((a: any) => (gone.includes(a.repository) ? (({ repository: _r, ...rest }) => rest)(a) : a)),
      repositories: Object.fromEntries(repoNames.map((n) => [n, decl.repositories[n].kind === "workspace_files" ? { ...decl.repositories[n], store: "second_app" } : decl.repositories[n]])) };
    const { compileDeclarations } = await import("../src/pack-manifest.js");
    setPacksForTest([{ manifest: { id: "second_app", name: "Second app", version: "1", entry: null, migrations: null, words: {} }, declared: compileDeclarations(json) }]);
    // Its workspace repositories: the fixture's files at its declared paths (the company and application folders).
    const files = workspaceFiles("acme", "A");
    const w = await repos.indexWorkspaceFiles(A.orgId, "second_app", files);
    const w2 = await repos.indexWorkspaceFiles(B.orgId, "second_app", workspaceFiles("globex", "B"));
    const wAgain = await repos.indexWorkspaceFiles(A.orgId, "second_app", files);
    console.log(`✓ the second app's declaration (${path.basename(real)}): ${repoNames.length} repositories${gone.length ? ` (${gone.join(", ")} left out: an upstream catalog)` : ""}; ` +
      `workspace A ${JSON.stringify(w.map(counts))}, B ${JSON.stringify(w2.map(counts))}, A again written=${wAgain.some((x) => x.written)}`);
    assert.ok(!wAgain.some((x) => x.written), "idempotent");
    assert.ok(w.every((x) => x.areas.every((a) => a.desired > 0)), "every area fed");
  } else console.log("- the second app's declaration: not given (SECOND_APP_DECLARATION)");
  await db.close();
  console.log("DATA REPOSITORIES TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
