import { getDb } from "./db.js";
import { sessionEngine } from "./host-tables.js";
import { AUTOSCALE } from "./autoscaler.js";
import { scheduledAgents, variantsOf } from "./agents.js";
import { currentPopulation } from "./agent-mix.js";
import { currentCodeHash } from "./fleet.js";
import { agentKeyCoverage, classifiedSandboxes, type ClassifiedSandbox } from "./compute.js";
import { classifyOrchestrator, classifySession, FIX_LINKS, type SessionErrorKey } from "./error-classes.js";
import { BOAT_SETUP_HARNESSES } from "./harness-setup.js";
import { BOAT_PRICE_PER_HOUR } from "../orchestrator/core/config.js";
import * as lib from "../orchestrator/deploy/boat-lib.js";

/**
 * The Compute page's record tables (docs/compute-and-traces-spec.md §2.2 F2, F3): agent sessions and orchestrators,
 * each a list with filters and one record for the side peek, plus which scheduled agents can actually run. Read only:
 * nothing here cancels, drains or deletes. Sessions and orchestrators are across all organizations (admin only).
 *
 * Spend follows §2.1: a session's model $ is its own cost_usd (gateway rows are shown as detail, never added), a
 * worker sandbox's is the estimate the orchestrator wrote, an orchestrator's model $ is its gateway total and its
 * sandbox $ is its lifetime on boat's small machine at the price table's rate.
 */

