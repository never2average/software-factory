/**
 * What the shell's scheduled work last did (mold_v0-204, sql/migrations/0037_scheduler_jobs.sql): each run of a job is
 * timed and its outcome kept in scheduler_jobs (last run, last success, last failure and its error), read by the staff
 * console's Health › Scheduled work (src/health-tabs.ts). Whoever runs the job writes it: a server's loops and the
 * Vercel cron entry alike, so the page sees every instance.
 *
 * Bookkeeping never gets in the job's way: a write that fails is logged and dropped, and the job's own result or error
 * is handed back as it was. A success is written at most every WRITE_EVERY_MS per job and process (the webhook loop
 * runs every 15 seconds); a failure, and the first success after one, always. An error is kept short and without
 * addresses, links or anything key-like (safeError), so the console never shows a person's data or a secret.
 */
import { getDb } from "./db.js";
import { asPlatform } from "./tenant-scope.js";

export const SCHEDULER_JOBS = ["schedules", "record_clocks", "email_intake", "event_outbox", "webhook_deliveries", "ledger_checkpoints",
  "encrypted_fields", "audit_retention", "workspace_retention", "run_charges", "health_samples", "harness_sessions"] as const;
export type SchedulerJob = (typeof SCHEDULER_JOBS)[number];

const WRITE_EVERY_MS = 30_000;
const lastWrite = new Map<string, { at: number; ok: boolean }>();

/** An error as the console may show it: one line, at most 300 characters, no address, link, token or long number. */
export function safeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
  return String(raw ?? "")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<address>")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+/gi, (u) => { try { return `<${new URL(u).protocol.replace(":", "")} link>`; } catch { return "<link>"; } })
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "<credential>")
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "<redacted>")
    .replace(/\s+/g, " ").trim().slice(0, 300) || "failed";
}

/** A report's own error (`{ error }`, as the cron entry's catch handlers return it), else null. */
const reportError = (r: unknown): string | null =>
  r && typeof r === "object" && "error" in r && typeof (r as { error: unknown }).error === "string" && Object.keys(r).length === 1 ? (r as { error: string }).error : null;

async function record(job: SchedulerJob, startedAt: Date, ms: number, error: string | null): Promise<void> {
  const prev = lastWrite.get(job), now = Date.now();
  if (!error && prev?.ok && now - prev.at < WRITE_EVERY_MS) return;
  lastWrite.set(job, { at: now, ok: !error });
  await asPlatform(async () => (await getDb()).query(
    `INSERT INTO scheduler_jobs AS j (job, last_run_at, last_ok_at, last_error_at, last_error, last_ms, runs, failures)
     VALUES ($1, $2::timestamptz, CASE WHEN $3::text IS NULL THEN $2::timestamptz END, CASE WHEN $3::text IS NOT NULL THEN $2::timestamptz END, $3::text, $4::int, 1, CASE WHEN $3::text IS NULL THEN 0 ELSE 1 END)
     ON CONFLICT (job) DO UPDATE SET last_run_at = GREATEST(j.last_run_at, excluded.last_run_at),
       last_ok_at = coalesce(GREATEST(j.last_ok_at, excluded.last_ok_at), j.last_ok_at, excluded.last_ok_at),
       last_error_at = coalesce(GREATEST(j.last_error_at, excluded.last_error_at), j.last_error_at, excluded.last_error_at),
       last_error = CASE WHEN excluded.last_error IS NOT NULL THEN excluded.last_error ELSE j.last_error END,
       last_ms = excluded.last_ms, runs = j.runs + 1, failures = j.failures + excluded.failures`,
    [job, startedAt, error, Math.min(2_147_483_647, Math.max(0, Math.round(ms)))]));
}

/**
 * Run one job and keep what it did. Its result (or its error, thrown again) is handed back unchanged; a result that is
 * only `{ error }` counts as a failure.
 */
export async function tracked<T>(job: SchedulerJob, fn: () => Promise<T>): Promise<T> {
  const startedAt = new Date(), t0 = performance.now();
  const keep = (error: string | null) => record(job, startedAt, performance.now() - t0, error === null ? null : safeError(error))
    .catch((e) => console.error(`scheduler jobs: ${job}: not recorded: ${(e as Error).message}`));
  try {
    const out = await fn();
    await keep(reportError(out));
    return out;
  } catch (e) {
    await keep(safeError(e));
    throw e;
  }
}

export interface SchedulerJobRow { job: string; last_run_at: string; last_ok_at: string | null; last_error_at: string | null; last_error: string | null; last_ms: number | null; runs: number; failures: number }
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
/** Every job's row (staff only: the platform's own bookkeeping, no workspace's data). */
export async function schedulerJobRows(): Promise<SchedulerJobRow[]> {
  const rows = await asPlatform(async () => (await getDb()).query<Record<string, unknown>>(
    "SELECT job, last_run_at, last_ok_at, last_error_at, last_error, last_ms, runs, failures FROM scheduler_jobs ORDER BY job"));
  return rows.map((r) => ({ job: String(r.job), last_run_at: iso(r.last_run_at)!, last_ok_at: iso(r.last_ok_at), last_error_at: iso(r.last_error_at),
    last_error: (r.last_error as string | null) ?? null, last_ms: r.last_ms == null ? null : Number(r.last_ms), runs: Number(r.runs), failures: Number(r.failures) }));
}
