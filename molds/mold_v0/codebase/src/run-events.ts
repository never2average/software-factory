/**
 * One run's events as the platform operator may see them (mold_v0-183): what the run engine and the runner recorded
 * for a run (claimed, sandbox_prepared, agent_checkout, workspace_restored, each step's stdout lines, the agent's output
 * files, workspace_ignored, workspace_written, workspace_indexed, succeeded, ...), in order, so "the run succeeded but
 * nothing changed" can be answered from the run itself. Read by `npm run audit:run-events` (scripts/operator/run-events.ts),
 * which the factory runs with the app's own database role (provision.py <app> --operator audit:run-events -- <run_id>).
 *
 * READ ONLY:
 *  - everything runs in ONE transaction made read-only before its first query (SET TRANSACTION READ ONLY, then checked
 *    with SHOW transaction_read_only) and always rolled back: a write inside it fails with 25006;
 *  - it reads the runs and run_events tables (and the workspace's slug) only, never the vault, a credential, a lease
 *    token or a gateway token. Event data was redacted of the run's credential values when it was written
 *    (src/credential-redact.ts); what is printed is masked once more for shapes of secrets (maskSecrets).
 */
import type { RawConn } from "./vault-status.js";

export interface RunEventRow { id: number; attempt: number; type: string; at: string; data: unknown }
export interface RunEventsReport {
  read_only: true;
  run: {
    id: string; workspace: string | null; pack: string; kind: string; status: string; attempt: number; max_attempts: number;
    cost_usd: number | null; error_kind: string | null; error: string | null;
    created_at: string | null; started_at: string | null; ended_at: string | null;
    targets: unknown; scope_keys: string[];
  } | null;
  events: RunEventRow[];
  /** Events of the run in all, of the types asked for (before the limit). */
  total: number;
  /** How many events of each type the run has (all types). */
  counts: Record<string, number>;
  truncated: boolean;
}
export interface RecentRun { id: string; workspace: string | null; pack: string; kind: string; status: string; cost_usd: number | null; created_at: string | null; ended_at: string | null }

export const RUN_ID = /^run_[A-Za-z0-9_-]{4,64}$/;
const TYPE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

/**
 * Shapes of secrets masked in whatever is printed, on top of the redaction the run's own values got when the event was
 * written: a URL's user and password, and well-known token prefixes. A guard against accidents, as that redaction is.
 */
export function maskSecrets(s: string): string {
  return s
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+(?::[^\s/@"']*)?@/gi, "$1***@")
    .replace(/\b(sk-ant-[a-z0-9]{2,8}-|sk-proj-|sk-|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abpr]-|oct_|boat_[a-z]+_|AKIA|ASIA)[A-Za-z0-9_\-]{8,}/g, "$1***")
    .replace(/\b(Bearer|token|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, "$1 ***");
}

/** The report, read in one READ ONLY transaction on `conn` that is rolled back whatever happens. */
export async function runEvents(conn: RawConn, opts: { run: string; types?: string[]; limit?: number; attempt?: number }): Promise<RunEventsReport> {
  if (!RUN_ID.test(opts.run)) throw Object.assign(new Error(`not a run id: ${JSON.stringify(opts.run.slice(0, 80))} (run_...)`), { code: 2 });
  for (const t of opts.types ?? []) if (!TYPE.test(t)) throw Object.assign(new Error(`not an event type: ${JSON.stringify(t.slice(0, 80))}`), { code: 2 });
  return readOnly(conn, async (q) => {
    const [r] = await q(
      `/* tenant: internal: the platform operator's read-only run report reads one run by its id (no row leaves this report but that run's) */
       SELECT r.id, o.slug AS workspace, r.pack, r.kind, r.status, r.attempt, r.max_attempts, r.cost_usd, r.error_kind, r.error,
              r.created_at, r.started_at, r.ended_at, r.targets, r.scope
         FROM runs r LEFT JOIN organizations o ON o.id = r.org_id WHERE r.id = $1`, [opts.run]);
    if (!r) return { read_only: true as const, run: null, events: [], total: 0, counts: {}, truncated: false };
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 2000), 1), 20000);
    const counts: Record<string, number> = {};
    for (const c of await q(
      `/* tenant: internal: the platform operator's read-only run report, that run's own events */
       SELECT type, count(*)::int AS n FROM run_events WHERE run_id = $1 GROUP BY type ORDER BY type`, [opts.run])) counts[c.type] = Number(c.n);
    const types = opts.types?.length ? opts.types : null;
    const where = `run_id = $1${types ? " AND type = ANY($2::text[])" : ""}${opts.attempt !== undefined ? ` AND attempt = $${types ? 3 : 2}` : ""}`;
    const params: unknown[] = [opts.run, ...(types ? [types] : []), ...(opts.attempt !== undefined ? [opts.attempt] : [])];
    const [{ n }] = await q(`/* tenant: internal: the platform operator's read-only run report, that run's own events */ SELECT count(*)::int AS n FROM run_events WHERE ${where}`, params);
    const rows = await q(
      `/* tenant: internal: the platform operator's read-only run report, that run's own events */
       SELECT id, attempt, type, at, data FROM run_events WHERE ${where} ORDER BY id LIMIT ${limit}`, params);
    return {
      read_only: true as const,
      run: { id: r.id, workspace: r.workspace ?? null, pack: r.pack, kind: r.kind, status: r.status, attempt: Number(r.attempt), max_attempts: Number(r.max_attempts),
             cost_usd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd), error_kind: r.error_kind ?? null,
             error: r.error ? maskSecrets(String(r.error)) : null, created_at: iso(r.created_at), started_at: iso(r.started_at), ended_at: iso(r.ended_at),
             targets: r.targets ?? null, scope_keys: r.scope && typeof r.scope === "object" ? Object.keys(r.scope) : [] },
      events: rows.map((e) => ({ id: Number(e.id), attempt: Number(e.attempt), type: String(e.type), at: iso(e.at)!, data: JSON.parse(maskSecrets(JSON.stringify(e.data ?? {}))) })),
      total: Number(n), counts, truncated: Number(n) > rows.length,
    };
  });
}