const n = (v: unknown) => Number(v ?? 0) || 0;
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const usd = (x: number) => Math.round(x * 10_000) / 10_000;
const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { status: 404 });
const badRequest = (msg: string) => Object.assign(new Error(msg), { status: 400 });
const list = (v: unknown) => (typeof v === "string" && v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const page = (q: Record<string, unknown>, def: number) => ({
  offset: Math.max(0, Math.floor(n(q.offset))), limit: Math.min(500, Math.max(1, Math.floor(n(q.limit)) || def)),
});
/** A heartbeat older than this is amber on the page (and "stale" for a running orchestrator). */
const HEARTBEAT_STALE_S = 90;

/** The agent ids the current population schedules (with their model variants). Null when there is no population. */
export async function scheduledIds(): Promise<Set<string> | null> {
  try { return new Set(scheduledAgents(await currentPopulation()).flatMap((a) => [a.id, ...variantsOf(a).map((v) => v.id)])); }
  catch { return null; }
}

// ---------------------------------------------------------------- runnability (GET /compute/agents/runnable)

export interface Runnable { agent_id: string; harness: string; has_setup_script: boolean; missing_env: string[]; runnable: boolean; reason: string }

const NO_SETUP = "No setup script: runs only if boat's preinstalled CLI matches the pin (checked inside the sandbox at run time).";

/**
 * For each scheduled agent: whether its harness has a boat setup script, and which of the env vars its sessions need
 * no vault key covers (the same rule the credentials broker applies). Runnable means nothing is missing; without a
 * setup script it still runs if boat's preinstalled CLI happens to match, which only the sandbox can tell.
 */
export async function agentRunnability(): Promise<{ rows: Runnable[] }> {
  const rows = (await agentKeyCoverage()).map((a): Runnable => {
    const has = BOAT_SETUP_HARNESSES.includes(a.harness);
    const runnable = a.missing_env.length === 0;
    const reason = !runnable ? `No vault key for ${a.missing_env.join(", ")}. Add it in Key vault.` : has ? "Ready to run." : NO_SETUP;
    return { agent_id: a.agent_id, harness: a.harness, has_setup_script: has, missing_env: a.missing_env, runnable, reason };
  });
  return { rows: rows.sort((a, b) => Number(a.runnable) - Number(b.runnable) || a.agent_id.localeCompare(b.agent_id)) };
}

// ---------------------------------------------------------------- sessions (GET /compute/sessions)

const STATUSES = ["queued", "running", "completed", "failed", "timeout", "cancelled"];
const RANGES: Record<string, number> = { "1h": 1, "24h": 24, "7d": 168 };
const SORTS: Record<string, string> = {
  recent: "coalesce(s.ended_at, s.started_at, s.queued_at) DESC",
  queued_at: "s.queued_at ASC",
  wait: "coalesce(s.started_at, now()) - s.queued_at DESC",
  ended_at: "s.ended_at DESC NULLS LAST",
};

interface SessionDb {
  id: string; simulation_id: string; org_slug: string; org_name: string; agent_id: string | null; harness: string; model: string; status: string;
  attempt: number; infra_retries: string | null; infra_error: string | null; queued_at: Date; started_at: Date | null; heartbeat_at: Date | null;
  ended_at: Date | null; completed_reason: string | null; error_message: string | null; worker_id: string | null; sandbox_id: string | null;
  cost_usd: unknown; sandbox_est: string | null;
}

const SESSION_COLS = `s.id, s.simulation_id, o.slug AS org_slug, o.name AS org_name, s.agent_id, s.harness, s.model, s.status, s.attempt,
  s.metadata->>'infra_retries' AS infra_retries, s.metadata->>'infra_error' AS infra_error, s.queued_at, s.started_at, s.heartbeat_at,
  s.ended_at, s.completed_reason, s.error_message, s.worker_id, s.sandbox_id, s.cost_usd,
  CASE WHEN jsonb_typeof(s.metadata->'boat_est_cost_usd') = 'number' THEN s.metadata->>'boat_est_cost_usd' END AS sandbox_est`;

function sessionRow(r: SessionDb, scheduled: Set<string> | null) {
  const c = classifySession({ ...r, metadata: { infra_error: r.infra_error } }, { scheduled: scheduled ?? undefined });
  return {
    id: r.id, simulation_id: r.simulation_id, org: { slug: r.org_slug, name: r.org_name }, agent_id: r.agent_id, harness: r.harness, model: r.model,
    status: r.status, attempt: n(r.attempt), infra_retries: n(r.infra_retries), queued_at: iso(r.queued_at), started_at: iso(r.started_at),
    heartbeat_at: iso(r.heartbeat_at), ended_at: iso(r.ended_at), completed_reason: r.completed_reason,
    error_class: c?.key ?? null, error_label: c?.label ?? null, error_message: r.error_message, worker_id: r.worker_id, sandbox_id: r.sandbox_id,
    cost_usd: usd(n(r.cost_usd)), sandbox_est_usd: r.sandbox_est == null ? null : usd(n(r.sandbox_est)),
  };
}
export type SessionRow = ReturnType<typeof sessionRow>;

/**
 * Sessions matching the filters, newest activity first (or by `sort`). Queued and running sessions are always in the
 * range; others count from when they last moved. The error class is worked out here (src/error-classes.ts), so a
 * `class` filter reads up to 5,000 matching rows and filters them; every other filter is SQL. `include` adds one
 * session whatever the filters (a deep link to its peek).
 */
export async function listSessions(q: Record<string, unknown>) {
  const db = await getDb();
  const { offset, limit } = page(q, 50);
  const where: string[] = [], params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const status = list(q.status).filter((s) => STATUSES.includes(s));
  const agents = list(q.agent);
  if (agents.length) where.push(`s.agent_id = ANY(${p(agents)})`);
  for (const [k, col] of [["harness", "s.harness"], ["model", "s.model"], ["reason", "s.completed_reason"], ["job_id", "s.simulation_id"]] as const) {
    const v = str(q[k]);
    if (v) where.push(`${col} = ${p(v)}`);
  }
  const since = str(q.since) ?? "24h";
  if (!(since in RANGES)) throw badRequest("since must be 1h, 24h or 7d");
  where.push(`(s.status IN ('queued', 'running') OR coalesce(s.ended_at, s.started_at, s.queued_at) > now() - make_interval(hours => ${p(RANGES[since])}))`);
  // Status and heartbeat stay apart from the rest (and their params last) so the facets can count each under the others.
  const base = where.join(" AND "), nBase = params.length;
  const statusCond = status.length ? `s.status = ANY(${p(status)})` : null, stale = q.stale_heartbeat === "1";
  const cond = [base, statusCond, stale ? STALE : null].filter(Boolean).join(" AND ");
  const sort = SORTS[str(q.sort) ?? "recent"];
  if (!sort) throw badRequest("sort must be recent, queued_at, wait or ended_at");
  // Sessions are the session engine's, a host pack's table (mold_v0-049): a build without it has none.
  if (!sessionEngine()) return { total: 0, facets: { status: {}, class: { "": 0 }, stale: { "": 0, "1": 0 } }, rows: [] };
  const include = str(q.include);
  const incP = include ? p(include) : null;
  const match = incP ? `((${cond}) OR s.id = ${incP})` : cond;
  const cls = str(q.class) as SessionErrorKey | null;
  const scheduled = await scheduledIds();
  const from = `${SESSION_FROM} WHERE ${match}`;
  const facets = await sessionFacets({ base, params: params.slice(0, nBase), status, stale, cls, scheduled });

  if (cls) {
    const rows = (await db.query<SessionDb>(`SELECT ${SESSION_COLS} ${from} ORDER BY ${sort} LIMIT 5000`, params))
      .map((r) => sessionRow(r, scheduled)).filter((r) => r.error_class === cls || r.id === include);
    return { total: rows.length, facets, rows: rows.slice(offset, offset + limit) };
  }
  const [{ total }] = await db.query<{ total: unknown }>(`SELECT count(*) AS total ${from}`, params);
  const rows = await db.query<SessionDb>(`SELECT ${SESSION_COLS} ${from} ORDER BY ${incP ? `(s.id = ${incP}) DESC, ` : ""}${sort} LIMIT ${limit} OFFSET ${offset}`, params);
  return { total: n(total), facets, rows: rows.map((r) => sessionRow(r, scheduled)) };
}

const SESSION_FROM = `/* tenant: internal: admin Compute page, sessions across all orgs (admin only) */
    FROM agent_sessions s JOIN organizations o ON o.id = s.org_id`;
/** A running session with no heartbeat for 5 minutes (the Heartbeat filter). */
const STALE = "(s.status = 'running' AND coalesce(s.heartbeat_at, s.started_at) < now() - interval '5 minutes')";

/**
 * Sessions each status, failure class and heartbeat choice matches under the other filters ("" is the dropdown's
 * "any"; the `include` row aside). `base` holds every filter but those three. Status and heartbeat count in SQL;
 * failure classes are worked out per row, so up to 5,000 sessions that can have one (queued, failed, timed out, or
 * ended with a reason) are read and classified, and with a class filter the status and heartbeat counts come from them.
 */
async function sessionFacets(f: { base: string; params: unknown[]; status: string[]; stale: boolean; cls: SessionErrorKey | null; scheduled: Set<string> | null }) {
  const db = await getDb();
  const bump = (out: Record<string, number>, k: string) => { out[k] = (out[k] ?? 0) + 1; };
  const statusOk = (s: string) => !f.status.length || f.status.includes(s);
  const sp = `$${f.params.length + 1}`, withStatus = f.status.length ? [...f.params, f.status] : f.params;
  const [classed, [hb], byStatus] = await Promise.all([
    db.query<SessionDb & { stale: boolean }>(
      `SELECT s.id, s.status, s.agent_id, s.completed_reason, s.error_message, s.metadata->>'infra_error' AS infra_error, ${STALE} AS stale
        ${SESSION_FROM} WHERE ${f.base} AND (s.status IN ('queued', 'failed', 'timeout') OR s.completed_reason IS NOT NULL) LIMIT 5000`, f.params),
    db.query<{ n_any: unknown; n_stale: unknown }>(
      `SELECT count(*) AS n_any, count(*) FILTER (WHERE ${STALE}) AS n_stale ${SESSION_FROM} WHERE ${f.base}${f.status.length ? ` AND s.status = ANY(${sp})` : ""}`, withStatus),
    f.cls ? Promise.resolve([]) : db.query<{ status: string; n: unknown }>(
      `SELECT s.status, count(*) AS n ${SESSION_FROM} WHERE ${f.base}${f.stale ? ` AND ${STALE}` : ""} GROUP BY 1`, f.params),
  ]);
  const rows = classed.map((r) => ({ status: r.status, stale: !!r.stale,
    key: classifySession({ ...r, metadata: { infra_error: r.infra_error } }, { scheduled: f.scheduled ?? undefined })?.key ?? null }));
  const status: Record<string, number> = {}, cls: Record<string, number> = {}, stale: Record<string, number> = {};
  for (const r of rows) if (r.key && statusOk(r.status) && (!f.stale || r.stale)) bump(cls, r.key);
  cls[""] = n(f.stale ? hb?.n_stale : hb?.n_any);
  if (f.cls) {
    for (const r of rows) if (r.key === f.cls) {
      if (!f.stale || r.stale) bump(status, r.status);
      if (statusOk(r.status)) { bump(stale, ""); if (r.stale) bump(stale, "1"); }
    }
  } else {
    for (const r of byStatus) status[r.status] = n(r.n);
    Object.assign(stale, { "": n(hb?.n_any), "1": n(hb?.n_stale) });
  }
  return { status, class: cls, stale };
}

/** Metadata keys the session peek shows; everything else (environment, adapter internals) stays out. */
const SESSION_META = ["wall_ms", "harness_runs", "agent_turns", "max_agent_turns", "simulated_user_turns", "max_user_turns", "developer_nudges",
  "done_reason", "changed_files", "exit_code", "exit_signal", "infra_retries", "infra_error", "boat_sandbox_id", "boat_sandbox_type",
  "boat_sandbox_seconds", "boat_est_cost_usd", "runner", "orchestrator_status", "orchestrator_note", "cancelled_by", "cancelled_at", "cancelled_from"] as const;

/** One session for its peek: the row, timing and run metadata, gateway rows, a fix hint, runnability and the last 20 events. */
export async function sessionDetail(id: string) {
  if (!sessionEngine()) throw notFound("Session"); // no session engine tables in this build (mold_v0-049)
  const db = await getDb();
  const [r] = await db.query<SessionDb & { tokens_in: unknown; tokens_out: unknown; metadata: Record<string, unknown> }>(
    `/* tenant: internal: admin Compute page, one session by id (admin only) */
     SELECT ${SESSION_COLS}, s.tokens_in, s.tokens_out, s.metadata FROM agent_sessions s JOIN organizations o ON o.id = s.org_id WHERE s.id = $1`, [id]);
  if (!r) throw notFound("Session");
  const scheduled = await scheduledIds();
  const session = { ...sessionRow(r, scheduled), tokens_in: n(r.tokens_in), tokens_out: n(r.tokens_out) };
  const metadata = Object.fromEntries(SESSION_META.filter((k) => r.metadata?.[k] !== undefined).map((k) => [k, r.metadata[k]]));
  const gateway = (await db.query<Record<string, unknown>>(
    `/* tenant: internal: admin Compute page, gateway usage of one session by id */
     SELECT provider, sum(requests) AS requests, sum(errors) AS errors, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
            sum(cost_usd) AS cost_usd, max(last_at) AS last_at
       FROM gateway_usage WHERE session_id = $1 GROUP BY provider ORDER BY provider`, [id]))
    .map((g) => ({ provider: String(g.provider), requests: n(g.requests), errors: n(g.errors), input_tokens: n(g.input_tokens), output_tokens: n(g.output_tokens),
                   cost_usd: usd(n(g.cost_usd)), last_at: iso(g.last_at) }));
  const transcript = (await db.query<{ seq: number; ts: Date; type: string; text: string }>(
    `/* tenant: internal: admin Compute page, the last events of one session by id */
     SELECT seq, ts, type, left(text, 300) AS text FROM transcript_events WHERE session_id = $1 ORDER BY seq DESC LIMIT 20`, [id]))
    .reverse().map((e) => ({ seq: n(e.seq), ts: iso(e.ts), type: e.type, text: e.text }));
  // The orchestrator that ran it: the fleet row whose worker id claimed it, else (it has ended) the job's orchestrator alive then.
  const [orch] = r.worker_id ? await db.query<{ id: number; orchestrator_id: string | null }>(
    `SELECT o.id, o.orchestrator_id FROM orchestrator_sandboxes o LEFT JOIN orchestrators f ON f.id = o.orchestrator_id
      WHERE f.meta->>'worker_id' = $1 OR (o.job_id = $2 AND o.created_at <= coalesce($3::timestamptz, now()) AND coalesce(o.deleted_at, now()) >= coalesce($3::timestamptz, now()))
      ORDER BY (f.meta->>'worker_id' = $1) DESC NULLS LAST, o.id DESC LIMIT 1`, [r.worker_id, r.simulation_id, r.started_at]) : [];
  const runnable = ["unclaimable", "harness_install", "credentials"].includes(session.error_class ?? "")
    ? (await agentRunnability()).rows.find((a) => a.agent_id === r.agent_id) ?? null : null;
  return { session, metadata, gateway, hint: sessionHint(session, r.error_message ?? r.infra_error ?? ""), runnable, transcript,
           orchestrator: orch ? { id: orch.id, orchestrator_id: orch.orchestrator_id } : null };
}

/** What to do about a failure class, with the page that fixes it. */
export function sessionHint(s: { error_class: string | null; agent_id: string | null; harness: string }, message: string): { text: string; href: string } | null {
  const env = /No vault provider supplies ([A-Z][A-Z0-9_]*(?:, [A-Z][A-Z0-9_]*)*)/.exec(message)?.[1];
  switch (s.error_class) {
    case "credentials": return { text: env ? `Missing key ${env}. Add it in Key vault.` : "A provider key is missing. Add it in Key vault.", href: FIX_LINKS.key_vault.href };
    case "boat_permission": return { text: "The boat key may not create sandboxes. Replace it in Key vault.", href: FIX_LINKS.key_vault.href };
    case "unclaimable": return { text: `${s.agent_id ?? "This agent"} is not in the scheduled population, so no orchestrator claims it. Turn it on in Harness mix.`, href: FIX_LINKS.harness_mix.href };
    case "harness_install": return { text: `The ${s.harness} CLI could not be installed in the sandbox. Check its pin in Harness mix.`, href: FIX_LINKS.harness_mix.href };
    case "time_cap": return { text: "It ran past the session time limit (MAX_SESSION_MINUTES). It is set in the deployment environment, shown in Compute › Environment.", href: FIX_LINKS.environment.href };
    case "agent": return { text: "The agent stopped on its own (gave up, or hit a turn or time cap). Those caps are set in the deployment environment, shown in Compute › Environment.", href: FIX_LINKS.environment.href };
    default: return null;
  }
}

// ---------------------------------------------------------------- orchestrators (GET /compute/orchestrators)

export const ORCH_STATES = ["live", "booting", "running", "draining", "stale", "failed_launch", "ended", "unmatched", "all"] as const;
export type OrchState = (typeof ORCH_STATES)[number];

interface OrchDb {
  id: number; sandbox_id: string | null; orchestrator_id: string | null; job_id: string | null; state: string; pods: number | null;
  created_at: Date; ready_at: Date | null; last_seen: Date | null; deleted_at: Date | null; retiring_since: Date | null; code_hash: string | null;
  from_image: string | null; timings: Record<string, number> | null; error: string | null; launch_step: string | null; launch_error: string | null;
  reap_reason: string | null; fleet_seen: Date | null; meta: { running?: Record<string, number>; worker_id?: string } | null; model_usd: unknown;
}

const ORCH_COLS = `o.id, o.sandbox_id, o.orchestrator_id, o.job_id, o.state, o.pods, o.created_at, o.ready_at, o.last_seen, o.deleted_at, o.retiring_since,
  o.code_hash, o.from_image, o.timings, o.error, o.launch_step, o.launch_error, o.reap_reason, f.last_seen AS fleet_seen, f.meta,
  (SELECT /* tenant: internal: admin Compute page, gateway spend summed per orchestrator id */ coalesce(sum(g.cost_usd), 0)
     FROM gateway_usage g WHERE g.orchestrator_id = o.orchestrator_id) AS model_usd`;
const ORCH_FROM = "FROM orchestrator_sandboxes o LEFT JOIN orchestrators f ON f.id = o.orchestrator_id";

/** The SQL for a state chip. Stale: booting past the boot limit, or running with no check-in for 90 s. */
function stateWhere(state: OrchState): string {
  const boot = `make_interval(mins => ${Math.max(1, Math.round(AUTOSCALE.bootMinutes()))})`;
  switch (state) {
    case "live": return "o.state <> 'deleted'";
    case "booting": case "running": case "draining": return `o.state = '${state}'`;
    case "stale": return `((o.state = 'booting' AND o.created_at < now() - ${boot})
      OR (o.state = 'running' AND coalesce(f.last_seen, o.last_seen, o.ready_at) < now() - interval '${HEARTBEAT_STALE_S} seconds'))`;
    case "failed_launch": return "o.launch_step IS NOT NULL";
    case "ended": return "o.state = 'deleted' AND o.deleted_at > now() - interval '24 hours'";
    default: return "true";
  }
}

/** The thresholds the page colours by (amber heartbeat, stuck boot), so the table and the server agree. */
const recordLimits = () => ({ boot_minutes: AUTOSCALE.bootMinutes(), stale_minutes: AUTOSCALE.staleMinutes(), heartbeat_stale_s: HEARTBEAT_STALE_S });

const ttlOf = (s: ClassifiedSandbox | undefined, now: number) => (s?.archiveAfter ? Math.round((Date.parse(s.archiveAfter) - now) / 1000) : null);

function orchRow(r: OrchDb, sb: Map<string, ClassifiedSandbox>, now: number, current: string | null) {
  const s = r.sandbox_id ? sb.get(r.sandbox_id) : undefined;
  const ended = r.state === "deleted";
  const running = Object.fromEntries(Object.entries(r.meta?.running ?? {}).map(([k, v]) => [k, n(v)]).filter(([, v]) => (v as number) > 0));
  const heartbeat = r.fleet_seen ?? r.last_seen;
  const hours = ((r.deleted_at ? new Date(r.deleted_at).getTime() : now) - new Date(r.created_at).getTime()) / 3_600_000;
  const why = classifyOrchestrator(r);
  return {
    id: r.id, sandbox_id: r.sandbox_id, orchestrator_id: r.orchestrator_id, job_id: r.job_id, state: r.state, boat_state: s?.state ?? null,
    state_since: iso(ended ? r.deleted_at : r.state === "booting" ? r.created_at : r.state === "draining" ? r.retiring_since ?? r.ready_at : r.ready_at ?? r.created_at),
    running_by_agent: running, running: Object.values(running).reduce((a: number, b) => a + (b as number), 0),
    pods: r.pods ?? (r.job_id ? 0 : AUTOSCALE.podCapacity()), heartbeat_at: iso(heartbeat),
    boot_ms: r.ready_at ? new Date(r.ready_at).getTime() - new Date(r.created_at).getTime() : null, from_image: r.from_image, timings: r.timings,
    ttl_left_s: ended ? null : ttlOf(s, now), code_hash: r.code_hash, current_code: !!current && r.code_hash === current, retiring_since: iso(r.retiring_since),
    launch_step: why?.key.startsWith("launch:") ? why.key.slice(7) : null, launch_error: why?.key.startsWith("launch:") ? why.message : null,
    reap_reason: why?.key.startsWith("reap:") ? why.message : null, end_class: why ? { key: why.key, label: why.label, routine: why.routine } : null,
    created_at: iso(r.created_at), ready_at: iso(r.ready_at), deleted_at: iso(r.deleted_at), worker_id: r.meta?.worker_id ?? null,
    spend: { orchestrator_model_usd: usd(n(r.model_usd)), sandbox_est_usd: usd(Math.max(0, hours) * (BOAT_PRICE_PER_HOUR[lib.ORCH_SANDBOX_TYPE] ?? 0)) },
  };
}
export type OrchRow = ReturnType<typeof orchRow>;

export type UnmatchedKind = "worker_no_parent" | "orch_no_row" | "image_builder" | "other_prefix";
/**
 * boat sandboxes that match nothing of ours that is live: a worker whose orchestrator is gone, an orchestrator-named
 * sandbox with no row, the image builder, and other deployments' sandboxes on the same account. Snapshot images are
 * kept on purpose and are not listed. Pure; smoke-tested.
 */
export function unmatchedSandboxes(sbs: ClassifiedSandbox[], live: { sandbox_id: string | null; orchestrator_id: string | null }[], now = Date.now()) {
  const ids = new Set(live.map((r) => r.sandbox_id).filter(Boolean)), orchIds = new Set(live.map((r) => r.orchestrator_id).filter(Boolean));
  const kindOf = (s: ClassifiedSandbox): UnmatchedKind | null =>
    s.kind === "worker" ? (s.parent_orchestrator_id && orchIds.has(s.parent_orchestrator_id) ? null : "worker_no_parent")
      : s.kind === "orchestrator" ? (ids.has(s.id) ? null : "orch_no_row")
      : s.kind === "image_builder" ? "image_builder" : s.kind === "other" ? "other_prefix" : null;
  return sbs.filter((s) => s.live).flatMap((s) => {
    const kind = kindOf(s);
    return kind ? [{ sandbox_id: s.id, name: s.name ?? null, kind, parent_orchestrator_id: s.parent_orchestrator_id, created_at: s.createdAt ?? null,
      boat_state: s.state, ttl_left_s: ttlOf(s, now) }] : [];
  });
}

/**
 * Orchestrators for a state chip, newest first, each with boat's live state and TTL when boat answered. "unmatched"
 * swaps in boat's sandboxes that match no live row instead. `include` adds one row whatever the chip (a deep link).
 */
export async function listOrchestrators(q: Record<string, unknown>) {
  const db = await getDb();
  const { offset, limit } = page(q, 25);
  const state = (str(q.state) ?? "live") as OrchState;
  if (!ORCH_STATES.includes(state)) throw badRequest(`state must be one of ${ORCH_STATES.join(", ")}`);
  const listing = await classifiedSandboxes();
  const boat = { ok: listing.ok, stale: listing.stale, error: listing.error };
  const now = Date.now();
  if (state === "unmatched") {
    const live = await db.query<{ sandbox_id: string | null; orchestrator_id: string | null }>("SELECT sandbox_id, orchestrator_id FROM orchestrator_sandboxes WHERE state <> 'deleted'");
    const rows = unmatchedSandboxes(listing.sandboxes, live, now);
    return { total: rows.length, boat, limits: recordLimits(), facets: await orchFacets([], [], null, listing.sandboxes, now), rows: rows.slice(offset, offset + limit) };
  }
  const params: unknown[] = [];
  const where = [stateWhere(state)];
  const job = str(q.job_id);
  if (job) { params.push(job); where.push(`o.job_id = $${params.length}`); }
  const reason = str(q.reason);
  // `launch:<step>` / `reap:<kind>` (Failures by reason) is a class from src/error-classes.ts, matched after the query.
  const byClass = reason && /^(launch|reap):/.test(reason) ? reason : null;
  if (reason && !byClass) { params.push(reason); where.push(`(o.launch_step = $${params.length} OR o.reap_reason ILIKE $${params.length} || '%')`); }
  const include = Number(q.include);
  const facets = await orchFacets(where.slice(1), [...params], byClass, listing.sandboxes, now);
  let match = where.join(" AND ");
  if (Number.isInteger(include) && include > 0) { params.push(include); match = `((${match}) OR o.id = $${params.length})`; }
  const sb = new Map(listing.sandboxes.map((s) => [s.id, s]));
  let current: string | null = null;
  try { current = currentCodeHash(); } catch { /* no code on this deployment: "current" is unknown */ }
  if (byClass) {
    const all = (await db.query<OrchDb>(`/* tenant: internal: admin Compute page, gateway spend summed per orchestrator id */
      SELECT ${ORCH_COLS} ${ORCH_FROM} WHERE ${match} ORDER BY o.id DESC LIMIT 5000`, params))
      .filter((r) => classifyOrchestrator(r)?.key === byClass || (Number.isInteger(include) && r.id === include));
    if (Number.isInteger(include) && include > 0) all.sort((a, b) => Number(b.id === include) - Number(a.id === include));
    return { total: all.length, boat, limits: recordLimits(), facets, rows: all.slice(offset, offset + limit).map((r) => orchRow(r, sb, now, current)) };
  }
  const [{ total }] = await db.query<{ total: unknown }>(`SELECT count(*) AS total ${ORCH_FROM} WHERE ${match}`, params);
  const rows = await db.query<OrchDb>(
    `/* tenant: internal: admin Compute page, gateway spend summed per orchestrator id */
     SELECT ${ORCH_COLS} ${ORCH_FROM} WHERE ${match}
      ORDER BY ${Number.isInteger(include) && include > 0 ? `(o.id = $${params.length}) DESC, ` : ""}o.id DESC LIMIT ${limit} OFFSET ${offset}`, params);
  return { total: n(total), boat, limits: recordLimits(), facets, rows: rows.map((r) => orchRow(r, sb, now, current)) };
}

/**
 * Orchestrators each state choice matches under the job and reason filters (the `include` row aside); `where` holds
 * those filters. A reason that is a failure class is matched per row, over at most 5,000 rows as the list does.
 * Unmatched counts boat's sandboxes that match no live row (the job and reason filters do not apply to it).
 */
async function orchFacets(where: string[], params: unknown[], byClass: string | null, sandboxes: ClassifiedSandbox[], now: number) {
  const db = await getDb();
  const states = ORCH_STATES.filter((s) => s !== "unmatched");
  const flags = states.map((s, i) => `(${stateWhere(s)}) AS f${i}`).join(", ");
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const out: Record<string, number> = {};
  if (byClass) {
    const rows = (await db.query<OrchDb & Record<string, boolean>>(`SELECT o.launch_step, o.launch_error, o.reap_reason, o.error, o.ready_at, ${flags} ${ORCH_FROM} ${w} ORDER BY o.id DESC LIMIT 5000`, params))
      .filter((r) => classifyOrchestrator(r)?.key === byClass);
    states.forEach((s, i) => { out[s] = rows.filter((r) => r[`f${i}`]).length; });
  } else {
    const [r] = await db.query<Record<string, unknown>>(`SELECT ${states.map((s, i) => `count(*) FILTER (WHERE ${stateWhere(s)}) AS f${i}`).join(", ")} ${ORCH_FROM} ${w}`, params);
    states.forEach((s, i) => { out[s] = n(r?.[`f${i}`]); });
  }
  const live = await db.query<{ sandbox_id: string | null; orchestrator_id: string | null }>("SELECT sandbox_id, orchestrator_id FROM orchestrator_sandboxes WHERE state <> 'deleted'");
  out.unmatched = unmatchedSandboxes(sandboxes, live, now).length;
  return out;
}

/** One orchestrator for its peek: the row, boot timings, its workers now, recent sessions, worker tokens, events, gateway spend. */
export async function orchestratorDetail(id: number) {
  if (!Number.isInteger(id) || id <= 0) throw badRequest("id must be an orchestrator row id");
  const db = await getDb();
  const [r] = await db.query<OrchDb>(`/* tenant: internal: admin Compute page, gateway spend of one orchestrator */ SELECT ${ORCH_COLS} ${ORCH_FROM} WHERE o.id = $1`, [id]);
  if (!r) throw notFound("Orchestrator");
  const listing = await classifiedSandboxes();
  const now = Date.now();
  let current: string | null = null;
  try { current = currentCodeHash(); } catch { /* unknown */ }
  const row = orchRow(r, new Map(listing.sandboxes.map((s) => [s.id, s])), now, current);

  // Workers now: boat's worker sandboxes named for this orchestrator, with the session running in each.
  const mine = r.orchestrator_id ? listing.sandboxes.filter((s) => s.kind === "worker" && s.live && s.parent_orchestrator_id === r.orchestrator_id) : [];
  const bySandbox = new Map((mine.length && sessionEngine() ? await db.query<{ id: string; agent_id: string | null; status: string; heartbeat_at: Date | null; sandbox_id: string }>(
    `/* tenant: internal: admin Compute page, sessions by worker sandbox id */
     SELECT DISTINCT ON (sandbox_id) id, agent_id, status, heartbeat_at, sandbox_id FROM agent_sessions WHERE sandbox_id = ANY($1) ORDER BY sandbox_id, queued_at DESC`,
    [mine.map((s) => s.id)]) : []).map((x) => [x.sandbox_id, x]));
  const prefixes = r.orchestrator_id ? lib.workerPrefixesOf(r.orchestrator_id) : [];
  const workers = mine.map((s) => {
    const ses = bySandbox.get(s.id);
    const prefix = prefixes.find((p) => s.name?.startsWith(p));
    return { sandbox_id: s.id, name: s.name ?? null, agent_id: ses?.agent_id ?? (prefix ? s.name!.slice(prefix.length) : null), session_id: ses?.id ?? null,
      status: ses?.status ?? null, heartbeat_age_s: ses?.heartbeat_at ? Math.round((now - new Date(ses.heartbeat_at).getTime()) / 1000) : null, boat_state: s.state };
  });

  // Recent sessions on it: claimed by its worker id; once its fleet row is gone, the job's sessions started in its lifetime.
  const worker = r.meta?.worker_id ?? null;
  const sessions = (!sessionEngine() ? [] : await db.query<{ id: string; agent_id: string | null; status: string; queued_at: Date; started_at: Date | null; ended_at: Date | null; error_message: string | null }>(
    `/* tenant: internal: admin Compute page, sessions of one orchestrator (worker id or its job) */
     SELECT id, agent_id, status, queued_at, started_at, ended_at, left(error_message, 200) AS error_message FROM agent_sessions
      WHERE ($1::text IS NOT NULL AND worker_id = $1)
         OR ($1::text IS NULL AND $2::text IS NOT NULL AND simulation_id = $2 AND started_at >= $3::timestamptz AND started_at <= coalesce($4::timestamptz, now()))
      ORDER BY coalesce(started_at, queued_at) DESC LIMIT 10`, [worker, r.job_id, r.created_at, r.deleted_at]))
    .map((s) => ({ id: s.id, agent_id: s.agent_id, status: s.status, queued_at: iso(s.queued_at), started_at: iso(s.started_at), ended_at: iso(s.ended_at), error_message: s.error_message }));

  const tokens = (await db.query<{ job_id: string; created_at: Date; expires_at: Date; revoked_at: Date | null }>(
    `/* tenant: internal: admin Compute page, worker tokens of one orchestrator row (no hashes) */
     SELECT job_id, created_at, expires_at, revoked_at FROM worker_tokens WHERE sandbox_row_id = $1 ORDER BY created_at DESC LIMIT 20`, [id]))
    .map((t) => ({ job_id: t.job_id, created_at: iso(t.created_at), expires_at: iso(t.expires_at), revoked_at: iso(t.revoked_at) }));
  const events = r.sandbox_id || r.orchestrator_id ? (await db.query<{ at: Date; kind: string; sandbox_id: string | null; step: string | null; reason: string | null; actor: string | null }>(
    `SELECT at, kind, sandbox_id, step, reason, actor FROM compute_events
      WHERE ($1::text IS NOT NULL AND sandbox_id = $1) OR ($2::text IS NOT NULL AND orchestrator_id = $2) ORDER BY at DESC LIMIT 50`, [r.sandbox_id, r.orchestrator_id]))
    .map((e) => ({ ...e, at: iso(e.at) })) : [];
  const gateway = r.orchestrator_id ? (await db.query<Record<string, unknown>>(
    `/* tenant: internal: admin Compute page, gateway usage of one orchestrator by id */
     SELECT provider, sum(requests) AS requests, sum(errors) AS errors, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens, sum(cost_usd) AS cost_usd
       FROM gateway_usage WHERE orchestrator_id = $1 GROUP BY provider ORDER BY provider`, [r.orchestrator_id]))
    .map((g) => ({ provider: String(g.provider), requests: n(g.requests), errors: n(g.errors), input_tokens: n(g.input_tokens), output_tokens: n(g.output_tokens), cost_usd: usd(n(g.cost_usd)) })) : [];

  return {
    row, timings: r.timings ?? {}, workers, sessions, tokens, events, gateway,
    boat: { ok: listing.ok, stale: listing.stale, error: listing.error },
    logs_command: r.sandbox_id ? `npm run boat-orchestrators -- logs ${r.sandbox_id}` : null,
    limits: recordLimits(),
  };
}
