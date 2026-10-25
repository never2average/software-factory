import { getDb } from "./db.js";
import { researchJobs, sessionEngine } from "./host-tables.js";
import { AUTOSCALE, type TickState } from "./autoscaler.js";
import { agentRunnability, scheduledIds } from "./compute-records.js";
import { classifyOrchestrator, classifySession, FIX_LINKS, ROUTINE_REAPS, reapKind, type ReapKind, type SessionErrorKey } from "./error-classes.js";
import { BOAT_PRICE_PER_HOUR } from "../orchestrator/core/config.js";
import * as lib from "../orchestrator/deploy/boat-lib.js";
import { ENGINE_SETTINGS } from "./settings.js";
import { jobKinds } from "./runs.js";
import { RUN_USD } from "./run-spend.js";
import { word } from "./vocabulary.js";
import { reportRange } from "./insights.js";

/**
 * The Compute page's Jobs table and Failures by reason (docs/compute-and-traces-spec.md §2.2 F, G). A job is a
 * simulation or a research job (a product's, or a prospect's from an access request); its state, why it waits and
 * its spend are worked out here from its sessions, its orchestrators and the autoscaler's last tick, so the page and
 * the server agree. Read only: nothing here cancels, drains or requeues.
 *
 * Spend follows §2.1: sessions' own cost_usd, the job's orchestrators' gateway totals (the only spend a research job
 * has), and the sandbox estimate (workers' boat_est_cost_usd plus each orchestrator's lifetime on boat's small machine).
 */

const n = (v: unknown) => Number(v ?? 0) || 0;
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const ms = (d: unknown) => (d ? new Date(d as string).getTime() : null);
const usd = (x: number) => Math.round(x * 10_000) / 10_000;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { status: 404 });
const badRequest = (msg: string) => Object.assign(new Error(msg), { status: 400 });
const RANGES: Record<string, number> = { "1h": 1, "24h": 24, "7d": 168 };

// ---------------------------------------------------------------- state and why it waits (pure, smoke-tested)

export type JobState = "waiting" | "queued" | "booting" | "running" | "draining" | "failed" | "finished";
export const JOB_STATES: readonly JobState[] = ["waiting", "queued", "booting", "running", "draining", "failed", "finished"];

export interface JobFacts {
  /** The job row says it failed (research only: a simulation has no failed status). */
  failed: boolean;
  finished: boolean;
  /** States of the job's orchestrators that are not deleted (a shared fleet's, for a simulation in shared mode). */
  orchestrators: string[];
  running_sessions: number;
  research_running: boolean;
  queued_work: boolean;
  /** In the last tick's jobs[] with served = false. */
  unserved: boolean;
}

/** §2.2 F status rules, first match wins. */
export function jobState(f: JobFacts): JobState {
  if (f.failed) return "failed";
  if (f.finished) return "finished";
  if (f.orchestrators.includes("draining")) return "draining";
  if ((f.orchestrators.includes("running") && f.running_sessions > 0) || f.research_running) return "running";
  if (f.orchestrators.includes("booting")) return "booting";
  if ((f.queued_work && !f.orchestrators.length) || f.unserved) return "waiting";
  return "queued";
}

export interface Why { text: string; note: string | null; free: number | null; needed: number | null; cap: number | null }

/**
 * Why a job that is not served waits, in plain English, from the last tick's note (src/autoscaler.ts scaleJobs writes
 * one clause per job it skipped, joined by "; "). `unclaimable`: it has queued sessions, none of them for a scheduled
 * agent, so no orchestrator would claim them. Null when nothing explains a wait (the job is served).
 */
export function whyWaiting(job: { id: string; kind: "simulation" | "research"; unfinished: number; unclaimable: boolean },
  tick: Pick<TickState, "enabled" | "note" | "jobs" | "free" | "cap"> | null, opts: { per_job: boolean; job_pod_capacity: number; live_orchestrators: number }): Why | null {
  const needed = 1 + (job.kind === "simulation" ? Math.min(opts.job_pod_capacity, Math.max(1, job.unfinished)) : 0);
  const base = { free: tick?.free ?? null, needed, cap: tick?.cap ?? null };
  if (job.unclaimable) return { text: "Agents not scheduled: none of its queued sessions is for an agent in the harness mix", note: null, ...base };
  if (tick && tick.enabled === false) return { text: "The autoscaler is off", note: tick.note ?? null, ...base };
  if (!opts.per_job) return opts.live_orchestrators ? null : { text: "No orchestrator yet", note: tick?.note ?? null, ...base };
  const entry = tick?.jobs?.find((j) => j.id === job.id);
  if (entry?.served) return null;
  const notes = (tick?.note ?? "").split("; ").filter(Boolean);
  const own = notes.find((x) => x.includes(job.id));
  const boat = own && /waits for boat plan capacity \((-?\d+) free\)/.exec(own);
  if (boat) {
    const free = Math.max(0, Number(boat[1]));
    return { text: `Waiting for boat capacity (${free} free, needs ${needed})`, note: own!, ...base, free };
  }
  if (own?.startsWith("cooldown:")) return { text: "Relaunch cooldown: its orchestrator idled out with sessions it could not claim", note: own, ...base };
  const cap = entry && notes.find((x) => x.startsWith(`at ${ENGINE_SETTINGS.maxJobOrchestrators}`));
  if (cap) return { text: `At the orchestrator limit (${tick?.cap ?? "?"} per-job orchestrators)`, note: cap, ...base };
  return { text: "No orchestrator yet", note: own ?? null, ...base };
}

