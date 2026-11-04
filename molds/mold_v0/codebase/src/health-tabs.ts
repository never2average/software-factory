/**
 * The staff console's Health tabs in a build without the session engine (mold_v0-204; web/src/features/admin/
 * health-tabs.tsx): Runs, Scheduled work, Email Delivery (?section=deliveries), Webhook Delivery (?section=webhooks, mold_v0-215)
 * and Status, beside Errors (src/insights.ts). A build with the
 * engine keeps its own tabs (Errors, Jobs, Sessions) as they were; these routes answer there too, unused.
 *
 * Staff only (the admin router's guard, `/api/admin/onboarding/health/*`), read only, and never a person's data, an
 * address or a secret: runs by kind and error kind with their numbers, a failed run's error cut short and cleaned
 * (src/scheduler-jobs.ts safeError), its events' types and figures only; scheduler jobs' times and errors; emails by
 * kind and status (never an address, a subject or a body); webhook deliveries by status and the endpoints switched off
 * (never their address); the live checks as /healthz and the key vault's status give them (set or missing, never a
 * value).
 */
import { createRequire } from "node:module";
import { getDb } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import { reportRange } from "./insights.js";
import { RUN_USD } from "./run-spend.js";
import { jobKinds } from "./runs.js";
import { dueAreas, schedulesWired } from "./schedules.js";
import { clockAreas } from "./record-clocks.js";
import { intakeWired } from "./email-intake.js";
import { companyEmailWired } from "./company-email.js";
import { developerSurface } from "./developer-surface.js";
import { signOn } from "./ledger.js";
import { encryptedAreas } from "./encrypted-fields-migration.js";
import { auditSettings } from "./audit-trail.js";
import { retentionWired } from "./workspace-retention.js";
import { runBillingOn } from "./run-charges.js";
import { REFUSED_RETRY_EVENT } from "./provider-safe-env.js";
import { safeError, schedulerJobRows, type SchedulerJob } from "./scheduler-jobs.js";
import { probeFromCron, rlsProbeState } from "./rls.js";
import { storageSource } from "./storage.js";
import { vaultUnlocked } from "./keyvault.js";
import { vaultStatus, type RawConn } from "./vault-status.js";
import { loadMigrations } from "./migrate.js";
import { word } from "./vocabulary.js";
import { healthSamplingOn } from "./health-samples.js";

const n = (v: unknown) => Number(v ?? 0) || 0;
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const usd = (x: number) => Math.round(x * 10_000) / 10_000;
const secs = (v: unknown) => (v == null ? null : Math.round(Number(v) * 10) / 10);
const DAY = 86_400_000;
const days = (from: Date, count: number) => Array.from({ length: count }, (_, i) => new Date(from.getTime() + i * DAY).toISOString().slice(0, 10));

// ---------------------------------------------------------------- Runs

export const ERROR_KINDS = ["infrastructure", "run", "validation", "timeout", "cancelled", "output_missing"] as const;
/** The run event fields a staff reader may see: figures and words of the shell's own, never a person, a path or a value. */
const EVENT_FIELDS = ["error_kind", "reason", "cost_usd", "requests", "refused", "version", "files", "location", "outcome"] as const;

