import { getDb } from "./db.js";
import { hostTable, researchJobs, sessionEngine } from "./host-tables.js";
import { memoryConfig } from "./host.js";
import { spendRange, SHARED, SHARED_NAME } from "./spend.js";
import { transcripts } from "./transcripts.js";
import { NS } from "./namespace.js";

/**
 * The admin Spend page's Compute hours and Data & storage tabs (GET /spend/compute, GET /spend/storage). Both are
 * measured, never priced: hours come from sandbox timestamps and sizes from the database and stores themselves. Each
 * report is one round of queries run together; days are UTC.
 *
 * Compute hours
 *   - Orchestrator sandboxes (orchestrator_sandboxes): created_at to deleted_at (a deleted row with no deleted_at ends
 *     at its last_seen; a live one at now()). The account is the orchestrator's job (job_id: a simulation or a research
 *     job); no job, or a job that matches neither (shared orchestrators, prospect research), is the shared row.
 *   - Agent (worker) sandboxes (agent_sessions): started_at to ended_at (running: now(); ended without ended_at: its last
 *     heartbeat). Attributed to the session's account, agent and job; the sandbox provider is the runner the worker
 *     reported (metadata.runner, boat by default as orchestrator/core/config.ts has it). "pool" sessions run in an
 *     orchestrator's warm pods, so their hours sit inside that orchestrator's hours too.
 *   - Each interval is clipped to the range and split at UTC midnights.
 *   - Peak running at once: computed from those same intervals (orchestrators plus agent sessions), a sweep over their
 *     start and end times, per day; not from autoscaler_ticks samples.
 *
 * Data & storage
 *   - Database size: pg_database_size(current_database()); table sizes: pg_total_relation_size (table, indexes, TOAST).
 *     Both guarded: a database that lacks them reports null, never an error.
 *   - Rows per table: exact count(*) over the app's tables (TABLES_NOW); new rows: rows whose created timestamp is in the
 *     range; last write: the latest created or updated timestamp. Per account: the tables with an org_id (scenarios
 *     through their product).
 *   - Transcripts: the transcript store (src/transcripts.ts). Postgres: the transcript_events table. ClickHouse: rows and
 *     bytes from system.parts; new events per day there come from agent_sessions.events by the session's queued day.
 *   - Gateway data: gateway_usage.bytes (request and response bytes through the model gateway), by the token's last
 *     request; per model provider, and per account through the session or the orchestrator's job.
 *   - Archive: sessions and research results copied to R2 (archive_key / archived_at), by archived day.
 */

const TENANT = "/* tenant: internal: admin Spend page, every account's compute hours and storage */";
const n = (v: unknown) => Number(v ?? 0) || 0;
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const hours = (secs: number) => r4(secs / 3600);
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

type Org = { id: number; slug: string; name: string };
async function orgIndex() {
  const db = await getDb();
  const orgs = await db.query<Org>("SELECT id, slug, name FROM organizations ORDER BY name");
  const keyOf = new Map(orgs.map((o) => [Number(o.id), o.slug]));
  return { orgs, keyOf, key: (id: unknown) => (id == null ? SHARED : keyOf.get(Number(id)) ?? SHARED) };
}

// ====================================================================== Compute hours

const DAYS = `d AS (SELECT g AS d0, g + interval '1 day' AS d1 FROM generate_series($1::timestamptz, $2::timestamptz - interval '1 day', interval '1 day') g)`;
/**
 * An orchestrator's job is a simulation or research, and a session the agent sandbox: the session engine's, a host
 * pack's tables (mold_v0-049). In a build without them, no job is known and there is no session (the same columns).
 */