/** The latest runs (all workspaces, or one pack's), newest first: to find a run id. */
export async function recentRuns(conn: RawConn, opts: { pack?: string; limit?: number } = {}): Promise<RecentRun[]> {
  if (opts.pack !== undefined && !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(opts.pack)) throw Object.assign(new Error("not a pack id"), { code: 2 });
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 200);
  return readOnly(conn, async (q) => (await q(
    `/* tenant: internal: the platform operator's read-only run report lists the latest runs' ids, kinds and states (no data of theirs) */
     SELECT r.id, o.slug AS workspace, r.pack, r.kind, r.status, r.cost_usd, r.created_at, r.ended_at
       FROM runs r LEFT JOIN organizations o ON o.id = r.org_id ${opts.pack ? "WHERE r.pack = $1" : ""} ORDER BY r.created_at DESC LIMIT ${limit}`,
    opts.pack ? [opts.pack] : [])).map((r) => ({ id: r.id, workspace: r.workspace ?? null, pack: r.pack, kind: r.kind, status: r.status,
      cost_usd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd), created_at: iso(r.created_at), ended_at: iso(r.ended_at) })));
}

async function readOnly<T>(conn: RawConn, read: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<T>): Promise<T> {
  await conn.query("BEGIN");
  try {
    await conn.query("SET TRANSACTION READ ONLY");
    const [ro] = (await conn.query("SHOW transaction_read_only")).rows;
    if (String(ro?.transaction_read_only ?? Object.values(ro ?? {})[0]) !== "on") throw new Error("the transaction could not be made read-only; nothing was read");
    await conn.query("SET LOCAL statement_timeout = '20s'");
    await conn.query("SET LOCAL lock_timeout = '5s'");
    return await read(async (sql, params) => (await conn.query(sql, params)).rows);
  } finally {
    await conn.query("ROLLBACK").catch(() => {});
  }
}

const short = (v: unknown, n: number) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? `${s.slice(0, n)}... (${s.length} chars)` : s; };

/** One event as a line (or a few): step output as its line, the agent's output files with their JSON, the rest as JSON. */
function eventText(e: RunEventRow, full: boolean): string {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const head = `${e.at.slice(11, 19)} #${e.attempt} ${e.type}`;
  if (e.type === "step_log") return `${head} [${String(d.step ?? "")}] ${short(String(d.line ?? ""), full ? 2000 : 400)}`;
  if (e.type === "log" || e.type === "stderr") return `${head} ${short(d.line ?? d.tail ?? d, full ? 4000 : 600)}`;
  if (e.type === "agent_output" || e.type === "agent_file") {
    const j = d.json;
    return `${head} ${String(d.path)} (${d.size} bytes)${j === undefined ? "" : `\n    ${short(j, full ? 12000 : 3000)}`}`;
  }
  return `${head} ${short(d, full ? 4000 : 800)}`;
}

export function formatRunEvents(r: RunEventsReport, opts: { full?: boolean } = {}): string {
  if (!r.run) return "No run with that id (read-only; nothing was changed).";
  const x = r.run;
  const out = [
    `Run ${x.id} (READ ONLY; nothing was changed)`,
    `  workspace ${x.workspace ?? "?"}, ${x.pack}/${x.kind}: ${x.status}, attempt ${x.attempt} of ${x.max_attempts}, cost ${x.cost_usd ?? "?"} USD`,
    `  created ${x.created_at}, started ${x.started_at ?? "-"}, ended ${x.ended_at ?? "-"}`,
    ...(x.error ? [`  error (${x.error_kind}): ${x.error}`] : []),
    `  targets ${JSON.stringify(x.targets)}${x.scope_keys.length ? `; scope keys ${x.scope_keys.join(", ")}` : ""}`,
    `  events by type: ${Object.entries(r.counts).map(([t, n]) => `${t} ${n}`).join(", ") || "none"}`,
    `  ${r.events.length} of ${r.total} event(s) shown${r.truncated ? " (raise --limit for the rest)" : ""}:`,
    ...r.events.map((e) => eventText(e, !!opts.full)),
  ];
  return out.join("\n");
}

export function formatRecentRuns(rows: RecentRun[]): string {
  if (!rows.length) return "No runs (read-only; nothing was changed).";
  return ["Latest runs (READ ONLY; nothing was changed):",
    ...rows.map((r) => `  ${r.id}  ${r.created_at ?? "?"}  ${r.workspace ?? "?"}  ${r.pack}/${r.kind}  ${r.status}  ${r.cost_usd ?? "?"} USD`)].join("\n");
}