// ---------------------------------------------------------------- the rows

interface JobDb {
  id: string; kind: "simulation" | "research" | "prospect"; status: string; name: string | null; created_at: Date; started_at: Date | null;
  heartbeat_at: Date | null; finished_at: Date | null; org_slug: string | null; org_name: string | null; product_id: number | null; product_name: string | null;
  company: string | null; stage: string | null; note: string | null; error: string | null; attempts: number | null; searches: number | null;
}
interface OrchDb {
  id: number; orchestrator_id: string | null; sandbox_id: string | null; job_id: string | null; state: string; pods: number | null;
  created_at: Date; ready_at: Date | null; deleted_at: Date | null; error: string | null; launch_step: string | null; launch_error: string | null;
  reap_reason: string | null; meta: { running?: Record<string, number> } | null; model_usd: unknown;
}
interface SesAgg {
  simulation_id: string; queued: unknown; running: unknown; completed: unknown; failed: unknown; timeout: unknown; cancelled: unknown;
  claimable: unknown; oldest_queued: Date | null; model_usd: unknown; sandbox_usd: unknown;
}

const SIM_SQL = `SELECT /* tenant: internal: admin Compute page, jobs across all orgs (admin only) */
    s.id, 'simulation' AS kind, s.status, s.name, s.created_at, s.started_at, NULL::timestamptz AS heartbeat_at, s.finished_at,
    o.slug AS org_slug, o.name AS org_name, p.id AS product_id, p.name AS product_name, NULL AS company,
    NULL AS stage, NULL AS note, NULL AS error, NULL::int AS attempts, NULL::int AS searches
  FROM simulations s JOIN organizations o ON o.id = s.org_id LEFT JOIN products p ON p.id = s.product_id`;
const RSH_SQL = `SELECT /* tenant: internal: admin Compute page, research jobs across all orgs (admin only) */
    r.id, CASE WHEN r.kind = 'prospect' THEN 'prospect' ELSE 'research' END AS kind, r.status, NULL AS name, r.created_at, r.started_at,
    r.heartbeat_at, r.finished_at, o.slug AS org_slug, o.name AS org_name, p.id AS product_id, p.name AS product_name, a.company,
    r.stage, r.note, r.error, r.attempts, r.searches
  FROM product_research r LEFT JOIN organizations o ON o.id = r.org_id LEFT JOIN products p ON p.id = r.product_id
  LEFT JOIN access_requests a ON a.id = r.request_id`;

/** The autoscaler's last tick, as its lease row holds it. */
async function lastTick(): Promise<TickState | null> {
  const db = await getDb();
  const [lease] = await db.query<{ state: TickState | null }>("SELECT state FROM autoscaler_lease WHERE name = 'autoscaler'");
  return lease?.state && Object.keys(lease.state).length ? lease.state : null;
}

const orchHours = (o: OrchDb, now: number) => Math.max(0, ((ms(o.deleted_at) ?? now) - new Date(o.created_at).getTime()) / 3_600_000);
const orchSandboxUsd = (o: OrchDb, now: number) => orchHours(o, now) * (BOAT_PRICE_PER_HOUR[lib.ORCH_SANDBOX_TYPE] ?? 0);
const runningOf = (o: OrchDb) => Object.values(o.meta?.running ?? {}).reduce((a, b) => a + n(b), 0);

/**
 * Build the rows for these job records: one query each for their sessions, failures and orchestrators, then the
 * state rules and the wait reason against the last tick.
 */