const ORCH_IV = () => {
  const sim = sessionEngine(), pr = researchJobs();
  return `oiv AS (
    SELECT * FROM (
      SELECT o.id, o.job_id, o.pods, ${sim && pr ? "coalesce(sim.org_id, pr.org_id)" : sim ? "sim.org_id" : "NULL::int"} AS org_id,
             ${sim || pr ? `CASE ${sim ? "WHEN sim.id IS NOT NULL THEN 'simulation' " : ""}${pr ? "WHEN pr.id IS NOT NULL THEN 'research' " : ""}END` : "NULL::text"} AS job_kind,
             ${sim && pr ? "coalesce(sim.name, pr.input->>'name')" : sim ? "sim.name" : "NULL::text"} AS job_name, o.created_at AS t0,
             greatest(o.created_at, coalesce(o.deleted_at, CASE WHEN o.state = 'deleted' THEN coalesce(o.last_seen, o.created_at) ELSE now() END)) AS t1
        FROM orchestrator_sandboxes o${sim ? `
        LEFT JOIN simulations sim ON sim.id = o.job_id` : ""}${pr ? `
        LEFT JOIN product_research pr ON pr.id = o.job_id` : ""}
       WHERE o.created_at < $2) x
     WHERE t1 > $1)`;
};
const SES_IV = () => !sessionEngine() ? `siv AS (
    SELECT NULL::text AS id, NULL::int AS org_id, NULL::text AS job_id, NULL::text AS job_name, NULL::text AS agent, NULL::text AS runner,
           NULL::text AS sandbox_type, NULL::timestamptz AS t0, NULL::timestamptz AS t1 WHERE false AND $1::timestamptz IS NULL AND $2::timestamptz IS NULL)` : `siv AS (
    SELECT * FROM (
      SELECT s.id, s.org_id, s.simulation_id AS job_id, sim.name AS job_name, coalesce(s.agent_id, s.harness || '/' || s.model) AS agent,
             coalesce(s.metadata->>'runner', 'boat') AS runner, s.metadata->>'boat_sandbox_type' AS sandbox_type, s.started_at AS t0,
             greatest(s.started_at, coalesce(s.ended_at, CASE WHEN s.status = 'running' THEN now() ELSE coalesce(s.heartbeat_at, s.started_at) END)) AS t1
        FROM agent_sessions s LEFT JOIN simulations sim ON sim.id = s.simulation_id
       WHERE s.started_at IS NOT NULL AND s.started_at < $2) x
     WHERE t1 > $1)`;
const OVERLAP = "extract(epoch FROM least(t1, d1) - greatest(t0, d0))";
const DAY_OF = "to_char(d0 AT TIME ZONE 'UTC', 'YYYY-MM-DD')";

/** Where a runner's sandboxes run (orchestrator/core/runners.ts: boat, docker, local; pool = pods in an orchestrator on boat). */
const PROVIDERS: Record<string, string> = { boat: "boat.dev", pool: "boat.dev", docker: "Docker", local: "Local machine" };
const providerOf = (runner: string) => PROVIDERS[runner] ?? runner;

