import { getDb } from "./db.js";
import { orgBudgets, type BudgetSource } from "./billing.js";
import { team } from "./admin.js";
import { RUN_USD } from "./run-spend.js";
import { researchJobs, sessionEngine } from "./host-tables.js";
import { PROFILE } from "./profile.js";

/**
 * The admin FinOps page's Model spend tab (/admin/finops?section=spend, GET /api/admin/onboarding/spend): what the app spends on models across every
 * account, from metered data only. The boat sandbox price-table estimate is never counted here.
 *
 * Where each dollar comes from, and the day it lands on (UTC):
 *   - Session spend, per session: GREATEST(agent_sessions.cost_usd, sum of its gateway_usage.cost_usd), the figure
 *     Billing uses (queries.ts orgMonthSpendUsd), so a running session counts with its live gateway total. It lands on
 *     the day the session was queued (queued_at), as Billing counts a session in its queued_at month. Attributed to
 *     its account, launcher (simulations.created_by), agent, model and product.
 *   - Orchestrator spend: gateway_model_usage rows with consumer = 'orchestrator', by day, provider and model. The
 *     part that can be tied to a job comes from gateway_usage rows with an orchestrator_id (and no session_id): the
 *     orchestrator's job (orchestrator_sandboxes.job_id) is a simulation or a research job, and so an account. Those
 *     rows are one running total per orchestrator token, so they land on the day of their last request (last_at).
 *     What is left of a day's orchestrator spend (shared orchestrators, prospect research, a day boundary) shows as
 *     "<name> (shared)" (the profile's name): max(0, the day's gateway_model_usage orchestrator cost minus the day's attributed spend).
 *     A day's orchestrator spend is therefore max(metered, attributed).
 *   - Provider and model detail: gateway_model_usage as it is. priced = false means some request's model had no price,
 *     so its cost is understated; the page flags those rows "Unpriced".
 *   - Run spend (mold_v0-053), per run of the generic run engine (src/runs.ts): GREATEST(runs.cost_usd, sum of its
 *     gateway_usage.cost_usd), src/run-spend.ts RUN_USD, landing on the day the run was queued (created_at), attributed
 *     to its account, the member who started it (requested_by) and its kind. Runs are counted as sessions are, in the
 *     account's spend and its month figure; with no runs every figure is what it was.
 *   - "This month vs allowance" is Billing's figure (session and run spend this UTC month) against orgBudget's allowance.
 *   - Providers: the model rows summed per provider; its top accounts come from gateway_usage (per-token running totals,
 *     by last request), a session's account or an orchestrator's through its job, the rest the shared row.
 *
 * Compute hours and Data & storage (the page's other two tabs) are in spend-usage.ts.
 */

const DAY = 86_400_000;
export const SHARED = "shared";
export const SHARED_NAME = `${PROFILE.name} (shared)`;
const badRequest = (msg: string) => Object.assign(new Error(msg), { status: 400 });
const notFound = (msg: string) => Object.assign(new Error(msg), { status: 404 });
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const n = (v: unknown) => Number(v ?? 0) || 0;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const TENANT = "/* tenant: internal: admin Spend page, every account's metered model spend */";

/** from/to (YYYY-MM-DD, UTC, both included); default this month to date. At most 366 days. */
export function spendRange(q: { from?: unknown; to?: unknown }, now = Date.now()) {
  const today = Math.floor(now / DAY) * DAY;
  const d0 = new Date(today);
  const monthStart = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1);
  const parse = (v: unknown, name: string) => {
    if (v == null || v === "") return null;
    const s = String(v);
    const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN;
    if (!Number.isFinite(t) || dayOf(t) !== s) throw badRequest(`${name} must be a date, YYYY-MM-DD`);
    return t;
  };
  const from = parse(q.from, "from") ?? monthStart, to = parse(q.to, "to") ?? today;
  if (to < from) throw badRequest("to must not be before from");
  if ((to - from) / DAY > 365) throw badRequest("A range is at most 366 days");
  const days: string[] = [];
  for (let t = from; t <= to; t += DAY) days.push(dayOf(t));
  const monthEnd = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1);
  const monthDays: string[] = [];
  for (let t = monthStart; t <= today; t += DAY) monthDays.push(dayOf(t));
  return {
    from: dayOf(from), to: dayOf(to), days, start: new Date(from), end: new Date(to + DAY),
    month: { start: dayOf(monthStart), days_in_month: Math.round((monthEnd - monthStart) / DAY), elapsed_days: Math.max(1 / 24, (now - monthStart) / DAY), days: monthDays },
    // Everything is read over the range and this month together, so the month's pace needs no second round.
    window: { start: new Date(Math.min(from, monthStart)), end: new Date(Math.max(to, today) + DAY) },
  };
}