async function buildRows(jobs: JobDb[]) {
  const db = await getDb();
  const now = Date.now();
  const ids = jobs.map((j) => j.id), simIds = jobs.filter((j) => j.kind === "simulation").map((j) => j.id);
  const scheduled = await scheduledIds();
  const agents = scheduled ? [...scheduled] : [];
  const agg = new Map((simIds.length ? await db.query<SesAgg>(
    `/* tenant: internal: admin Compute page, sessions of the listed jobs by simulation id */
     SELECT simulation_id, count(*) FILTER (WHERE status = 'queued') AS queued, count(*) FILTER (WHERE status = 'running') AS running,
            count(*) FILTER (WHERE status = 'completed') AS completed, count(*) FILTER (WHERE status = 'failed') AS failed,
            count(*) FILTER (WHERE status = 'timeout') AS timeout, count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
            count(*) FILTER (WHERE status = 'queued' AND (agent_id IS NULL OR cardinality($2::text[]) = 0 OR agent_id = ANY($2))) AS claimable,
            min(queued_at) FILTER (WHERE status = 'queued') AS oldest_queued, coalesce(sum(cost_usd), 0) AS model_usd,
            coalesce(sum(CASE WHEN jsonb_typeof(metadata->'boat_est_cost_usd') = 'number' THEN (metadata->>'boat_est_cost_usd')::numeric END), 0) AS sandbox_usd
       FROM agent_sessions WHERE simulation_id = ANY($1) GROUP BY simulation_id`, [simIds, agents]) : []).map((r) => [r.simulation_id, r]));
  // Failures per simulation and the most common class (the shared classifier, src/error-classes.ts).
  const fails = new Map<string, Map<string, { label: string; count: number }>>();
  if (simIds.length) {
    const rows = await db.query<{ simulation_id: string; status: string; error_message: string | null; completed_reason: string | null; infra_error: string | null }>(
      `/* tenant: internal: admin Compute page, failed sessions of the listed jobs by simulation id */
       SELECT simulation_id, status, left(error_message, 2000) AS error_message, completed_reason, metadata->>'infra_error' AS infra_error
         FROM agent_sessions WHERE simulation_id = ANY($1) AND status IN ('failed', 'timeout') LIMIT 20000`, [simIds]);
    for (const r of rows) {
      const c = classifySession({ ...r, metadata: { infra_error: r.infra_error } });
      if (!c) continue;
      const m = fails.get(r.simulation_id) ?? new Map();
      const e = m.get(c.key) ?? { label: c.label, count: 0 };
      e.count++; m.set(c.key, e); fails.set(r.simulation_id, m);
    }
  }
  const orchs = ids.length ? await db.query<OrchDb>(
    `SELECT o.id, o.orchestrator_id, o.sandbox_id, o.job_id, o.state, o.pods, o.created_at, o.ready_at, o.deleted_at, o.error, o.launch_step,
            o.launch_error, o.reap_reason, f.meta,
            (SELECT /* tenant: internal: admin Compute page, gateway spend summed per orchestrator id */ coalesce(sum(g.cost_usd), 0)
               FROM gateway_usage g WHERE g.orchestrator_id = o.orchestrator_id) AS model_usd
       FROM orchestrator_sandboxes o LEFT JOIN orchestrators f ON f.id = o.orchestrator_id
      WHERE o.job_id = ANY($1) ORDER BY o.created_at DESC, o.id DESC`, [ids]) : [];
  const byJob = new Map<string, OrchDb[]>();
  for (const o of orchs) byJob.set(o.job_id!, [...(byJob.get(o.job_id!) ?? []), o]);
  const perJob = AUTOSCALE.perJob();
  const shared = perJob ? [] : await db.query<OrchDb>("SELECT state FROM orchestrator_sandboxes WHERE job_id IS NULL AND state <> 'deleted'");
  const tick = await lastTick();
  const opts = { per_job: perJob, job_pod_capacity: AUTOSCALE.jobPodCapacity() };

  return jobs.map((j) => {
    const sim = j.kind === "simulation";
    const a = agg.get(j.id);
    const mine = byJob.get(j.id) ?? [];
    const live = mine.filter((o) => o.state !== "deleted");
    const liveStates = [...live, ...(sim ? shared : [])].map((o) => o.state);
    const sessions = sim ? { queued: n(a?.queued), running: n(a?.running), completed: n(a?.completed), failed: n(a?.failed), timeout: n(a?.timeout), cancelled: n(a?.cancelled) } : null;
    const queuedWork = sim ? n(a?.queued) > 0 : j.status === "queued";
    const unclaimable = sim && n(a?.queued) > 0 && n(a?.claimable) === 0;
    const entry = tick?.jobs?.find((x) => x.id === j.id);
    const state = jobState({ failed: j.status === "failed", finished: !!j.finished_at || (sim && ["completed", "cancelled"].includes(j.status)),
      orchestrators: liveStates, running_sessions: n(a?.running), research_running: !sim && j.status === "running", queued_work: queuedWork, unserved: entry?.served === false });
    const why = state === "waiting" || state === "queued"
      ? whyWaiting({ id: j.id, kind: sim ? "simulation" : "research", unfinished: n(a?.queued) + n(a?.running), unclaimable }, tick, { ...opts, live_orchestrators: liveStates.length })
      : null;
    const top = [...(fails.get(j.id)?.entries() ?? [])].sort((x, y) => y[1].count - x[1].count)[0];
    const failedLaunches = mine.filter((o) => classifyOrchestrator(o)?.key.startsWith("launch:")).length;
    const current = live[0] ?? mine[0] ?? null;
    const runningOrch = live.find((o) => o.state === "running");
    const orchModel = mine.reduce((s, o) => s + n(o.model_usd), 0);
    const sandbox = mine.reduce((s, o) => s + orchSandboxUsd(o, now), 0) + n(a?.sandbox_usd);
    const sessionModel = n(a?.model_usd);
    return {
      id: j.id, kind: j.kind, name: j.name, status: j.status,
      org: j.org_slug ? { slug: j.org_slug, name: j.org_name! } : null, company: j.company,
      product: j.product_id ? { id: j.product_id, name: j.product_name! } : null,
      state, why_waiting: why?.text ?? null, note: why?.note ?? null,
      sessions, research: sim ? null : { stage: j.stage, attempts: n(j.attempts) },
      orchestrator: current ? { id: current.id, orchestrator_id: current.orchestrator_id, state: current.state } : null,
      orchestrators_total: mine.length, failed_launches: failedLaunches,
      pods: { running: live.reduce((s, o) => s + runningOf(o), 0), reserved: live.reduce((s, o) => s + n(o.pods), 0) },
      created_at: iso(j.created_at), finished_at: iso(j.finished_at),
      waiting_since: sim ? iso(a?.oldest_queued) : j.status === "queued" ? iso(j.created_at) : null,
      running_since: iso(runningOrch?.ready_at ?? (!sim && j.status === "running" ? j.started_at : null)),
      failures: { count: sim ? n(a?.failed) + n(a?.timeout) : j.status === "failed" ? 1 : 0, top_key: top?.[0] ?? null, top_label: top?.[1].label ?? null },
      spend: { session_model_usd: usd(sessionModel), orchestrator_model_usd: usd(orchModel), sandbox_est_usd: usd(sandbox), total_usd: usd(sessionModel + orchModel + sandbox) },
      // For the peek; the table does not show them.
      _why: why, _orchs: mine, _tick_free: tick?.free ?? null,
    };
  });
}
type Built = Awaited<ReturnType<typeof buildRows>>[number];
const publicRow = ({ _why, _orchs, _tick_free, ...r }: Built) => r;
export type JobRow = ReturnType<typeof publicRow>;