export async function computeReport(q: { from?: unknown; to?: unknown } = {}, now = Date.now()) {
  const R = spendRange(q, now);
  const db = await getDb();
  const span = [R.start, R.end];
  const [orchDays, sesDays, sesStats, peaks, idx, orchType] = await Promise.all([
    db.query<{ org_id: number | null; job_id: string | null; job_kind: string | null; job_name: string | null; day: string; secs: number; launched: number }>(`${TENANT}
      WITH ${DAYS}, ${ORCH_IV()}
      SELECT org_id, job_id, job_kind, job_name, ${DAY_OF} AS day, sum(${OVERLAP})::float AS secs, count(*) FILTER (WHERE t0 >= d0 AND t0 < d1)::int AS launched
        FROM oiv JOIN d ON t0 < d1 AND t1 > d0 GROUP BY 1, 2, 3, 4, 5`, span),
    db.query<{ org_id: number; job_id: string; job_name: string | null; agent: string; runner: string; day: string; secs: number }>(`${TENANT}
      WITH ${DAYS}, ${SES_IV()}
      SELECT org_id, job_id, job_name, agent, runner, ${DAY_OF} AS day, sum(${OVERLAP})::float AS secs
        FROM siv JOIN d ON t0 < d1 AND t1 > d0 GROUP BY 1, 2, 3, 4, 5, 6`, span),
    // Per session that ran in the range: its whole length (not clipped), for the average and the longest.
    db.query<{ org_id: number; agent: string; runner: string; sandbox_type: string | null; sessions: number; secs: number; longest: number }>(`${TENANT}
      WITH ${SES_IV()}
      SELECT org_id, agent, runner, sandbox_type, count(*)::int AS sessions, sum(extract(epoch FROM t1 - t0))::float AS secs,
             max(extract(epoch FROM t1 - t0))::float AS longest
        FROM siv GROUP BY 1, 2, 3, 4`, span),
    // Most sandboxes running at once each day: +1 at every start, -1 at every end (ends first at a tie), and a 0 at
    // each midnight so a day with no start or end still reads what was running through it.
    db.query<{ day: string; peak: number }>(`${TENANT}
      WITH ${DAYS}, ${ORCH_IV()}, ${SES_IV()},
      iv AS (SELECT greatest(t0, $1) AS t0, least(t1, $2) AS t1 FROM oiv UNION ALL SELECT greatest(t0, $1), least(t1, $2) FROM siv),
      ev AS (SELECT t0 AS t, 1 AS dl FROM iv WHERE t1 > t0 UNION ALL SELECT t1, -1 FROM iv WHERE t1 > t0 UNION ALL SELECT d0, 0 FROM d),
      run AS (SELECT t, sum(dl) OVER (ORDER BY t, dl ROWS UNBOUNDED PRECEDING) AS c FROM ev)
      SELECT to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, max(c)::int AS peak FROM run WHERE t < $2 GROUP BY 1`, span),
    orgIndex(),
    import("../orchestrator/deploy/boat-lib.js").then((m) => m.ORCH_SANDBOX_TYPE as string).catch(() => null),
  ]);
  const at = new Map(R.days.map((d, i) => [d, i]));
  const zeros = () => R.days.map(() => 0);

  type Acc = { orch: number[]; agent: number[]; launched: number; sessions: number; full: number; longest: number;
    agents: Map<string, { secs: number; sessions: number }>; jobs: Map<string, { job_id: string; kind: string | null; name: string | null; orch: number; agent: number }>;
    providers: Map<string, { orch: number; agent: number; sessions: number }> };
  const acc = new Map<string, Acc>();
  const A = (key: string) => {
    let a = acc.get(key);
    if (!a) acc.set(key, a = { orch: zeros(), agent: zeros(), launched: 0, sessions: 0, full: 0, longest: 0, agents: new Map(), jobs: new Map(), providers: new Map() });
    return a;
  };
  type Prov = { orch: number[]; agent: number[]; launched: number; sessions: number; types: Map<string, { kind: string; type: string; secs: number }>;
    accounts: Map<string, { orch: number; agent: number; sessions: number }> };
  const prov = new Map<string, Prov>();
  const P = (name: string) => {
    let p = prov.get(name);
    if (!p) prov.set(name, p = { orch: zeros(), agent: zeros(), launched: 0, sessions: 0, types: new Map(), accounts: new Map() });
    return p;
  };
  const pa = (p: Prov, key: string) => { const x = p.accounts.get(key) ?? { orch: 0, agent: 0, sessions: 0 }; p.accounts.set(key, x); return x; };
  const job = (a: Acc, id: string | null, kind: string | null, name: string | null) => {
    const k = id ?? "";
    const x = a.jobs.get(k) ?? { job_id: id ?? "", kind, name, orch: 0, agent: 0 }; a.jobs.set(k, x);
    x.kind ??= kind; x.name ??= name;
    return x;
  };
  const typeOf = (p: Prov, kind: string, type: string | null) => {
    const k = `${kind}|${type ?? ""}`;
    const x = p.types.get(k) ?? { kind, type: type ?? "", secs: 0 }; p.types.set(k, x);
    return x;
  };

  // Orchestrators all run on boat.dev (orchestrator/deploy/boat-lib.ts launchOrchestrator).
  for (const r of orchDays) {
    const i = at.get(r.day); if (i == null) continue;
    const key = idx.key(r.org_id), a = A(key), p = P("boat.dev"), secs = n(r.secs);
    a.orch[i] += secs; a.launched += n(r.launched);
    if (r.job_id) job(a, r.job_id, r.job_kind, r.job_name).orch += secs;
    p.orch[i] += secs; p.launched += n(r.launched); pa(p, key).orch += secs;
    typeOf(p, "Orchestrator", orchType).secs += secs;
  }
  for (const r of sesDays) {
    const i = at.get(r.day); if (i == null) continue;
    const key = idx.key(r.org_id), a = A(key), p = P(providerOf(r.runner)), secs = n(r.secs);
    a.agent[i] += secs;
    const g = a.agents.get(r.agent) ?? { secs: 0, sessions: 0 }; a.agents.set(r.agent, g); g.secs += secs;
    job(a, r.job_id, "simulation", r.job_name).agent += secs;
    const ap = a.providers.get(providerOf(r.runner)) ?? { orch: 0, agent: 0, sessions: 0 }; a.providers.set(providerOf(r.runner), ap); ap.agent += secs;
    p.agent[i] += secs; pa(p, key).agent += secs;
  }
  for (const r of sesStats) {
    const key = idx.key(r.org_id), a = A(key), p = P(providerOf(r.runner)), k = n(r.sessions);
    a.sessions += k; a.full += n(r.secs); a.longest = Math.max(a.longest, n(r.longest));
    const g = a.agents.get(r.agent) ?? { secs: 0, sessions: 0 }; a.agents.set(r.agent, g); g.sessions += k;
    p.sessions += k; pa(p, key).sessions += k;
    // Agent hours per sandbox type: the sessions' whole lengths share out the provider's clipped agent hours below.
    typeOf(p, "Agent", r.sandbox_type).secs += n(r.secs);
  }
  for (const p of prov.values()) {
    // Scale the agent types' whole-session seconds to the clipped hours, so a provider's types add up to its hours.
    const agentTypes = [...p.types.values()].filter((t) => t.kind === "Agent"), whole = sum(agentTypes.map((t) => t.secs)), clipped = sum(p.agent);
    for (const t of agentTypes) t.secs = whole > 0 ? (t.secs / whole) * clipped : 0;
  }

  const nameOf = new Map<string, string>([...idx.orgs.map((o) => [o.slug, o.name] as [string, string]), [SHARED, SHARED_NAME]]);
  const keys = [...idx.orgs.map((o) => o.slug), SHARED];
  const accounts = keys.map((key) => {
    const a = acc.get(key) ?? A(key), org = idx.orgs.find((o) => o.slug === key);
    const orchestrator_hours = hours(sum(a.orch)), agent_hours = hours(sum(a.agent));
    return {
      key, slug: org?.slug ?? null, name: nameOf.get(key)!, shared: key === SHARED,
      orchestrator_hours, agent_hours, total_hours: r4(orchestrator_hours + agent_hours),
      sessions: a.sessions, orchestrators: a.launched,
      avg_session_hours: a.sessions ? hours(a.full / a.sessions) : null, longest_session_hours: a.sessions ? hours(a.longest) : null,
      daily_orchestrator: a.orch.map(hours), daily_agent: a.agent.map(hours),
      by_agent: [...a.agents].map(([agent, g]) => ({ agent, hours: hours(g.secs), sessions: g.sessions })).sort((x, y) => y.hours - x.hours || y.sessions - x.sessions),
      by_job: [...a.jobs.values()].map((j) => ({ job_id: j.job_id, kind: j.kind, name: j.name, orchestrator_hours: hours(j.orch), agent_hours: hours(j.agent), total_hours: hours(j.orch + j.agent) }))
        .sort((x, y) => y.total_hours - x.total_hours).slice(0, 10),
    };
  });
  const providers = [...prov].map(([name, p]) => {
    const orchestrator_hours = hours(sum(p.orch)), agent_hours = hours(sum(p.agent));
    return {
      key: name, name, orchestrator_hours, agent_hours, total_hours: r4(orchestrator_hours + agent_hours), sessions: p.sessions, orchestrators: p.launched,
      daily_orchestrator: p.orch.map(hours), daily_agent: p.agent.map(hours),
      sandbox_types: [...p.types.values()].map((t) => ({ kind: t.kind, type: t.type || null, hours: hours(t.secs) })).filter((t) => t.hours > 0).sort((x, y) => y.hours - x.hours),
      by_account: [...p.accounts].map(([key, x]) => ({ key, name: nameOf.get(key) ?? key, orchestrator_hours: hours(x.orch), agent_hours: hours(x.agent), total_hours: hours(x.orch + x.agent), sessions: x.sessions }))
        .sort((x, y) => y.total_hours - x.total_hours),
    };
  }).sort((x, y) => y.total_hours - x.total_hours);
  const peakOf = new Map(peaks.map((p) => [p.day, n(p.peak)]));
  const daily_peak = R.days.map((d) => peakOf.get(d) ?? 0);
  const totals = {
    orchestrator_hours: r4(sum(accounts.map((a) => a.orchestrator_hours))), agent_hours: r4(sum(accounts.map((a) => a.agent_hours))), total_hours: 0,
    peak_running: Math.max(0, ...daily_peak), daily_peak, peak_source: "intervals" as const,
  };
  totals.total_hours = r4(totals.orchestrator_hours + totals.agent_hours);
  return { range: { from: R.from, to: R.to, days: R.days }, totals, accounts, providers };
}

