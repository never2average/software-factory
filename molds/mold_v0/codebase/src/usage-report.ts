/**
 * Usage pages in neutral words (mold_v0-008): tool calls and cost per run, per member and per workspace, for one
 * workspace (its members; GET /api/usage, the console's /app/activity) and for the operator (every workspace; GET
 * /api/admin/onboarding/usage, /admin/activity). From what the shell already records:
 *
 *   mcp_events  one row per MCP request (src/analytics.ts recordMcpEvent): workspace, member (or key id), client name and
 *               version, tool, outcome, error class, latency, request and answer sizes. Never arguments or results.
 *   runs        the generic runs (src/runs.ts) with their gateway usage (requests, tokens, cost: src/run-spend.ts) and
 *               their events (a run's tool calls are the events its program reports as `tool_call` or `tool.<name>`).
 *
 * Figures: calls per tool with errors and p50/p95 latency; errors by class; daily and weekly active people (a member,
 * or a key with no member) and week-over-week retention (of the people active one ISO week, how many were active the
 * next); per member (workspace) or per workspace (operator): calls, errors, runs and run cost; per run: its kind,
 * status, who started it, its tool calls, model requests, tokens and cost.
 *
 * The words come from the build: a pack may show "workspace" as "company" or "run" as "audit" (pack.json `words`);
 * with no pack, the shell's own. Workspace reports name the workspace in every query and run under its row-level
 * security (the caller is inside withTenant); the operator's are platform reads, for platform admins only.
 */
import { getDb } from "./db.js";
import { packs } from "./packs.js";
import { RUN_USD } from "./run-spend.js";

const DAY = 86_400_000;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const n = (v: unknown) => Number(v ?? 0) || 0;

/** The shell's words and the packs' (first pack to name a word wins), for the pages' labels. */
export const SHELL_WORDS = { workspace: "workspace", member: "member", run: "run", tool_call: "tool call", key: "key" } as const;
export function usageWords(): Record<keyof typeof SHELL_WORDS, string> {
  const out: Record<string, string> = { ...SHELL_WORDS };
  const set = new Set<string>();
  for (const p of packs()) for (const [k, v] of Object.entries(p.manifest.words ?? {}))
    if (k in SHELL_WORDS && !set.has(k)) { out[k] = v; set.add(k); }
  return out as Record<keyof typeof SHELL_WORDS, string>;
}

/** from/to (YYYY-MM-DD, UTC, both included); default the last 28 days. At most 366 days. */
export function usageRange(q: { from?: unknown; to?: unknown; days?: unknown } = {}, now = Date.now()) {
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) ? Date.parse(`${v}T00:00:00Z`) : null);
  const today = Math.floor(now / DAY) * DAY;
  let to = day(q.to) ?? today, from = day(q.from) ?? to - (Math.min(366, Math.max(1, Math.trunc(Number(q.days) || 28))) - 1) * DAY;
  if (to < from) [from, to] = [to, from];
  if ((to - from) / DAY > 365) from = to - 365 * DAY;
  return { from: new Date(from).toISOString().slice(0, 10), to: new Date(to).toISOString().slice(0, 10), start: new Date(from), end: new Date(to + DAY) };
}
type Range = ReturnType<typeof usageRange>;

/** Who a call is: its member, else its key, else the workspace's own connector. */
// Staff acting for a workspace (mold_v0-067, user_id staff:...) are in its log but are none of its people.
const PERSON = "CASE WHEN e.user_id LIKE 'staff:%' THEN NULL ELSE coalesce('m:' || e.user_id, 'k:' || e.key_id::text, 'w') END";