const ORDER: Record<JobState, number> = { waiting: 0, queued: 1, booting: 2, running: 3, draining: 4, failed: 5, finished: 6 };

/**
 * Jobs that are active, or finished within `since` (1h by default), waiting first, then running, then finished.
 * Filters: `state` (a JobState, "active" or "all"), `kind` (simulation, research, prospect), `q` (job id, account,
 * product or company), `has_failures=1`, `sort=spend`. `include` adds one job whatever the filters (a deep link).
 * At most 2,000 candidate jobs are read; state is worked out per job, so the filters run after. `facets` counts the
 * jobs each state, kind and failures choice would match under the other filters (the `include` row aside).
 */
export async function listJobs(q: Record<string, unknown>) {
  const db = await getDb();
  const offset = Math.max(0, Math.floor(n(q.offset))), limit = Math.min(500, Math.max(1, Math.floor(n(q.limit)) || 25));
  const since = str(q.since) ?? "1h";
  if (!(since in RANGES)) throw badRequest("since must be 1h, 24h or 7d");
  const state = str(q.state) ?? "all";
  if (!["all", "active", ...JOB_STATES].includes(state)) throw badRequest(`state must be all, active or one of ${JOB_STATES.join(", ")}`);
  const kind = str(q.kind);
  if (kind && !["simulation", "research", "prospect"].includes(kind)) throw badRequest("kind must be simulation, research or prospect");
  const include = str(q.include);
  const hours = RANGES[since];
  const recent = (t: string) => `(${t}.status IN ('queued', 'running') OR coalesce(${t}.finished_at, ${t}.created_at) > now() - make_interval(hours => $1) OR ${t}.id = $2)`;
  // Every kind is read (the kind filter runs after, with the others) so the Kind facet can count each one. Jobs are the
  // session engine's, a host pack's tables (mold_v0-049): a build without them has none.
  const [sims, rsh] = await Promise.all([
    !sessionEngine() ? [] : db.query<JobDb>(`${SIM_SQL} WHERE ${recent("s")} ORDER BY s.created_at DESC LIMIT 2000`, [hours, include]),
    !researchJobs() ? [] : db.query<JobDb>(`${RSH_SQL} WHERE ${recent("r")} ORDER BY r.created_at DESC LIMIT 2000`, [hours, include]),
  ]);
  const needle = str(q.q)?.toLowerCase();
  let rows = (await buildRows([...sims, ...rsh])).map(publicRow);
  const okState = (r: JobRow, s: string) => s === "all" || (s === "active" ? !["finished", "failed"].includes(r.state) : r.state === s);
  const okFail = (r: JobRow) => r.failures.count > 0 || r.failed_launches > 0;
  const okText = (r: JobRow) => !needle || [r.id, r.name, r.org?.name, r.org?.slug, r.product?.name, r.company].some((x) => x?.toLowerCase().includes(needle));
  const keep = (r: JobRow, skip?: "state" | "kind" | "fail") => okText(r)
    && (skip === "state" || okState(r, state)) && (skip === "kind" || !kind || r.kind === kind) && (skip === "fail" || q.has_failures !== "1" || okFail(r));
  // The deep-linked row is read whatever its age; it counts only when it is in the range like the rest.
  const inWindow = (r: JobRow) => r.id !== include || ["queued", "running"].includes(r.status) || Date.parse(r.finished_at ?? r.created_at ?? "") > Date.now() - hours * 3_600_000;
  const count = (skip: "state" | "kind" | "fail", by: (r: JobRow) => string[]) => {
    const out: Record<string, number> = {};
    for (const r of rows) if (inWindow(r) && keep(r, skip)) for (const k of ["", ...by(r)]) out[k] = (out[k] ?? 0) + 1;
    return out;
  };
  const facets = {
    state: count("state", (r) => ["all", r.state, ...(okState(r, "active") ? ["active"] : [])]),
    kind: count("kind", (r) => [r.kind]),
    has_failures: count("fail", (r) => (okFail(r) ? ["1"] : [])),
  };
  rows = rows.filter((r) => keep(r) || r.id === include);
  const at = (d: string | null) => (d ? Date.parse(d) : Infinity);
  rows.sort(q.sort === "spend"
    // Metered model spend only: the sandbox figure is a price-table estimate.
    ? (a, b) => (b.spend.session_model_usd + b.spend.orchestrator_model_usd) - (a.spend.session_model_usd + a.spend.orchestrator_model_usd)
    : (a, b) => ORDER[a.state] - ORDER[b.state]
      || (ORDER[a.state] >= ORDER.failed ? at(b.finished_at ?? b.created_at) - at(a.finished_at ?? a.created_at)
        : at(a.waiting_since ?? a.running_since ?? a.created_at) - at(b.waiting_since ?? b.running_since ?? b.created_at)));
  if (include) rows.sort((a, b) => Number(b.id === include) - Number(a.id === include));
  return { total: rows.length, facets, rows: rows.slice(offset, offset + limit) };
}

