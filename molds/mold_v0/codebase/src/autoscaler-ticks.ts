import { getDb } from "./db.js";
import type { TickState } from "./autoscaler.js";

/**
 * The autoscaler's history (sql/schema.sql `autoscaler_ticks`, docs/compute-and-traces-spec.md §2.4, §2.5), read by
 * the Compute page's Activity chart and Autoscaler decisions log. Only the leader writes, after its tick: a row for a
 * tick that acted (launched, reaped, or its note or error changed since the last row), and otherwise a sample row
 * (acted = false) once the last row is a minute old. That is about 1,440 samples a day plus the acting ticks. Writing
 * is best effort: a failed insert is logged and never fails the tick. Pruning runs from the cron and the VM loop,
 * never inside a tick.
 */

const n = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const badRequest = (msg: string) => Object.assign(new Error(msg), { status: 400 });

/** A sample row at most this often when nothing changes. */
export const SAMPLE_MS = 60_000;
export const TICK_RETENTION_DAYS = 14;
export const EVENT_RETENTION_DAYS = 90;

export interface PrevTick { at: Date | string; note: string | null; error: string | null }

/** Pure: did this tick change anything worth a decision row. A note or error that repeats tick after tick is not news. */
export function tickActed(st: TickState, prev: PrevTick | null): boolean {
  if (st.launched?.length || st.reaped?.length) return true;
  return (st.error ?? null) !== (prev?.error ?? null) || (st.note ?? null) !== (prev?.note ?? null);
}

/** Pure: what to write for this tick: an acting row, a minute sample, or nothing (a follower writes nothing). */
export function tickWrite(st: TickState, prev: PrevTick | null): "acted" | "sample" | null {
  if (!st.leader) return null;
  if (tickActed(st, prev)) return "acted";
  if (!prev || Date.parse(st.at) - new Date(prev.at).getTime() >= SAMPLE_MS) return "sample";
  return null;
}