/** Runs over the period (?from&to, Health's range; else the last 30 days): by kind, failures by error kind, the refused-and-retried, recent failures. */
export async function healthRuns(q: Record<string, unknown>) {
  const range = reportRange(q);
  const p = [range.start, range.end];
  const db = await getDb();
  const kinds = jobKinds();
  const labelOf = (pack: string, kind: string) => kinds.find((k) => k.pack === pack && k.name === kind)?.label ?? kind;
  // An agent run: its kind runs a coding agent on the workspace (pack.json agentJobKinds, runner agent-workspace).
  const agentOf = (pack: string, kind: string, stored: boolean) => { const k = kinds.find((x) => x.pack === pack && x.name === kind); return k ? "runner" in k : stored; };
  const [byKind, failures, daily, refused, recent] = await Promise.all([
    db.query<Record<string, unknown>>(
      `/* tenant: internal: admin Health (staff), every account's runs, by kind */
       SELECT r.pack, r.kind, bool_or(coalesce(r.spec->>'runner', '') = 'agent-workspace') AS agent, count(*) AS total,
              count(*) FILTER (WHERE r.status = 'succeeded') AS succeeded, count(*) FILTER (WHERE r.status = 'failed') AS failed,
              count(*) FILTER (WHERE r.status = 'cancelled') AS cancelled, count(*) FILTER (WHERE r.status IN ('queued', 'running')) AS open,
              count(DISTINCT r.org_id) AS accounts, coalesce(sum(${RUN_USD}), 0) AS usd,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.ended_at - r.started_at)) FILTER (WHERE r.ended_at IS NOT NULL AND r.started_at IS NOT NULL) AS p50_s,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM r.ended_at - r.started_at)) FILTER (WHERE r.ended_at IS NOT NULL AND r.started_at IS NOT NULL) AS p95_s
         FROM runs r WHERE r.created_at >= $1 AND r.created_at < $2 GROUP BY r.pack, r.kind`, p),
    db.query<Record<string, unknown>>(
      `/* tenant: internal: admin Health (staff), every account's failed runs, by kind and error kind */
       SELECT r.pack, r.kind, coalesce(r.error_kind, 'unknown') AS error_kind, count(*) AS n
         FROM runs r WHERE r.status = 'failed' AND r.created_at >= $1 AND r.created_at < $2 GROUP BY 1, 2, 3`, p),
    db.query<Record<string, unknown>>(
      `/* tenant: internal: admin Health (staff), every account's runs, by day */
       SELECT to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS total, count(*) FILTER (WHERE r.status = 'failed') AS failed,
              coalesce(sum(${RUN_USD}), 0) AS usd,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.ended_at - r.started_at)) FILTER (WHERE r.ended_at IS NOT NULL AND r.started_at IS NOT NULL) AS p50_s
         FROM runs r WHERE r.created_at >= $1 AND r.created_at < $2 GROUP BY 1`, p),
    db.query<Record<string, unknown>>(
      `/* tenant: internal: admin Health (staff), every account's runs the model API refused and the shell queued once more */
       SELECT r.status, count(*) AS n FROM runs r
        WHERE r.created_at >= $1 AND r.created_at < $2 AND EXISTS (SELECT 1 FROM run_events e WHERE e.run_id = r.id AND e.type = $3)
        GROUP BY r.status`, [...p, REFUSED_RETRY_EVENT]),
    db.query<Record<string, unknown>>(
      `/* tenant: internal: admin Health (staff), every account's latest failed runs */
       SELECT r.id, r.pack, r.kind, coalesce(r.spec->>'runner', '') = 'agent-workspace' AS agent, r.error_kind, r.error, r.attempt, r.max_attempts,
              r.created_at, r.ended_at, extract(epoch FROM r.ended_at - r.started_at) AS seconds, ${RUN_USD} AS usd, o.name AS account,
              EXISTS (SELECT 1 FROM run_events e WHERE e.run_id = r.id AND e.type = $3) AS refused_retry
         FROM runs r JOIN organizations o ON o.id = r.org_id
        WHERE r.status = 'failed' AND r.created_at >= $1 AND r.created_at < $2 ORDER BY coalesce(r.ended_at, r.created_at) DESC LIMIT 200`, [...p, REFUSED_RETRY_EVENT]),
  ]);
  const kindRows = byKind.map((r) => {
    const pack = String(r.pack), kind = String(r.kind);
    const fails = failures.filter((f) => f.pack === pack && f.kind === kind);
    return { pack, kind, label: labelOf(pack, kind), agent: agentOf(pack, kind, Boolean(r.agent)), total: n(r.total), succeeded: n(r.succeeded), failed: n(r.failed),
      cancelled: n(r.cancelled), open: n(r.open), accounts: n(r.accounts), usd: usd(n(r.usd)), p50_seconds: secs(r.p50_s), p95_seconds: secs(r.p95_s),
      failures: Object.fromEntries(fails.map((f) => [String(f.error_kind), n(f.n)])) as Record<string, number> };
  });
  // The kinds the build declares, with no run in the period, are listed too (each with nothing).
  for (const k of kinds) if (!kindRows.some((r) => r.pack === k.pack && r.kind === k.name))
    kindRows.push({ pack: k.pack, kind: k.name, label: k.label ?? k.name, agent: "runner" in k, total: 0, succeeded: 0, failed: 0, cancelled: 0, open: 0, accounts: 0, usd: 0, p50_seconds: null, p95_seconds: null, failures: {} });
  const byErrorKind: Record<string, number> = {};
  for (const f of failures) byErrorKind[String(f.error_kind)] = (byErrorKind[String(f.error_kind)] ?? 0) + n(f.n);
  const dayMap = new Map(daily.map((d) => [String(d.day), d]));
  const series = days(range.start, range.days).map((day) => {
    const d = dayMap.get(day);
    return { day, total: n(d?.total), failed: n(d?.failed), usd: usd(n(d?.usd)), p50_seconds: secs(d?.p50_s) ?? 0 };
  });
  const total = kindRows.reduce((a, r) => a + r.total, 0), failed = kindRows.reduce((a, r) => a + r.failed, 0);
  const durations = byKind.map((r) => ({ total: n(r.total), p50: r.p50_s == null ? null : n(r.p50_s) })).filter((x) => x.p50 !== null);
  return {
    range: { from: range.from, to: range.to, days: range.days },
    words: { one: word("Run"), many: word("Runs") },
    totals: { runs: total, failed, failure_pct: total ? Math.round((failed / total) * 1000) / 10 : 0, usd: usd(kindRows.reduce((a, r) => a + r.usd, 0)),
      // The median of the kinds' medians, weighted by their runs: a figure for the card, the table has each kind's own.
      p50_seconds: durations.length ? secs(durations.reduce((a, x) => a + x.p50! * x.total, 0) / Math.max(1, durations.reduce((a, x) => a + x.total, 0))) : null,
      refused_retried: refused.reduce((a, r) => a + n(r.n), 0), refused_then_succeeded: n(refused.find((r) => r.status === "succeeded")?.n),
      refused_then_failed: n(refused.find((r) => r.status === "failed")?.n) },
    by_error_kind: byErrorKind,
    kinds: kindRows.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)),
    daily: series,
    recent_failed: recent.map((r) => ({ id: String(r.id), pack: String(r.pack), kind: String(r.kind), label: labelOf(String(r.pack), String(r.kind)), agent: Boolean(r.agent),
      error_kind: (r.error_kind as string | null) ?? null, error: r.error ? safeError(r.error) : null, attempt: n(r.attempt), max_attempts: n(r.max_attempts),
      created_at: iso(r.created_at), ended_at: iso(r.ended_at), seconds: secs(r.seconds), usd: usd(n(r.usd)), account: String(r.account ?? ""), refused_retry: Boolean(r.refused_retry) })),
  };
}