/** Tool calls in [start, end): per tool, totals, errors by class, active people, retention; for one workspace or all. */
async function callFigures(orgId: number | null, R: Range) {
  const db = await getDb();
  const where = `e.method = 'tools/call' AND e.at >= $1 AND e.at < $2${orgId != null ? " AND e.org_id = $3" : ""}`;
  const who = orgId != null ? PERSON : `e.org_id::text || ':' || ${PERSON}`;
  const p = orgId != null ? [R.start, R.end, orgId] : [R.start, R.end];
  // Retention reads the week before the range too, so the first week has a previous one.
  const wp = orgId != null ? [new Date(+R.start - 7 * DAY), R.end, orgId] : [new Date(+R.start - 7 * DAY), R.end];
  const [tools, totals, classes, daily, weekly, clients] = await Promise.all([
    db.query<{ name: string; calls: number; errors: number; p50: number | null; p95: number | null; req: number | null; res: number | null }>(
      `/* tenant: a workspace's report names e.org_id = $3 (in where); the operator's reads every workspace */ SELECT e.name, count(*)::int AS calls, count(*) FILTER (WHERE NOT e.ok)::int AS errors,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY e.ms) AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY e.ms) AS p95,
              avg(e.req_bytes) AS req, avg(e.res_bytes) AS res
         FROM mcp_events e WHERE ${where} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 200`, p),
    db.query<{ calls: number; errors: number; p50: number | null; p95: number | null; people: number }>(
      `/* tenant: a workspace's report names e.org_id = $3 (in where); the operator's reads every workspace */ SELECT count(*)::int AS calls, count(*) FILTER (WHERE NOT e.ok)::int AS errors,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY e.ms) AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY e.ms) AS p95,
              count(DISTINCT ${who})::int AS people
         FROM mcp_events e WHERE ${where}`, p),
    db.query<{ class: string; n: number }>(
      `/* tenant: a workspace's report names e.org_id = $3 (in where); the operator's reads every workspace */ SELECT coalesce(e.error_class, 'error') AS class, count(*)::int AS n FROM mcp_events e WHERE ${where} AND NOT e.ok GROUP BY 1 ORDER BY 2 DESC`, p),
    db.query<{ day: string; people: number; calls: number }>(
      `/* tenant: a workspace's report names e.org_id = $3 (in where); the operator's reads every workspace */ SELECT to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(DISTINCT ${who})::int AS people, count(*)::int AS calls
         FROM mcp_events e WHERE ${where} GROUP BY 1 ORDER BY 1`, p),
    db.query<{ week: string; person: string }>(
      `/* tenant: a workspace's report names e.org_id = $3 (in where); the operator's reads every workspace */ SELECT DISTINCT to_char(date_trunc('week', e.at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week, ${who} AS person
         FROM mcp_events e WHERE ${where}`, wp),
    db.query<{ name: string | null; version: string | null; calls: number }>(
      `/* tenant: a workspace's report names e.org_id = $3 (in where); the operator's reads every workspace */ SELECT e.client_name AS name, e.client_version AS version, count(*)::int AS calls FROM mcp_events e WHERE ${where}
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`, p),
  ]);
  const t = totals[0] ?? { calls: 0, errors: 0, p50: null, p95: null, people: 0 };
  const days: string[] = [];
  for (let d = +R.start; d < +R.end; d += DAY) days.push(new Date(d).toISOString().slice(0, 10));
  const byDay = new Map(daily.map((d) => [d.day, d]));
  // Weekly active people and week-over-week retention (ISO weeks, Monday, UTC).
  const weeks = new Map<string, Set<string>>();
  for (const w of weekly) { if (w.person == null) continue; const s = weeks.get(w.week) ?? new Set<string>(); s.add(w.person); weeks.set(w.week, s); }
  const monday = (t: number) => { const d = Math.floor(t / DAY) * DAY; return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY; };
  const retention = [];
  for (let w = monday(+R.start); w < +R.end; w += 7 * DAY) {
    const key = new Date(w).toISOString().slice(0, 10), prev = new Date(w - 7 * DAY).toISOString().slice(0, 10);
    const now = weeks.get(key) ?? new Set<string>(), before = weeks.get(prev) ?? new Set<string>();
    const kept = [...before].filter((x) => now.has(x)).length;
    retention.push({ week: key, active: now.size, previous: before.size, retained: kept, rate: before.size ? r2(kept / before.size) : null });
  }
  const lastWeek = new Set(weekly.filter((w) => w.person != null && Date.parse(`${w.week}T00:00:00Z`) >= monday(+R.end - DAY)).map((w) => w.person));
  const dailyPeople = days.map((d) => n(byDay.get(d)?.people));
  return {
    totals: { calls: n(t.calls), errors: n(t.errors), error_rate: n(t.calls) ? r2(n(t.errors) / n(t.calls)) : 0,
      p50_ms: t.p50 == null ? null : Math.round(Number(t.p50)), p95_ms: t.p95 == null ? null : Math.round(Number(t.p95)), people: n(t.people) },
    tools: tools.map((x) => ({ name: x.name, calls: n(x.calls), errors: n(x.errors), p50_ms: x.p50 == null ? null : Math.round(Number(x.p50)),
      p95_ms: x.p95 == null ? null : Math.round(Number(x.p95)), avg_request_bytes: x.req == null ? null : Math.round(Number(x.req)),
      avg_answer_bytes: x.res == null ? null : Math.round(Number(x.res)) })),
    errors_by_class: classes.map((c) => ({ class: c.class, errors: n(c.n) })),
    active: { days, daily_people: dailyPeople, daily_calls: days.map((d) => n(byDay.get(d)?.calls)),
      dau_avg: dailyPeople.length ? r2(dailyPeople.reduce((a, b) => a + b, 0) / dailyPeople.length) : 0, wau: lastWeek.size },
    retention,
    clients: clients.map((c) => ({ name: c.name ?? "unknown", version: c.version, calls: n(c.calls) })),
  };
}

