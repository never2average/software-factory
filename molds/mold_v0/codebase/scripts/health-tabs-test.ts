// The staff console's Health tabs beside Errors (mold_v0-204, src/health-tabs.ts, src/scheduler-jobs.ts), offline: an
// embedded database, the module called as its routes call it.
//   npm run test:health-tabs
//
//   1. safeError: an address, a link, a bearer credential and anything key-like never reach the console
//   2. tracked: a job's success and failure (thrown, or a `{ error }` report) are kept with their times and counts; the
//      job's own result and error are handed back unchanged; a success is written at most every 30 s per process
//   3. Scheduled work lists only the jobs this build runs (zero packs: none), with last run, success, lag and error
//   4. Runs: by kind (agent or not), failures by error kind (output_missing included), the refused-and-retried runs
//      (mold_v0-189) and how they ended, durations, cost, the recent failed runs (no address in an error) and one run's
//      events (figures only: who asked is never shown)
//   5. Deliveries: emails by kind and status (never an address or a subject), webhook deliveries by status, endpoints
//      switched off (never their address)
//   6. Status: database, the row-level security probe, object storage, the key vault and the Claude provider, the last
//      migration and the release; never a key's value
//   7. Status history (mold_v0-210, src/health-samples.ts, 0038_health_samples): a sample is taken (runs ended and
//      failed, the Claude provider's refusals and errors, deliveries, the API's latency in this process), at most every
//      4 minutes across processes; samples older than 35 days are pruned; the history is bucketed per range (24h, 7d,
//      30d), an uptime band, the Claude counters as differences; the table holds only numbers and states (no text but
//      two enumerated states), is closed to tenant work and read only by the staff routes
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { cleanup, STAMP } from "./lib/test-world.js";