interface SessionCell { org_id: number; day: string; model: string; usd: number; sessions: number; last_at: Date | null }
interface OrchCell { org_id: number; day: string; usd: number; last_at: Date | null }
interface ModelDay { day: string; provider: string; model: string; consumer: "session" | "orchestrator"; requests: number; errors: number;
  input_tokens: number; cached_input_tokens: number; output_tokens: number; cost_usd: number; priced: boolean }

interface DayPart { session_usd: number; orchestrator_usd: number; run_usd: number; sessions: number; top_model: string | null }
interface RunCell { org_id: number; day: string; usd: number; runs: number; last_at: Date | null }

/**
 * The session spend CTE: one row per session queued in [$1, $2), its spend as Billing counts it. The session engine's
 * tables are a host pack's (mold_v0-049): in a build without them, no rows (the same columns).
 */
const SESSIONS = () => !sessionEngine() ? `
  ses AS (SELECT NULL::text AS id, NULL::int AS org_id, NULL::text AS simulation_id, NULL::int AS product_id, NULL::text AS model, NULL::text AS agent,
                 NULL::text AS day, NULL::float AS usd, NULL::timestamptz AS last_at WHERE false AND $1::timestamptz IS NULL AND $2::timestamptz IS NULL)` : `
  ses AS (
    SELECT s.id, s.org_id, s.simulation_id, s.product_id, s.model, coalesce(s.agent_id, s.harness || '/' || s.model) AS agent,
           to_char(s.queued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
           GREATEST(s.cost_usd, coalesce(g.usd, 0))::float AS usd,
           GREATEST(s.queued_at, g.last_at) AS last_at
      FROM agent_sessions s
      LEFT JOIN LATERAL (SELECT sum(x.cost_usd) AS usd, max(x.last_at) AS last_at FROM gateway_usage x WHERE x.session_id = s.id) g ON true
     WHERE s.queued_at >= $1 AND s.queued_at < $2)`;

/**
 * Orchestrator gateway rows tied to an account through their job, in [$1, $2) by last request. A job is a simulation
 * or research, the session engine's (a host pack's tables, mold_v0-049): without them no row has an account.
 */
const ORCHESTRATORS = () => `
  orch AS (
    SELECT g.cost_usd::float AS usd, g.last_at, to_char(g.last_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, os.job_id,
           ${jobJoins().org} AS org_id, ${sessionEngine() ? "sim.created_by" : "NULL::text"} AS created_by, ${researchJobs() ? "(pr.id IS NOT NULL)" : "false"} AS research
      FROM gateway_usage g
      LEFT JOIN LATERAL (SELECT x.job_id FROM orchestrator_sandboxes x WHERE x.orchestrator_id = g.orchestrator_id AND x.job_id IS NOT NULL
                          ORDER BY x.id DESC LIMIT 1) os ON true${jobJoins().joins}
     WHERE g.orchestrator_id IS NOT NULL AND g.session_id IS NULL AND g.last_at >= $1 AND g.last_at < $2)`;
/** The joins from an orchestrator's job (os.job_id) to its simulation and research, with the account they give. */
const jobJoins = () => ({
  joins: (sessionEngine() ? "\n      LEFT JOIN simulations sim ON sim.id = os.job_id" : "") + (researchJobs() ? "\n      LEFT JOIN product_research pr ON pr.id = os.job_id" : ""),
  org: sessionEngine() && researchJobs() ? "coalesce(sim.org_id, pr.org_id)" : sessionEngine() ? "sim.org_id" : "NULL::int",
});