/**
 * One job for its peek: the row, why it waits (with the numbers compared), its sessions by agent with whether each
 * agent can run, its orchestrators, and research details.
 */
export async function jobDetail(id: string) {
  if (!sessionEngine()) throw notFound("Job"); // no session engine tables in this build (mold_v0-049)
  const db = await getDb();
  const found = (await db.query<JobDb>(`${SIM_SQL} WHERE s.id = $1`, [id]))[0] ?? (researchJobs() ? (await db.query<JobDb>(`${RSH_SQL} WHERE r.id = $1`, [id]))[0] : undefined);
  if (!found) throw notFound("Job");
  const [built] = await buildRows([found]);
  const now = Date.now();
  let agents: { agent_id: string | null; harness: string; queued: number; running: number; completed: number; failed: number; usd: number; runnable: { ok: boolean; reason: string } | null }[] = [];
  if (found.kind === "simulation") {
    const scheduled = await scheduledIds();
    const runnable = new Map((await agentRunnability()).rows.map((r) => [r.agent_id, r]));
    agents = (await db.query<{ agent_id: string | null; harness: string; queued: unknown; running: unknown; completed: unknown; failed: unknown; usd: unknown }>(
      `/* tenant: internal: admin Compute page, sessions of one job by simulation id */
       SELECT agent_id, harness, count(*) FILTER (WHERE status = 'queued') AS queued, count(*) FILTER (WHERE status = 'running') AS running,
              count(*) FILTER (WHERE status = 'completed') AS completed, count(*) FILTER (WHERE status IN ('failed', 'timeout')) AS failed,
              coalesce(sum(cost_usd), 0) AS usd
         FROM agent_sessions WHERE simulation_id = $1 GROUP BY agent_id, harness ORDER BY count(*) DESC`, [id]))
      .map((r) => {
        const run = r.agent_id ? runnable.get(r.agent_id) : undefined;
        const notScheduled = !!scheduled && !!r.agent_id && !scheduled.has(r.agent_id);
        return { agent_id: r.agent_id, harness: r.harness, queued: n(r.queued), running: n(r.running), completed: n(r.completed), failed: n(r.failed), usd: usd(n(r.usd)),
          runnable: notScheduled ? { ok: false, reason: "Not in the harness mix, so no orchestrator claims its sessions." }
            : run ? { ok: run.runnable, reason: run.reason } : null };
      });
  }
  const orchestrators = built._orchs.map((o) => {
    const why = classifyOrchestrator(o);
    return { id: o.id, orchestrator_id: o.orchestrator_id, sandbox_id: o.sandbox_id, state: o.state, created_at: iso(o.created_at),
      boot_ms: o.ready_at ? new Date(o.ready_at).getTime() - new Date(o.created_at).getTime() : null,
      lifetime_s: Math.round(orchHours(o, now) * 3600), end_reason: why ? { key: why.key, label: why.label, routine: why.routine, message: why.message } : null };
  });
  const research = found.kind === "simulation" ? null : {
    status: found.status, stage: found.stage, note: found.note, attempts: n(found.attempts), searches: n(found.searches), heartbeat_at: iso(found.heartbeat_at), error: found.error };
  const w = built._why;
  return { job: publicRow(built), why: w ? { text: w.text, note: w.note, free: w.free, needed: w.needed, cap: w.cap } : null, agents, orchestrators, research };
}

