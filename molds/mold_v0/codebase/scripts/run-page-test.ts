// A run's own page (mold_v0-256, flag record_pages), through its API (src/run-page.ts, mounted by src/view-routes.ts),
// offline: an embedded database, a fake sign-in, the fixture scripts/fixtures/packs/fixture_pages.
//   npm run test:run-page
//   1. Off (the default): /api/runs/<id>/page, /events, /rerun and /stop answer nothing (404); /api/runs/<id> as before.
//   2. The page of a running re-run of a build: its kind in the pack's words, the record it ran on, who started it, its
//      live cost (the gateway's meter while it runs) against its budget; its timeline (each event's level, source and
//      words, a secret's shape masked); the agent (harness, model, turns, tokens and cost by model); its tool calls
//      (input and output, masked); its results (required outputs, the checks); the files it wrote; the records it ran on,
//      checked and created.
//   3. Polling: the events since an id, and the run's state; a new event read on the next poll.
//   4. Who may: a viewer reads it but may neither re-run nor stop it (403); another workspace's run is not found.
//   5. Stop (cancel requested, asked again: nothing to stop once it ended) and Re-run (a new run of the same kind with
//      the same input, on the same record).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";
import { anthropicShaped } from "./lib/fake-secrets.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ok = (m: string) => console.log(`✓ ${m}`);
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages", "pack.json"), "utf8"));