/** One run's events for staff: type, attempt, time and the shell's own figures and words (EVENT_FIELDS), errors cleaned. */
export async function healthRunEvents(runId: string) {
  const db = await getDb();
  const [run] = await db.query<Record<string, unknown>>(
    `/* tenant: internal: admin Health (staff), one run by id */
     SELECT r.id, r.pack, r.kind, r.status, r.error_kind, r.attempt, r.created_at, r.ended_at, o.name AS account FROM runs r JOIN organizations o ON o.id = r.org_id WHERE r.id = $1`, [String(runId)]);
  if (!run) throw Object.assign(new Error("run not found"), { status: 404 });
  const events = await db.query<{ id: number; attempt: number; type: string; data: Record<string, unknown> | null; at: Date }>(
    "/* tenant: internal: admin Health (staff), one run's events, by run id */ SELECT id, attempt, type, data, at FROM run_events WHERE run_id = $1 ORDER BY id LIMIT 500", [String(runId)]);
  const kinds = jobKinds();
  return {
    run: { id: String(run.id), pack: String(run.pack), kind: String(run.kind), label: kinds.find((k) => k.pack === run.pack && k.name === run.kind)?.label ?? String(run.kind),
      status: String(run.status), error_kind: (run.error_kind as string | null) ?? null, attempt: n(run.attempt), created_at: iso(run.created_at), ended_at: iso(run.ended_at), account: String(run.account ?? "") },
    events: events.map((e) => {
      const d = e.data ?? {};
      const shown: Record<string, string | number | boolean> = {};
      for (const k of EVENT_FIELDS) {
        const v = d[k];
        if (typeof v === "number" || typeof v === "boolean") shown[k] = v;
        else if (typeof v === "string" && v) shown[k] = safeError(v).slice(0, 160);
      }
      if (typeof d.error === "string" && d.error) shown.error = safeError(d.error);
      return { id: Number(e.id), attempt: n(e.attempt), type: String(e.type), at: iso(e.at), data: shown };
    }),
  };
}