// ---------------------------------------------------------------- failures by reason (GET /compute/failures)

const UNATTENDED: Record<string, string> = {
  worker_deleted: "Worker deleted with its orchestrator", orphan_deleted: "Orphan orchestrator deleted", image_builder_deleted: "Stale image builder deleted",
};
const LAUNCH_STEP_LABEL: Record<string, string> = {
  create: "Create the sandbox", name: "Name the sandbox", ready: "Sandbox ready", "code upload": "Upload code", configure: "Configure", preflight: "Preflight", start: "Start",
};

export interface EndRow { at: Date | string; launch_step?: string | null; launch_error?: string | null; reap_reason?: string | null; error?: string | null; ready_at?: Date | string | null; deleted?: boolean }

/**
 * Orchestrator launches and reaps grouped by reason: failed launches by step, reaps by normalized reason (routine ones
 * flagged: the autoscaler doing its job), each with a count, when it last happened and the latest message. Pure.
 */
export function groupOrchestratorEnds(rows: EndRow[]) {
  const launches = new Map<string, { step: string; label: string; count: number; last_at: number; message: string }>();
  const reaps = new Map<string, { reason: ReapKind; key: string; label: string; routine: boolean; count: number; last_at: number; message: string }>();
  for (const r of rows) {
    const c = classifyOrchestrator(r);
    if (!c) continue;
    const at = new Date(r.at).getTime();
    if (c.key.startsWith("launch:")) {
      const step = c.key.slice(7);
      const g = launches.get(step) ?? { step, label: LAUNCH_STEP_LABEL[step] ?? step, count: 0, last_at: 0, message: "" };
      g.count++; if (at >= g.last_at) { g.last_at = at; g.message = c.message; }
      launches.set(step, g);
    } else if (r.deleted !== false) {
      const { kind, label } = reapKind(c.message);
      const g = reaps.get(kind) ?? { reason: kind, key: c.key, label, routine: ROUTINE_REAPS.has(kind), count: 0, last_at: 0, message: "" };
      g.count++; if (at >= g.last_at) { g.last_at = at; g.message = c.message; }
      reaps.set(kind, g);
    }
  }
  const out = <T extends { count: number; last_at: number }>(m: Map<string, T>) =>
    [...m.values()].sort((a, b) => b.count - a.count || b.last_at - a.last_at).map((g) => ({ ...g, last_at: new Date(g.last_at).toISOString() }));
  // Failures first, routine reaps after (the page shows them muted below a divider).
  return { launches: out(launches), reaps: out(reaps).sort((a, b) => Number(a.routine) - Number(b.routine)) };
}

