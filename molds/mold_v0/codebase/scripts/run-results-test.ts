// Run results (mold_v0-065; src/runs.ts checkResults, sql/migrations/0010_run_results_identity.sql), offline: an
// embedded database, fixture kinds whose program writes the results it is given (scripts/fixtures/runs/results.mjs).
//   npm run test:run-results
//
// 1. Identity: several findings on one check x asset x source stay separate rows when their fingerprints differ; the
//    same identity twice (the same fingerprint, or none on both) is still refused; the database's unique index agrees.
// 2. unresolved_references "reject" (the default): a result naming a record the workspace does not have refuses the
//    whole run, as before.
// 3. "drop": that result is left out, the rest written; each is reported (result_unresolved, with its status) and
//    counted in the "succeeded" event, failures dropped counted on their own.
// 4. "downgrade": a missing asset or source is cleared and kept as written in detail.unresolved; a missing check is
//    dropped; another workspace's asset never becomes a link to it; two results that become the same are one row and
//    the other is reported dropped.
// 5. Limits: more than max_unresolved refuses the run's results; an area that is not declared or not of its role is
//    refused whatever the mode.
import assert from "node:assert/strict";
import path from "node:path";
import { cleanup, connect, STAMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack, defineTool, z } = await import("../src/pack-api.js");
  const harness = await import("../src/run-harness.js");
  const rec = await import("../src/record-areas.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const A = (await createOrg(`Results A ${STAMP}`)).org, B = (await createOrg(`Results B ${STAMP}`)).org;
  const k = (name: string, extra: Record<string, unknown> = {}) => ({ name, runner: "workspace-harness", entry: "results.mjs", lease_seconds: 15, max_attempts: 1, ...extra });
  const fixture = definePack({
    id: "fixture_results",
    recordAreas: [
      { name: "res_sources", label: "Sources", role: "source", scope: "platform", fields: [{ name: "body", label: "Body" }] },
      { name: "res_checks", label: "Checks", role: "check", scope: "platform", fields: [{ name: "summary", label: "Summary" }] },
      { name: "res_apps", label: "Applications", role: "asset", scope: "workspace", fields: [{ name: "url", label: "Address" }] },
    ],
    jobKinds: [k("strict"), k("dropping", { unresolved_references: "drop" }), k("downgrading", { unresolved_references: "downgrade" }),
      k("dropping_one", { unresolved_references: "drop", max_unresolved: 1 })] as never,
    tools: [defineTool({ name: "fixture_results_run", description: "Start a run (test).", inputSchema: { kind: z.string(), results: z.array(z.unknown()) },
      handler: async (_ws, { kind, results }, { runs: r }) => r.start(kind, { scope: { results } }) })],
  });
  setPacksForTest([{ manifest: { id: "fixture_results", name: "Fixture results", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: fixture }]);
  await rec.putPlatform(null, "res_sources", "s1", { title: "A source", data: { body: "x" } });
  await rec.putPlatform(null, "res_checks", "c1", { title: "A check", data: { summary: "x" } });
  await rec.putPlatform(null, "res_checks", "c2", { title: "Another", data: { summary: "y" } });
  await withTenant(A.orgId, () => rec.workspaceRecords("fixture_results", A.orgId).put("res_apps", "app-a", { title: "A's", data: { url: "https://a.example" } }));
  await withTenant(B.orgId, () => rec.workspaceRecords("fixture_results", B.orgId).put("res_apps", "app-b", { title: "B's", data: { url: "https://b.example" } }));
  const ca = await connect(A);
  const client = await harness.localRunnerClient("w-results");
  const run = async (kind: string, results: unknown[]) => {
    const s = await ca.call("fixture_results_run", { kind, results });
    assert.ok(!s.isError, s.content[0]?.text);
    const c = (await client.claim([`fixture_results/${kind}`]))!;
    const view = await harness.runWorkspaceHarness(client, c, { allowSameUser: true, egress: "off" });
    const rows = await db.query<any>("SELECT check_key, asset_area, asset_key, source_key, status, finding_fingerprint, detail FROM run_results WHERE run_id = $1 ORDER BY id", [c.run.id]);
    const events = await db.query<{ type: string; data: any }>("SELECT type, data FROM run_events WHERE run_id = $1 ORDER BY id", [c.run.id]);
    return { id: c.run.id, view, rows, events, of: (t: string) => events.filter((e) => e.type === t).map((e) => e.data) };
  };
  const C1 = { area: "res_checks", key: "c1" }, APP = { area: "res_apps", key: "app-a" }, S1 = { area: "res_sources", key: "s1" };
  try {
    // ---------- 1. identity ----------
    {
      const two = await run("strict", [{ check: C1, asset: APP, source: S1, status: "fail", finding_fingerprint: "sha256:aaa" },
        { check: C1, asset: APP, source: S1, status: "fail", finding_fingerprint: "sha256:bbb" }, { check: C1, asset: APP, source: S1, status: "pass" }]);
      assert.equal(two.view?.status, "succeeded", JSON.stringify(two.view));
      assert.deepEqual(two.rows.map((r) => r.finding_fingerprint), ["sha256:aaa", "sha256:bbb", null], "two findings and a fingerprint-less row on one triple: three rows");
      const same = await run("strict", [{ check: C1, asset: APP, status: "fail", finding_fingerprint: "f1" }, { check: C1, asset: APP, status: "pass", finding_fingerprint: "f1" }]);
      assert.equal(same.view?.status, "failed"); assert.match(same.view!.error!, /x finding f1 is listed twice/);
      const none = await run("strict", [{ check: C1, asset: APP, status: "fail" }, { check: C1, asset: APP, status: "pass" }]);
      assert.equal(none.view?.status, "failed"); assert.match(none.view!.error!, /listed twice/, "no fingerprint on both: still one identity");
      // The database agrees: the unique index includes the fingerprint.
      const ins = (fp: string | null) => db.query("INSERT INTO run_results (run_id, org_id, check_area, check_key, status, finding_fingerprint) VALUES ($1, $2, 'res_checks', 'zz', 'fail', $3)", [two.id, A.orgId, fp]);
      await ins("x1"); await ins("x2");
      await assert.rejects(ins("x1"), /duplicate key|unique/i, "the same identity twice is refused by the database");
      await ins(null);
      await assert.rejects(ins(null), /duplicate key|unique/i);
      console.log("✓ identity: findings on one check x asset x source stay separate rows by fingerprint; the same identity twice is refused (code and database)");
    }
    // ---------- 2. reject (default) ----------
    {
      const r = await run("strict", [{ check: C1, asset: APP, status: "pass" }, { check: C1, asset: { area: "res_apps", key: "nope" }, status: "fail" }]);
      assert.equal(r.view?.status, "failed"); assert.match(r.view!.error!, /no asset record nope in res_apps for this run's workspace/);
      assert.equal(r.rows.length, 0, "no result is written");
      console.log("✓ reject (the default): one unresolved reference refuses the whole run's results");
    }
    // ---------- 3. drop ----------
    {
      const r = await run("dropping", [{ check: C1, asset: APP, status: "pass" }, { check: C1, asset: { area: "res_apps", key: "gone" }, status: "fail", finding_fingerprint: "fp-gone" },
        { check: { area: "res_checks", key: "c-missing" }, status: "error" }, { check: C1, source: { area: "res_sources", key: "s-missing" }, status: "pass" }]);
      assert.equal(r.view?.status, "succeeded", JSON.stringify(r.view));
      assert.deepEqual(r.rows.map((x) => [x.check_key, x.asset_key]), [["c1", "app-a"]], "the unresolved results are left out, the rest written");
      const un = r.of("result_unresolved");
      assert.deepEqual(un.map((u) => [u.action, u.missing, u.status]), [["dropped", ["asset"], "fail"], ["dropped", ["check"], "error"], ["dropped", ["source"], "pass"]]);
      assert.equal(un[0].finding_fingerprint, "fp-gone");
      const done = r.of("succeeded")[0];
      assert.deepEqual([done.results, done.unresolved, done.dropped, done.downgraded, done.dropped_not_passing], [1, 3, 3, 0, 2], "counted, failures dropped on their own");
      console.log("✓ drop: unresolved results left out, each reported with its status, counted (failures dropped counted on their own)");
    }
    // ---------- 4. downgrade ----------
    {
      const r = await run("downgrading", [
        { check: C1, asset: { area: "res_apps", key: "app-b" }, source: S1, status: "fail", finding_fingerprint: "f-b", detail: { note: "kept" } }, // B's asset: not this workspace's
        { check: C1, asset: { area: "res_apps", key: "ghost" }, source: S1, status: "fail", finding_fingerprint: "f-b" }, // the same once cleared
        { check: C1, asset: APP, source: { area: "res_sources", key: "s-gone" }, status: "fail" },
        { check: { area: "res_checks", key: "c-gone" }, asset: APP, status: "fail" },
      ]);
      assert.equal(r.view?.status, "succeeded", JSON.stringify(r.view));
      assert.deepEqual(r.rows.map((x) => [x.asset_key, x.source_key, x.finding_fingerprint]), [[null, "s1", "f-b"], ["app-a", null, null]]);
      assert.deepEqual(r.rows[0].detail, { note: "kept", unresolved: { asset: { area: "res_apps", key: "app-b" } } }, "the cleared reference is kept as written, as text, never as a link");
      assert.deepEqual(r.rows[1].detail, { unresolved: { source: { area: "res_sources", key: "s-gone" } } });
      const un = r.of("result_unresolved").map((u) => [u.action, u.missing, u.reason ?? null]);
      assert.deepEqual(un, [["downgraded", ["asset"], null], ["dropped", ["asset"], "the same as another result once downgraded"], ["downgraded", ["source"], null], ["dropped", ["check"], null]]);
      const leak = await withTenant(B.orgId, () => db.query("/* tenant: test */ SELECT 1 FROM run_results WHERE asset_key = 'app-b'"));
      assert.equal(leak.length, 0, "B sees no row naming its asset");
      console.log("✓ downgrade: a missing asset or source is cleared and kept as written in detail; a missing check is dropped; another workspace's asset never becomes a link; duplicates once cleared are one row");
    }
    // ---------- 5. limits ----------
    {
      const over = await run("dropping_one", [{ check: C1, asset: { area: "res_apps", key: "x1" }, status: "fail" }, { check: C1, asset: { area: "res_apps", key: "x2" }, status: "fail" }]);
      assert.equal(over.view?.status, "failed"); assert.match(over.view!.error!, /2 name records that do not exist .* at most 1/);
      assert.equal(over.rows.length, 0);
      const wrongArea = await run("dropping", [{ check: { area: "res_apps", key: "app-a" }, status: "pass" }]);
      assert.equal(wrongArea.view?.status, "failed"); assert.match(wrongArea.view!.error!, /res_apps is not a check area/);
      const undeclared = await run("downgrading", [{ check: C1, asset: { area: "nowhere", key: "x" }, status: "pass" }]);
      assert.equal(undeclared.view?.status, "failed"); assert.match(undeclared.view!.error!, /nowhere is not a asset area/);
      console.log("✓ limits: more than max_unresolved refuses the run's results; an undeclared area or a wrong role is refused whatever the mode");
    }
    // The tables are still under row-level security.
    const { rlsCatalogProblems } = await import("../src/rls.js");
    assert.deepEqual(await rlsCatalogProblems(db), []);
  } finally {
    await ca.close();
  }
  await db.close();
  console.log("RUN RESULTS TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