const DAY = 86_400_000;
const ago = (days: number, mins = 0) => new Date(Date.now() - days * DAY - mins * 60_000).toISOString();
let failures = 0;
const ok = (m: string) => console.log(`ok - ${m}`);

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const { createOrg } = await import("../src/auth.js");
  const jobsMod = await import("../src/scheduler-jobs.js");
  const h = await import("../src/health-tabs.js");

  // ---------- 1. safeError ----------
  const cleaned = jobsMod.safeError(new Error("send to jane.doe@example.org failed: https://hooks.example.org/x?token=abc Bearer sk-live-123 key AKIAABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
  assert.ok(!/jane|example\.org|token=|sk-live|AKIA/.test(cleaned), cleaned);
  assert.match(cleaned, /<address>/); assert.match(cleaned, /<https link>/); assert.match(cleaned, /<credential>/); assert.match(cleaned, /<redacted>/);
  assert.ok(jobsMod.safeError("x".repeat(1000)).length <= 300);
  ok("safeError: no address, link, bearer credential or key-like text; at most 300 characters");

  // ---------- 2. tracked ----------
  const res = await jobsMod.tracked("schedules", async () => ({ fired: 2 }));
  assert.deepEqual(res, { fired: 2 }, "the job's result is handed back");
  await assert.rejects(jobsMod.tracked("schedules", async () => { throw new Error("boom for ops@example.org"); }), /boom for ops@example\.org/, "the job's own error is thrown again, unchanged");
  let [row] = await jobsMod.schedulerJobRows();
  assert.equal(row!.job, "schedules"); assert.equal(row!.runs, 2); assert.equal(row!.failures, 1);
  assert.ok(row!.last_ok_at && row!.last_error_at && row!.last_error === "boom for <address>", JSON.stringify(row));
  await jobsMod.tracked("schedules", async () => ({ ok: true }));
  [row] = await jobsMod.schedulerJobRows();
  assert.equal(row!.runs, 3, "the first success after a failure is written");
  await jobsMod.tracked("schedules", async () => ({ ok: true }));
  [row] = await jobsMod.schedulerJobRows();
  assert.equal(row!.runs, 3, "a success right after a success is not written again (30 s per process)");
  await jobsMod.tracked("record_clocks", async () => ({ error: "the clock check failed" }));
  const clocks = (await jobsMod.schedulerJobRows()).find((r) => r.job === "record_clocks")!;
  assert.equal(clocks.failures, 1, "a { error } report is a failure"); assert.equal(clocks.last_ok_at, null);
  ok("tracked: runs, successes and failures kept; result and error handed back; successes throttled");

  // ---------- 3. Scheduled work ----------
  const sched = await h.healthScheduled();
  assert.deepEqual(sched.jobs.map((j) => j.id), h.enabledJobs().map((j) => j.id), "only the jobs this build runs");
  assert.ok(!sched.jobs.some((j) => j.id === "webhook_deliveries"), "zero packs: no developer surface, no webhook job");
  // With every condition true, every job is listed, with its row.
  const all = h.JOB_SPECS.map((j) => j.id);
  assert.equal(new Set(all).size, 11, "eleven jobs the shell can run (mold_v0-210: health samples)");
  assert.ok(sched.jobs.some((j) => j.id === "health_samples"), "zero packs (no session engine): Health samples run");
  ok(`Scheduled work: ${sched.jobs.length} job(s) in this build (${sched.jobs.map((j) => j.id).join(", ") || "none"}); the rows only for those`);

  // ---------- 4. Runs ----------
  const { org } = await createOrg(`Health ${STAMP}`);
  const run = async (id: string, kind: string, status: string, error_kind: string | null, agent: boolean, cost: number, startDays: number, mins: number, error: string | null = null) => {
    await db.query(
      `INSERT INTO runs (id, org_id, pack, kind, status, spec, attempt, max_attempts, token_lifetime_seconds, lease_seconds, budget_usd, cost_usd, error_kind, error, requested_by, created_at, started_at, ended_at)
       VALUES ($1, $2, 'fx', $3, $4, $5, 1, 2, 600, 60, 5, $6, $7, $8, 'person@example.org', $9, $9, $10)`,
      [id, org.orgId, kind, status, JSON.stringify(agent ? { runner: "agent-workspace" } : {}), cost, error_kind, error, ago(startDays), ago(startDays, -mins)]);
  };
  await run("run_a1", "audit", "succeeded", null, true, 1.5, 2, 10);
  await run("run_a2", "audit", "failed", "output_missing", true, 0.5, 1, 4, "required output report.md was not written");
  await run("run_a3", "audit", "failed", "run", true, 0.25, 1, 2, "agent wrote to alice@example.org and failed");
  await run("run_b1", "sync", "succeeded", null, false, 0, 3, 1);
  await run("run_b2", "sync", "failed", "infrastructure", false, 0, 0, 1, "sandbox lost");
  await db.query("INSERT INTO run_events (run_id, org_id, attempt, type, data) VALUES ('run_a1', $1, 0, 'queued', $2)", [org.orgId, JSON.stringify({ kind: "audit", requested_by: "person@example.org" })]);
  await db.query("INSERT INTO run_events (run_id, org_id, attempt, type, data) VALUES ('run_a1', $1, 1, 'model_refused_retry', $2)", [org.orgId, JSON.stringify({ reason: "refused before any token was spent", requests: 1, refused: 1, cost_usd: 0 })]);
  await db.query("INSERT INTO run_events (run_id, org_id, attempt, type, data) VALUES ('run_a3', $1, 1, 'model_refused_retry', $2)", [org.orgId, JSON.stringify({ reason: "refused", requests: 2, refused: 2, cost_usd: 0 })]);
  const runs = await h.healthRuns({ days: "30" });
  assert.equal(runs.totals.runs, 5); assert.equal(runs.totals.failed, 3); assert.equal(runs.totals.failure_pct, 60);
  assert.equal(runs.totals.usd, 2.25);
  assert.equal(runs.totals.refused_retried, 2); assert.equal(runs.totals.refused_then_succeeded, 1); assert.equal(runs.totals.refused_then_failed, 1);
  assert.deepEqual(runs.by_error_kind, { output_missing: 1, run: 1, infrastructure: 1 });
  const audit = runs.kinds.find((k) => k.kind === "audit")!, sync = runs.kinds.find((k) => k.kind === "sync")!;
  assert.equal(audit.agent, true); assert.equal(sync.agent, false);
  assert.deepEqual(audit.failures, { output_missing: 1, run: 1 });
  assert.equal(audit.p50_seconds, 240); assert.ok(audit.p95_seconds! > 500);
  assert.equal(runs.recent_failed.length, 3);
  assert.ok(!JSON.stringify(runs).includes("example.org"), "no address anywhere in the Runs answer");
  assert.equal(runs.recent_failed.find((r) => r.id === "run_a3")!.refused_retry, true);
  assert.equal(runs.daily.length, 30); assert.equal(runs.daily.reduce((a, d) => a + d.total, 0), 5);
  const ev = await h.healthRunEvents("run_a1");
  assert.deepEqual(ev.events.map((e) => e.type), ["queued", "model_refused_retry"]);
  assert.ok(!JSON.stringify(ev).includes("example.org") && !("requested_by" in ev.events[0]!.data), "who asked is never shown");
  assert.equal(ev.events[1]!.data.requests, 1);
  await assert.rejects(h.healthRunEvents("run_nope"), /not found/);
  ok("Runs: kinds (agent or not), failures by error kind with output_missing, refused-and-retried and how they ended, durations, cost, recent failures, events without people");

  // ---------- 5. Deliveries ----------
  await db.query(`INSERT INTO email_log (kind, to_hash, to_domain, subject, status, idempotency_key, error) VALUES
    ('sign_in_code', 'h1', 'example.org', 'Your code 123456', 'sent', 'k1', NULL), ('sign_in_code', 'h2', 'example.org', 'Your code', 'failed', 'k2', 'bounced for bob@example.org'),
    ('due_soon', 'h3', 'example.org', 'Due soon: secret project', 'skipped', 'k3', 'off')`);
  await db.query(`INSERT INTO webhook_endpoints (id, org_id, url, events, secret_sealed, status, disabled_reason, failure_streak) VALUES
    ('we_1', $1, 'https://hooks.example.org/private-path', '{record.created}', 'sealed', 'disabled', 'disabled after 5 days of failures at https://hooks.example.org/private-path', 40)`, [org.orgId]);
  await db.query(`INSERT INTO webhook_deliveries (id, org_id, endpoint_id, event_type, dedupe_key, payload, status, attempts) VALUES
    ('d1', $1, 'we_1', 'record.created', 'a', '{}', 'succeeded', 1), ('d2', $1, 'we_1', 'record.created', 'b', '{}', 'failed', 8), ('d3', $1, 'we_1', 'run.finished', 'c', '{}', 'pending', 1)`, [org.orgId]);
  const del = await h.healthDeliveries({ days: "30" });
  const sic = del.emails.find((e) => e.kind === "sign_in_code")!;
  assert.equal(sic.sent, 1); assert.equal(sic.failed, 1);
  assert.ok(!JSON.stringify(del).includes("example.org") && !JSON.stringify(del).includes("Your code") && !JSON.stringify(del).includes("secret project"), "no address, domain or subject");
  ok(`Deliveries: emails by kind and status${del.webhooks ? ", webhook deliveries by status, endpoints switched off" : " (no developer surface in this build: webhooks left out)"}; no address or subject`);

  // ---------- 6. Status ----------
  const st = await h.healthStatus();
  const ids = st.checks.map((c) => c.id);
  assert.deepEqual(ids, ["database", "rls", "object_storage", "vault", "claude"]);
  assert.equal(st.checks[0]!.state, "ok");
  assert.ok(st.release.last_migration && st.release.last_migration.name === "health_samples", JSON.stringify(st.release));
  assert.match(st.release.mold.schema ?? "", /^0038_health_samples$/);
  assert.ok(!/sk-|whsec_|BEGIN PRIVATE/.test(JSON.stringify(st)), "never a key");
  ok(`Status: ${st.checks.map((c) => `${c.id} ${c.state}`).join(", ")}; last migration ${st.release.last_migration?.version}`);

  // ---------- 7. Status history ----------
  {
    const hs = await import("../src/health-samples.js");
    const { withTenant } = await import("../src/tenant-scope.js");
    const { readFileSync } = await import("node:fs");
    assert.equal(hs.healthSamplingOn(), true, "zero packs: sampled");
    // What happened in the window: a run failed and one succeeded, one refused-and-retried, the Claude provider's day.
    await db.query("DELETE FROM health_samples");
    await run("run_s1", "sync", "failed", "run", false, 0, 0, -1, "failed for carol@example.org");
    await run("run_s2", "sync", "succeeded", null, false, 0, 0, -1);
    await db.query("UPDATE runs SET ended_at = now() - interval '1 minute' WHERE id IN ('run_s1', 'run_s2')");
    await db.query("INSERT INTO run_events (run_id, org_id, attempt, type, data) VALUES ('run_s1', $1, 1, 'model_refused_retry', '{}')", [org.orgId]);
    await db.query(`INSERT INTO gateway_model_usage (day, provider, model, consumer, requests, errors) VALUES ((now() AT TIME ZONE 'UTC')::date, 'anthropic', 'claude-opus-5-5', 'session', 40, 3)
                    ON CONFLICT (day, provider, model, consumer) DO UPDATE SET requests = 40, errors = 3`);
    for (const ms of [10, 20, 30, 40, 1000]) hs.noteRequestMs(ms);
    const first = await hs.sampleHealth({ force: true });
    assert.equal(first.sampled, true);
    const [row] = await db.query<Record<string, unknown>>("SELECT * FROM health_samples");
    assert.ok(row, "one sample written");
    assert.equal(row!.up, true); assert.ok(Number(row!.db_ms) >= 0);
    assert.equal(Number(row!.runs_ended), 2); assert.equal(Number(row!.runs_failed), 1); assert.equal(Number(row!.claude_refusals), 1);
    assert.equal(Number(row!.claude_requests_day), 40); assert.equal(Number(row!.claude_errors_day), 3);
    assert.equal(Number(row!.api_requests), 5); assert.equal(Number(row!.api_p50_ms), 30); assert.equal(Number(row!.api_p95_ms), 1000);
    assert.ok(["ok", "failed", "error", "not run"].includes(String(row!.rls)) && ["env", "vault", "dir", "none"].includes(String(row!.storage)));
    // Only numbers and states: every column a number, a boolean, a time or one of the two enumerated states.
    const cols = await db.query<{ column_name: string; data_type: string }>("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'health_samples'");
    const text = cols.filter((c) => c.data_type === "text").map((c) => c.column_name).sort();
    assert.deepEqual(text, ["rls", "storage"], "no free text column");
    assert.ok(cols.every((c) => ["integer", "bigint", "boolean", "timestamp with time zone", "text"].includes(c.data_type)), JSON.stringify(cols));
    await assert.rejects(db.query("INSERT INTO health_samples (window_seconds, up, rls, storage) VALUES (60, true, 'carol@example.org', 'none')"), /check|violates/i, "a state outside its set is refused");
    assert.ok(!/example\.org|carol|@/.test(JSON.stringify(row)), "no address, no person");
    // At most every 4 minutes across processes; a forced one is the test's.
    assert.equal((await hs.sampleHealth()).sampled, false, "not again within 4 minutes");
    assert.equal((await hs.sampleHealth({ now: new Date(Date.now() + 5 * 60_000) })).sampled, true, "again after 4 minutes");
    // Retention: 35 days.
    await db.query("INSERT INTO health_samples (at, window_seconds, up, rls, storage) VALUES (now() - interval '40 days', 300, true, 'ok', 'none'), (now() - interval '34 days', 300, true, 'ok', 'none')");
    assert.equal(await hs.pruneHealthSamples(), 1, "the sample older than 35 days is pruned, the 34-day one kept");
    assert.equal(Number((await db.query<{ n: number }>("SELECT count(*) AS n FROM health_samples WHERE at < now() - interval '30 days'"))[0]!.n), 1);
    // History: a seeded day, one sample down, the Claude counters as differences.
    await db.query("DELETE FROM health_samples");
    const now = new Date();
    const at = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60_000);
    const put = (a: Date, up: boolean, req: number, err: number, failed: number) => db.query(
      "INSERT INTO health_samples (at, window_seconds, up, db_ms, api_p50_ms, api_p95_ms, rls, storage, vault_set, vault_missing, claude_requests_day, claude_errors_day, runs_ended, runs_failed, scheduler_lag_s) VALUES ($1, 300, $2, 4, 20, 90, 'ok', 'vault', 3, 1, $3, $4, 10, $5, 0)",
      [a, up, req, err, failed]);
    // Within one UTC day (the counters are per day): three samples 5 minutes apart, just now.
    await put(at(12), true, 10, 1, 0); await put(at(7), false, 15, 1, 2); await put(at(2), true, 25, 4, 1);
    const day = await hs.healthHistory({ range: "24h" }, now);
    assert.equal(day.range, "24h"); assert.equal(day.buckets.length, 48); assert.equal(day.samples, 3);
    assert.equal(day.totals.up_pct, 66.7, "one of three samples down");
    assert.equal(day.totals.runs_ended, 30); assert.equal(day.totals.runs_failed, 3);
    const sameDay = at(12).toISOString().slice(0, 10) === at(2).toISOString().slice(0, 10);
    if (sameDay) { assert.equal(day.totals.claude_requests, 15, "differences of the day's counters"); assert.equal(day.totals.claude_errors, 3); }
    assert.ok(day.buckets.filter((b) => b.samples).every((b) => b.up_pct != null && b.rls_ok === 100 && b.storage_ok === 100));
    assert.equal(day.latest?.vault_set, 3);
    assert.equal((await hs.healthHistory({ range: "7d" }, now)).buckets.length, 56);
    assert.equal((await hs.healthHistory({ range: "30d" }, now)).buckets.length, 60);
    assert.equal((await hs.healthHistory({ range: "drop table" }, now)).range, "24h", "an unknown range is 24h");
    assert.ok(!/@/.test(JSON.stringify(day)), "no address in the history");
    // Staff only: closed to tenant work, read by the staff router alone.
    await assert.rejects(withTenant(org.orgId, async () => (await getDb()).query("SELECT count(*) FROM health_samples")), /permission denied|refused/i, "a tenant query cannot read it");
    const http = readFileSync(new URL("../src/http.ts", import.meta.url), "utf8");
    assert.match(http, /ob\.get\("\/health\/history"/, "the history route is on the staff router");
    ok(`Status history: sample (runs, refusals, Claude errors, API latency), every 4 minutes at most, 35-day retention, 24h/7d/30d buckets, numbers and states only, staff only`);
  }
} catch (e) {
  failures++;
  console.error(`not ok - ${(e as Error).stack ?? e}`);
} finally {
  cleanup();
}
if (failures) process.exit(1);
console.log("health tabs: all checks passed");
process.exit(0);
