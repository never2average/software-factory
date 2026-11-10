/**
 * The staff console's Health › Status history (mold_v0-210; sql/migrations/0038_health_samples.sql, 0039_health_samples_webhooks.sql, web/src/features/
 * admin/health-tabs.tsx): every few minutes the scheduler takes one sample of the live signals (the database's answer
 * time, the API's latency, up or down, the row-level security probe, object storage, the key vault's providers, the
 * Claude provider's errors and refusals, the scheduler's lag, the runs' failures, the emails' and (mold_v0-215, 0039) the
 * webhooks' failures, each its own) and keeps it in
 * health_samples for 35 days; the Status tab draws its graphs from them (24 hours, 7 days, 30 days).
 *
 * Whoever runs the scheduler samples: a server's own loop (startHealthSampler, every minute, a sample when the last one
 * is SAMPLE_EVERY_MS old) and the Vercel cron entry (every 5 minutes), so history exists without the long-running
 * server. Only in a build without the session engine (whose Health keeps its own tabs, mold_v0-204), and not with
 * APP_SCHEDULER=off.
 *
 * A sample is numbers and states only: no address, no secret, no person's data, no workspace's name or id. The table is
 * platform bookkeeping, closed to tenant work (src/rls.ts NO_ACCESS), read by staff routes only.
 */
import { getDb } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import { featureOn } from "./features.js";
import { ENV } from "./env-names.js";
import { probeFromCron, rlsProbeState } from "./rls.js";
import { storageSource } from "./storage.js";
import { REFUSED_RETRY_EVENT } from "./provider-safe-env.js";

/** A sample at most this often across every process (the Vercel cron entry ticks every 5 minutes; a little slack). */
export const SAMPLE_EVERY_MS = 4 * 60_000;
/** How long samples are kept (the longest view is 30 days). */
export const RETENTION_DAYS = 35;

/** Sampling is on in a build without the session engine (an engine build keeps its own Health tabs). */
// The features registry (mold_v0-219): the health_history flag, asked for by a build without the session engine.
export const healthSamplingOn = (): boolean => featureOn("health_history");

// ---------------------------------------------------------------- the API's latency, in this process

/** Request durations since the last sample (ms), at most RING of them: the API's own requests, never their address. */
const RING = 5000;
let durations: number[] = [];
export function noteRequestMs(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  if (durations.length >= RING) durations.splice(0, durations.length - RING + 1);
  durations.push(Math.round(ms));
}
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};

// ---------------------------------------------------------------- one sample

export interface Sample {
  at: string; window_seconds: number; up: boolean; db_ms: number | null; api_p50_ms: number | null; api_p95_ms: number | null; api_requests: number;
  rls: "ok" | "failed" | "error" | "not run"; storage: "env" | "vault" | "dir" | "none"; vault_set: number; vault_missing: number;
  claude_requests_day: number; claude_errors_day: number; claude_refusals: number; scheduler_lag_s: number | null;
  runs_ended: number; runs_failed: number;
  /** Emails settled (sent or failed) and failed in the window; null when the app sends none of its own (since 0039, email only). */
  deliveries_total: number | null; deliveries_failed: number | null;
  /** Webhook deliveries settled (succeeded or failed) and failed in the window; null without a developer surface (0039). */
  webhooks_total: number | null; webhooks_failed: number | null;
  /**
   * mold_v0-293 (0068): the scheduled work so far: the jobs this build runs, every job's runs and failures (counters, the
   * history takes differences) and their average last duration; null in a sample taken before.
   */
  scheduler_jobs: number | null; scheduler_runs: number | null; scheduler_failures: number | null; scheduler_ms: number | null;
}
const COLUMNS = ["window_seconds", "up", "db_ms", "api_p50_ms", "api_p95_ms", "api_requests", "rls", "storage", "vault_set", "vault_missing",
  "claude_requests_day", "claude_errors_day", "claude_refusals", "scheduler_lag_s", "runs_ended", "runs_failed", "deliveries_total", "deliveries_failed", "webhooks_total", "webhooks_failed",
  "scheduler_jobs", "scheduler_runs", "scheduler_failures", "scheduler_ms"] as const;