// ====================================================================== Data & storage

/**
 * The app's tables (sql/migrations/0001_baseline.sql): a plain label, the created timestamp new rows are counted by, the last-write
 * timestamp (default: created), and how a row belongs to an account. Every count is exact (count(*)).
 */
interface TableDef { table: string; label: string; created?: string; written?: string; org?: string; from?: string; where?: string }
const ALL_TABLES: TableDef[] = [
  { table: "organizations", label: "Accounts", created: "created_at" },
  { table: "api_keys", label: "API keys", created: "created_at", written: "greatest(created_at, last_used_at, revoked_at)", org: "org_id" },
  { table: "products", label: "Products", created: "created_at", written: "greatest(created_at, updated_at)", org: "org_id" },
  { table: "scenarios", label: "Scenarios", created: "x.created_at", written: "greatest(x.created_at, x.updated_at)", org: "p.org_id", from: "scenarios x JOIN products p ON p.id = x.product_id" },
  { table: "simulations", label: "Simulations", created: "created_at", written: "greatest(created_at, finished_at)", org: "org_id" },
  { table: "agent_sessions", label: "Agent sessions", created: "queued_at", written: "greatest(queued_at, ended_at)", org: "org_id" },
  { table: "transcript_events", label: "Transcript events", created: "ts" },
  { table: "access_requests", label: "Access requests", created: "created_at", org: "org_id" },
  { table: "developer_profiles", label: "Developer profiles", created: "synced_at", written: "greatest(synced_at, edited_at)", org: "org_id" },
  { table: "library_tasks", label: "Library tasks", created: "synced_at", written: "greatest(synced_at, edited_at)" },
  { table: "orchestrators", label: "Orchestrators", created: "registered_at", written: "last_seen" },
  { table: "orchestrator_sandboxes", label: "Orchestrator sandboxes", created: "created_at", written: "greatest(created_at, deleted_at)" },
  { table: "compute_events", label: "Compute events", created: "at" },
  { table: "autoscaler_ticks", label: "Autoscaler history", created: "at" },
  { table: "autoscaler_lease", label: "Autoscaler lease" },
  { table: "vault_providers", label: "Key vault providers", written: "updated_at" },
  { table: "vault_credentials", label: "Key vault keys", created: "created_at", written: "greatest(created_at, rotated_at)" },
  { table: "gateway_tokens", label: "Gateway tokens", created: "created_at" },
  { table: "gateway_usage", label: "Gateway usage", written: "last_at" },
  { table: "gateway_model_usage", label: "Gateway usage by model", created: "(day::timestamp AT TIME ZONE 'UTC')" },
  { table: "model_prices", label: "Model prices", written: "updated_at" },
  { table: "developer_populations", label: "Developer populations", created: "created_at", written: "greatest(created_at, updated_at)", org: "org_id" },
  { table: "developer_population_agents", label: "Population agents", written: "updated_at" },
  { table: "product_research", label: "Product research", created: "created_at", written: "greatest(created_at, finished_at)", org: "org_id" },
  { table: "usage_alerts", label: "Usage alerts", created: "sent_at" },
  { table: "mcp_events", label: "MCP events", created: "at", org: "org_id" },
  { table: "nudges", label: "Nudges", created: "created_at", org: "org_id" },
  { table: "nudge_prefs", label: "Nudge preferences", written: "last_shown_at", org: "org_id" },
  { table: "usage_policies", label: "Usage policies", written: "updated_at", org: "org_id" },
  { table: "usage_teams", label: "Usage teams", created: "created_at", org: "org_id" },
  { table: "usage_members", label: "Usage members", org: "org_id" },
  { table: "usage_rule_changes", label: "Usage rule changes", created: "at", org: "org_id" },
  { table: "usage_rule_migrations", label: "Usage rule migrations", created: "applied_at" },
  { table: "account_context", label: "Account context", written: "updated_at", org: "org_id" },
  { table: "user_context", label: "User context", written: "updated_at", org: "org_id" },
  { table: "journey_templates", label: "Journey templates", created: "created_at", written: "greatest(created_at, updated_at)", org: "org_id" },
  { table: "journey_progress", label: "Journey progress", created: "done_at", org: "org_id" },
  { table: "journey_seed", label: "Journey seed", created: "seeded_at" },
  { table: "context_memories", label: "Context memories", created: "created_at", org: "org_id" },
  { table: "adoption_help", label: "Adoption help requests", created: "created_at", org: "org_id" },
  { table: "worker_tokens", label: "Worker tokens", created: "created_at", org: "org_id" },
  { table: "org_deletions", label: "Account deletions", created: "deleted_at" },
  { table: "org_task_sets", label: "Account task sets", created: "created_at", org: "org_id" },
  { table: "org_harnesses", label: "Account harnesses", created: "created_at", written: "greatest(created_at, updated_at)", org: "org_id" },
  { table: "org_keys", label: "Account keys", created: "created_at", org: "org_id" },
  { table: "admin_access_log", label: "Admin access log", created: "at" },
  { table: "platform_settings", label: "Platform settings", written: "updated_at" },
  { table: "platform_harnesses", label: "Platform harnesses", created: "created_at", written: "greatest(created_at, updated_at)" },
];