/** Runs queued in [$1, $2), each with its spend (src/run-spend.ts RUN_USD). */
const RUNS = `
  rr AS (
    SELECT r.id, r.org_id, r.pack, r.kind, r.requested_by, to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
           ${RUN_USD}::float AS usd, GREATEST(r.created_at, (SELECT max(g.last_at) FROM gateway_usage g WHERE g.run_id = r.id)) AS last_at
      FROM runs r WHERE r.created_at >= $1 AND r.created_at < $2)`;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Every figure of the Spend page in one round of queries (run together). */
export async function spendReport(q: { from?: unknown; to?: unknown } = {}, now = Date.now()) {
  const R = spendRange(q, now);
  const db = await getDb();
  const w = [R.window.start, R.window.end];
  const [sesCells, orchCells, modelDays, orgs, provAccounts, runCells] = await Promise.all([
    db.query<SessionCell>(`${TENANT} WITH ${SESSIONS()}
      SELECT org_id, day, model, sum(usd)::float AS usd, count(*)::int AS sessions, max(last_at) FILTER (WHERE usd > 0) AS last_at
        FROM ses GROUP BY 1, 2, 3`, w),
    db.query<OrchCell>(`${TENANT} WITH ${ORCHESTRATORS()}
      SELECT org_id, day, sum(usd)::float AS usd, max(last_at) AS last_at FROM orch WHERE org_id IS NOT NULL GROUP BY 1, 2`, w),
    db.query<ModelDay>(`${TENANT} SELECT to_char(day, 'YYYY-MM-DD') AS day, provider, model, consumer, requests::int AS requests, errors::int AS errors,
        input_tokens::float AS input_tokens, cached_input_tokens::float AS cached_input_tokens, output_tokens::float AS output_tokens,
        cost_usd::float AS cost_usd, priced
        FROM gateway_model_usage WHERE day >= $1::date AND day < $2::date`, [dayOf(+R.window.start), dayOf(+R.window.end)]),
    db.query<{ id: number; slug: string; name: string }>("SELECT id, slug, name FROM organizations ORDER BY name"),
    // Per provider and account, the gateway's own per-token totals in the range (by last request): a session's account,
    // or an orchestrator's through its job; neither is the shared row (org_id null).
    db.query<{ provider: string; org_id: number | null; usd: number; requests: number }>(`${TENANT}
      SELECT g.provider, coalesce(${sessionEngine() ? "s.org_id, " : ""}run.org_id, ${jobJoins().org}) AS org_id, sum(g.cost_usd)::float AS usd, sum(g.requests)::int AS requests
        FROM gateway_usage g${sessionEngine() ? "\n        LEFT JOIN agent_sessions s ON s.id = g.session_id" : ""}
        LEFT JOIN runs run ON run.id = g.run_id
        LEFT JOIN LATERAL (SELECT x.job_id FROM orchestrator_sandboxes x WHERE g.session_id IS NULL AND x.orchestrator_id = g.orchestrator_id AND x.job_id IS NOT NULL
                            ORDER BY x.id DESC LIMIT 1) os ON true${jobJoins().joins}
       WHERE g.last_at >= $1 AND g.last_at < $2 GROUP BY 1, 2`, [R.start, R.end]),
    db.query<RunCell>(`${TENANT} WITH ${RUNS}
      SELECT org_id, day, sum(usd)::float AS usd, count(*)::int AS runs, max(last_at) FILTER (WHERE usd > 0) AS last_at FROM rr GROUP BY 1, 2`, w),
  ]);
  const budgets = await orgBudgets(orgs.map((o) => Number(o.id)));
  const inRange = (d: string) => d >= R.from && d <= R.to;
  const inMonth = (d: string) => d >= R.month.start;
  const keyOf = new Map(orgs.map((o) => [Number(o.id), o.slug]));
  const nameOf = new Map<string, string>([...orgs.map((o) => [o.slug, o.name] as [string, string]), [SHARED, SHARED_NAME]]);

  // Per (account, day): session spend, attributed orchestrator spend, sessions, the day's top session model.
  const parts = new Map<string, Map<string, DayPart & { models: Map<string, number> }>>();
  const part = (key: string, day: string) => {
    const m = parts.get(key) ?? new Map(); parts.set(key, m);
    const p = m.get(day) ?? { session_usd: 0, orchestrator_usd: 0, run_usd: 0, sessions: 0, top_model: null, models: new Map<string, number>() }; m.set(day, p);
    return p;
  };
  const lastAt = new Map<string, number>();
  const seen = (key: string, d: Date | null) => { if (d) lastAt.set(key, Math.max(lastAt.get(key) ?? 0, +new Date(d))); };
  const rangeModels = new Map<string, Map<string, number>>(); // account -> model -> session usd in range
  for (const c of sesCells) {
    const key = keyOf.get(Number(c.org_id)); if (!key) continue;
    const p = part(key, c.day);
    p.session_usd += n(c.usd); p.sessions += n(c.sessions); p.models.set(c.model, (p.models.get(c.model) ?? 0) + n(c.usd));
    if (inRange(c.day)) {
      seen(key, c.last_at);
      const m = rangeModels.get(key) ?? new Map(); rangeModels.set(key, m); m.set(c.model, (m.get(c.model) ?? 0) + n(c.usd));
    }
  }
  for (const c of runCells) {
    const key = keyOf.get(Number(c.org_id)); if (!key) continue;
    part(key, c.day).run_usd += n(c.usd);
    if (inRange(c.day)) seen(key, c.last_at);
  }
  const attributed = new Map<string, number>(); // day -> attributed orchestrator usd
  for (const c of orchCells) {
    const key = keyOf.get(Number(c.org_id)); if (!key) continue;
    part(key, c.day).orchestrator_usd += n(c.usd);
    attributed.set(c.day, (attributed.get(c.day) ?? 0) + n(c.usd));
    if (inRange(c.day)) seen(key, c.last_at);
  }
  // Shared: the day's metered orchestrator spend that no job claimed.
  const orchByDay = new Map<string, number>(), orchModelsByDay = new Map<string, Map<string, number>>();
  for (const r of modelDays) {
    const add = (m: Map<string, Map<string, number>>) => { const x = m.get(r.day) ?? new Map(); m.set(r.day, x); x.set(r.model, (x.get(r.model) ?? 0) + n(r.cost_usd)); };
    if (r.consumer === "orchestrator") { orchByDay.set(r.day, (orchByDay.get(r.day) ?? 0) + n(r.cost_usd)); add(orchModelsByDay); }
  }
  const top = (m: Map<string, number> | undefined) => {
    let best: string | null = null, v = 0;
    for (const [k, x] of m ?? []) if (x > v) { best = k; v = x; }
    return best;
  };
  for (const [day, usd] of orchByDay) {
    const left = usd - (attributed.get(day) ?? 0);
    if (left > 1e-9) { const p = part(SHARED, day); p.orchestrator_usd += left; p.models = orchModelsByDay.get(day) ?? new Map(); }
    if (inRange(day) && usd > 0) lastAt.set(SHARED, Math.max(lastAt.get(SHARED) ?? 0, Date.parse(`${day}T23:59:59Z`)));
  }
  for (const m of parts.values()) for (const p of m.values()) p.top_model = top(p.models);
  const at = (key: string, day: string) => parts.get(key)?.get(day);

  // ---------- Accounts ----------
  const keys = [...orgs.map((o) => o.slug), SHARED];
  const accounts = keys.map((key) => {
    const shared = key === SHARED;
    const org = shared ? null : orgs.find((o) => o.slug === key)!;
    const daily_session = R.days.map((d) => r6(at(key, d)?.session_usd ?? 0));
    const daily_orchestrator = R.days.map((d) => r6(at(key, d)?.orchestrator_usd ?? 0));
    const daily_run = R.days.map((d) => r6(at(key, d)?.run_usd ?? 0));
    const month_daily = R.month.days.map((d) => r6((at(key, d)?.session_usd ?? 0) + (at(key, d)?.orchestrator_usd ?? 0) + (at(key, d)?.run_usd ?? 0)));
    // Billing's figure: session and run spend this month (orchestrator spend is not charged to the allowance).
    const month_usd = r6(sum(R.month.days.map((d) => (at(key, d)?.session_usd ?? 0) + (at(key, d)?.run_usd ?? 0))));
    const b = org ? budgets.get(Number(org.id)) : undefined;
    const session_usd = r6(sum(daily_session)), orchestrator_usd = r6(sum(daily_orchestrator)), run_usd = r6(sum(daily_run));
    const rangeOrch = new Map<string, number>();
    if (shared) for (const d of R.days) for (const [m, v] of orchModelsByDay.get(d) ?? []) rangeOrch.set(m, (rangeOrch.get(m) ?? 0) + v);
    return {
      key, slug: org?.slug ?? null, name: nameOf.get(key)!, shared,
      allowance: b ? { budget_usd: b.budget, plan: b.plan, source: b.source as BudgetSource } : null,
      spent_usd: r6(session_usd + orchestrator_usd + run_usd), session_usd, orchestrator_usd, run_usd,
      month_usd: shared ? r6(sum(month_daily)) : month_usd,
      month_pct: b && b.budget > 0 ? month_usd / b.budget : null,
      sessions: sum(R.days.map((d) => at(key, d)?.sessions ?? 0)),
      top_model: top(shared ? rangeOrch : rangeModels.get(key)),
      last_spend_at: lastAt.has(key) ? new Date(lastAt.get(key)!).toISOString() : null,
      daily_session, daily_orchestrator, daily_run, month_daily,
    };
  });

  // ---------- Models: gateway_model_usage over the range, per provider, model and consumer ----------
  const idx = new Map(R.days.map((d, i) => [d, i]));
  const mrows = new Map<string, { key: string; provider: string; model: string; consumer: "session" | "orchestrator"; requests: number; errors: number;
    input_tokens: number; cached_input_tokens: number; output_tokens: number; cost_usd: number; priced: boolean; unpriced_requests: number; last_day: string;
    daily_requests: number[]; daily_tokens: number[]; daily_unpriced: number[]; daily_cost: number[] }>();
  for (const r of modelDays) {
    if (!inRange(r.day)) continue;
    const key = `${r.provider}|${r.model}|${r.consumer}`;
    const x = mrows.get(key) ?? { key, provider: r.provider, model: r.model, consumer: r.consumer, requests: 0, errors: 0, input_tokens: 0, cached_input_tokens: 0,
      output_tokens: 0, cost_usd: 0, priced: true, unpriced_requests: 0, last_day: r.day,
      daily_requests: R.days.map(() => 0), daily_tokens: R.days.map(() => 0), daily_unpriced: R.days.map(() => 0), daily_cost: R.days.map(() => 0) };
    mrows.set(key, x);
    const i = idx.get(r.day)!;
    x.requests += n(r.requests); x.errors += n(r.errors); x.input_tokens += n(r.input_tokens); x.cached_input_tokens += n(r.cached_input_tokens);
    x.output_tokens += n(r.output_tokens); x.cost_usd = r6(x.cost_usd + n(r.cost_usd));
    if (!r.priced) { x.priced = false; x.unpriced_requests += n(r.requests); x.daily_unpriced[i] += n(r.requests); }
    if (r.day > x.last_day) x.last_day = r.day;
    x.daily_requests[i] += n(r.requests); x.daily_tokens[i] += n(r.input_tokens) + n(r.output_tokens); x.daily_cost[i] = r6(x.daily_cost[i] + n(r.cost_usd));
  }
  const models = [...mrows.values()].sort((a, b) => b.cost_usd - a.cost_usd || a.key.localeCompare(b.key));

  // ---------- Providers: the models rows summed per provider, with the accounts that spent most through it ----------
  const providers = [...new Set(models.map((m) => m.provider))].map((provider) => {
    const ms = models.filter((m) => m.provider === provider);
    const tot = (f: (m: (typeof models)[number]) => number) => sum(ms.map(f));
    const daily = (f: (m: (typeof models)[number]) => number[]) => R.days.map((_, i) => sum(ms.map((m) => f(m)[i])));
    const top_accounts = provAccounts.filter((r) => r.provider === provider).map((r) => {
      const key = r.org_id == null ? SHARED : keyOf.get(Number(r.org_id)) ?? SHARED;
      return { key, usd: n(r.usd), requests: n(r.requests) };
    }).reduce((acc, r) => { const x = acc.get(r.key) ?? { key: r.key, name: nameOf.get(r.key)!, usd: 0, requests: 0 }; x.usd = r6(x.usd + r.usd); x.requests += r.requests; acc.set(r.key, x); return acc; },
      new Map<string, { key: string; name: string; usd: number; requests: number }>());
    return {
      provider, models: ms.length, requests: tot((m) => m.requests), errors: tot((m) => m.errors), input_tokens: tot((m) => m.input_tokens),
      cached_input_tokens: tot((m) => m.cached_input_tokens), output_tokens: tot((m) => m.output_tokens), cost_usd: r6(tot((m) => m.cost_usd)),
      session_usd: r6(sum(ms.filter((m) => m.consumer === "session").map((m) => m.cost_usd))),
      orchestrator_usd: r6(sum(ms.filter((m) => m.consumer === "orchestrator").map((m) => m.cost_usd))),
      priced: ms.every((m) => m.priced), unpriced_requests: tot((m) => m.unpriced_requests), last_day: ms.map((m) => m.last_day).sort().at(-1)!,
      daily_requests: daily((m) => m.daily_requests), daily_cost: daily((m) => m.daily_cost).map(r6),
      top_accounts: [...top_accounts.values()].sort((a, b) => b.usd - a.usd || b.requests - a.requests).slice(0, 10),
    };
  }).sort((a, b) => b.cost_usd - a.cost_usd || a.provider.localeCompare(b.provider));

  const totals = {
    session_usd: r6(sum(accounts.map((a) => a.session_usd))), orchestrator_usd: r6(sum(accounts.map((a) => a.orchestrator_usd))),
    run_usd: r6(sum(accounts.map((a) => a.run_usd))), total_usd: 0,
    shared_usd: accounts.find((a) => a.shared)!.spent_usd, metered_model_usd: r6(sum(models.map((m) => m.cost_usd))),
    unpriced_requests: sum(models.map((m) => m.unpriced_requests)),
  };
  totals.total_usd = r6(totals.session_usd + totals.orchestrator_usd + totals.run_usd);
  return { range: { from: R.from, to: R.to, days: R.days }, month: R.month, totals, accounts, models, providers };
}