// ---------------------------------------------------------------- Scheduled work

/** Seconds between a job's runs here: a server's loops, or the Vercel cron entry (every 5 minutes). */
const onVercel = () => Boolean(process.env.VERCEL);
interface JobSpec { id: SchedulerJob; label: string; about: string; on: () => boolean; every: () => number }
export const JOB_SPECS: readonly JobSpec[] = [
  { id: "schedules", label: "Schedules and due dates", about: "Starts the workspaces' scheduled runs and posts the daily due-date notices.", on: () => schedulesWired() || dueAreas().length > 0, every: () => (onVercel() ? 300 : 60) },
  { id: "record_clocks", label: "Record clocks", about: "Works out each record's deadline, sends reminders and escalates overdue ones (at most every 15 minutes).", on: () => clockAreas().length > 0, every: () => (onVercel() ? 300 : 60) },
  { id: "email_intake", label: "Email intake", about: "Reads each workspace's connected mailboxes and files new messages as records.", on: () => intakeWired(), every: () => (onVercel() ? 300 : 60) },
  { id: "event_outbox", label: "Event outbox relay", about: "Hands each committed event to the webhook endpoints that take it.", on: () => !!developerSurface(), every: () => (onVercel() ? 300 : 15) },
  { id: "webhook_deliveries", label: "Webhook deliveries", about: "Sends the deliveries that are due and retries the failed ones with a backoff.", on: () => !!developerSurface(), every: () => (onVercel() ? 300 : 15) },
  { id: "ledger_checkpoints", label: "Ledger checkpoints", about: "Signs a checkpoint of each audit chain with new entries.", on: () => signOn(), every: () => (onVercel() ? 300 : 60) },
  { id: "encrypted_fields", label: "Encrypted-field migration", about: "Rewrites rows written before a field was encrypted, a batch at a time.", on: () => encryptedAreas().length > 0, every: () => (onVercel() ? 300 : 60) },
  { id: "audit_retention", label: "Audit retention", about: "Removes audit entries older than the app's retention.", on: () => { const s = auditSettings(); return s.data || s.platform; }, every: () => (onVercel() ? 300 : 3600) },
  { id: "workspace_retention", label: "Workspace store retention", about: "Expires old versions of the workspaces' stored files (daily).", on: () => retentionWired(), every: () => (onVercel() ? 300 : 60) },
  { id: "run_charges", label: "Run charges", about: "Hands pending run charges to billing.", on: () => runBillingOn(), every: () => (onVercel() ? 300 : 60) },
  { id: "health_samples", label: "Health samples", about: "Samples the live checks for Health › Status's graphs every few minutes and drops samples older than 35 days.", on: () => healthSamplingOn(), every: () => (onVercel() ? 300 : 240) },
];
/** The jobs this build runs (the same conditions as the loops that start them). */
export const enabledJobs = () => JOB_SPECS.filter((j) => { try { return j.on(); } catch { return false; } });