/** After a leader's tick: write its row when it acted or the last row is a minute old. */
export async function recordTick(st: TickState): Promise<void> {
  if (!st.leader) return;
  try {
    const db = await getDb();
    const [prev] = await db.query<PrevTick>("SELECT at, note, error FROM autoscaler_ticks ORDER BY at DESC LIMIT 1");
    const write = tickWrite(st, prev ?? null);
    if (!write) return;
    const [o] = await db.query<{ n: unknown }>("SELECT count(*) AS n FROM orchestrator_sandboxes WHERE state IN ('booting', 'running', 'draining')");
    const d = st.demand;
    await db.query(
      `INSERT INTO autoscaler_ticks (at, holder, acted, queued, running, research, unclaimable, orchestrators, desired, cap, active, free,
                                     demand, jobs, launched, reaped, note, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [st.at, st.holder, write === "acted",
       d ? d.queued_sessions : null, d ? Math.max(0, d.sessions - d.queued_sessions) : null, d ? d.research : null, d ? d.unclaimable_sessions : null,
       n(o?.n), st.desired ?? null, st.cap ?? null, st.active ?? null, st.free ?? null,
       d ? JSON.stringify(d) : null, st.jobs ? JSON.stringify(st.jobs) : null,
       JSON.stringify(st.launches ?? (st.launched ?? []).map((label) => ({ label }))), JSON.stringify(st.reaped ?? []),
       st.note?.slice(0, 2000) ?? null, st.error?.slice(0, 2000) ?? null]);
  } catch (e) {
    console.error(`autoscaler tick not recorded: ${(e as Error).message}`);
  }
}

/** Deletes history past its retention, 5,000 rows a table per call (the daily backlog is ~1,500 ticks). */
export async function pruneComputeHistory(): Promise<{ ticks: number; events: number }> {
  const db = await getDb();
  const del = async (table: string, days: number) => n((await db.query<{ n: unknown }>(
    `WITH d AS (DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE at < now() - make_interval(days => $1) LIMIT 5000) RETURNING 1)
     SELECT count(*) AS n FROM d`, [days]))[0]?.n);
  return { ticks: await del("autoscaler_ticks", TICK_RETENTION_DAYS), events: await del("compute_events", EVENT_RETENTION_DAYS) };
}

// ---------------------------------------------------------------- GET /compute/ticks (Autoscaler decisions)

interface TickDb {
  id: unknown; at: Date; holder: string | null; acted: boolean; queued: number | null; running: number | null; research: number | null;
  unclaimable: number | null; orchestrators: number | null; desired: number | null; cap: number | null; active: number | null; free: number | null;
  demand: unknown; jobs: unknown; launched: unknown; reaped: unknown; note: string | null; error: string | null; trace_id: string | null;
}
export interface Launched { row: number | null; job_id: string | null; pods: number | null; label: string | null;
  orchestrator_id: string | null; sandbox_id: string | null; state: string | null; launch_step: string | null }
export interface Reaped { sandbox_id: string; reason: string; row: number | null; orchestrator_id: string | null; job_id: string | null }

const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
const HAS = ["error", "launch", "reap"] as const;

/**
 * Decision rows, newest first. Acting ticks only unless `acted=0` (adds the minute samples). `has` is a comma list
 * of error, launch and reap (all must hold); `q` matches the note or the error. Launched rows are joined to their
 * orchestrator row (its orchestrator id and how it went), reaped sandboxes to theirs, so the page can link both.
 */
export async function listTicks(q: Record<string, unknown>) {
  const db = await getDb();
  const offset = Math.max(0, Math.floor(n(q.offset))), limit = Math.min(500, Math.max(1, Math.floor(n(q.limit)) || 25));
  const has = (str(q.has) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const bad = has.find((h) => !(HAS as readonly string[]).includes(h));
  if (bad) throw badRequest(`has must be a comma list of ${HAS.join(", ")}`);
  const where: string[] = [], params: unknown[] = [];
  const HAS_SQL: Record<(typeof HAS)[number], string> = { error: "error IS NOT NULL", launch: "jsonb_array_length(launched) > 0", reap: "jsonb_array_length(reaped) > 0" };
  const acted = str(q.acted) !== "0";
  if (acted) where.push("acted");
  for (const h of HAS) if (has.includes(h)) where.push(HAS_SQL[h]);
  const text = str(q.q);
  if (text) { params.push(`%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); where.push(`(note ILIKE $${params.length} OR error ILIKE $${params.length})`); }
  const from = `FROM autoscaler_ticks${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  // Facets: ticks each "has" choice would leave (with the ones picked, all must hold) and each minute-samples choice.
  const picked = has.map((h) => HAS_SQL[h as (typeof HAS)[number]]), all = (xs: string[]) => (xs.length ? xs.join(" AND ") : "true");
  const [f] = await db.query<Record<string, unknown>>(`SELECT ${HAS.map((h) => `count(*) FILTER (WHERE ${all([...(acted ? ["acted"] : []), ...picked, HAS_SQL[h]])}) AS has_${h}`).join(", ")},
      count(*) FILTER (WHERE ${all(["acted", ...picked])}) AS acted, count(*) FILTER (WHERE ${all(picked)}) AS every
      FROM autoscaler_ticks${text ? " WHERE (note ILIKE $1 OR error ILIKE $1)" : ""}`, params);
  const facets = { has: Object.fromEntries(HAS.map((h) => [h, n(f?.[`has_${h}`])])), samples: { "": n(f?.acted), "1": n(f?.every) } };
  const [{ total }] = await db.query<{ total: unknown }>(`SELECT count(*) AS total ${from}`, params);
  const rows = await db.query<TickDb>(`SELECT * ${from} ORDER BY at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, params);

  // Link what each tick launched and reaped to the orchestrator rows (one query each for the page).
  const launchedIds = [...new Set(rows.flatMap((r) => arr(r.launched).map((l) => Number(l.row)).filter((x) => Number.isInteger(x) && x > 0)))];
  const reapedIds = [...new Set(rows.flatMap((r) => arr(r.reaped).map((x) => String(x.sandbox_id ?? ""))).filter((s) => s && s !== "(none)"))];
  const orch = new Map((launchedIds.length ? await db.query<{ id: unknown; orchestrator_id: string | null; sandbox_id: string | null; state: string; launch_step: string | null }>(
    "SELECT id, orchestrator_id, sandbox_id, state, launch_step FROM orchestrator_sandboxes WHERE id = ANY($1::bigint[])", [launchedIds]) : []).map((o) => [n(o.id), o]));
  const bySandbox = new Map((reapedIds.length ? await db.query<{ id: unknown; orchestrator_id: string | null; sandbox_id: string; job_id: string | null }>(
    "SELECT id, orchestrator_id, sandbox_id, job_id FROM orchestrator_sandboxes WHERE sandbox_id = ANY($1::text[])", [reapedIds]) : []).map((o) => [o.sandbox_id, o]));

  return {
    total: n(total), facets,
    rows: rows.map((r) => ({
      id: n(r.id), at: iso(r.at)!, holder: r.holder, acted: r.acted,
      queued: r.queued, running: r.running, research: r.research, unclaimable: r.unclaimable, orchestrators: r.orchestrators,
      desired: r.desired, cap: r.cap, active: r.active, free: r.free,
      demand: r.demand ?? null, jobs: Array.isArray(r.jobs) ? r.jobs : null,
      launched: arr(r.launched).map((l): Launched => {
        const row = Number.isInteger(Number(l.row)) && Number(l.row) > 0 ? Number(l.row) : null;
        const o = row ? orch.get(row) : undefined;
        return { row, job_id: str(l.job_id), pods: l.pods == null ? null : n(l.pods), label: str(l.label),
                 orchestrator_id: o?.orchestrator_id ?? null, sandbox_id: o?.sandbox_id ?? null, state: o?.state ?? null, launch_step: o?.launch_step ?? null };
      }),
      reaped: arr(r.reaped).map((x): Reaped => {
        const o = bySandbox.get(String(x.sandbox_id ?? ""));
        return { sandbox_id: String(x.sandbox_id ?? ""), reason: String(x.reason ?? ""), row: o ? n(o.id) : null, orchestrator_id: o?.orchestrator_id ?? null, job_id: o?.job_id ?? null };
      }),
      note: r.note, error: r.error, trace_id: r.trace_id,
    })),
  };
}