try {
  const F = await import("../src/features.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  const ra = await import("../src/record-areas.js");
  const { getDb } = await import("../src/db.js");
  const { asPlatform } = await import("../src/tenant-scope.js");
  const db = await getDb();
  setPacksForTest([{ manifest: { id: "fixture_pages", name: "Fixture pages", version: "0.1.0", entry: null, migrations: null, words: {},
    dir: path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages") }, declared: compileDeclarations(FIXTURE) } as never]);
  const A = (await createOrg(`Run page A ${STAMP}`)).org, B = (await createOrg(`Run page B ${STAMP}`)).org;
  const http = await startHttp();
  const owner = await http.signIn(A, "owner"), member = await http.signIn(A, "member"), viewer = await http.signIn(A, "viewer"), ownerB = await http.signIn(B, "owner");
  const h = (tok: string) => ({ authorization: `Bearer ${tok}`, "x-pack-request": "1" });
  const get = async (tok: string, p: string) => { const r = await http.req("GET", p, h(tok)); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const post = async (tok: string, p: string, body: unknown = {}) => { const r = await http.req("POST", p, h(tok), body); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  F.setFeaturesForTest({ record_pages: true });
  const rec = ra.workspaceRecords("fixture_pages", A.orgId);
  await ra.asWriter({ by: "people", id: "seed" }, async () => {
    await rec.put("projects", "checkout", { title: "Checkout", data: { summary: "The payment pages" } });
    await rec.put("builds", "build-05", { title: "Build 05", data: { status: "queued", project: "checkout", branch: "main", commit: "c0ffee05" } });
  });
  await rec.move("builds", "build-05", "running"); await rec.move("builds", "build-05", "failed");
  const started = await post(member, "/api/records/_page/builds/build-05/actions/start_run.rebuild", { input: { build: "build-05", branch: "main", commit: "c0ffee05" } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const id: string = started.body.run.id;
  // The runner's side, as it would write it: claimed, running, its events, its spend, a result, a record it created.
  const SECRET = anthropicShaped();
  await asPlatform(async () => {
    await db.query("UPDATE runs SET status = 'running', attempt = 1, started_at = now() - interval '90 seconds' WHERE id = $1", [id]);
    const ev = (type: string, data: unknown) => db.query("INSERT INTO run_events (run_id, org_id, attempt, type, data) VALUES ($1, $2, 1, $3, $4)", [id, A.orgId, type, JSON.stringify(data)]);
    await ev("claimed", { worker_id: "runner-1" });
    await ev("step_log", { step: "install", line: "WARN 3 packages are deprecated" });
    await ev("step_log", { step: "test", line: `FAIL payments/refund.spec (key ${SECRET})` });
    await ev("tool_call", { name: "read_file", input: { path: "src/refund.ts", auth: `Bearer ${"x".repeat(24)}` }, output: { lines: 120 }, ms: 40 });
    await ev("tool.run_tests", { input: { suite: "payments" }, error: "4 failed" });
    await ev("agent_usage", { turns: 9, model: "model-large", models: { "model-large": { provider: "anthropic", requests: 22, input_tokens: 182000, output_tokens: 9100, cost_usd: 0.39 }, "model-small": { provider: "anthropic", requests: 5, input_tokens: 9000, output_tokens: 700, cost_usd: 0.03 } } });
    await ev("agent_output", { path: "results/report.json", size: 2100, sha256: "ab".repeat(32), json: { failed: 4 } });
    await ev("workspace_written", { version: 12, unchanged: false });
    await db.query("INSERT INTO gateway_usage (token_hash, provider, run_id, requests, input_tokens, output_tokens, cost_usd) VALUES ($1, 'anthropic', $2, 27, 191000, 9800, 0.42)", [`th-${id}`, id]);
    await db.query("INSERT INTO run_results (run_id, org_id, check_area, check_key, status, evidence_ref) VALUES ($1, $2, 'builds', 'build-05', 'fail', 'results/report.json')", [id, A.orgId]);
  });
  await ra.asWriter({ by: "run", id }, () => rec.put("builds", "build-77", { title: "Build 77", data: { status: "queued", project: "checkout", branch: "main" } }));

  // ---------- 1. off ----------
  F.setFeaturesForTest({ record_pages: false });
  for (const p of ["page", "events"]) assert.equal((await get(member, `/api/runs/${id}/${p}`)).status, 404, `off: /${p}`);
  for (const p of ["rerun", "stop"]) assert.equal((await post(member, `/api/runs/${id}/${p}`)).status, 404, `off: /${p}`);
  assert.equal((await get(member, `/api/runs/${id}`)).status, 200, "the run's own route as before");
  F.setFeaturesForTest({ record_pages: true });
  ok("off (the default): the run page's routes answer nothing (404); /api/runs/<id> as before");

  // ---------- 2. the page ----------
  let last = 0;
  {
    const r = await get(member, `/api/runs/${id}/page`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body;
    assert.deepEqual([d.run.label, d.run.status, d.run.by, d.run.record], ["Re-run a build", "running", "You", { area: "builds", key: "build-05", title: "Build 05" }], "its kind in words, running, by you, on its build");
    assert.equal(d.run.cost_usd, 0.42, "its live cost: the gateway's meter while it runs");
    assert.equal(d.run.budget_usd, 2, "against its budget");
    assert.deepEqual(d.can, { rerun: { disabled: null }, stop: { disabled: null } }, "a member may re-run it and stop it");
    const t = d.timeline.events;
    assert.deepEqual(t.map((e: any) => e.type), ["queued", "claimed", "step_log", "step_log", "agent_usage", "agent_output", "workspace_written"], "the timeline: its events in order (tool calls on their own tab)");
    assert.deepEqual(t.slice(2, 4).map((e: any) => [e.level, e.source]), [["warning", "install"], ["error", "test"]], "each line's level and source (a step's name)");
    assert.ok(!JSON.stringify(d).includes(SECRET) && /sk-ant-api03-\*\*\*/.test(t[3].message), "a secret's shape masked");
    last = d.timeline.last;
    assert.deepEqual([d.agent.harness, d.agent.models.includes("model-large"), d.agent.turns], ["node rebuild.mjs", true, 9], "the agent: harness, model, turns");
    assert.deepEqual(d.agent.usage.map((u: any) => [u.model, u.input_tokens, u.cost_usd]), [["model-large", 182000, 0.39], ["model-small", 9000, 0.03]], "tokens and cost by model (its own report)");
    assert.deepEqual(d.tools.map((x: any) => [x.name, x.error]), [["read_file", null], ["run_tests", "4 failed"]], "its tool calls");
    assert.match(JSON.stringify(d.tools[0].input), /Bearer \*\*\*/, "a tool call's input masked");
    assert.deepEqual(d.results.outputs, [{ pattern: "results/report.json", state: "pending" }], "a required output: not yet, while it runs");
    assert.deepEqual([d.results.counts, d.results.checks[0].check], [{ fail: 1 }, { area: "builds", key: "build-05" }], "the checks");
    assert.deepEqual([d.files.version, d.files.files[0].path, d.files.files[0].kind, d.files.files[0].preview], [12, "results/report.json", "output", { failed: 4 }], "the files it wrote");
    const rel = Object.fromEntries(d.related.map((x: any) => [x.key, x.how]));
    assert.deepEqual(rel, { "build-05": ["Ran on", "Checked"], "build-77": ["Created"] }, "the records it ran on, checked and created");
    ok("the page: its kind in words, running, by you, on its build, its live cost against its budget; its timeline (levels, sources, a secret masked); the agent (harness, model, turns, tokens and cost by model); its tool calls (masked); a required output not yet written, the checks; the files it wrote and the workspace's version; the records it ran on, checked and created");
  }

  // ---------- 3. polling ----------
  {
    const none = await get(member, `/api/runs/${id}/events?after=${last}`);
    assert.deepEqual([none.body.events, none.body.run.status], [[], "running"], "nothing new yet");
    await asPlatform(() => db.query("INSERT INTO run_events (run_id, org_id, attempt, type, data) VALUES ($1, $2, 1, 'step_log', $3)", [id, A.orgId, JSON.stringify({ step: "report", line: "wrote coverage.xml" })]));
    const next = await get(member, `/api/runs/${id}/events?after=${last}`);
    assert.deepEqual(next.body.events.map((e: any) => e.message), ["wrote coverage.xml"], "the next poll reads the new event");
    assert.ok(next.body.last > last);
    assert.equal((await get(member, `/api/runs/${id}/events?after=-1`)).status, 400);
    ok("polling: the events since an id and the run's state; a new event read on the next poll");
  }

  // ---------- 4. who may ----------
  {
    const v = await get(viewer, `/api/runs/${id}/page`);
    assert.equal(v.status, 200);
    assert.deepEqual(v.body.can, { rerun: null, stop: null }, "a viewer reads it, may neither re-run nor stop it");
    assert.equal((await post(viewer, `/api/runs/${id}/rerun`)).status, 403);
    assert.equal((await post(viewer, `/api/runs/${id}/stop`)).status, 403);
    assert.equal((await get(ownerB, `/api/runs/${id}/page`)).status, 404, "another workspace's run: not found");
    assert.equal((await post(ownerB, `/api/runs/${id}/stop`)).status, 404);
    assert.equal((await get(member, "/api/runs/run_nope/page")).status, 404);
    ok("who may: a viewer reads it but may not re-run or stop it (403); another workspace's run is not found");
  }

  // ---------- 5. stop and re-run ----------
  {
    const s = await post(member, `/api/runs/${id}/stop`);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.run.cancel_requested, true, "stop: asked for");
    assert.match((await get(member, `/api/runs/${id}/page`)).body.can.stop.disabled, /A stop was asked for/, "then said so");
    await asPlatform(() => db.query("UPDATE runs SET status = 'cancelled', ended_at = now() WHERE id = $1", [id]));
    assert.equal((await post(member, `/api/runs/${id}/stop`)).status, 409, "an ended run: nothing to stop");
    const again = await post(member, `/api/runs/${id}/rerun`);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const [row] = await db.query<{ kind: string; scope: Record<string, unknown>; record_area: string; record_key: string }>("SELECT kind, scope, record_area, record_key FROM runs WHERE id = $1", [again.body.run.id]);
    assert.deepEqual([row!.kind, row!.scope, row!.record_area, row!.record_key], ["rebuild", { build: "build-05", branch: "main", commit: "c0ffee05" }, "builds", "build-05"], "re-run: the same kind and input, on the same record");
    ok("stop: asked for (said so after), refused once the run ended; re-run: a new run of the same kind with the same input, on the same record");
  }
  F.setFeaturesForTest(null);
  await http.close();
} finally {
  cleanup();
}
process.exit(0);
