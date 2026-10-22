/**
 * The last 24 hours (or `?hours=168`, a week), hour by hour, for the sparklines on Health › Jobs and Sessions and on
 * every Compute tab (GET /compute/trends). Queue, running, orchestrators, our sandboxes in use and free boat sandboxes
 * are the autoscaler's samples averaged per hour (autoscaler_ticks), with its ticks, tick errors and the orchestrators
 * it launched and reaped counted per hour; the rest are counted from the records by the hour they happened: sessions
 * by when they ended (failed, the window's top failure class, model spend) or started (wait, sandbox starts),
 * orchestrators by when they were created (launches, failed launches) or deleted (unexpected reaps), sandboxes deleted
 * from compute_events, and jobs by when they were created. Admin only, across orgs.
 */
import { getDb } from "./db.js";
import { researchJobs, sessionEngine } from "./host-tables.js";
import { classifySession } from "./error-classes.js";
import { groupOrchestratorEnds } from "./compute-jobs.js";

type Series = Record<string, number[]>;

export async function computeTrends(q: { hours?: unknown } = {}) {
  const HOURS = Number(q.hours) === 168 ? 168 : 24;
  const db = await getDb();
  const end = Math.floor(Date.now() / 3_600_000) + 1, start = end - HOURS;
  const from = new Date(start * 3_600_000);
  const hour = (c: string) => `floor(extract(epoch FROM ${c}) / 3600)::bigint`;
  const s: Series = {};
  const put = (k: string, rows: { h: unknown; v: unknown }[], round = false) => {
    const out = Array.from({ length: HOURS }, () => 0);
    for (const r of rows) {
      const i = Number(r.h) - start;
      if (i >= 0 && i < HOURS) out[i] = round ? Math.round(Number(r.v ?? 0) * 100) / 100 : Number(r.v ?? 0);
    }
    s[k] = out;
  };

  // Sessions, simulations and research are the session engine's, a host pack's tables (mold_v0-049): none without them.
  const eng = sessionEngine(), none = <T,>() => Promise.resolve([] as T[]);
  const [ticks, ended, waits, orch, jobs, failed, deletes] = await Promise.all([
    db.query<{ h: unknown; queued: unknown; running: unknown; research: unknown; orchestrators: unknown; unclaimable: unknown; in_use: unknown; free: unknown;
               ticks: unknown; tick_errors: unknown; launched: unknown; reaped: unknown }>(
      `SELECT ${hour("at")} AS h, avg(queued) AS queued, avg(running) AS running, avg(research) AS research, avg(orchestrators) AS orchestrators,
              avg(unclaimable) AS unclaimable, avg(coalesce(orchestrators, 0) + coalesce(running, 0)) AS in_use, avg(greatest(free, 0)) AS free,
              count(*) AS ticks, count(*) FILTER (WHERE error IS NOT NULL) AS tick_errors,
              sum(jsonb_array_length(launched)) AS launched, sum(jsonb_array_length(reaped)) AS reaped
         FROM autoscaler_ticks WHERE at >= $1 GROUP BY 1`, [from]),
    !eng ? none<{ h: unknown; ended: unknown; failed: unknown; usd: unknown }>() : db.query<{ h: unknown; ended: unknown; failed: unknown; usd: unknown }>(
      `/* tenant: internal: admin Health trends across all orgs */
       SELECT ${hour("ended_at")} AS h, count(*) AS ended, count(*) FILTER (WHERE status IN ('failed', 'timeout')) AS failed, coalesce(sum(cost_usd), 0) AS usd
         FROM agent_sessions WHERE ended_at >= $1 GROUP BY 1`, [from]),
    !eng ? none<{ h: unknown; v: unknown; starts: unknown }>() : db.query<{ h: unknown; v: unknown; starts: unknown }>(
      `/* tenant: internal: admin Health trends across all orgs */
       SELECT ${hour("started_at")} AS h, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM started_at - queued_at)) AS v,
              count(*) FILTER (WHERE sandbox_id IS NOT NULL) AS starts
         FROM agent_sessions WHERE started_at >= $1 GROUP BY 1`, [from]),
    // Each orchestrator row once: launched in the window (by created_at) and/or ended in it (by deleted_at).
    db.query<{ created_h: unknown; deleted_h: unknown; state: string; launch_step: string | null; launch_error: string | null; reap_reason: string | null; error: string | null; ready_at: Date | null; at: Date }>(
      `SELECT ${hour("created_at")} AS created_h, ${hour("deleted_at")} AS deleted_h, state, launch_step, launch_error, reap_reason, error, ready_at,
              coalesce(deleted_at, created_at) AS at
         FROM orchestrator_sandboxes WHERE created_at >= $1 OR deleted_at >= $1 LIMIT 20000`, [from]),
    !eng ? none<{ h: unknown; jobs: unknown; failed: unknown }>() : db.query<{ h: unknown; jobs: unknown; failed: unknown }>(
      `/* tenant: internal: admin Health trends across all orgs */
       SELECT h, sum(jobs) AS jobs, sum(failed) AS failed FROM (
         SELECT ${hour("s.created_at")} AS h, count(*) AS jobs,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM agent_sessions a WHERE a.simulation_id = s.id AND a.status IN ('failed', 'timeout'))) AS failed
           FROM simulations s WHERE s.created_at >= $1 GROUP BY 1${researchJobs() ? `
         UNION ALL
         SELECT ${hour("created_at")} AS h, count(*) AS jobs, count(*) FILTER (WHERE status = 'failed') AS failed
           FROM product_research WHERE created_at >= $1 GROUP BY 1` : ""}) x GROUP BY h`, [from]),
    !eng ? none<{ h: unknown; status: string; agent_id: string | null; error_message: string | null; completed_reason: string | null; infra_error: string | null }>()
    : db.query<{ h: unknown; status: string; agent_id: string | null; error_message: string | null; completed_reason: string | null; infra_error: string | null }>(
      `/* tenant: internal: admin Health trends, classified into counts across all orgs */
       SELECT ${hour("ended_at")} AS h, status, agent_id, error_message, completed_reason, metadata->>'infra_error' AS infra_error
         FROM agent_sessions WHERE status IN ('failed', 'timeout') AND ended_at >= $1 ORDER BY ended_at DESC LIMIT 5000`, [from]),
    db.query<{ h: unknown; v: unknown }>(
      `SELECT ${hour("at")} AS h, count(*) AS v FROM compute_events
        WHERE kind IN ('reaped', 'worker_deleted', 'orphan_deleted', 'image_builder_deleted') AND at >= $1 GROUP BY 1`, [from]),
  ]);

  for (const k of ["queued", "running", "research", "orchestrators", "unclaimable", "in_use", "free"] as const)
    put(k, ticks.map((r) => ({ h: r.h, v: r[k] })), true);
  for (const k of ["ticks", "tick_errors", "launched", "reaped"] as const) put(k, ticks.map((r) => ({ h: r.h, v: r[k] })));
  put("ended", ended.map((r) => ({ h: r.h, v: r.ended })));
  put("failed", ended.map((r) => ({ h: r.h, v: r.failed })));
  put("spend", ended.map((r) => ({ h: r.h, v: r.usd })), true);
  put("wait_p50", waits, true);
  // Orchestrator launches (all, failed) by the hour created; reaps the autoscaler does not do as routine, by the hour deleted.
  const tally = (rows: { h: unknown }[]) => [...rows.reduce((m, r) => m.set(Number(r.h), (m.get(Number(r.h)) ?? 0) + 1), new Map<number, number>())].map(([h, v]) => ({ h, v }));
  const launchedIn = orch.filter((r) => r.created_h != null && Number(r.created_h) >= start);
  put("launches", tally(launchedIn.map((r) => ({ h: r.created_h }))));
  put("launches_failed", tally(launchedIn.filter((r) => r.launch_step != null).map((r) => ({ h: r.created_h }))));
  put("reaps", tally(orch.filter((r) => r.state === "deleted" && r.deleted_h != null && Number(r.deleted_h) >= start)
    .filter((r) => groupOrchestratorEnds([{ ...r, deleted: true }]).reaps.some((g) => !g.routine)).map((r) => ({ h: r.deleted_h }))));
  // Our boat sandbox starts: orchestrators launched plus worker sandboxes for sessions that started.
  const sessionStarts = new Map(waits.map((r) => [Number(r.h), Number(r.starts ?? 0)]));
  put("starts", [...new Set([...sessionStarts.keys(), ...launchedIn.map((r) => Number(r.created_h))])].map((h) => ({
    h, v: (sessionStarts.get(h) ?? 0) + launchedIn.filter((r) => Number(r.created_h) === h).length })));
  put("deletes", deletes);
  put("jobs", jobs.map((r) => ({ h: r.h, v: r.jobs })));
  put("jobs_failed", jobs.map((r) => ({ h: r.h, v: r.failed })));
  // The window's most common failure class, hour by hour.
  const classed = failed.map((f) => ({ h: Number(f.h), key: classifySession({ ...f, metadata: { infra_error: f.infra_error } })?.key ?? null }));
  const classes = new Map<string, number>();
  for (const c of classed) if (c.key) classes.set(c.key, (classes.get(c.key) ?? 0) + 1);
  const top = [...classes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const byHour = new Map<number, number>();
  for (const c of classed) if (top && c.key === top) byHour.set(c.h, (byHour.get(c.h) ?? 0) + 1);
  put("top_failure", [...byHour].map(([h, v]) => ({ h, v })));
  return { from: from.toISOString(), hours: HOURS, series: s };
}
