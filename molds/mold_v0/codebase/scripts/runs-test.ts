// The generic run engine (mold_v0-041; src/runs.ts, src/run-harness.ts, src/run-routes.ts), offline: an embedded
// database, a fake model upstream behind the real gateway, fixture job kinds (scripts/fixtures/runs/*.mjs).
//   npm run test:runs
//
//  1. Zero packs: no job kinds; nothing to claim.
//  2. definePack refuses kinds that would get past the engine (an entry outside the pack, a port or an address in egress).
//  3. A fixture kind's run, started by the pack's own tool for the calling workspace, goes through claim, events,
//     heartbeat and complete; its results link a check, an asset and a source record; its program sees no server secret.
//  4. Cost per run is its gateway usage (gateway_usage.run_id); the token lives the kind's lifetime (four hours here) and
//     the attempt's deadline is the token's expiry, so it never expires mid-run; the session default (90 min) would.
//  5. Retry on infrastructure failure (exit 75), up to max_attempts; a run's own failure and a failed validation are final.
//  6. Cancel: a queued run ends at once; a running one stops spending at once and stops at its next heartbeat.
//  7. Leases: a lapsed lease is swept and the run claimed again; the old lease can neither heartbeat, write nor complete.
//  8. Budget: the gateway refuses a run's requests once its cost reaches the kind's budget, across attempts.
//  9. Egress: each run's proxy refuses every host not on that run's list (probe), and lets its own hosts past the list.
// 10. Workspaces: a run cannot name another workspace's records in its results; a workspace sees only its own runs; the
//     row-level security check and probe pass. The worker API needs the fleet token and the lease token (HTTP runner).
// 11. Isolation: the run's programs as a user of their own.
// 12. A run program that starts processes (mold_v0-054): they run as the run's user and die with the run.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp } from "./lib/test-world.js";
import { ENV } from "../src/env-names.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUNS_DIR = path.join(ROOT, "scripts", "fixtures", "runs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack, defineTool, z } = await import("../src/pack-api.js");
  const runs = await import("../src/runs.js");
  const harness = await import("../src/run-harness.js");
  const rec = await import("../src/record-areas.js");
  const { tokenRefusal } = await import("../src/gateway.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const A = (await createOrg(`Runs A ${STAMP}`)).org, B = (await createOrg(`Runs B ${STAMP}`)).org;

  // ---------- 1. zero packs ----------
  assert.deepEqual(runs.jobKinds(), [], "no packs, no job kinds");
  assert.equal(await runs.claimRun("w-zero"), null, "nothing to claim");
  console.log("✓ zero packs: no job kinds, nothing to claim");

  // ---------- 2. definePack refuses kinds that would get past the engine ----------
  {
    const kind = (extra: Record<string, unknown>) => definePack({ id: "pk", jobKinds: [{ name: "kk", runner: "workspace-harness", entry: "run.mjs", ...extra } as never] });
    assert.throws(() => kind({ entry: "../outside.mjs" }), /inside the pack/);
    assert.throws(() => kind({ entry: "/etc/passwd.mjs" }), /inside the pack/);
    assert.throws(() => kind({ runner: "shell" }), /jobKinds\[0\]: runner/);
    assert.throws(() => kind({ egress: ["api.example.com:8443"] }), /HTTPS on port 443/);
    assert.throws(() => kind({ egress: ["10.0.0.5"] }), /a host name/);
    assert.throws(() => kind({ token_lifetime_seconds: 30 }), /token_lifetime_seconds/);
    assert.doesNotThrow(() => kind({ egress: ["*.example.com", "api.example.org"] }));
    console.log("✓ definePack refuses entries outside the pack, other runners, ports and addresses in egress, too-short tokens");
  }

  // ---------- the fixture pack ----------
  const kinds = [
    { name: "audit", runner: "workspace-harness", entry: "ok.mjs", providers: ["anthropic"], token_lifetime_seconds: 4 * 3600, lease_seconds: 15, budget_usd: 1, egress: ["api.allowed.example"] },
    { name: "plain", runner: "workspace-harness", entry: "ok.mjs", lease_seconds: 15 },
    { name: "flaky", runner: "workspace-harness", entry: "flaky.mjs", max_attempts: 3 },
    { name: "broken_infra", runner: "workspace-harness", entry: "infra.mjs", max_attempts: 2 },
    { name: "failing", runner: "workspace-harness", entry: "fail.mjs" },
    { name: "rejected", runner: "workspace-harness", entry: "ok.mjs", validator: "reject.mjs" },
    { name: "slow", runner: "workspace-harness", entry: "slow.mjs", providers: ["anthropic"], lease_seconds: 15 },
    { name: "costly", runner: "workspace-harness", entry: "ok.mjs", providers: ["anthropic"], budget_usd: 0.1 },
    { name: "probe_one", runner: "workspace-harness", entry: "egress.mjs", egress: ["one.allowed.example"] },
    { name: "probe_two", runner: "workspace-harness", entry: "egress.mjs", egress: ["*.two.example"] },
    { name: "isolation", runner: "workspace-harness", entry: "isolation.mjs" },
    { name: "spawner", runner: "workspace-harness", entry: "spawner.mjs" },
  ];
  const fixture = definePack({
    id: "fixture_runs",
    recordAreas: [
      { name: "run_sources", label: "Sources", role: "source", scope: "platform", fields: [{ name: "body", label: "Body" }] },
      { name: "run_checks", label: "Checks", role: "check", scope: "platform", fields: [{ name: "summary", label: "Summary" }] },
      { name: "run_apps", label: "Applications", role: "asset", scope: "workspace", fields: [{ name: "url", label: "Address" }] },
    ],
    jobKinds: kinds as never,
    tools: [
      defineTool({ name: "fixture_start_run", description: "Start a run (test).", inputSchema: { kind: z.string(), targets: z.record(z.string(), z.unknown()).optional(), scope: z.record(z.string(), z.unknown()).optional() },
        handler: async (_ws, { kind, targets, scope }, { runs: r }) => r.start(kind, { targets, scope }) }),
      defineTool({ name: "fixture_cancel_run", description: "Cancel a run (test).", inputSchema: { id: z.string() }, handler: async (_ws, { id }, { runs: r }) => r.cancel(id) }),
      defineTool({ name: "fixture_run_results", description: "A run's results (test).", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true },
        handler: async (_ws, { id }, { runs: r }) => ({ run: await r.get(id), results: await r.results(id) }) }),
    ],
  });
  setPacksForTest([{ manifest: { id: "fixture_runs", name: "Fixture runs", version: "1", entry: "index.ts", migrations: null, words: {}, dir: RUNS_DIR }, definition: fixture }]);
  await rec.putPlatform(null, "run_sources", "s1", { title: "Keep logs", data: { body: "a year" } });
  await rec.putPlatform(null, "run_checks", "c1", { title: "Retention", data: { summary: "logs kept" } });
  await withTenant(A.orgId, () => rec.workspaceRecords("fixture_runs", A.orgId).put("run_apps", "app-a", { title: "A's app", data: { url: "https://a.example" } }));
  await withTenant(B.orgId, () => rec.workspaceRecords("fixture_runs", B.orgId).put("run_apps", "app-b", { title: "B's app", data: { url: "https://b.example" } }));

  // The gateway, with a fake model upstream that reports usage, and a price for its model.
  const upstream = createServer((req, res) => {
    req.resume().on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message_start\ndata: {"type":"message_start","message":{"model":"fixture-model","usage":{"input_tokens":120,"output_tokens":1}}}\n\n`);
      res.end(`event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":30}}\n\n`);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const http = await startHttp();
  process.env.PUBLIC_URL = http.base; // the gateway's address, as the runs' programs reach it
  const kv = await import("../src/keyvault.js");
  await kv.upsertProvider({ slug: "anthropic", mode: "gateway", enabled: true, upstream_url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, auth_header: "x-api-key", auth_prefix: "", env_vars: ["ANTHROPIC_API_KEY"] });
  await kv.setCredential("anthropic", "sk-fixture-real-key");
  await db.query(`INSERT INTO model_prices (model, input_per_mtok, cached_input_per_mtok, output_per_mtok) VALUES ('fixture-model', 500, 50, 2000)
                  ON CONFLICT (model) DO UPDATE SET input_per_mtok = 500, output_per_mtok = 2000`);
  const ca = await connect(A), cb = await connect(B);
  const start = async (c: typeof ca, kind: string, input: Record<string, unknown> = {}) => {
    const r = await c.call("fixture_start_run", { kind, ...input });
    assert.ok(!r.isError, `start ${kind}: ${r.content[0]?.text}`);
    return r.structuredContent as { id: string; status: string };
  };
  const client = await harness.localRunnerClient("w-local");
  const runOne = async (kinds: string[], opts: Parameters<typeof harness.runWorkspaceHarness>[2] = {}) => {
    const c = await client.claim(kinds);
    assert.ok(c, `a run of ${kinds.join(", ")} to claim`);
    return { claim: c!, view: await harness.runWorkspaceHarness(client, c!, { allowSameUser: true, egress: "off", ...opts }) };
  };
  const row = async (id: string) => (await db.query<any>("SELECT * FROM runs WHERE id = $1", [id]))[0];
  const eventsOf = async (id: string) => db.query<{ type: string; data: any; attempt: number }>("SELECT type, data, attempt FROM run_events WHERE run_id = $1 ORDER BY id", [id]);

  try {
    // ---------- 3 and 4. the lifecycle, cost, token lifetime ----------
    {
      const started = await start(ca, "audit", { targets: { asset: "app-a" } });
      assert.equal(started.status, "queued");
      assert.equal((await row(started.id)).org_id, A.orgId, "the run is the caller's workspace's");
      const claim = await client.claim(["fixture_runs/audit"]);
      assert.ok(claim && claim.run.id === started.id && claim.run.attempt === 1 && claim.lease_token.startsWith("orl_"));
      assert.ok(claim.gateway.env.ANTHROPIC_BASE_URL === `${http.base}/gw/anthropic` && claim.gateway.env.ANTHROPIC_API_KEY.startsWith("ogw_"), "gateway env for the kind's provider");
      assert.ok(!JSON.stringify(claim).includes("sk-fixture-real-key"), "the real provider key never reaches a run");
      assert.deepEqual(claim.egress.hosts, ["api.allowed.example"], "the run's egress list (the local gateway is an address, never listed)");
      // The token lives the kind's lifetime; the attempt's deadline is its expiry.
      const [tok] = await db.query<{ expires_at: Date; created_at: Date; revoked_at: Date | null; kind: string }>("SELECT expires_at, created_at, revoked_at, kind FROM gateway_tokens WHERE run_id = $1", [claim.run.id]);
      const life = (new Date(tok!.expires_at).getTime() - new Date(tok!.created_at).getTime()) / 1000;
      assert.ok(tok!.kind === "run" && Math.abs(life - 4 * 3600) < 10, `a four-hour token (${life}s)`);
      assert.equal(new Date(tok!.expires_at).getTime(), new Date(claim.deadline_at).getTime(), "the attempt's deadline is the token's expiry: the run is stopped before its token can expire");
      const at = (s: number) => new Date(new Date(tok!.created_at).getTime() + s * 1000);
      assert.equal(tokenRefusal(tok, at(3 * 3600 + 59 * 60)), null, "usable 3 h 59 min into the run");
      assert.equal(tokenRefusal({ ...tok!, expires_at: at(90 * 60) }, at(3 * 3600 + 59 * 60)), "expired", "a session-lifetime token (90 min) would have expired mid-run");
      assert.equal(tokenRefusal(tok, at(4 * 3600 + 60)), "expired", "and it does expire after the deadline");
      const view = await harness.runWorkspaceHarness(client, claim, { allowSameUser: true, egress: "off" });
      assert.equal(view?.status, "succeeded", `succeeded: ${JSON.stringify(view)}`);
      const ev = await eventsOf(claim.run.id);
      assert.deepEqual(ev.filter((e) => ["queued", "claimed", "succeeded"].includes(e.type)).map((e) => e.type), ["queued", "claimed", "succeeded"], "lifecycle events");
      assert.ok(ev.some((e) => e.type === "log" && e.data.line === "plain log line"), "stdout lines are events");
      assert.deepEqual(ev.find((e) => e.type === "gateway")?.data.statuses, [200], "the program reached the model through the gateway");
      const keys: string[] = ev.find((e) => e.type === "env")!.data.keys;
      for (const secret of ["DATABASE_URL", "APP_VAULT_KEY", "APP_WORKER_TOKEN", "CLERK_SECRET_KEY", "PGLITE_DIR", "R2_SECRET_ACCESS_KEY"])
        assert.ok(!keys.includes(secret), `the run's program does not see ${secret}`);
      // Cost per run: its gateway usage. 120 in x $500/M + 30 out x $2000/M = $0.12.
      const [u] = await db.query<{ cost: number }>("SELECT sum(cost_usd)::float AS cost FROM gateway_usage WHERE run_id = $1", [claim.run.id]);
      assert.ok(Math.abs(u!.cost - 0.12) < 1e-6, `metered per run: ${u!.cost}`);
      assert.ok(Math.abs(view!.cost_usd - 0.12) < 1e-6, "the run's cost is its gateway usage");
      const [after] = await db.query<{ revoked_at: Date | null }>("SELECT revoked_at FROM gateway_tokens WHERE run_id = $1", [claim.run.id]);
      assert.ok(after!.revoked_at, "the token is revoked when the run ends");
      const res = (await ca.call("fixture_run_results", { id: claim.run.id })).structuredContent;
      assert.deepEqual(res.results, [{ check: { area: "run_checks", key: "c1" }, asset: { area: "run_apps", key: "app-a" }, source: { area: "run_sources", key: "s1" },
        status: "fail", finding_fingerprint: "c1:app:retention", evidence_ref: "evidence/logs.txt", detail: { note: "short retention" } }], "a result links a check, an asset and a source");
      console.log("✓ a fixture run: started for its workspace, claimed, events, completed with results (check x asset x source); no server secret in its environment");
      console.log("✓ cost per run from gateway usage ($0.12); a 4-hour token, deadline = expiry, usable at 3 h 59 min (a 90-min token would not be)");
    }

    // ---------- 5. retry on infrastructure failure; final failures ----------
    {
      const f = await start(ca, "flaky");
      const first = await runOne(["fixture_runs/flaky"]);
      assert.deepEqual([first.view?.status, first.view?.attempt, first.view?.error_kind], ["queued", 1, "infrastructure"], "exit 75: queued again");
      const second = await runOne(["fixture_runs/flaky"]);
      assert.deepEqual([second.claim.run.id, second.view?.status, second.view?.attempt], [f.id, "succeeded", 2], "the second attempt succeeds");
      assert.ok((await eventsOf(f.id)).some((e) => e.type === "retry"), "the retry is an event");
      const b = await start(ca, "broken_infra");
      await runOne(["fixture_runs/broken_infra"]);
      const last = await runOne(["fixture_runs/broken_infra"]);
      assert.deepEqual([last.claim.run.id, last.view?.status, last.view?.attempt], [b.id, "failed", 2], "failed once its attempts are spent");
      assert.equal(await client.claim(["fixture_runs/broken_infra"]), null);
      await start(ca, "failing");
      const failed = await runOne(["fixture_runs/failing"]);
      assert.deepEqual([failed.view?.status, failed.view?.error_kind, failed.view?.attempt], ["failed", "run", 1], "a run's own failure is not retried");
      assert.ok((await eventsOf(failed.claim.run.id)).some((e) => e.type === "stderr" && /could not be completed/.test(e.data.tail)), "its stderr is kept");
      await start(ca, "rejected", { targets: { asset: "app-a" } });
      const rejected = await runOne(["fixture_runs/rejected"]);
      assert.deepEqual([rejected.view?.status, rejected.view?.error_kind], ["failed", "validation"], "a failed validation fails the run");
      assert.equal((await db.query("SELECT 1 FROM run_results WHERE run_id = $1", [rejected.claim.run.id])).length, 0, "and writes no result");
      console.log("✓ retry on infrastructure failure (exit 75) up to max_attempts; run failures and failed validations are final");
    }

    // ---------- 6. cancel ----------
    {
      const q = await start(ca, "plain");
      const cq = await ca.call("fixture_cancel_run", { id: q.id });
      assert.equal(cq.structuredContent.status, "cancelled", "a queued run ends at once");
      assert.equal(await client.claim(["fixture_runs/plain"]), null, "and is never claimed");
      const notMine = await cb.call("fixture_cancel_run", { id: q.id });
      assert.ok(notMine.isError && /no such run/.test(notMine.content[0]!.text), "another workspace cannot cancel it (or see it)");
      const s = await start(ca, "slow");
      const claim = (await client.claim(["fixture_runs/slow"]))!;
      const beats: { cancel: boolean }[] = [];
      const running = harness.runWorkspaceHarness(client, claim, { allowSameUser: true, egress: "off", onHeartbeat: (h) => beats.push(h) });
      await sleep(1500);
      const tokenBefore = claim.gateway.env.ANTHROPIC_API_KEY!;
      const gw = () => fetch(`${http.base}/gw/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": tokenBefore, "content-type": "application/json" }, body: "{}" });
      assert.equal((await gw()).status, 200, "the running run's token works");
      const t0 = Date.now();
      assert.equal((await ca.call("fixture_cancel_run", { id: s.id })).structuredContent.cancel_requested, true);
      assert.equal((await gw()).status, 401, "a cancelled run stops spending at once (its token is refused)");
      const v = await running;
      assert.equal(v?.status, "cancelled", "the runner stopped at its next heartbeat");
      assert.ok(Date.now() - t0 < 15_000 && beats.some((b) => b.cancel), `within one heartbeat interval (${Date.now() - t0} ms)`);
      console.log("✓ cancel: a queued run ends at once; a running run's token is refused at once and the runner stops at its next heartbeat");
    }

    // ---------- 7. leases ----------
    {
      const r = await start(ca, "plain", { targets: { asset: "app-a" } });
      const c1 = (await client.claim(["fixture_runs/plain"]))!;
      assert.equal(c1.run.id, r.id);
      assert.equal(await client.claim(["fixture_runs/plain"]), null, "a running run is not claimed twice");
      await assert.rejects(runs.heartbeatRun(r.id, "orl_forged"), /lease is not yours/, "a forged lease token is refused");
      await db.query("UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [r.id]);
      const c2 = (await client.claim(["fixture_runs/plain"]))!;
      assert.deepEqual([c2.run.id, c2.run.attempt], [r.id, 2], "a lapsed lease is swept and the run claimed again");
      assert.ok((await eventsOf(r.id)).some((e) => e.type === "retry" && e.data.reason === "lease lapsed"));
      await assert.rejects(runs.heartbeatRun(r.id, c1.lease_token), /lease is not yours/, "the old lease cannot heartbeat");
      await assert.rejects(runs.appendRunEvents(r.id, c1.lease_token, [{ type: "x" }]), /lease is not yours/, "nor write events");
      await assert.rejects(runs.completeRun(r.id, c1.lease_token, { outcome: "succeeded", results: [] }), /lease is not yours/, "nor complete it");
      const done = await harness.runWorkspaceHarness(client, c2, { allowSameUser: true, egress: "off" });
      assert.equal(done?.status, "succeeded", "the new attempt completes");
      await assert.rejects(runs.completeRun(r.id, c2.lease_token, { outcome: "failed" }), /lease is not yours/, "a run completes once");
      // Two claims at the same moment for one queued run: exactly one gets it.
      await start(ca, "plain");
      const both = await Promise.all([client.claim(["fixture_runs/plain"]), client.claim(["fixture_runs/plain"])]);
      assert.equal(both.filter(Boolean).length, 1, "one of two simultaneous claims wins");
      const won = both.find(Boolean)!;
      await runs.completeRun(won.run.id, won.lease_token, { outcome: "failed", error_kind: "run", error: "test" });
      console.log("✓ leases: a lapsed lease is swept and re-claimed; the old lease token can neither heartbeat, write nor complete; one claim wins");
    }

    // ---------- 8. budget ----------
    {
      const r = await start(ca, "costly", { targets: { asset: "app-a", calls: 3 } });
      const { view } = await runOne(["fixture_runs/costly"]);
      const ev = await eventsOf(r.id);
      assert.deepEqual(ev.find((e) => e.type === "gateway")?.data.statuses, [200, 429, 429], "the gateway refuses once the run's cost ($0.12) reaches its budget ($0.10)");
      assert.ok(Math.abs(view!.cost_usd - 0.12) < 1e-6, "one request was metered");
      console.log("✓ budget: the gateway refuses a run's requests once its cost reaches the kind's budget");
    }

    // ---------- 9. egress: each run's own allowlist ----------
    {
      const tryHosts = ["one.allowed.example:443", "deep.two.example:443", "unlisted.example:443", "1.1.1.1:443", "one.allowed.example:80"];
      const probe = async (kind: string) => {
        const r = await start(ca, kind, { scope: { try: tryHosts } });
        let log = "";
        const { view } = await runOne([`fixture_runs/${kind}`], { egress: "proxy", onProxyLog: (l) => (log = l) });
        assert.equal(view?.status, "succeeded", `${kind}: ${JSON.stringify(view)}`);
        const e = (await eventsOf(r.id)).find((x) => x.type === "egress")!.data;
        assert.equal(e.proxy, true, "the run's program got proxy settings");
        const decisions = log.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
        const why = (h: string) => decisions.filter((d) => d.deny?.startsWith(h) || d.allow === h.split(":")[0]).map((d) => d.allow ? "allowed" : d.why);
        return { answers: e.answers as Record<string, string>, why };
      };
      const one = await probe("probe_one"), two = await probe("probe_two");
      for (const [p, mine, other] of [[one, "one.allowed.example:443", "deep.two.example:443"], [two, "deep.two.example:443", "one.allowed.example:443"]] as const) {
        assert.ok(p.why(mine).length > 0 && !p.why(mine).includes("host not allowed"), `${mine}: passes its run's allowlist (then ${p.why(mine).join(",")})`);
        if (process.env.RUNS_TEST_VERBOSE) console.log(`  ${mine}: ${p.why(mine).join(",")}; ${other}: ${p.why(other).join(",")}`);
        assert.match(p.answers[other]!, /^HTTP\/1\.1 403/, `${other}: refused, another run's host`);
        assert.ok(p.why(other).includes("host not allowed"), `${other}: refused by the allowlist`);
        assert.match(p.answers["unlisted.example:443"]!, /^HTTP\/1\.1 403/);
        assert.ok(p.why("unlisted.example:443").includes("host not allowed"), "an unlisted host is refused by the allowlist");
        assert.match(p.answers["1.1.1.1:443"]!, /^HTTP\/1\.1 403/, "an address is refused");
        assert.match(p.answers["one.allowed.example:80"]!, /^HTTP\/1\.1 403/, "a port other than 443 is refused");
      }
      console.log("✓ egress: each run's proxy refuses every host not on its own list (another run's, unlisted, an address, port 80) and lets its own past the list");
    }

    // ---------- 10. workspaces; the worker API ----------
    {
      // A's run cannot name B's application, nor an asset that does not exist, nor a check in a non-check area.
      const bad = async (results: unknown[], re: RegExp) => {
        const r = await start(ca, "plain", { targets: { results } });
        const { view } = await runOne(["fixture_runs/plain"]);
        assert.equal(view?.status, "failed");
        assert.match(view!.error!, re);
        assert.equal((await db.query("SELECT 1 FROM run_results WHERE run_id = $1", [r.id])).length, 0);
      };
      await bad([{ check: { area: "run_checks", key: "c1" }, asset: { area: "run_apps", key: "app-b" }, status: "fail" }], /no asset record app-b in run_apps for this run's workspace/);
      await bad([{ check: { area: "run_apps", key: "app-a" }, status: "pass" }], /run_apps is not a check area/);
      await bad([{ check: { area: "run_checks", key: "c1" }, status: "maybe" }], /result status/);
      // The review's case: a result listed twice used to break the unique index and leave the run "running".
      const twice = { check: { area: "run_checks", key: "c1" }, asset: { area: "run_apps", key: "app-a" }, status: "pass" };
      await bad([twice, twice], /listed twice/);
      // B's run with B's own asset is fine; A cannot see it.
      const rb = await start(cb, "plain", { targets: { asset: "app-b" } });
      assert.equal((await runOne(["fixture_runs/plain"])).view?.status, "succeeded");
      assert.equal(await runs.getRun(A.orgId, rb.id), null, "A cannot read B's run");
      const seen = await withTenant(A.orgId, () => db.query<{ org_id: number }>("/* tenant: test */ SELECT DISTINCT org_id FROM runs UNION SELECT DISTINCT org_id FROM run_results UNION SELECT DISTINCT org_id FROM run_events"));
      assert.deepEqual(seen.map((x) => x.org_id), [A.orgId], "the tenant role sees only its own runs, results and events");
      const peek = await ca.call("fixture_run_results", { id: rb.id });
      assert.ok(peek.isError, "A's tool cannot read B's results");
      const { rlsCatalogProblems, rlsProbe } = await import("../src/rls.js");
      assert.deepEqual(await rlsCatalogProblems(db), []);
      const probe = await rlsProbe(db);
      assert.deepEqual(probe.problems, [], "the live probe passes with the run tables");
      // The worker API: fleet token, then the lease token; a whole run over HTTP.
      const W = ENV.APP_WORKER_TOKEN!;
      const post = (p: string, body: unknown, h: Record<string, string> = {}) => http.req("POST", `/api/worker/runs${p}`, h, body);
      assert.equal((await post("/claim", { worker_id: "w" })).status, 401, "no worker token");
      assert.equal((await post("/claim", { worker_id: "w" }, { authorization: "Bearer owk_forged" })).status, 401, "a forged one");
      const viaHttp = harness.httpRunnerClient(http.base, W, "w-http");
      const rh = await start(ca, "plain", { targets: { asset: "app-a" } });
      const ch = (await viaHttp.claim(["fixture_runs/plain"]))!;
      assert.equal(ch.run.id, rh.id);
      assert.equal((await post(`/${rh.id}/heartbeat`, {}, { authorization: `Bearer ${W}` })).status, 409, "no lease token: refused");
      assert.equal((await post(`/${rh.id}/heartbeat`, {}, { authorization: `Bearer ${W}`, "x-run-lease": "orl_forged" })).status, 409, "a forged lease: refused");
      const vh = await harness.runWorkspaceHarness(viaHttp, ch, { allowSameUser: true, egress: "off" });
      assert.equal(vh?.status, "succeeded", "a run carried out over the worker API");
      assert.equal((await db.query("SELECT 1 FROM run_results WHERE run_id = $1", [rh.id])).length, 1);
      // A workspace cannot fill the queue: at most APP_RUNS_MAX_LIVE_PER_WORKSPACE runs queued or running.
      process.env.APP_RUNS_MAX_LIVE_PER_WORKSPACE = "3";
      for (let i = 0; i < 3; i++) await start(cb, "failing");
      const over = await cb.call("fixture_start_run", { kind: "failing" });
      assert.ok(over.isError && /already has 3 runs/.test(over.content[0]!.text), `the per-workspace cap: ${over.content[0]?.text}`);
      assert.ok(!(await ca.call("fixture_start_run", { kind: "failing" })).isError, "another workspace is not held to it");
      delete process.env.APP_RUNS_MAX_LIVE_PER_WORKSPACE;
      while (await client.claim(["fixture_runs/failing"]).then(async (c) => c && (await harness.runWorkspaceHarness(client, c, { allowSameUser: true, egress: "off" }), true))) { /* drain */ }
      // Deleting a workspace takes its runs.
      await db.query("DELETE FROM organizations WHERE id = $1", [B.orgId]);
      assert.equal((await db.query("SELECT 1 FROM runs WHERE org_id = $1", [B.orgId])).length, 0, "a deleted workspace's runs go with it");
      console.log("✓ a run listing a result twice fails cleanly (not stuck); one workspace cannot queue more than its cap");
      console.log(`✓ workspaces: results cannot name another workspace's records; runs are each workspace's own (probe ${probe.checked} checks); worker API: fleet token + lease token, a run over HTTP`);
    }
    // ---------- 11. isolation: the run's programs as a user of their own ----------
    {
      const r = await start(ca, "isolation");
      const c = (await client.claim(["fixture_runs/isolation"]))!;
      if (process.getuid?.() === 0) {
        // A runner started as root runs every run as a user of the run's own by default (mold_v0-078), never as root.
        assert.equal(harness.runIsolation({})?.mode, "pool", "as root, the default is a run user leased per run");
        await assert.rejects(harness.runWorkspaceHarness(client, c, { egress: "off", runAs: { uid: 0, gid: 0 } }), /other than root/, "never root itself");
      } else {
        await assert.rejects(harness.runWorkspaceHarness(client, c, { egress: "off" }), /only as a run user of their own/, "the harness refuses to run a program as its own user unless told");
        await assert.rejects(harness.drainRuns(client, { egress: "off" }), /only as a run user of their own/, "a runner loop refuses before claiming anything");
      }
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const probe = async (opts: Parameters<typeof harness.runWorkspaceHarness>[2]) => {
        await db.query("UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [r.id]);
        const cc = (await client.claim(["fixture_runs/isolation"]))!;
        assert.equal(cc.run.id, r.id);
        const v = await harness.runWorkspaceHarness(client, cc, { egress: "off", ...opts });
        const e = (await db.query<{ data: any }>("SELECT data FROM run_events WHERE run_id = $1 AND type = 'isolation' ORDER BY id DESC LIMIT 1", [r.id]))[0]!.data;
        return { v, e };
      };
      // Same user (what the review showed): the program reads the runner's environment and leaves a process behind.
      // (/proc/<pid>/environ is the environment the runner started with: on a server, its database URL and vault key.)
      const same = await probe({ allowSameUser: true });
      assert.ok(Array.isArray(same.e.environ) && same.e.environ.includes("PATH"), "as the runner's own user, /proc/<runner>/environ is readable (why the harness refuses it by default)");
      const leftover = same.e.grandchild as number;
      assert.ok(alive(leftover), "and a process in its own session outlives the run");
      process.kill(leftover, "SIGKILL");
      await db.query("UPDATE runs SET status = 'queued', ended_at = NULL WHERE id = $1", [r.id]);
      if (process.getuid?.() === 0) {
        // As root the harness's default: a user of the run's own, leased for it (mold_v0-078).
        const iso = await probe({});
        assert.equal(iso.v?.status, "succeeded", JSON.stringify(iso.v));
        const ru = (await db.query<{ data: any }>("SELECT data FROM run_events WHERE run_id = $1 AND type = 'run_user' ORDER BY id DESC LIMIT 1", [r.id]))[0]!.data.uid;
        assert.ok(ru > 0 && ru !== process.getuid!() && iso.e.uid === ru, "the program ran as the run's own user");
        assert.equal(iso.e.environ, "EACCES", "it cannot read the runner's environment");
        assert.ok(!alive(iso.e.grandchild), "and nothing it started outlives the run");
        console.log("✓ isolation: as a separate user the program cannot read the runner's environment and leaves nothing running; the harness refuses to run as its own user unless told");
      } else console.log("- isolation as a separate user: skipped (needs a runner started as root); the default refusal is checked");
    }
    // ---------- 12. a run program that starts processes (mold_v0-054) ----------
    {
      const r = await start(ca, "spawner");
      const c = (await client.claim(["fixture_runs/spawner"]))!;
      assert.equal(c.run.id, r.id);
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const asRoot = process.getuid?.() === 0;
      const v = await harness.runWorkspaceHarness(client, c, { egress: "off", ...(asRoot ? {} : { allowSameUser: true }) });
      assert.equal(v?.status, "succeeded", JSON.stringify(v));
      const e = (await db.query<{ data: any }>("SELECT data FROM run_events WHERE run_id = $1 AND type = 'spawned'", [r.id]))[0]!.data;
      const want = asRoot ? (await db.query<{ data: any }>("SELECT data FROM run_events WHERE run_id = $1 AND type = 'run_user'", [r.id]))[0]!.data.uid : process.getuid!();
      assert.deepEqual([e.uid, e.node_child_uid, e.sh_child_uid], [want, want, want], "the program and every process it starts run as the run's user");
      if (asRoot) assert.ok(!alive(e.left_behind), "and none outlives the run");
      else process.kill(e.left_behind, "SIGKILL");
      console.log(`✓ a run program starts processes (node and a shell) as the run's user${asRoot ? " (its own, leased for it), and none outlives the run" : ""}`);
    }
  } finally {
    await ca.close(); await cb.close();
    await http.close();
    upstream.close();
  }
  await db.close();
  console.log("RUNS TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