/** A run's tool calls: the events its program reported as tool_call or tool.<name> / tool:<name>. */
const RUN_TOOL_CALLS = "(SELECT count(*) FROM run_events ev WHERE ev.run_id = r.id AND ev.org_id = r.org_id AND (ev.type = 'tool_call' OR ev.type LIKE 'tool.%' OR ev.type LIKE 'tool:%'))";
const RUN_GW = (col: string) => `(SELECT /* tenant: the usage of run r, a row its query scoped */ coalesce(sum(g.${col}), 0) FROM gateway_usage g WHERE g.run_id = r.id)`;

/**
 * One workspace's runs queued in [start, end) (optionally started by some people only): totals, per kind, per person,
 * and the latest runs, each with its tool calls, model requests, tokens and cost.
 */
export async function workspaceRunUsage(orgId: number, start: Date, end: Date, users: string[] = []) {
  const db = await getDb();
  const by = users.length ? " AND r.requested_by = ANY($4)" : "";
  const p = users.length ? [orgId, start, end, users] : [orgId, start, end];
  const rows = await db.query<{ id: string; pack: string; kind: string; status: string; requested_by: string | null; created_at: Date; ended_at: Date | null;
    tool_calls: number; requests: number; tokens: number; usd: number }>(
    `SELECT r.id, r.pack, r.kind, r.status, r.requested_by, r.created_at, r.ended_at, ${RUN_TOOL_CALLS}::int AS tool_calls,
            ${RUN_GW("requests")}::int AS requests, ${RUN_GW("input_tokens + g.output_tokens")}::float AS tokens, ${RUN_USD}::float AS usd
       FROM runs r WHERE r.org_id = $1 AND r.created_at >= $2 AND r.created_at < $3${by} ORDER BY r.created_at DESC, r.id DESC LIMIT 5000`, p);
  const kinds = new Map<string, { pack: string; kind: string; runs: number; succeeded: number; failed: number; tool_calls: number; requests: number; cost_usd: number }>();
  const people = new Map<string, { user_id: string | null; runs: number; tool_calls: number; cost_usd: number }>();
  for (const r of rows) {
    const k = kinds.get(`${r.pack}/${r.kind}`) ?? { pack: r.pack, kind: r.kind, runs: 0, succeeded: 0, failed: 0, tool_calls: 0, requests: 0, cost_usd: 0 };
    k.runs++; if (r.status === "succeeded") k.succeeded++; if (r.status === "failed") k.failed++;
    k.tool_calls += n(r.tool_calls); k.requests += n(r.requests); k.cost_usd = r6(k.cost_usd + n(r.usd));
    kinds.set(`${r.pack}/${r.kind}`, k);
    const who = people.get(r.requested_by ?? "") ?? { user_id: r.requested_by, runs: 0, tool_calls: 0, cost_usd: 0 };
    who.runs++; who.tool_calls += n(r.tool_calls); who.cost_usd = r6(who.cost_usd + n(r.usd));
    people.set(r.requested_by ?? "", who);
  }
  return {
    runs: rows.length, cost_usd: r6(rows.reduce((a, r) => a + n(r.usd), 0)), tool_calls: rows.reduce((a, r) => a + n(r.tool_calls), 0),
    requests: rows.reduce((a, r) => a + n(r.requests), 0), tokens: rows.reduce((a, r) => a + n(r.tokens), 0),
    by_kind: [...kinds.values()].sort((a, b) => b.cost_usd - a.cost_usd || b.runs - a.runs),
    by_person: [...people.values()].sort((a, b) => b.cost_usd - a.cost_usd || b.runs - a.runs),
    recent: rows.slice(0, 25).map((r) => ({ id: r.id, pack: r.pack, kind: r.kind, status: r.status, requested_by: r.requested_by,
      created_at: new Date(r.created_at).toISOString(), ended_at: r.ended_at ? new Date(r.ended_at).toISOString() : null,
      tool_calls: n(r.tool_calls), requests: n(r.requests), tokens: n(r.tokens), cost_usd: r6(n(r.usd)) })),
  };
}