export interface FailedSession { status: string; agent_id: string | null; simulation_id: string; error_message: string | null; completed_reason: string | null; infra_error: string | null; at: Date | string }

/**
 * Session failures grouped by class: count, share of the sessions that ended in the window, jobs affected, the agent
 * most of them ran, when it last happened and the page that fixes it. Queued sessions no orchestrator will claim are
 * a class too (`unclaimable`); they have not ended, so their share is null. Pure.
 */
export function groupSessionFailures(rows: FailedSession[], ended: number, scheduled: ReadonlySet<string> | null) {
  const groups = new Map<SessionErrorKey, { label: string; fix: keyof typeof FIX_LINKS | null; count: number; jobs: Set<string>; agents: Map<string, number>; last_at: number }>();
  for (const r of rows) {
    const c = classifySession({ ...r, metadata: { infra_error: r.infra_error } }, { scheduled: scheduled ?? undefined });
    if (!c) continue;
    const g = groups.get(c.key) ?? { label: c.label, fix: c.fix, count: 0, jobs: new Set(), agents: new Map(), last_at: 0 };
    g.count++; g.jobs.add(r.simulation_id);
    if (r.agent_id) g.agents.set(r.agent_id, (g.agents.get(r.agent_id) ?? 0) + 1);
    g.last_at = Math.max(g.last_at, new Date(r.at).getTime());
    groups.set(c.key, g);
  }
  return [...groups.entries()].map(([key, g]) => ({
    key, label: g.label, count: g.count, share: key === "unclaimable" || !ended ? null : Math.round((g.count / ended) * 1000) / 1000,
    jobs: g.jobs.size, top_agent: [...g.agents.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, last_at: new Date(g.last_at).toISOString(),
    fix: g.fix ? { text: FIX_LINKS[g.fix].label, href: FIX_LINKS[g.fix].href } : null,
  })).sort((a, b) => b.count - a.count);
}

/** Failures by reason over the last `hours` (24 or 168): orchestrator launches and reaps, unattended deletes, sessions. */
export async function computeFailures(q: Record<string, unknown>) {
  const hours = n(q.hours) || 24;
  if (![24, 168].includes(hours)) throw badRequest("hours must be 24 or 168");
  const db = await getDb();
  const orch = await db.query<EndRow & { state: string; created_at: Date; deleted_at: Date | null }>(
    `SELECT state, created_at, deleted_at, coalesce(deleted_at, created_at) AS at, launch_step, launch_error, reap_reason, error, ready_at
       FROM orchestrator_sandboxes WHERE coalesce(deleted_at, created_at) > now() - make_interval(hours => $1)`, [hours]);
  const { launches, reaps } = groupOrchestratorEnds(orch.map((r) => ({ ...r, deleted: r.state === "deleted" })));
  const unattended = (await db.query<{ kind: string; count: unknown; last_at: Date; message: string | null }>(
    `SELECT kind, count(*) AS count, max(at) AS last_at, (array_agg(reason ORDER BY at DESC))[1] AS message FROM compute_events
      WHERE kind IN ('worker_deleted', 'orphan_deleted', 'image_builder_deleted') AND at > now() - make_interval(hours => $1) GROUP BY kind ORDER BY count(*) DESC`, [hours]))
    .map((e) => ({ kind: e.kind, label: UNATTENDED[e.kind] ?? e.kind, count: n(e.count), last_at: iso(e.last_at), message: e.message }));
  const scheduled = await scheduledIds();
  // Sessions are the session engine's, a host pack's table (mold_v0-049): a build without it has none.
  if (!sessionEngine()) return { hours, launches, reaps, unattended, sessions: groupSessionFailures([], 0, scheduled), ended: 0 };
  const failed = await db.query<FailedSession>(
    `/* tenant: internal: admin Compute page, failed and unclaimable sessions across all orgs (admin only) */
     SELECT status, agent_id, simulation_id, left(error_message, 2000) AS error_message, completed_reason, metadata->>'infra_error' AS infra_error,
            coalesce(ended_at, queued_at) AS at
       FROM agent_sessions
      WHERE (status IN ('failed', 'timeout') AND ended_at > now() - make_interval(hours => $1))
         OR (status = 'queued' AND agent_id IS NOT NULL AND cardinality($2::text[]) > 0 AND NOT agent_id = ANY($2))
      ORDER BY coalesce(ended_at, queued_at) DESC LIMIT 20000`, [hours, scheduled ? [...scheduled] : []]);
  const [{ ended }] = await db.query<{ ended: unknown }>(
    "/* tenant: internal: admin Compute page, sessions that ended across all orgs (a count) */ SELECT count(*) AS ended FROM agent_sessions WHERE ended_at > now() - make_interval(hours => $1)", [hours]);
  return { hours, launches, reaps, unattended, sessions: groupSessionFailures(failed, n(ended), scheduled), ended: n(ended) };
}

// ---------------------------------------------------------------- the packs' runs per job kind (mold_v0-104)

const RUN_RANGES: Record<string, number> = { "24h": 24, "7d": 168, "30d": 720 };
/**
 * FinOps' runs tab (mold_v0-104; on FinOps since mold_v0-126, where it took the pricing Experiments tab's place) in a
 * build without the session engine (whose Jobs and Sessions tables are its own): every job kind the packs declare, by its label (the pack's words), with how its runs in the range ended, across every account, what
 * they cost, how long they took and the latest failure. Kinds with no run in the range are listed too (zero), and a
 * kind runs still carry but no pack declares any more is listed under its name. Read only.
 */
export async function runKinds(q: Record<string, unknown>) {
  // A period (from, to: YYYY-MM-DD, FinOps' date range), else the last `since` (24h, 7d, 30d).
  const period = typeof q.from === "string" && typeof q.to === "string" ? reportRange(q) : null;
  const since = period ? null : typeof q.since === "string" && RUN_RANGES[q.since] ? q.since : "7d";
  const hours = period ? Math.round((period.end.getTime() - period.start.getTime()) / 3_600_000) : RUN_RANGES[since!]!;
  const start = period ? period.start : new Date(Date.now() - hours * 3_600_000), end = period ? period.end : new Date(Date.now() + 60_000);
  const kinds = jobKinds();
  const rows = !kinds.length ? [] : await (await getDb()).query<{ pack: string; kind: string; total: unknown; queued: unknown; running: unknown; succeeded: unknown;
    failed: unknown; cancelled: unknown; accounts: unknown; usd: unknown; avg_s: unknown; last_at: Date | null; last_error: string | null; last_failed_at: Date | null }>(
    `/* tenant: internal: admin Health (onboarding admin routes), every account's runs */
     SELECT r.pack, r.kind, count(*) AS total, count(*) FILTER (WHERE r.status = 'queued') AS queued, count(*) FILTER (WHERE r.status = 'running') AS running,
            count(*) FILTER (WHERE r.status = 'succeeded') AS succeeded, count(*) FILTER (WHERE r.status = 'failed') AS failed,
            count(*) FILTER (WHERE r.status = 'cancelled') AS cancelled, count(DISTINCT r.org_id) AS accounts, coalesce(sum(${RUN_USD}), 0) AS usd,
            avg(extract(epoch FROM r.ended_at - r.started_at)) FILTER (WHERE r.ended_at IS NOT NULL AND r.started_at IS NOT NULL) AS avg_s,
            max(r.created_at) AS last_at, (array_agg(r.error ORDER BY r.created_at DESC) FILTER (WHERE r.status = 'failed'))[1] AS last_error,
            max(r.ended_at) FILTER (WHERE r.status = 'failed') AS last_failed_at
       FROM runs r WHERE r.created_at >= $1 AND r.created_at < $2 GROUP BY r.pack, r.kind`, [start, end]);
  const by = new Map(rows.map((r) => [`${r.pack}/${r.kind}`, r]));
  const shape = (pack: string, name: string, label: string, description: string | null) => {
    const r = by.get(`${pack}/${name}`);
    by.delete(`${pack}/${name}`);
    return { pack, kind: name, label, description, total: n(r?.total), queued: n(r?.queued), running: n(r?.running), succeeded: n(r?.succeeded),
      failed: n(r?.failed), cancelled: n(r?.cancelled), accounts: n(r?.accounts), usd: usd(n(r?.usd)), avg_seconds: r?.avg_s == null ? null : Math.round(n(r.avg_s)),
      last_at: iso(r?.last_at), last_error: r?.last_error ?? null, last_failed_at: iso(r?.last_failed_at) };
  };
  const list = kinds.map((k) => shape(k.pack, k.name, k.label ?? k.name, k.description ?? null));
  for (const r of [...by.values()]) list.push(shape(r.pack, r.kind, r.kind, null));
  return { since, hours, range: period ? { from: period.from, to: period.to } : null, words: { one: word("Run"), many: word("Runs") }, kinds: list };
}