export async function healthScheduled() {
  const rows = new Map((await schedulerJobRows()).map((r) => [r.job, r]));
  const now = Date.now();
  const jobs = enabledJobs().map((j) => {
    const r = rows.get(j.id);
    const every = j.every();
    const late = r ? Math.max(0, Math.round((now - new Date(r.last_run_at).getTime()) / 1000 - every)) : null;
    // failing: the last run failed; late: no run for three of its periods (a minute's grace); never: not run yet.
    const state = !r ? "never" : r.last_error_at && (!r.last_ok_at || r.last_error_at >= r.last_ok_at) ? "failing" : late! > Math.max(60, every * 2) ? "late" : "ok";
    return { id: j.id, label: j.label, about: j.about, every_seconds: every, state, lag_seconds: late,
      last_run_at: r?.last_run_at ?? null, last_ok_at: r?.last_ok_at ?? null, last_error_at: r?.last_error_at ?? null, last_error: r?.last_error ?? null,
      last_ms: r?.last_ms ?? null, runs: r?.runs ?? 0, failures: r?.failures ?? 0 };
  });
  return { runtime: onVercel() ? "vercel" : "server", jobs };
}

// ---------------------------------------------------------------- Email Delivery (the tab's section id: deliveries)

/** Email Delivery is a tab when the app sends mail of a workspace's own, or has a developer surface (its people's mail). */
export const deliveriesOn = () => companyEmailWired() || !!developerSurface();
/** Webhook Delivery (mold_v0-215) is a tab when the app has a developer surface: its declared events go out as webhooks. */
export const webhooksOn = () => !!developerSurface();

/** Email sends by kind and status, and by day: counts, never an address, a domain or a subject. */
export async function healthDeliveries(q: Record<string, unknown>) {
  const range = reportRange(q);
  const p = [range.start, range.end];
  return asPlatform(async () => {
    const db = await getDb();
    const [emails, emailDaily] = await Promise.all([
      db.query<Record<string, unknown>>(
        `SELECT kind, count(*) AS total, count(*) FILTER (WHERE status = 'sent') AS sent, count(*) FILTER (WHERE status = 'failed') AS failed,
                count(*) FILTER (WHERE status = 'skipped') AS skipped, count(*) FILTER (WHERE status = 'sending') AS sending, max(at) AS last_at,
                max(at) FILTER (WHERE status = 'failed') AS last_failed_at
           FROM email_log WHERE at >= $1 AND at < $2 GROUP BY kind`, p),
      db.query<Record<string, unknown>>(
        `SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) FILTER (WHERE status = 'sent') AS sent, count(*) FILTER (WHERE status = 'failed') AS failed,
                count(*) FILTER (WHERE status = 'skipped') AS skipped
           FROM email_log WHERE at >= $1 AND at < $2 GROUP BY 1`, p),
    ]);
    const ed = new Map(emailDaily.map((d) => [String(d.day), d]));
    const rows = emails.map((r) => ({ kind: String(r.kind), total: n(r.total), sent: n(r.sent), failed: n(r.failed), skipped: n(r.skipped), sending: n(r.sending),
      last_at: iso(r.last_at), last_failed_at: iso(r.last_failed_at) })).sort((a, b) => b.total - a.total);
    const sum = (k: "total" | "sent" | "failed" | "skipped" | "sending") => rows.reduce((a, r) => a + r[k], 0);
    const settled = sum("sent") + sum("failed");
    return {
      range: { from: range.from, to: range.to, days: range.days },
      email: companyEmailWired() || emails.length > 0,
      totals: { tried: sum("total"), sent: sum("sent"), failed: sum("failed"), skipped: sum("skipped"), sending: sum("sending"), kinds: rows.length,
        failure_pct: settled ? Math.round((sum("failed") / settled) * 1000) / 10 : 0 },
      emails: rows,
      daily: days(range.start, range.days).map((day) => ({ day, sent: n(ed.get(day)?.sent), failed: n(ed.get(day)?.failed), skipped: n(ed.get(day)?.skipped) })),
    };
  });
}

// ---------------------------------------------------------------- Webhook Delivery (the tab's section id: webhooks)