// ---------------------------------------------------------------- GET /compute/activity (the Activity chart)

export interface ActivitySample { t: string; queued: number | null; running: number | null; research: number | null; orchestrators: number | null; gap: boolean }
interface Point { at: number; queued: number | null; running: number | null; research: number | null; orchestrators: number | null }

/**
 * Pure: one sample per bucket from the tick rows (sorted by time, one row before the window allowed). A bucket holds
 * the latest row at or before its end, as long as that row is at most `holdMs` old there: rows come about once a
 * minute, so a 1-minute bucket can fall between two of them without anything being missing. Past that, the bucket is
 * a gap (no autoscaler tick), never interpolated. The bucket still in progress is left out until it has a row.
 */
export function bucketActivity(points: Point[], from: number, to: number, bucketMs: number, holdMs: number): ActivitySample[] {
  const out: ActivitySample[] = [];
  let i = 0, last: Point | null = null;
  for (let s = Math.floor(from / bucketMs) * bucketMs; s < to; s += bucketMs) {
    const end = Math.min(s + bucketMs, to);
    let inBucket = false;
    while (i < points.length && points[i]!.at < end) { if (points[i]!.at >= s) inBucket = true; last = points[i]!; i++; }
    if (end === to && end < s + bucketMs && !inBucket) break;
    const fresh = last && end - last.at <= holdMs;
    out.push(fresh
      ? { t: new Date(s).toISOString(), queued: last!.queued, running: last!.running, research: last!.research, orchestrators: last!.orchestrators, gap: false }
      : { t: new Date(s).toISOString(), queued: null, running: null, research: null, orchestrators: null, gap: true });
  }
  return out;
}