const n = (v: unknown) => Number(v ?? 0) || 0;
const int = (v: number | null) => (v == null ? null : Math.max(0, Math.min(2_147_483_647, Math.round(v))));

/** Take one sample of the live signals over [since, now) (nothing is written). Each part that fails leaves its figure empty. */
export async function measure(now = new Date(), since?: Date): Promise<Omit<Sample, "at">> {
  const db = await getDb();
  const from = since ?? new Date(now.getTime() - 5 * 60_000);
  const window = Math.max(1, Math.round((now.getTime() - from.getTime()) / 1000));
  const p = [from, now];
  const safe = async <T>(f: () => Promise<T>, fallback: T): Promise<T> => { try { return await f(); } catch { return fallback; } };
  // Up: the database answers, as /healthz needs (a process that is down takes no sample: a gap in the band).
  let dbMs: number | null = null;
  const t0 = performance.now();
  try { await db.query("SELECT 1"); dbMs = performance.now() - t0; } catch { dbMs = null; }
  const up = dbMs !== null;
  const rls = (await probeFromCron(getDb).catch(() => rlsProbeState())) as Sample["rls"];
  const store = await storageSource().catch(() => ({ source: null }));
  const h = await import("./health-tabs.js");
  const vault = await safe(() => h.vaultReport(), null);
  // The API's latency: this process's requests since the last sample; with none (a Vercel function that only ran the
  // cron entry), the MCP requests every instance recorded in the window (mcp_events.ms).
  const mine = durations; durations = [];
  let api = { p50: pct(mine, 50), p95: pct(mine, 95), count: mine.length };
  if (!mine.length) api = await safe(async () => {
    const [r] = await asPlatform(async () => db.query<Record<string, unknown>>(
      `/* tenant: internal: admin Health samples (staff), every account's MCP request times, figures only */
       SELECT count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95
         FROM mcp_events WHERE at >= $1 AND at < $2 AND ms IS NOT NULL`, p));
    return { p50: r?.p50 == null ? null : n(r.p50), p95: r?.p95 == null ? null : n(r.p95), count: n(r?.n) };
  }, api);
  const claude = await safe(async () => {
    const [r] = await asPlatform(async () => db.query<Record<string, unknown>>(
      `SELECT coalesce(sum(requests), 0) AS requests, coalesce(sum(errors), 0) AS errors FROM gateway_model_usage WHERE provider = 'anthropic' AND day = ($1::timestamptz AT TIME ZONE 'UTC')::date`, [now]));
    return { requests: n(r?.requests), errors: n(r?.errors) };
  }, { requests: 0, errors: 0 });
  const refusals = await safe(async () => n((await asPlatform(async () => db.query<Record<string, unknown>>(
    `/* tenant: internal: admin Health samples (staff), every account's refused-and-retried run events, counted */
     SELECT count(*) AS n FROM run_events WHERE type = $3 AND at >= $1 AND at < $2`, [...p, REFUSED_RETRY_EVENT])))[0]?.n), 0);
  const scheduled = await safe(async () => (await h.healthScheduled()).jobs, null);
  const lag = (() => {
    const lags = (scheduled ?? []).filter((j) => j.id !== "health_samples").map((j) => j.lag_seconds).filter((x): x is number => x != null);
    return lags.length ? Math.max(...lags) : null;
  })();
  const took = (scheduled ?? []).map((j) => j.last_ms).filter((x): x is number => x != null);
  const runs = await safe(async () => {
    const [r] = await asPlatform(async () => db.query<Record<string, unknown>>(
      `/* tenant: internal: admin Health samples (staff), every account's runs that ended, counted */
       SELECT count(*) AS ended, count(*) FILTER (WHERE status = 'failed') AS failed FROM runs WHERE ended_at >= $1 AND ended_at < $2`, p));
    return { ended: n(r?.ended), failed: n(r?.failed) };
  }, { ended: 0, failed: 0 });
  // Emails and webhooks apart (mold_v0-215): each has its own graph on the Status tab.
  const deliveries = h.deliveriesOn() ? await safe(async () => asPlatform(async () => {
    const [e] = await db.query<Record<string, unknown>>(
      "SELECT count(*) FILTER (WHERE status IN ('sent', 'failed')) AS total, count(*) FILTER (WHERE status = 'failed') AS failed FROM email_log WHERE at >= $1 AND at < $2", p);
    return { total: n(e?.total), failed: n(e?.failed) };
  }), null) : null;
  const webhooks = h.webhooksOn() ? await safe(async () => asPlatform(async () => {
    const [w] = await db.query<Record<string, unknown>>(
      `/* tenant: internal: admin Health samples (staff), every account's settled webhook deliveries, counted */
       SELECT count(*) FILTER (WHERE status IN ('succeeded', 'failed')) AS total, count(*) FILTER (WHERE status = 'failed') AS failed
         FROM webhook_deliveries WHERE created_at >= $1 AND created_at < $2`, p);
    return { total: n(w?.total), failed: n(w?.failed) };
  }), null) : null;
  return {
    window_seconds: window, up, db_ms: int(dbMs), api_p50_ms: int(api.p50), api_p95_ms: int(api.p95), api_requests: api.count,
    rls: (["ok", "failed", "error", "not run"] as const).includes(rls) ? rls : "not run",
    storage: store.source ?? "none",
    vault_set: vault ? vault.providers.filter((x) => x.set === "yes").length : 0, vault_missing: vault ? vault.providers.filter((x) => x.set !== "yes").length : 0,
    claude_requests_day: claude.requests, claude_errors_day: claude.errors, claude_refusals: refusals, scheduler_lag_s: int(lag),
    runs_ended: runs.ended, runs_failed: runs.failed, deliveries_total: deliveries?.total ?? null, deliveries_failed: deliveries?.failed ?? null,
    webhooks_total: webhooks?.total ?? null, webhooks_failed: webhooks?.failed ?? null,
    scheduler_jobs: scheduled ? scheduled.length : null, scheduler_runs: scheduled ? scheduled.reduce((a, j) => a + j.runs, 0) : null,
    scheduler_failures: scheduled ? scheduled.reduce((a, j) => a + j.failures, 0) : null,
    scheduler_ms: took.length ? int(took.reduce((a, x) => a + x, 0) / took.length) : null,
  };
}