/**
 * The tables of this build: the shell's, and a host pack's only when this build has it (mold_v0-049: the product's
 * tables are its host pack's, created by its migrations; listed here so the Storage page names them when present).
 */
const HOST_TABLE_NAMES = new Set(["products", "scenarios", "simulations", "agent_sessions", "transcript_events", "developer_profiles", "library_tasks",
  "developer_populations", "developer_population_agents", "product_research", "nudges", "nudge_prefs",
  "journey_templates", "journey_progress", "journey_seed", "adoption_help", "org_task_sets", "org_harnesses"]);
/**
 * The account context and memory component's tables (mold_v0-142, src/account-context.ts): the shell's in every build,
 * named on the Storage page only where the component is on (pack.json memory), the only builds that write them.
 */
const CONTEXT_TABLE_NAMES = new Set(["account_context", "user_context", "context_memories"]);
let tableList: TableDef[] | null = null;
/** Read on first use, once the build's packs are registered (the component's config is theirs). */
const TABLES_NOW = (): TableDef[] => (tableList ??= ALL_TABLES.filter((t) => (!HOST_TABLE_NAMES.has(t.table) || hostTable(t.table)
  // scenarios is read through products (its account): both must be there
  && (t.table !== "scenarios" || hostTable("products"))) && (!CONTEXT_TABLE_NAMES.has(t.table) || memoryConfig() !== null)));