export const ACTIVITY_MINUTES = [60, 120, 1440] as const;

/**
 * Queued, running and research work and live orchestrators over the last hour, 2 hours or day (1-minute buckets, 5
 * for a day), from the tick rows; launches (orchestrator rows created) and reaps (compute events) as markers.
 * `first_at` / `last_at` bound the whole history, for "recording started" and "no samples since".
 */
export async function computeActivity(q: Record<string, unknown>) {
  const db = await getDb();
  const minutes = q.minutes == null || q.minutes === "" ? 120 : Math.floor(n(q.minutes));
  if (!(ACTIVITY_MINUTES as readonly number[]).includes(minutes)) throw badRequest("minutes must be 60, 120 or 1440");
  const bucket_s = minutes === 1440 ? 300 : 60;
  // A VM ticks every 15 s and samples every minute; on Vercel ticks come from events and the 5-minute cron.
  const holdMs = Math.max(2 * bucket_s * 1000, process.env.VERCEL ? 6 * 60_000 : 150_000);
  const to = Date.now(), from = to - minutes * 60_000;
  const rows = await db.query<{ at: Date; queued: number | null; running: number | null; research: number | null; orchestrators: number | null }>(
    `(SELECT at, queued, running, research, orchestrators FROM autoscaler_ticks WHERE at < $1 ORDER BY at DESC LIMIT 1)
     UNION ALL
     (SELECT at, queued, running, research, orchestrators FROM autoscaler_ticks WHERE at >= $1 ORDER BY at LIMIT 20000)`, [new Date(from - holdMs)]);
  const points = rows.map((r) => ({ at: new Date(r.at).getTime(), queued: r.queued, running: r.running, research: r.research, orchestrators: r.orchestrators }))
    .sort((a, b) => a.at - b.at);
  const [bounds] = await db.query<{ first_at: Date | null; last_at: Date | null }>("SELECT min(at) AS first_at, max(at) AS last_at FROM autoscaler_ticks");

  const launches = await db.query<{ id: unknown; created_at: Date; orchestrator_id: string | null; sandbox_id: string | null; job_id: string | null; launch_step: string | null; launch_error: string | null }>(
    "SELECT id, created_at, orchestrator_id, sandbox_id, job_id, launch_step, launch_error FROM orchestrator_sandboxes WHERE created_at >= $1 ORDER BY created_at LIMIT 2000", [new Date(from)]);
  const reaps = await db.query<{ at: Date; orchestrator_id: string | null; sandbox_id: string | null; reason: string | null; row_id: unknown }>(
    `SELECT e.at, e.orchestrator_id, e.sandbox_id, e.reason, o.id AS row_id FROM compute_events e
       LEFT JOIN orchestrator_sandboxes o ON o.sandbox_id = e.sandbox_id
      WHERE e.kind = 'reaped' AND e.at >= $1 ORDER BY e.at LIMIT 2000`, [new Date(from)]);
  const events = [
    ...launches.map((l) => ({ at: iso(l.created_at)!, kind: "launch" as const, row_id: n(l.id), orchestrator_id: l.orchestrator_id, sandbox_id: l.sandbox_id,
      reason: l.launch_step ? `launch failed at ${l.launch_step}: ${l.launch_error ?? "no message"}` : l.job_id ? `for ${l.job_id}` : "shared fleet" })),
    ...reaps.map((r) => ({ at: iso(r.at)!, kind: "reap" as const, row_id: r.row_id == null ? null : n(r.row_id), orchestrator_id: r.orchestrator_id, sandbox_id: r.sandbox_id, reason: r.reason ?? "" })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return { minutes, bucket_s, from: new Date(from).toISOString(), to: new Date(to).toISOString(), first_at: iso(bounds?.first_at), last_at: iso(bounds?.last_at), samples: bucketActivity(points, from, to, bucket_s * 1000, holdMs), events };
}