/** Webhook deliveries by event and status, by day, and the endpoints switched off: counts, never an endpoint's address. */
export async function healthWebhooks(q: Record<string, unknown>) {
  const range = reportRange(q);
  const p = [range.start, range.end];
  return asPlatform(async () => {
    const db = await getDb();
    const [deliveries, hookDaily, disabled] = await Promise.all([
      db.query<Record<string, unknown>>(
        `/* tenant: internal: admin Health (staff), every account's webhook deliveries, by event and status */
         SELECT event_type, count(*) AS total, count(*) FILTER (WHERE status = 'succeeded') AS succeeded, count(*) FILTER (WHERE status = 'failed') AS failed,
                count(*) FILTER (WHERE status = 'pending') AS pending, count(*) FILTER (WHERE status = 'pending' AND attempts > 0) AS retrying,
                coalesce(sum(attempts), 0) AS attempts, max(created_at) AS last_at
           FROM webhook_deliveries WHERE created_at >= $1 AND created_at < $2 GROUP BY event_type`, p),
      db.query<Record<string, unknown>>(
        `/* tenant: internal: admin Health (staff), every account's webhook deliveries, by day */
         SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) FILTER (WHERE status = 'succeeded') AS succeeded,
                count(*) FILTER (WHERE status = 'failed') AS failed, count(*) FILTER (WHERE status = 'pending') AS pending
           FROM webhook_deliveries WHERE created_at >= $1 AND created_at < $2 GROUP BY 1`, p),
      db.query<Record<string, unknown>>(
        `/* tenant: internal: admin Health (staff), every account's endpoints switched off */
         SELECT e.id, o.name AS account, cardinality(e.events) AS events, e.disabled_reason, e.failure_streak, e.first_failure_at, e.updated_at
           FROM webhook_endpoints e JOIN organizations o ON o.id = e.org_id WHERE e.status = 'disabled' ORDER BY e.updated_at DESC LIMIT 200`),
    ]);
    const hd = new Map(hookDaily.map((d) => [String(d.day), d]));
    const rows = deliveries.map((r) => ({ event: String(r.event_type), total: n(r.total), succeeded: n(r.succeeded), failed: n(r.failed), pending: n(r.pending),
      retrying: n(r.retrying), attempts: n(r.attempts), last_at: iso(r.last_at) })).sort((a, b) => b.total - a.total);
    const sum = (k: "total" | "succeeded" | "failed" | "pending" | "retrying" | "attempts") => rows.reduce((a, r) => a + r[k], 0);
    const settled = sum("succeeded") + sum("failed");
    return {
      range: { from: range.from, to: range.to, days: range.days },
      webhooks: webhooksOn(),
      totals: { total: sum("total"), succeeded: sum("succeeded"), failed: sum("failed"), pending: sum("pending"), retrying: sum("retrying"), attempts: sum("attempts"),
        events: rows.length, endpoints_off: disabled.length, failure_pct: settled ? Math.round((sum("failed") / settled) * 1000) / 10 : 0 },
      deliveries: rows,
      disabled_endpoints: disabled.map((r) => ({ id: String(r.id), account: String(r.account ?? ""), events: n(r.events), reason: r.disabled_reason ? safeError(r.disabled_reason) : null,
        failure_streak: n(r.failure_streak), first_failure_at: iso(r.first_failure_at), disabled_at: iso(r.updated_at) })),
      daily: days(range.start, range.days).map((day) => ({ day, succeeded: n(hd.get(day)?.succeeded), failed: n(hd.get(day)?.failed), pending: n(hd.get(day)?.pending) })),
    };
  });
}

// ---------------------------------------------------------------- Status

class Rollback extends Error {}
/** The key vault's status (src/vault-status.ts) over a transaction of the app's own pool, read only and rolled back. */
export async function vaultReport() {
  let out: Awaited<ReturnType<typeof vaultStatus>> | null = null;
  await asPlatform(async () => (await getDb()).transaction(async (tx) => {
    // vaultStatus opens and rolls back its own transaction on a raw connection: here the transaction is the pool's,
    // so its BEGIN and ROLLBACK are left to it (the throw below rolls it back).
    const conn: RawConn = { query: async (sql, params) => (/^(BEGIN|ROLLBACK)$/i.test(sql.trim()) ? { rows: [] } : { rows: await tx.query(sql, params) }) };
    out = await vaultStatus(conn);
    throw new Rollback();
  })).catch((e) => { if (!(e instanceof Rollback)) throw e; });
  return out!;
}
const pkgVersion = (() => { try { return String(createRequire(import.meta.url)("../package.json").version ?? ""); } catch { return ""; } })();
const STARTED_AT = new Date().toISOString();

