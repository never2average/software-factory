// Data repositories (mold_v0-059; src/data-repositories.ts), offline: an embedded database, a local git repository
// standing in for an upstream catalog (never the network), a workspace's files, a local HTTP API, a fake Clerk.
//   npm run test:data-repositories
//   SECOND_APP_DECLARATION=<a declaration.json> npm run test:data-repositories   also runs a real declaration's shape
//
// 1. Declarations: gen-packs builds the fixture (shaped like the second app's declaration); the kinds' rules are
//    refused at build (scope per kind, writes on read-only areas, the store, the API's egress and credential, maps,
//    loaders, never_read, a reference into a live area).
// 2. An upstream catalog at a pin (git): read at the pinned commit whatever the branch says; idempotent by fingerprint
//    (a second index writes nothing); a new pin updates; a prune of more than half refused unless forced; staff rows
//    never pruned; a commit that is not there refused; a redirect refused (and git without the setting would follow
//    it); an index that fails part-way writes nothing; the same with a declared map and no code; the staff route.
// 3. The github transport: the commit checked, every request at the pin with redirects refused.
// 4. A workspace's files: the ledger (last line wins, other kinds left out), application folders (globs, never_read),
//    sealed rows keyed with the workspace's own fingerprint key; idempotent; pruned when a folder goes (the committed
//    files are the truth); two workspaces never touch each other's rows; re-indexed by the run engine
//    after a commit (results naming the indexed rows are accepted only then).
// 5. An external API, live: the workspace's own credential, each workspace its own items, filters and sorts, keys with
//    ( and ) encoded, read only, a redirect refused, private addresses refused, egress enforced, the token never shown.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";
import { catalogPack, catalogPackDir, catalogRepo, fixtureJson, workspaceFiles } from "./lib/catalog-fixture.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.APP_DATA_ALLOW_FILE_UPSTREAM = "1";
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
      ["an upstream feeding a workspace area", (j) => { j.record_areas[2].repository = "catalogs"; }, /an upstream catalog feeds shared areas/],
      ["a lifecycle on a read-only area", (j) => { const t = j.record_areas.find((a: any) => a.name === "tasks"); t.repository = "company_ledger"; }, /read only\): it cannot have a lifecycle/],
      ["writes declared on a read-only area", (j) => { j.record_areas[2].permissions = { update: ["owner"] }; }, /read only\): it cannot declare update/],
      ["another pack's store", (j) => { j.repositories.company_ledger.store = "other_pack"; }, /store other_pack is not this pack's own store/],
      ["a map naming an undeclared field", (j) => { j.repositories.company_ledger.map.control_status.fields.nope = "id"; }, /names field nope, which control_status does not declare/],
      ["a never_read rule that is not one", (j) => { j.repositories.company_applications.never_read = ["credentials.json"]; }, /never_read/],
      ["a path leaving the files", (j) => { j.repositories.company_ledger.path = "../x/{company}.jsonl"; }, /no \. or \.\. part/],
      ["a branch as the pin", (j) => { j.upstream.commit = "main"; }, /a full commit id/],
      ["a reference into a live area", (j) => { j.record_areas.find((a: any) => a.name === "tasks").fields.push({ name: "item", label: "Item", type: "reference", to: "vendor_items" }); }, /refers to vendor_items, which is read live from an API/],
      ["an unknown kind", (j) => { j.repositories.catalogs.kind = "ftp_site"; }, /repositories\.catalogs/],
    ];
    for (const [what, edit, re] of refused) assert.throws(() => tryJson(edit)(), re, what);
    assert.throws(() => installPacks([{ manifest: { id: "pk", name: "pk", version: "1", entry: "index.ts", migrations: null, words: {} }, definition: definePack({ id: "pk", loaders: { nowhere: () => ({}) } }) }]), /loader nowhere names no repository/);
    console.log(`✓ declarations: gen-packs builds the fixture (7 areas, 4 repositories); ${refused.length + 1} broken declarations refused, each with its reason`);
  }

  // ---------- 2. an upstream catalog at a pin ----------
  const settings = fixtureJson().repositories.catalogs;
  const up = catalogRepo(settings);
  const pin = async (commit: string, edit?: (j: any) => void) => { const p = await catalogPack((j) => { j.upstream = { repo: up.url, commit }; edit?.(j); }); setPacksForTest([p]); return p; };
  const shared = async (area: string) => (await db.query<{ key: string; title: string; data: any; version: string; updated_at: string; source: string | null }>("SELECT key, title, data, version, updated_at::text, source FROM platform_records WHERE area = $1 ORDER BY key", [area]));
  const counts = (r: { areas: { area: string; created: number; updated: number; unchanged: number; deleted: number }[] }) => Object.fromEntries(r.areas.map((a) => [a.area, [a.created, a.updated, a.unchanged, a.deleted]]));
  {
    await pin(up.c1);
    const r1 = await repos.syncUpstreamCatalog("fixture_catalog", "catalogs");
    assert.deepEqual(counts(r1), { regulators: [5, 0, 0, 0], controls: [15, 0, 0, 0] });
    assert.equal(r1.version, up.c1);
    const c = await shared("controls");
    const k = c.find((x) => x.key === "alpha-rules-2024:7(2)(b)")!;
    assert.deepEqual([k.data.prose, k.version, k.source], ["Requirement 7(2)(b)", up.c1, "catalogs"], "read at the pinned commit, though the branch is at c3");
    assert.ok(c.some((x) => x.key === "beta-code-2023:B.12") && !c.some((x) => x.key === "alpha-rules-2024:7(3)"), "c1's controls, not c2's or c3's");
    // Idempotent: the same pin writes nothing.
    const r2 = await repos.syncUpstreamCatalog("fixture_catalog", "catalogs");
    assert.deepEqual([r2.written, counts(r2)], [false, { regulators: [0, 0, 5, 0], controls: [0, 0, 15, 0] }]);
    assert.deepEqual((await shared("controls")).map((x) => x.updated_at), c.map((x) => x.updated_at), "no row was touched");
    // A row staff added by hand is never pruned; one changed by hand is written back by the next index.
    await rec.putPlatform(null, "controls", "hand:extra", { title: "Staff's own", data: { control_id: "extra" } });
    await rec.putPlatform(null, "controls", "alpha-rules-2024:34(vii)", { title: "edited by hand", data: { control_id: "34(vii)" } });
    // A new pin: what changed is written, the rest untouched.
    await pin(up.c2);
    const r3 = await repos.syncUpstreamCatalog("fixture_catalog", "catalogs");
    assert.deepEqual(counts(r3), { regulators: [0, 5, 0, 0], controls: [1, 14, 0, 0] }, "a new pin rewrites every row it wrote (its version is the commit) and adds the new one");
    assert.equal(r3.areas.find((a) => a.area === "controls")!.kept_by_hand, 2, "the hand-edited row and staff's own row are kept and counted");
    assert.equal((await shared("controls")).find((x) => x.key === "alpha-rules-2024:7(2)(b)")!.data.prose, "Changed requirement");
    assert.equal((await shared("controls")).find((x) => x.key === "alpha-rules-2024:34(vii)")!.title, "edited by hand", "a hand edit is never overwritten by an index (unless forced)");
    // c3 drops 10 of beta's 12 controls: more than half of what this repository wrote; refused unless forced.
    await pin(up.c3);
    const before = JSON.stringify(await shared("controls"));
    await assert.rejects(repos.syncUpstreamCatalog("fixture_catalog", "catalogs"), (e: any) => e.status === 409 && /would remove 10 of its 15 rows/.test(e.message));
    assert.equal(JSON.stringify(await shared("controls")), before, "nothing pruned or written");
    const r4 = await repos.syncUpstreamCatalog("fixture_catalog", "catalogs", { force: true });
    assert.equal(r4.areas.find((a) => a.area === "controls")!.deleted, 10);
    assert.ok((await shared("controls")).some((x) => x.key === "hand:extra"), "staff's own row survives every prune");
    assert.equal((await shared("controls")).find((x) => x.key === "alpha-rules-2024:34(vii)")!.source, "catalogs", "a forced index takes the hand-edited row back");
    // A commit that is not in the repository: refused, nothing changed.
    const now = JSON.stringify(await shared("controls"));
    await pin("f".repeat(40));
    await assert.rejects(repos.syncUpstreamCatalog("fixture_catalog", "catalogs"), (e: any) => e.status === 502 && /could not be fetched at f{40}/.test(e.message));
    // An index that fails part-way writes nothing: a loader whose last row breaks the area's types.
    const p = await pin(up.c2);
    const orig = p.definition.loaders.catalogs;
    p.definition.loaders.catalogs = async (input: any) => { const rows = await orig(input); rows.controls.push({ key: "bad", data: { mandatory: "yes" } }); return rows; };
    await assert.rejects(repos.syncUpstreamCatalog("fixture_catalog", "catalogs"), (e: any) => e.status === 422 && /field mandatory .* must be a boolean/.test(e.message));
    assert.equal(JSON.stringify(await shared("controls")), now, "a refused index leaves the area exactly as it was");
    // The same catalog with no code: a declared map.
    const mapped = await catalogPack((j) => {
      j.upstream = { repo: up.url, commit: up.c2 };
      j.repositories.catalogs.map = {
        regulators: { from: "instruments", each: "instruments", key: "{instrumentId}", title: "{shortName}", fields: { kind: "$.kind", regulator: "regulator", short_name: "shortName" } },
        controls: { from: "catalogs_dir", each: "groups.controls", key: "{$.instrumentId}:{id}", title: "{title}", fields: { instrument: "$.instrumentId", regulator: "$.regulator", control_id: "id" } },
      };
    });
    setPacksForTest([{ ...mapped, definition: null }]);
    const r5 = await repos.syncUpstreamCatalog("fixture_catalog", "catalogs", { force: true });
    assert.equal(r5.areas.find((a) => a.area === "controls")!.desired, 16, "a declared map reads every catalog in the directory");
    const m = (await shared("controls")).find((x) => x.key === "alpha-rules-2024:7(3)")!;
    assert.deepEqual([m.data.instrument, m.data.control_id, m.data.prose], ["alpha-rules-2024", "7(3)", "Requirement 7(3)"], "values by path, by the field's name, from the document's root");
    assert.equal((await shared("regulators")).find((x) => x.key === "beta-code-2023")!.data.kind, "fixture.catalog.instruments");
    console.log("✓ upstream catalog at a pin (git): read at the pin, idempotent (nothing written twice), new pins update, a big prune refused unless forced, staff rows kept, a missing commit refused, a failed index writes nothing, a declared map needs no code");

    // A redirect is refused (git's own following is turned off): a local server that redirects to another.
    let targetHits = 0;
    const target = await listen((_q, s) => { targetHits++; s.statusCode = 404; s.end(); });
    const redirector = await listen((q, s) => { s.statusCode = 302; s.setHeader("location", `http://127.0.0.1:${target.port}${q.url}`); s.end(); });
    try {
      await assert.rejects(repos.gitSource({ repo: `http://127.0.0.1:${redirector.port}/x.git`, commit: up.c1 }), (e: any) => e.status === 502);
      assert.equal(targetHits, 0, "the redirect was not followed");
      // And git with its default setting would have followed it: the test is a real one.
      // (Asynchronously: the two servers live in this process.)
      await new Promise((done) => execFile("git", ["ls-remote", `http://127.0.0.1:${redirector.port}/x.git`], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "http", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, timeout: 30_000 }, done));
      assert.ok(targetHits > 0, "git's default follows a redirect");
    } finally { target.close(); redirector.close(); }
    delete process.env.APP_DATA_ALLOW_FILE_UPSTREAM;
    await assert.rejects(repos.gitSource({ repo: up.url, commit: up.c1 }), /for tests only/, "file:// and http:// upstreams are refused outside tests");
    process.env.APP_DATA_ALLOW_FILE_UPSTREAM = "1";
    console.log("✓ a redirect is refused (git without the setting follows it); file:// and http:// upstreams only with the test switch");
  }

  // ---------- 3. the github transport ----------
  {
    const commit = "a".repeat(40);
    const seen: { url: string; redirect: unknown }[] = [];
    const files: Record<string, string> = { "x/one.json": "{\"a\":1}" };
    const fake = (opts: { sha?: string; throwOn?: RegExp; truncated?: boolean } = {}) => (async (url: string, init: RequestInit) => {
      seen.push({ url, redirect: init?.redirect });
      if (opts.throwOn?.test(url)) throw new TypeError("fetch failed: redirect mode is set to error");
      if (url.includes("/commits/")) return new Response(JSON.stringify({ sha: opts.sha ?? commit }), { status: 200 });
      if (url.includes("/git/trees/")) return new Response(JSON.stringify({ truncated: !!opts.truncated, tree: Object.keys(files).map((p) => ({ path: p, type: "blob" })) }), { status: 200 });
      const rel = url.split(`/${commit}/`)[1]!;
      return files[rel] ? new Response(files[rel], { status: 200 }) : new Response("", { status: 404 });
    }) as typeof fetch;
    const src = await repos.githubSource({ repo: "https://github.com/example/catalog", commit }, fake());
    assert.equal(await src.read("x/one.json"), "{\"a\":1}");
    assert.equal(await src.read("x/none.json"), null);
    assert.deepEqual(await src.list("x"), ["x/one.json"]);
    assert.ok(seen.every((s) => s.redirect === "error"), "every request refuses a redirect");
    assert.ok(seen.every((s) => s.url.includes(commit)), "every request names the pinned commit");
    assert.deepEqual([...new Set(seen.map((s) => new URL(s.url).host))].sort(), ["api.github.com", "raw.githubusercontent.com"]);
    await assert.rejects(repos.githubSource({ repo: "https://github.com/example/catalog", commit }, fake({ sha: "b".repeat(40) })), /no commit a{40}.*refused/, "the API names another commit");
    await assert.rejects(repos.githubSource({ repo: "https://github.com/example/catalog", commit }, fake({ throwOn: /commits/ })), /redirected \(refused\)|could not be reached/);
    const t = await repos.githubSource({ repo: "https://github.com/example/catalog", commit }, fake({ truncated: true }));
    await assert.rejects(t.list("x"), /could not be read whole/);
    await assert.rejects(repos.githubSource({ repo: "https://gitlab.example/x/y", commit }, fake()), /github\.com/);
    await assert.rejects(src.read("../etc/passwd"), /not a path inside the repository/);
    console.log("✓ github transport: the commit is checked, every request is at the pin with redirects refused, paths stay inside");
  }

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

      // The staff route that indexes an upstream catalog.
      setPacksForTest([await catalogPack((j) => { j.upstream = { repo: up.url, commit: up.c2 }; })]);
      const operator = await httpSrv.adminToken("operator"), owner = await httpSrv.adminToken("owner");
      const sync = (tok: string, body: unknown) => httpSrv.req("POST", "/api/admin/data/_repositories/fixture_catalog/catalogs/sync", { authorization: `Bearer ${tok}` }, body);
      const s1 = await sync(operator, {});
      assert.equal(s1.status, 200, await s1.clone().text());
      assert.equal((await sync(operator, { force: true })).status, 403, "forcing a prune needs delete");
      assert.equal((await sync(owner, { force: true })).status, 200);
      assert.equal((await httpSrv.req("POST", "/api/admin/data/_repositories/fixture_catalog/company_ledger/sync", { authorization: `Bearer ${operator}` }, {})).status, 400, "only an upstream catalog is synced by staff");
      console.log("✓ staff index an upstream catalog over REST (library; forcing a prune needs delete)");
    } finally { await httpSrv.close(); api.close(); }
  }

  // ---------- the second app's own declaration, when given ----------
  const real = process.env.SECOND_APP_DECLARATION;
  if (real && existsSync(real)) {
    const decl = JSON.parse(readFileSync(real, "utf8"));
    const repoNames = Object.keys(decl.repositories);
    const catName = repoNames.find((n) => decl.repositories[n].kind === "upstream_catalog")!;
    const upReal = catalogRepo(decl.repositories[catName]);
    const json = { id: "second_app", name: "Second app", version: "1", upstream: { repo: upReal.url, commit: upReal.c1 }, record_areas: decl.record_areas,
      repositories: Object.fromEntries(Object.entries(decl.repositories).map(([n, r]: [string, any]) => [n, r.kind === "workspace_files" ? { ...r, store: "second_app" } : r])) };
    const { compileDeclarations } = await import("../src/pack-manifest.js");
    const fixtureLoader = (await catalogPack()).definition.loaders.catalogs;
    setPacksForTest([{ manifest: { id: "second_app", name: "Second app", version: "1", entry: null, migrations: null, words: {} }, declared: compileDeclarations(json), definition: { id: "second_app", loaders: { [catName]: fixtureLoader } } }]);
    const r = await repos.syncUpstreamCatalog("second_app", catName);
    const again = await repos.syncUpstreamCatalog("second_app", catName);
    // Its workspace repositories: the fixture's files at its declared paths (the company and application folders).
    const files = workspaceFiles("acme", "A");
    const w = await repos.indexWorkspaceFiles(A.orgId, "second_app", files);
    const w2 = await repos.indexWorkspaceFiles(B.orgId, "second_app", workspaceFiles("globex", "B"));
    const wAgain = await repos.indexWorkspaceFiles(A.orgId, "second_app", files);
    console.log(`✓ the second app's declaration (${path.basename(real)}): ${repoNames.length} repositories; catalog at the pin ${JSON.stringify(counts(r))}, again written=${again.written}; ` +
      `workspace A ${JSON.stringify(w.map(counts))}, B ${JSON.stringify(w2.map(counts))}, A again written=${wAgain.some((x) => x.written)}`);
    assert.ok(!again.written && !wAgain.some((x) => x.written), "idempotent");
    assert.ok(r.areas.every((a) => a.desired > 0) && w.every((x) => x.areas.every((a) => a.desired > 0)), "every area fed");
  } else console.log("- the second app's declaration: not given (SECOND_APP_DECLARATION)");
  await db.close();
  console.log("DATA REPOSITORIES TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