/** One workspace's usage page (its members): the caller passes its own workspace, from its session. */
export async function workspaceUsageReport(orgId: number, q: { from?: unknown; to?: unknown; days?: unknown } = {}) {
  const R = usageRange(q);
  const db = await getDb();
  const [calls, runs, members] = await Promise.all([
    callFigures(orgId, R),
    workspaceRunUsage(orgId, R.start, R.end),
    db.query<{ user_id: string | null; key_id: number | null; calls: number; errors: number }>(
      `SELECT e.user_id, CASE WHEN e.user_id IS NULL THEN e.key_id END AS key_id, count(*)::int AS calls, count(*) FILTER (WHERE NOT e.ok)::int AS errors
         FROM mcp_events e WHERE e.org_id = $1 AND e.method = 'tools/call' AND e.at >= $2 AND e.at < $3 GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 500`,
      [orgId, R.start, R.end]),
  ]);
  const runsOf = new Map(runs.by_person.map((x) => [x.user_id ?? "", x]));
  const rows = members.map((m) => {
    const r = m.user_id ? runsOf.get(m.user_id) : undefined;
    if (m.user_id) runsOf.delete(m.user_id);
    return { user_id: m.user_id, key_id: m.key_id == null ? null : Number(m.key_id), calls: n(m.calls), errors: n(m.errors),
      runs: r?.runs ?? 0, run_tool_calls: r?.tool_calls ?? 0, run_cost_usd: r?.cost_usd ?? 0 };
  });
  // People who started runs but made no call in the range.
  for (const r of runsOf.values()) rows.push({ user_id: r.user_id, key_id: null, calls: 0, errors: 0, runs: r.runs, run_tool_calls: r.tool_calls, run_cost_usd: r.cost_usd });
  return { range: { from: R.from, to: R.to }, words: usageWords(), ...calls, members: rows, runs };
}

/** The operator's usage page: every workspace, platform admins only. */
export async function operatorUsageReport(q: { from?: unknown; to?: unknown; days?: unknown } = {}) {
  const R = usageRange(q);
  const db = await getDb();
  const [calls, perWs, runs] = await Promise.all([
    callFigures(null, R),
    db.query<{ org_id: number; slug: string; name: string; calls: number; errors: number; people: number; p95: number | null }>(
      `/* tenant: internal: operator usage page, every workspace */ SELECT o.id AS org_id, o.slug, o.name, count(e.id)::int AS calls,
              count(e.id) FILTER (WHERE NOT e.ok)::int AS errors, count(DISTINCT ${PERSON}) FILTER (WHERE e.id IS NOT NULL)::int AS people,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY e.ms) AS p95
         FROM organizations o LEFT JOIN mcp_events e ON e.org_id = o.id AND e.method = 'tools/call' AND e.at >= $1 AND e.at < $2
        GROUP BY 1, 2, 3`, [R.start, R.end]),
    db.query<{ org_id: number; runs: number; tool_calls: number; requests: number; usd: number }>(
      `/* tenant: internal: operator usage page, every workspace */ SELECT r.org_id, count(*)::int AS runs, sum(${RUN_TOOL_CALLS})::int AS tool_calls,
              sum(${RUN_GW("requests")})::int AS requests, sum(${RUN_USD})::float AS usd
         FROM runs r WHERE r.created_at >= $1 AND r.created_at < $2 GROUP BY 1`, [R.start, R.end]),
  ]);
  const runsOf = new Map(runs.map((r) => [Number(r.org_id), r]));
  const workspaces = perWs.map((w) => {
    const r = runsOf.get(Number(w.org_id));
    return { slug: w.slug, name: w.name, calls: n(w.calls), errors: n(w.errors), people: n(w.people), p95_ms: w.p95 == null ? null : Math.round(Number(w.p95)),
      runs: n(r?.runs), run_tool_calls: n(r?.tool_calls), run_requests: n(r?.requests), run_cost_usd: r6(n(r?.usd)) };
  }).filter((w) => w.calls || w.runs).sort((a, b) => b.run_cost_usd - a.run_cost_usd || b.calls - a.calls || a.slug.localeCompare(b.slug));
  return { range: { from: R.from, to: R.to }, words: usageWords(), ...calls, workspaces,
    runs: { runs: workspaces.reduce((a, w) => a + w.runs, 0), cost_usd: r6(workspaces.reduce((a, w) => a + w.run_cost_usd, 0)),
      tool_calls: workspaces.reduce((a, w) => a + w.run_tool_calls, 0) } };
}