type Check = { id: string; label: string; state: "ok" | "warn" | "bad" | "off"; value: string; detail: string | null };

/** The live checks, as /healthz says them, and the release: never a value of any key. */
export async function healthStatus() {
  const checks: Check[] = [];
  const db = await getDb();
  const t0 = performance.now();
  try { await db.query("SELECT 1"); checks.push({ id: "database", label: "Database", state: "ok", value: `answered in ${Math.round(performance.now() - t0)} ms`, detail: db.kind === "pglite" ? "embedded (PGlite)" : "Postgres" }); }
  catch (e) { checks.push({ id: "database", label: "Database", state: "bad", value: "not answering", detail: safeError(e) }); }
  // The row-level security probe (src/rls.ts): run here at most once an hour, as the cron entry does.
  const rls = await probeFromCron(getDb).catch(() => rlsProbeState());
  checks.push({ id: "rls", label: "Row-level security probe", state: rls === "ok" ? "ok" : rls === "not run" ? "warn" : "bad", value: rls,
    detail: rls === "failed" ? "tenant queries are refused until a probe passes" : "a rolled-back probe on the live database, at most once an hour" });
  const store = await storageSource().catch(() => ({ source: null }));
  checks.push({ id: "object_storage", label: "Object storage", state: store.source ? "ok" : "warn",
    value: store.source === "env" ? "set (environment)" : store.source === "vault" ? "set (key vault)" : store.source === "dir" ? "a local folder" : "not set", detail: null });
  let vault: Awaited<ReturnType<typeof vaultReport>> | null = null, vaultError: string | null = null;
  try { vault = await vaultReport(); } catch (e) { vaultError = safeError(e); }
  checks.push({ id: "vault", label: "Key vault", state: !vaultUnlocked() ? "bad" : vault?.runs.missing.length ? "warn" : vault ? "ok" : "bad",
    value: !vaultUnlocked() ? "locked" : vault ? (vault.runs.missing.length ? `${vault.runs.missing.length} needed key${vault.runs.missing.length > 1 ? "s" : ""} missing` : "unlocked") : "could not be read",
    detail: vaultError ?? (vault?.runs.missing.length ? `missing: ${vault.runs.missing.join(", ")}` : null) });
  const claude = vault?.providers.find((p) => p.slug === "anthropic") ?? null;
  checks.push({ id: "claude", label: "Claude provider", state: !claude ? "off" : claude.set === "yes" ? "ok" : "warn",
    value: !claude ? "not used by this build" : claude.set === "yes" ? (claude.backend === "vertex" || /Vertex/.test(claude.note ?? "") ? "set (through Vertex AI)" : "set (Anthropic)") : "missing",
    detail: claude ? [claude.note, claude.last_used_at ? `last used ${claude.last_used_at}` : "never used"].filter(Boolean).join("; ") : null });
  const [latest] = await db.query<{ version: number; name: string; applied_at: Date }>("SELECT version, name, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 1").catch(() => []);
  const shell = await loadMigrations().catch(() => []);
  const newest = shell.at(-1);
  const commit = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || null;
  return {
    checks,
    providers: (vault?.providers ?? []).map((p) => ({ slug: p.slug, name: p.name, category: p.category, set: p.set, enabled: p.enabled, backend: p.backend, note: p.note,
      keys: p.keys, last_changed_at: p.last_changed_at, last_used_at: p.last_used_at })),
    needs: (vault?.runs.needs ?? []).map((x) => ({ slug: x.slug, name: x.name, set: x.set, why: x.why })),
    release: {
      runtime: onVercel() ? "vercel" : "server",
      commit,
      instance_started_at: STARTED_AT,
      last_migration: latest ? { version: Number(latest.version), name: String(latest.name), applied_at: iso(latest.applied_at) } : null,
      mold: { schema: newest ? `${String(newest.version).padStart(4, "0")}_${newest.name}` : null, package: pkgVersion || null },
    },
  };
}