/**
 * Take a sample when the last one (by any process) is SAMPLE_EVERY_MS old, and drop the samples older than
 * RETENTION_DAYS. `force` samples whatever the last one's age (tests).
 */
export async function sampleHealth(opts: { now?: Date; force?: boolean } = {}): Promise<{ sampled: boolean; pruned: number }> {
  const now = opts.now ?? new Date();
  const db = await getDb();
  const [last] = await asPlatform(async () => db.query<{ at: Date }>("SELECT max(at) AS at FROM health_samples"));
  const lastAt = last?.at ? new Date(last.at) : null;
  const due = opts.force || !lastAt || now.getTime() - lastAt.getTime() >= SAMPLE_EVERY_MS;
  let sampled = false;
  if (due) {
    // The window: since the sample before, at most an hour (a gap is a gap, not one long window).
    const since = lastAt && now.getTime() - lastAt.getTime() <= 3_600_000 && lastAt < now ? lastAt : undefined;
    const s = await measure(now, since);
    await asPlatform(async () => db.query(
      `INSERT INTO health_samples (at, ${COLUMNS.join(", ")}) VALUES ($1, ${COLUMNS.map((_, i) => `$${i + 2}`).join(", ")})`,
      [now, ...COLUMNS.map((c) => s[c])]));
    sampled = true;
  }
  const pruned = await pruneHealthSamples(now);
  return { sampled, pruned };
}