/** One account's peek (or the shared row's): spend in the range by person, model, agent and product. */
export async function accountSpend(key: string, q: { from?: unknown; to?: unknown } = {}, now = Date.now()) {
  const R = spendRange(q, now);
  const db = await getDb();
  const span = [R.start, R.end];
  if (key === SHARED) {
    const rows = await db.query<{ provider: string; model: string; usd: number; requests: number }>(`${TENANT}
      SELECT provider, model, sum(cost_usd)::float AS usd, sum(requests)::int AS requests FROM gateway_model_usage
       WHERE consumer = 'orchestrator' AND day >= $1::date AND day < $2::date GROUP BY 1, 2 ORDER BY 3 DESC`, [R.from, dayOf(+R.end)]);
    return { key, name: SHARED_NAME, by_person: [], by_agent: [], by_product: [],
      by_model: rows.map((r) => ({ model: r.model, provider: r.provider, usd: r6(n(r.usd)), sessions: null, requests: n(r.requests) })) };
  }
  const [org] = await db.query<{ id: number; slug: string; name: string }>("SELECT id, slug, name FROM organizations WHERE slug = $1", [key]);
  if (!org) throw notFound(`No account ${key}`);
  const [ses, orch, runRows] = await Promise.all([
    !sessionEngine() ? Promise.resolve([] as { created_by: string | null; model: string; agent: string; product: string | null; usd: number; sessions: number }[])
    : db.query<{ created_by: string | null; model: string; agent: string; product: string | null; usd: number; sessions: number }>(`WITH ${SESSIONS()}
      SELECT r.created_by, ses.model, ses.agent, p.name AS product, sum(ses.usd)::float AS usd, count(*)::int AS sessions
        FROM ses JOIN simulations r ON r.id = ses.simulation_id LEFT JOIN products p ON p.id = ses.product_id
       WHERE ses.org_id = $3 GROUP BY 1, 2, 3, 4`, [...span, org.id]),
    db.query<{ created_by: string | null; research: boolean; usd: number }>(`WITH ${ORCHESTRATORS()}
      SELECT created_by, research, sum(usd)::float AS usd FROM orch WHERE org_id = $3 GROUP BY 1, 2`, [...span, org.id]),
    db.query<{ requested_by: string | null; kind: string; usd: number; runs: number }>(`WITH ${RUNS}
      SELECT requested_by, pack || '/' || kind AS kind, sum(usd)::float AS usd, count(*)::int AS runs FROM rr WHERE org_id = $3 GROUP BY 1, 2`, [...span, org.id]),
  ]);
  let who = new Map<string, string>();
  try { who = new Map((await team(org.slug)).members.map((m) => [m.user_id, m.email ?? m.name ?? m.user_id])); }
  catch { /* Clerk unreachable or not configured: ids stand in */ }
  const people = new Map<string, { user_id: string | null; label: string; session_usd: number; orchestrator_usd: number; run_usd?: number; sessions: number }>();
  const person = (id: string | null, research = false) => {
    const k = research ? "research" : id ?? "";
    const p = people.get(k) ?? { user_id: research ? null : id, label: research ? "Product research" : id == null ? "Connector key" : who.get(id) ?? "Former member",
      session_usd: 0, orchestrator_usd: 0, sessions: 0 };
    people.set(k, p);
    return p;
  };
  for (const r of ses) { const p = person(r.created_by); p.session_usd += n(r.usd); p.sessions += n(r.sessions); }
  for (const r of orch) person(r.research ? null : r.created_by, r.research).orchestrator_usd += n(r.usd);
  for (const r of runRows) { const p = person(r.requested_by); p.run_usd = (p.run_usd ?? 0) + n(r.usd); }
  const group = (f: (r: (typeof ses)[number]) => string | null) => {
    const m = new Map<string, { usd: number; sessions: number }>();
    for (const r of ses) { const k = f(r) ?? "—"; const x = m.get(k) ?? { usd: 0, sessions: 0 }; x.usd += n(r.usd); x.sessions += n(r.sessions); m.set(k, x); }
    return [...m].map(([k, x]) => ({ k, usd: r6(x.usd), sessions: x.sessions })).sort((a, b) => b.usd - a.usd || b.sessions - a.sessions);
  };
  return {
    key, name: org.name,
    by_person: [...people.values()].map((p) => ({ ...p, session_usd: r6(p.session_usd), orchestrator_usd: r6(p.orchestrator_usd),
      ...(p.run_usd != null ? { run_usd: r6(p.run_usd) } : {}), usd: r6(p.session_usd + p.orchestrator_usd + (p.run_usd ?? 0)) }))
      .sort((a, b) => b.usd - a.usd),
    by_model: group((r) => r.model).map(({ k, ...x }) => ({ model: k, provider: null, ...x, requests: null })),
    by_agent: group((r) => r.agent).map(({ k, ...x }) => ({ agent: k, ...x })),
    by_product: group((r) => r.product).map(({ k, ...x }) => ({ product: k, ...x })),
    // Runs by kind (mold_v0-053), only when the range has any.
    ...(runRows.length ? { by_run_kind: [...runRows.reduce((m, r) => { const x = m.get(r.kind) ?? { kind: r.kind, usd: 0, runs: 0 }; x.usd = r6(x.usd + n(r.usd)); x.runs += n(r.runs); return m.set(r.kind, x); },
      new Map<string, { kind: string; usd: number; runs: number }>()).values()].sort((a, b) => b.usd - a.usd) } : {}),
  };
}

export type SpendReport = Awaited<ReturnType<typeof spendReport>>;