/** One scan per table: rows per (account, created day in the range, or null outside it), and the latest write. */
const COUNTS_NOW = () => TABLES_NOW().map((t) => {
  const c = t.created, w = t.written ?? c;
  const day = c ? `CASE WHEN ${c} >= $1 AND ${c} < $2 THEN to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD') END` : "NULL::text";
  return `SELECT '${t.table}'::text AS t, ${t.org ?? "NULL::int"} AS org_id, ${day} AS day, count(*)::float AS n, ${w ? `max(${w})` : "NULL::timestamptz"} AS last
    FROM ${t.from ?? t.table}${t.where ? ` WHERE ${t.where}` : ""} GROUP BY 1, 2, 3`;
}).join("\n  UNION ALL ");

const safe = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);

export async function storageReport(q: { from?: unknown; to?: unknown } = {}, now = Date.now()) {
  const R = spendRange(q, now);
  const db = await getDb();
  const span = [R.start, R.end];
  const store = transcripts();
  const [counts, dbSize, sizes, events, gateway, archive, idx, storeStats] = await Promise.all([
    db.query<{ t: string; org_id: number | null; day: string | null; n: number; last: Date | null }>(`${TENANT} ${COUNTS_NOW()}`, span),
    safe(db.query<{ bytes: number }>("SELECT pg_database_size(current_database())::float AS bytes").then((r) => n(r[0]?.bytes) || null), null),
    safe(db.query<{ t: string; bytes: number }>(`SELECT c.relname AS t, pg_total_relation_size(c.oid)::float AS bytes
        FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = current_schema() AND c.relkind IN ('r', 'p')`), null),
    // Transcript events by session (the counter the worker keeps, agent_sessions.events), by account and queued day.
    !sessionEngine() ? Promise.resolve([] as { org_id: number; day: string | null; events: number }[]) : db.query<{ org_id: number; day: string | null; events: number }>(`${TENANT}
      SELECT org_id, CASE WHEN queued_at >= $1 AND queued_at < $2 THEN to_char(queued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') END AS day, sum(events)::float AS events
        FROM agent_sessions GROUP BY 1, 2`, span),
    db.query<{ provider: string; org_id: number | null; day: string | null; bytes: number; requests: number; last: Date | null }>(`${TENANT}
      SELECT g.provider, ${!sessionEngine() ? "NULL::int" : researchJobs() ? "coalesce(s.org_id, sim.org_id, pr.org_id)" : "coalesce(s.org_id, sim.org_id)"} AS org_id,
             CASE WHEN g.last_at >= $1 AND g.last_at < $2 THEN to_char(g.last_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') END AS day,
             sum(g.bytes)::float AS bytes, sum(g.requests)::float AS requests, max(g.last_at) AS last
        FROM gateway_usage g${sessionEngine() ? `
        LEFT JOIN agent_sessions s ON s.id = g.session_id
        LEFT JOIN LATERAL (SELECT x.job_id FROM orchestrator_sandboxes x WHERE g.session_id IS NULL AND x.orchestrator_id = g.orchestrator_id AND x.job_id IS NOT NULL
                            ORDER BY x.id DESC LIMIT 1) os ON true
        LEFT JOIN simulations sim ON sim.id = os.job_id` : ""}${researchJobs() ? `
        LEFT JOIN product_research pr ON pr.id = os.job_id` : ""}
       GROUP BY 1, 2, 3`, span),
    !sessionEngine() ? Promise.resolve([] as { what: string; day: string | null; n: number; events: number; last: Date | null }[])
    : db.query<{ what: string; day: string | null; n: number; events: number; last: Date | null }>(`${TENANT}
      SELECT 'sessions' AS what, CASE WHEN archived_at >= $1 AND archived_at < $2 THEN to_char(archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') END AS day,
             count(*)::float AS n, sum(coalesce(archive_events, 0))::float AS events, max(archived_at) AS last
        FROM agent_sessions WHERE archived_at IS NOT NULL GROUP BY 1, 2${researchJobs() ? `
      UNION ALL
      SELECT 'research', CASE WHEN archived_at >= $1 AND archived_at < $2 THEN to_char(archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') END,
             count(*)::float, 0::float, max(archived_at)
        FROM product_research WHERE archived_at IS NOT NULL GROUP BY 1, 2` : ""}`, span),
    orgIndex(),
    // A paused ClickHouse Cloud service can take ~15 s to wake: give up after 5 s and show the store without its size.
    safe(Promise.race([store.stats(), new Promise<null>((ok) => setTimeout(() => ok(null), 5_000).unref())]), null),
  ]);
  const at = new Map(R.days.map((d, i) => [d, i]));
  const zeros = () => R.days.map(() => 0);
  const sizeOf = sizes ? new Map(sizes.map((s) => [s.t, n(s.bytes)])) : null;
  const nameOf = new Map<string, string>([...idx.orgs.map((o) => [o.slug, o.name] as [string, string]), [SHARED, SHARED_NAME]]);
  const defOf = new Map(TABLES_NOW().map((t) => [t.table, t]));

  // ---------- per table ----------
  type T = { rows: number; new_rows: number; last: string | null; daily: number[] };
  const tab = new Map<string, T>(TABLES_NOW().map((t) => [t.table, { rows: 0, new_rows: 0, last: null, daily: zeros() }]));
  type AccT = { rows: number; new_rows: number; last: string | null; daily: number[]; tables: Map<string, { rows: number; new_rows: number }>;
    events: number; new_events: number; daily_events: number[]; gw_bytes: number; gw_requests: number; daily_gw: number[]; gw_last: string | null;
    gw_providers: Map<string, number> };
  const acc = new Map<string, AccT>();
  const A = (key: string) => {
    let a = acc.get(key);
    if (!a) acc.set(key, a = { rows: 0, new_rows: 0, last: null, daily: zeros(), tables: new Map(), events: 0, new_events: 0, daily_events: zeros(),
      gw_bytes: 0, gw_requests: 0, daily_gw: zeros(), gw_last: null, gw_providers: new Map() });
    return a;
  };
  for (const r of counts) {
    const t = tab.get(r.t)!, k = n(r.n), i = r.day ? at.get(r.day) : undefined, last = iso(r.last);
    t.rows += k; t.last = later(t.last, last);
    if (i != null) { t.new_rows += k; t.daily[i] += k; }
    // Account rows: tables with an org_id. Rows with none (and platform tables) are the app's own, the shared row.
    const a = A(defOf.get(r.t)!.org ? idx.key(r.org_id) : SHARED);
    a.rows += k; a.last = later(a.last, last);
    const x = a.tables.get(r.t) ?? { rows: 0, new_rows: 0 }; a.tables.set(r.t, x); x.rows += k;
    if (i != null) { a.new_rows += k; a.daily[i] += k; x.new_rows += k; }
  }
  const tables = TABLES_NOW().map((d) => {
    const t = tab.get(d.table)!;
    return { name: d.table, label: d.label, bytes: sizeOf?.get(d.table) ?? null, rows: t.rows, new_rows: t.new_rows, last_write: t.last, daily_new: t.daily };
  });
  const dbDaily = R.days.map((_, i) => sum(tables.map((t) => t.daily_new[i])));

  // ---------- transcripts ----------
  const evDaily = zeros();
  for (const r of events) {
    const a = A(idx.key(r.org_id)), k = n(r.events), i = r.day ? at.get(r.day) : undefined;
    a.events += k;
    if (i != null) { a.new_events += k; a.daily_events[i] += k; evDaily[i] += k; }
  }
  // Without the session engine's tables (mold_v0-049) there is no transcript table: an empty one stands in.
  const pgTranscripts = store.kind === "postgres", te = tables.find((t) => t.name === "transcript_events")
    ?? { bytes: null, rows: 0, new_rows: 0, daily_new: zeros(), last_write: null };
  const transcriptStore = {
    key: "transcripts", kind: "transcripts" as const, name: pgTranscripts ? "Transcripts (Postgres)" : "Transcripts (ClickHouse)",
    detail: pgTranscripts ? "transcript_events" : `${process.env.CLICKHOUSE_DATABASE ?? NS}.transcript_events`,
    bytes: pgTranscripts ? te.bytes : storeStats?.bytes ?? null,
    rows: pgTranscripts ? te.rows : storeStats?.rows ?? null,
    // Postgres: events by their own timestamp. ClickHouse: the sessions' event counters by queued day (no scan of the store).
    new_rows: pgTranscripts ? te.new_rows : sum(evDaily), daily_new: pgTranscripts ? te.daily_new : evDaily,
    last_write: pgTranscripts ? te.last_write : tab.get("agent_sessions")?.last ?? null,
    parts: [] as { name: string; label: string; bytes: number | null; rows: number; new_rows: number; last_write: string | null }[],
  };

  // ---------- gateway ----------
  const gwDaily = zeros();
  const gwProv = new Map<string, { bytes: number; requests: number; new_bytes: number; daily: number[]; last: string | null }>();
  for (const r of gateway) {
    const b = n(r.bytes), i = r.day ? at.get(r.day) : undefined, last = iso(r.last);
    const p = gwProv.get(r.provider) ?? { bytes: 0, requests: 0, new_bytes: 0, daily: zeros(), last: null }; gwProv.set(r.provider, p);
    p.bytes += b; p.requests += n(r.requests); p.last = later(p.last, last);
    if (i == null) continue;
    p.new_bytes += b; p.daily[i] += b; gwDaily[i] += b;
    const a = A(idx.key(r.org_id));
    a.gw_bytes += b; a.gw_requests += n(r.requests); a.daily_gw[i] += b; a.gw_last = later(a.gw_last, last);
    a.gw_providers.set(r.provider, (a.gw_providers.get(r.provider) ?? 0) + b);
  }

  // ---------- archive ----------
  const arch = { sessions: 0, research: 0, events: 0, new_rows: 0, daily: zeros(), last: null as string | null };
  for (const r of archive) {
    const k = n(r.n), i = r.day ? at.get(r.day) : undefined;
    if (r.what === "sessions") { arch.sessions += k; arch.events += n(r.events); } else arch.research += k;
    arch.last = later(arch.last, iso(r.last));
    if (i != null) { arch.new_rows += k; arch.daily[i] += k; }
  }

  // ---------- by store (the Provider grouping) ----------
  const dbName = db.kind === "pglite" ? "PGlite (local)" : /neon\.tech|neon\.build/.test(process.env.DATABASE_URL ?? "") ? "Neon Postgres" : "Postgres";
  const stores = [
    { key: "database", kind: "database" as const, name: dbName, detail: "current database", bytes: dbSize, rows: sum(tables.map((t) => t.rows)),
      new_rows: sum(tables.map((t) => t.new_rows)), daily_new: dbDaily, last_write: tables.reduce<string | null>((l, t) => later(l, t.last_write), null),
      parts: tables.map(({ daily_new: _d, ...t }) => t) },
    transcriptStore,
    { key: "archive", kind: "archive" as const, name: "Archive (R2)", detail: "archive_key", bytes: null, rows: arch.sessions + arch.research, new_rows: arch.new_rows,
      daily_new: arch.daily, last_write: arch.last,
      parts: [{ name: "agent_sessions", label: `Sessions (${arch.events.toLocaleString("en-US")} events)`, bytes: null, rows: arch.sessions, new_rows: 0, last_write: null },
        { name: "product_research", label: "Research results", bytes: null, rows: arch.research, new_rows: 0, last_write: null }] },
    ...[...gwProv].sort((a, b) => b[1].bytes - a[1].bytes).map(([provider, p]) => ({
      key: `gateway:${provider}`, kind: "gateway" as const, name: `Gateway: ${provider}`, detail: provider,
      // Gateway rows: bytes are request traffic, rows are requests; "new" is the range's bytes.
      bytes: p.bytes, rows: p.requests, new_rows: null as number | null, new_bytes: p.new_bytes, daily_new: p.daily, last_write: p.last, parts: [] as typeof transcriptStore.parts,
    })),
  ].map((s) => ({ new_bytes: null as number | null, ...s }));

  // ---------- by account ----------
  const keys = [...idx.orgs.map((o) => o.slug), SHARED];
  const accounts = keys.map((key) => {
    const a = acc.get(key) ?? A(key), org = idx.orgs.find((o) => o.slug === key);
    return {
      key, slug: org?.slug ?? null, name: nameOf.get(key)!, shared: key === SHARED,
      rows: a.rows, new_rows: a.new_rows, transcript_events: a.events, new_transcript_events: a.new_events,
      gateway_bytes: a.gw_bytes, gateway_requests: a.gw_requests, last_write: later(a.last, a.gw_last),
      daily_new: a.daily, daily_events: a.daily_events, daily_gateway_bytes: a.daily_gw,
      by_table: [...a.tables].map(([t, x]) => ({ name: t, label: defOf.get(t)!.label, ...x })).filter((x) => x.rows > 0).sort((x, y) => y.rows - x.rows),
      gateway_by_provider: [...a.gw_providers].map(([provider, bytes]) => ({ provider, bytes })).sort((x, y) => y.bytes - x.bytes),
    };
  });

  const totals = {
    db_bytes: dbSize, sizes_available: sizeOf != null, transcript_store: store.kind, transcript_rows: transcriptStore.rows, transcript_bytes: transcriptStore.bytes,
    gateway_bytes: sum(gwDaily), new_rows: sum(dbDaily), daily_new_rows: dbDaily, daily_transcript_rows: transcriptStore.daily_new, daily_gateway_bytes: gwDaily,
    archived: { sessions: arch.sessions, research: arch.research, last_archived_at: arch.last },
  };
  return { range: { from: R.from, to: R.to, days: R.days }, totals, tables, stores, accounts };
}

export type ComputeReport = Awaited<ReturnType<typeof computeReport>>;
export type StorageReport = Awaited<ReturnType<typeof storageReport>>;