/** Drop the samples older than RETENTION_DAYS. */
export async function pruneHealthSamples(now = new Date()): Promise<number> {
  const rows = await asPlatform(async () => (await getDb()).query(
    "DELETE FROM health_samples WHERE at < $1 RETURNING id", [new Date(now.getTime() - RETENTION_DAYS * 86_400_000)]));
  return rows.length;
}

let timer: NodeJS.Timeout | null = null;
let busy = false;
/** A server's loop: every minute, a sample when one is due (Vercel has no loop: its cron entry samples). */
export function startHealthSampler(everyMs = 60_000): boolean {
  if (timer || !healthSamplingOn() || (ENV.APP_SCHEDULER ?? "on").toLowerCase() === "off") return false;
  const run = () => {
    if (busy) return;
    busy = true;
    void import("./scheduler-jobs.js").then(({ tracked }) => tracked("health_samples", () => sampleHealth()))
      .catch((e) => console.error("health samples:", (e as Error).message)).finally(() => { busy = false; });
  };
  timer = setInterval(run, everyMs);
  timer.unref();
  setTimeout(run, 10_000).unref();
  return true;
}
export function stopHealthSampler() { if (timer) clearInterval(timer); timer = null; }

// ---------------------------------------------------------------- the history, for the Status tab

export const HISTORY_RANGES = { "24h": { ms: 86_400_000, buckets: 48 }, "7d": { ms: 7 * 86_400_000, buckets: 56 }, "30d": { ms: 30 * 86_400_000, buckets: 60 } } as const;
export type HistoryRange = keyof typeof HISTORY_RANGES;

export interface Bucket {
  at: string; samples: number; up_pct: number | null; db_ms: number | null; api_p50_ms: number | null; api_p95_ms: number | null;
  rls_ok: number | null; storage_ok: number | null; vault_set: number | null; vault_missing: number | null;
  claude_errors: number; claude_refusals: number; claude_requests: number; scheduler_lag_s: number | null;
  runs_ended: number; runs_failed: number; run_failure_pct: number | null;
  deliveries_total: number; deliveries_failed: number; delivery_failure_pct: number | null;
  webhooks_total: number; webhooks_failed: number; webhook_failure_pct: number | null;
  /** mold_v0-293: the scheduled work in the bucket: the jobs run (the last sample's), their runs and failures, their average duration. */
  scheduler_jobs: number | null; scheduler_runs: number; scheduler_failures: number; scheduler_ms: number | null;
}

const rows2samples = (rows: Record<string, unknown>[]): Sample[] => rows.map((r) => ({
  at: new Date(r.at as string).toISOString(), window_seconds: n(r.window_seconds), up: Boolean(r.up),
  db_ms: r.db_ms == null ? null : n(r.db_ms), api_p50_ms: r.api_p50_ms == null ? null : n(r.api_p50_ms), api_p95_ms: r.api_p95_ms == null ? null : n(r.api_p95_ms),
  api_requests: n(r.api_requests), rls: String(r.rls) as Sample["rls"], storage: String(r.storage) as Sample["storage"],
  vault_set: n(r.vault_set), vault_missing: n(r.vault_missing), claude_requests_day: n(r.claude_requests_day), claude_errors_day: n(r.claude_errors_day),
  claude_refusals: n(r.claude_refusals), scheduler_lag_s: r.scheduler_lag_s == null ? null : n(r.scheduler_lag_s),
  runs_ended: n(r.runs_ended), runs_failed: n(r.runs_failed),
  deliveries_total: r.deliveries_total == null ? null : n(r.deliveries_total), deliveries_failed: r.deliveries_failed == null ? null : n(r.deliveries_failed),
  webhooks_total: r.webhooks_total == null ? null : n(r.webhooks_total), webhooks_failed: r.webhooks_failed == null ? null : n(r.webhooks_failed),
  scheduler_jobs: r.scheduler_jobs == null ? null : n(r.scheduler_jobs), scheduler_runs: r.scheduler_runs == null ? null : n(r.scheduler_runs),
  scheduler_failures: r.scheduler_failures == null ? null : n(r.scheduler_failures), scheduler_ms: r.scheduler_ms == null ? null : n(r.scheduler_ms),
}));

