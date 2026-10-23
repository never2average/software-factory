// The post-commit workspace hook (mold_v0-064; definePack onWorkspaceCommit, src/runs.ts commitThenHook), offline: an
// embedded database, a local object store, a fixture run that writes items/<key>.json and results naming them
// (scripts/fixtures/runs/hooked.mjs), and a pack whose hook indexes those files into its asset area.
//   npm run test:workspace-hook
//
// 1. After the snapshot commits and before the results are checked: the hook gets every file of the committed snapshot
//    (bytes and sha256), the run, the version; the records it indexes are there when the results are checked, so
//    results naming them are accepted (without the hook they are refused).
// 2. A run that changes nothing still calls it (changed: false), so an index can always catch up.
// 3. A hook that throws, or runs past its time: the run fails ("run"), its results are not written, the snapshot stays
//    committed (the next version), and the next run's commit calls the hook again.
// 4. The hook works for the run's own workspace only: its records, its database handle (row-level security: another
//    workspace's rows are not even visible), its workspace id from the run row.
// 5. definePack refuses a hook that is not a function, or one in a pack with no workspace kind.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { cleanup, connect, STAMP, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack, defineTool, z } = await import("../src/pack-api.js");
  type Ctx = import("../src/pack-api.js").WorkspaceCommitContext;
  type File = import("../src/pack-api.js").WorkspaceFile;
  const harness = await import("../src/run-harness.js");
  const store = await import("../src/workspace-store.js");
  const rec = await import("../src/record-areas.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const A = (await createOrg(`Hook A ${STAMP}`)).org, B = (await createOrg(`Hook B ${STAMP}`)).org;

  // ---------- 5. definePack refuses ----------
  {
    assert.throws(() => definePack({ id: "pk", onWorkspaceCommit: "x" as never, jobKinds: [{ name: "kk", runner: "workspace-harness", entry: "a.mjs", workspace: true }] }), /must be a function/);
    assert.throws(() => definePack({ id: "pk", onWorkspaceCommit: () => {}, jobKinds: [{ name: "kk", runner: "workspace-harness", entry: "a.mjs" }] }), /declare a job kind with workspace: true/);
    console.log("✓ definePack refuses a hook that is not a function, or one with no workspace kind to call it");
  }

  const calls: { ctx: Ctx; files: File[]; seenOrgs: number[]; at: number }[] = [];
  let mode: "index" | "throw" | "slow" | "peek" = "index";
  const late: { result: string | null } = { result: null };
  const fixture = definePack({
    id: "fixture_hook",
    recordAreas: [
      { name: "hook_checks", label: "Checks", role: "check", scope: "platform", fields: [{ name: "summary", label: "Summary" }] },
      { name: "hook_apps", label: "Applications", role: "asset", scope: "workspace", fields: [{ name: "url", label: "Address" }] },
    ],
    jobKinds: [{ name: "items", runner: "workspace-harness", entry: "hooked.mjs", workspace: true, lease_seconds: 15, max_attempts: 1 }] as never,
    tools: [defineTool({ name: "fixture_hook_run", description: "Start a run (test).", inputSchema: { items: z.array(z.string()) },
      handler: async (_ws, { items }, { runs: r }) => r.start("items", { targets: { items } }) })],
    async onWorkspaceCommit(ctx, files) {
      // What tenant work sees of the run engine's tables: only its own workspace's rows.
      const seenOrgs = (await ctx.db.query<{ org_id: number }>("SELECT DISTINCT org_id FROM runs")).map((r) => r.org_id);
      calls.push({ ctx, files, seenOrgs, at: Date.now() });
      if (mode === "throw") throw new Error("the index refused a file");
      if (mode === "slow") {
        await new Promise((r) => setTimeout(r, 3000));
        // Its time is up by now: a write it still tries is refused.
        try { await ctx.records.put("hook_apps", "late-write", { title: "late", data: { url: "https://late.example" } }); late.result = "written"; }
        catch (e) { late.result = (e as Error).message; }
        return;
      }
      for (const f of files) {
        if (!f.path.startsWith("items/")) continue;
        const j = JSON.parse(Buffer.from(f.body).toString("utf8"));
        await ctx.records.put("hook_apps", j.key, { title: j.key, data: { url: j.url } });
      }
    },
  });
  setPacksForTest([{ manifest: { id: "fixture_hook", name: "Fixture hook", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: fixture }]);
  await rec.putPlatform(null, "hook_checks", "c1", { title: "A check", data: { summary: "x" } });
  await withTenant(B.orgId, () => rec.workspaceRecords("fixture_hook", B.orgId).put("hook_apps", "b-secret-app", { title: "B's", data: { url: "https://b.example" } }));
  // B has a run too, so "only its own rows" is a real test.
  const cb = await connect(B);
  await cb.call("fixture_hook_run", { items: [] });
  const ca = await connect(A);
  const client = await harness.localRunnerClient("w-hook");
  { const c = (await client.claim(["fixture_hook/items"]))!; assert.equal(c.run.org_id, B.orgId); assert.equal((await harness.runWorkspaceHarness(client, c, { allowSameUser: true, egress: "off" }))?.status, "succeeded"); calls.length = 0; }
  const run = async (items: string[]) => {
    const s = await ca.call("fixture_hook_run", { items });
    assert.ok(!s.isError, s.content[0]?.text);
    const c = (await client.claim(["fixture_hook/items"]))!;
    assert.equal(c.run.org_id, A.orgId);
    const view = await harness.runWorkspaceHarness(client, c, { allowSameUser: true, egress: "off" });
    const rows = await db.query<{ asset_key: string }>("SELECT asset_key FROM run_results WHERE run_id = $1 ORDER BY id", [c.run.id]);
    const events = await db.query<{ type: string; data: any }>("SELECT type, data FROM run_events WHERE run_id = $1 ORDER BY id", [c.run.id]);
    return { id: c.run.id, view, rows, types: events.map((e) => e.type), of: (t: string) => events.filter((e) => e.type === t).map((e) => e.data) };
  };
  const version = async () => (await store.latestSnapshot(db, A.orgId, "fixture_hook"))?.version ?? 0;
  const aRecords = async () => (await withTenant(A.orgId, () => rec.workspaceRecords("fixture_hook", A.orgId).list("hook_apps"))).records.map((r) => r.key).sort();
  try {
    // ---------- 1. commit, hook, then results ----------
    {
      const r = await run(["app-1", "app-2"]);
      assert.equal(r.view?.status, "succeeded", JSON.stringify(r.view));
      assert.deepEqual(r.rows.map((x) => x.asset_key), ["app-1", "app-2"], "results naming the records the hook indexed are accepted");
      assert.deepEqual(await aRecords(), ["app-1", "app-2"]);
      const call = calls.at(-1)!;
      assert.deepEqual(call.files.map((f) => f.path).sort(), ["items/app-1.json", "items/app-2.json"], "every file of the committed snapshot");
      for (const f of call.files) assert.equal(f.sha256, createHash("sha256").update(f.body).digest("hex"), "with bytes matching their sha256");
      assert.deepEqual([call.ctx.workspace.id, call.ctx.run.id, call.ctx.snapshot.version, call.ctx.snapshot.changed], [A.orgId, r.id, 1, true]);
      const order = r.types.filter((t) => ["workspace_written", "workspace_hook", "succeeded"].includes(t));
      assert.deepEqual(order, ["workspace_written", "workspace_hook", "succeeded"], "commit, then the hook, then the results");
      console.log("✓ after the snapshot commits and before the results are checked: the hook gets every committed file and indexes them; results naming what it indexed are accepted");
    }
    // ---------- 2. unchanged ----------
    {
      const r = await run(["app-1", "app-2"]);
      assert.equal(r.view?.status, "succeeded");
      assert.deepEqual([calls.at(-1)!.ctx.snapshot.version, calls.at(-1)!.ctx.snapshot.changed], [1, false], "a run that changed nothing still calls the hook");
      console.log("✓ a run that changes nothing still calls the hook (changed: false)");
    }
    // ---------- 3. failures ----------
    {
      mode = "throw";
      const before = await version();
      const r = await run(["app-3"]);
      assert.equal(r.view?.status, "failed"); assert.equal(r.view?.error_kind, "run");
      assert.match(r.view!.error!, /workspace hook \(onWorkspaceCommit\) failed: the index refused a file/);
      assert.equal(r.rows.length, 0, "its results are not written");
      assert.equal(await version(), before + 1, "the snapshot stays committed");
      assert.match(r.of("workspace_hook_failed")[0].snapshot, /kept/);
      mode = "slow";
      process.env.APP_WORKSPACE_HOOK_SECONDS = "1";
      const s = await run(["app-4"]);
      assert.equal(s.view?.status, "failed"); assert.match(s.view!.error!, /took longer than 1 s/);
      delete process.env.APP_WORKSPACE_HOOK_SECONDS;
      await new Promise((r) => setTimeout(r, 2500));
      assert.match(String(late.result), /time is up: refused/, "a hook past its time cannot write on");
      assert.ok(!(await aRecords()).includes("late-write"));
      mode = "index";
      // The next run's commit calls it again, with everything: the index catches up.
      const n = await run(["app-3", "app-4", "app-5"]);
      assert.equal(n.view?.status, "succeeded", JSON.stringify(n.view));
      assert.deepEqual(await aRecords(), ["app-1", "app-2", "app-3", "app-4", "app-5"]);
      console.log("✓ a hook that throws or runs past its time fails the run with no results; the snapshot stays committed; the next commit calls the hook again");
    }
    // ---------- 3b. results refused before the commit ----------
    {
      const before = await version(), n = calls.length;
      const s = await ca.call("fixture_hook_run", { items: ["app-6", "app-6"] }); // the same result twice
      assert.ok(!s.isError);
      const c = (await client.claim(["fixture_hook/items"]))!;
      // The program writes items/app-6.json once and two identical results: refused for their shape, not a missing record.
      const v = await harness.runWorkspaceHarness(client, c, { allowSameUser: true, egress: "off" });
      assert.equal(v?.status, "failed"); assert.match(v!.error!, /listed twice/);
      assert.equal(await version(), before, "results refused for anything but a missing record: nothing is committed");
      assert.equal(calls.length, n, "and the hook is not called");
      console.log("✓ results refused for their shape (a duplicate, a wrong area) are refused before the snapshot commits: nothing committed, no hook");
    }
    // ---------- 4. the run's own workspace only ----------
    {
      for (const c of calls) assert.deepEqual(c.seenOrgs, [A.orgId], "the hook's database handle sees only the run's workspace's rows");
      const bKeys = (await withTenant(B.orgId, () => rec.workspaceRecords("fixture_hook", B.orgId).list("hook_apps"))).records.map((r) => r.key);
      assert.deepEqual(bKeys, ["b-secret-app"], "B's records are untouched");
      // A hook that tries to read B's record through its records handle gets nothing.
      mode = "peek";
      const peek: { got: unknown } = { got: "unset" };
      const orig = fixture.onWorkspaceCommit!;
      (fixture as { onWorkspaceCommit: typeof orig }).onWorkspaceCommit = async (ctx, files) => { peek.got = await ctx.records.get("hook_apps", "b-secret-app"); return orig(ctx, files); };
      setPacksForTest([{ manifest: { id: "fixture_hook", name: "Fixture hook", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: fixture }]);
      const r = await run(["app-1"]);
      assert.equal(r.view?.status, "succeeded");
      assert.equal(peek.got, null, "another workspace's record is not there for the hook");
      console.log("✓ the hook works for the run's own workspace only: its records and database handle never reach another workspace's rows");
    }
  } finally {
    await ca.close(); await cb.close();
  }
  await db.close();
  console.log("WORKSPACE HOOK TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