/** The samples of a period, in buckets (24h: 30 minutes; 7d: 3 hours; 30d: 12 hours), and the latest sample. */
export async function healthHistory(q: Record<string, unknown>, now = new Date()) {
  const range: HistoryRange = (Object.keys(HISTORY_RANGES) as HistoryRange[]).includes(q.range as HistoryRange) ? (q.range as HistoryRange) : "24h";
  const { ms, buckets } = HISTORY_RANGES[range];
  const size = ms / buckets;
  // Bucket edges on whole bucket lengths, so a refresh moves the graph a bucket at a time.
  const end = Math.ceil(now.getTime() / size) * size, start = end - ms;
  const db = await getDb();
  // One sample before the period too: the Claude counters' first difference needs it.
  const rows = await asPlatform(async () => db.query<Record<string, unknown>>(
    `SELECT at, ${COLUMNS.join(", ")} FROM health_samples WHERE at >= $1 AND at < $2 ORDER BY at, id`, [new Date(start - 86_400_000), new Date(end)]));
  const samples = rows2samples(rows);
  // The Claude counters are the day's so far: each sample's share is the difference from the sample before on the same
  // UTC day (the day's first sample: its own count; a counter that went down, a new day's row: its own count).
  const claudeDelta = samples.map((s, i) => {
    const prev = samples[i - 1];
    if (!prev) return { requests: 0, errors: 0 };
    const sameDay = prev.at.slice(0, 10) === s.at.slice(0, 10);
    const d = (cur: number, before: number) => (sameDay ? (cur >= before ? cur - before : cur) : cur);
    return { requests: d(s.claude_requests_day, prev.claude_requests_day), errors: d(s.claude_errors_day, prev.claude_errors_day) };
  });
  // The scheduled work's counters (mold_v0-293) likewise: each sample's share is the difference from the sample before (a
  // counter that went down, its table emptied: its own count); none before, or a sample from before 0068: nothing.
  const schedDelta = samples.map((s, i) => {
    const prev = samples[i - 1];
    const d = (cur: number | null, before: number | null | undefined) => (cur == null || before == null ? 0 : cur >= before ? cur - before : cur);
    return { runs: d(s.scheduler_runs, prev?.scheduler_runs), failures: d(s.scheduler_failures, prev?.scheduler_failures) };
  });
  const out: Bucket[] = Array.from({ length: buckets }, (_, i) => ({
    at: new Date(start + i * size).toISOString(), samples: 0, up_pct: null, db_ms: null, api_p50_ms: null, api_p95_ms: null, rls_ok: null, storage_ok: null,
    vault_set: null, vault_missing: null, claude_errors: 0, claude_refusals: 0, claude_requests: 0, scheduler_lag_s: null,
    runs_ended: 0, runs_failed: 0, run_failure_pct: null, deliveries_total: 0, deliveries_failed: 0, delivery_failure_pct: null,
    webhooks_total: 0, webhooks_failed: 0, webhook_failure_pct: null, scheduler_jobs: null, scheduler_runs: 0, scheduler_failures: 0, scheduler_ms: null,
  }));
  const acc = out.map(() => ({ up: 0, db: [] as number[], p50: [] as number[], p95: [] as number[], rls: 0, store: 0, took: [] as number[] }));
  samples.forEach((s, i) => {
    const t = new Date(s.at).getTime();
    if (t < start) return;
    const k = Math.min(buckets - 1, Math.floor((t - start) / size));
    const b = out[k]!, a = acc[k]!;
    b.samples++;
    if (s.up) a.up++;
    if (s.db_ms != null) a.db.push(s.db_ms);
    if (s.api_p50_ms != null) a.p50.push(s.api_p50_ms);
    if (s.api_p95_ms != null) a.p95.push(s.api_p95_ms);
    if (s.rls === "ok") a.rls++;
    if (s.storage !== "none") a.store++;
    b.vault_set = s.vault_set; b.vault_missing = s.vault_missing;
    b.claude_errors += claudeDelta[i]!.errors; b.claude_requests += claudeDelta[i]!.requests; b.claude_refusals += s.claude_refusals;
    if (s.scheduler_lag_s != null) b.scheduler_lag_s = Math.max(b.scheduler_lag_s ?? 0, s.scheduler_lag_s);
    b.runs_ended += s.runs_ended; b.runs_failed += s.runs_failed;
    b.deliveries_total += s.deliveries_total ?? 0; b.deliveries_failed += s.deliveries_failed ?? 0;
    b.webhooks_total += s.webhooks_total ?? 0; b.webhooks_failed += s.webhooks_failed ?? 0;
    if (s.scheduler_jobs != null) b.scheduler_jobs = s.scheduler_jobs;
    b.scheduler_runs += schedDelta[i]!.runs; b.scheduler_failures += schedDelta[i]!.failures;
    if (s.scheduler_ms != null) a.took.push(s.scheduler_ms);
  });
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((x, y) => x + y, 0) / xs.length) : null);
  out.forEach((b, k) => {
    const a = acc[k]!;
    if (!b.samples) return;
    b.up_pct = Math.round((a.up / b.samples) * 1000) / 10;
    b.db_ms = avg(a.db); b.api_p50_ms = avg(a.p50); b.api_p95_ms = a.p95.length ? Math.max(...a.p95) : null;
    b.rls_ok = Math.round((a.rls / b.samples) * 1000) / 10; b.storage_ok = Math.round((a.store / b.samples) * 1000) / 10;
    b.run_failure_pct = b.runs_ended ? Math.round((b.runs_failed / b.runs_ended) * 1000) / 10 : null;
    b.delivery_failure_pct = b.deliveries_total ? Math.round((b.deliveries_failed / b.deliveries_total) * 1000) / 10 : null;
    b.webhook_failure_pct = b.webhooks_total ? Math.round((b.webhooks_failed / b.webhooks_total) * 1000) / 10 : null;
    b.scheduler_ms = avg(a.took);
  });
  const inRange = samples.filter((s) => new Date(s.at).getTime() >= start);
  const sum = (f: (b: Bucket) => number) => out.reduce((x, b) => x + f(b), 0);
  const h = await import("./health-tabs.js");
  return {
    range, from: new Date(start).toISOString(), to: new Date(end).toISOString(), bucket_seconds: size / 1000,
    sampling: healthSamplingOn(), every_seconds: process.env.VERCEL ? 300 : SAMPLE_EVERY_MS / 1000, retention_days: RETENTION_DAYS,
    deliveries: h.deliveriesOn(), webhooks: h.webhooksOn(),
    samples: inRange.length, latest: inRange.at(-1) ?? null,
    totals: {
      up_pct: inRange.length ? Math.round((inRange.filter((s) => s.up).length / inRange.length) * 1000) / 10 : null,
      claude_errors: sum((b) => b.claude_errors), claude_refusals: sum((b) => b.claude_refusals), claude_requests: sum((b) => b.claude_requests),
      runs_ended: sum((b) => b.runs_ended), runs_failed: sum((b) => b.runs_failed),
      deliveries_total: sum((b) => b.deliveries_total), deliveries_failed: sum((b) => b.deliveries_failed),
      webhooks_total: sum((b) => b.webhooks_total), webhooks_failed: sum((b) => b.webhooks_failed),
      scheduler_runs: sum((b) => b.scheduler_runs), scheduler_failures: sum((b) => b.scheduler_failures),
    },
    buckets: out,
  };
}
