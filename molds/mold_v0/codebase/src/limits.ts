/**
 * Usage limits inside an account: how an account's admins split the plan's monthly model budget across teams and
 * people, who may launch simulations (rollout), and how much each person may run at once (throughput). Set on /app
 * (Billing, Budget rules) by the account's admins; enforced when a simulation starts and while an adaptive run samples
 * more. Spend is live: a session that is still running counts what the gateway has metered so far.
 *
 * The plan's budget comes from Stripe (src/billing.ts) and people from Clerk; this module only stores the policy
 * (Octillion is the one enforcing spend on its own gateway, so the policy has to live here). Limits apply to people
 * signed in with Clerk; connector keys draw from the account's pool.
 *
 * Per calendar month (UTC), in every mode: the buffer (reserve_usd) and each team's budget are set aside; everyone
 * outside a budgeted team shares the rest; a person's own limit (cap_usd) applies. Inside each budget, people:
 *  - pool:   share it freely (no personal limit beyond their own);
 *  - even:   get an equal share of it, less own limits, split between those who can launch, plus their adjustment;
 *  - custom: can each spend up to the default cap.
 * allocate() below is the one place this is worked out; the page, checkRun and adaptive runs all use it.
 */
import type { Org } from "./auth.js";
import { orgBudget } from "./billing.js";
import { getDb, type Queryable } from "./db.js";
import { settingNumber } from "./settings.js";
import { accountRefusal, canAccount, type AccountRole } from "./account-roles.js";
import { monthRunSpendByPerson, RUN_USD } from "./run-spend.js";
import { sessionEngine } from "./host-tables.js";

/** Why a launch was refused, for /app to show beside the message; validation errors carry no code. */
export type LimitCode = "viewer_role" | "no_allowance" | "account_cap" | "budget_error" | "launch_access" | "person_limit" | "team_budget" | "rest_pot" | "buffer" |
  "runs_at_once" | "run_sessions";
export interface LimitInfo { code?: LimitCode; limit_usd?: number | null; left_usd?: number | null; set_by?: "you" | "team" | "account"; admins?: { name: string }[] }

export class LimitError extends Error {
  constructor(message: string, public status = 400, public info: LimitInfo = {}) { super(message); }
}

/** The calendar month's name and the date it resets (UTC), for refusal messages: "October", "November 1". */
export function monthWords(now = new Date()) {
  const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
  return { month: fmt(now, { month: "long" }), reset: fmt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)), { month: "long", day: "numeric" }) };
}

export type Mode = "pool" | "even" | "custom";

interface Policy { mode: Mode; reserve_usd: number; default_cap_usd: number | null; new_members_can_run: boolean;
  max_concurrent_runs: number | null; max_sessions_per_run: number | null; max_run_usd: number | null; updated_at: Date | null; updated_by: string | null }
interface Team { id: number; name: string; budget_usd: number | null; max_concurrent_runs: number | null }
interface MemberRow { user_id: string; team_id: number | null; cap_usd: number | null; adjust_usd: number; can_run: boolean | null; max_concurrent_runs: number | null }

const DEFAULT_POLICY: Policy = { mode: "pool", reserve_usd: 0, default_cap_usd: null, new_members_can_run: true,
  max_concurrent_runs: null, max_sessions_per_run: null, max_run_usd: null, updated_at: null, updated_by: null };
const num = (v: unknown) => (v == null ? null : Number(v));
const MONTH = `date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

/** The saved rules. Pass the transaction when inside one (a nested query outside it would wait on it). */
async function load(orgId: number, q?: Queryable) {
  const db = q ?? await getDb();
  const [p] = await db.query<Policy>("SELECT * FROM usage_policies WHERE org_id = $1", [orgId]);
  const teams = (await db.query<Team>("SELECT id, name, budget_usd, max_concurrent_runs FROM usage_teams WHERE org_id = $1 ORDER BY name", [orgId]))
    .map((t) => ({ ...t, id: Number(t.id), budget_usd: num(t.budget_usd), max_concurrent_runs: num(t.max_concurrent_runs) }));
  const rows = (await db.query<MemberRow>("SELECT user_id, team_id, cap_usd, adjust_usd, can_run, max_concurrent_runs FROM usage_members WHERE org_id = $1", [orgId]))
    .map((m) => ({ ...m, team_id: num(m.team_id), cap_usd: num(m.cap_usd), adjust_usd: Number(m.adjust_usd ?? 0), max_concurrent_runs: num(m.max_concurrent_runs) }));
  const policy: Policy = p ? { ...p, reserve_usd: Number(p.reserve_usd), default_cap_usd: num(p.default_cap_usd),
    max_concurrent_runs: num(p.max_concurrent_runs), max_sessions_per_run: num(p.max_sessions_per_run), max_run_usd: num(p.max_run_usd) } : DEFAULT_POLICY;
  return { policy, teams, rows: new Map(rows.map((m) => [m.user_id, m])) };
}

/**
 * This month's spend, tokens and open runs per person who launched simulations (simulations.created_by), plus the
 * spend of the runs they started (runs.requested_by, mold_v0-053). Spend is live:
 * per session, its recorded cost or the gateway's running total while it runs (whichever is larger), the same figure as
 * the account's spend (orgMonthSpendUsd in src/queries.ts), so a person's limit counts the runs they have going now.
 * in_flight is the part of it from sessions still queued or running.
 */
async function usageByPerson(orgId: number) {
  const db = await getDb();
  // The session engine's tables are a host pack's (mold_v0-049): with none, only the runs people started count.
  const rows = !sessionEngine() ? [] : await db.query<{ user_id: string; spent: number; in_flight: number; tokens_in: number; tokens_out: number; running: number }>(
    `WITH sims AS (SELECT id, created_by, status FROM simulations WHERE org_id = $1 AND created_by IS NOT NULL),
          live AS (SELECT s.created_by, a.status, a.tokens_in, a.tokens_out,
                          GREATEST(a.cost_usd, coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.session_id = a.id), 0)) AS usd
                     FROM sims s JOIN agent_sessions a ON a.simulation_id = s.id WHERE a.queued_at >= ${MONTH}),
          used AS (SELECT created_by, sum(usd) AS spent, coalesce(sum(usd) FILTER (WHERE status IN ('queued', 'running')), 0) AS in_flight,
                          sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out
                     FROM live GROUP BY created_by),
          open AS (SELECT created_by, count(*) AS running FROM sims WHERE status IN ('queued', 'running') GROUP BY created_by)
     SELECT p.created_by AS user_id, coalesce(u.spent, 0) AS spent, coalesce(u.in_flight, 0) AS in_flight, coalesce(u.tokens_in, 0) AS tokens_in,
            coalesce(u.tokens_out, 0) AS tokens_out, coalesce(o.running, 0) AS running
       FROM (SELECT DISTINCT created_by FROM sims) p LEFT JOIN used u ON u.created_by = p.created_by LEFT JOIN open o ON o.created_by = p.created_by`,
    [orgId]);
  const out = new Map(rows.map((r) => [r.user_id, { spent: Number(r.spent), in_flight_usd: Number(r.in_flight), tokens_in: Number(r.tokens_in),
    tokens_out: Number(r.tokens_out), running: Number(r.running) }]));
  // The runs a person started this month count against their limits too (mold_v0-053, src/run-spend.ts).
  for (const [user, x] of await monthRunSpendByPerson(orgId)) {
    const u = out.get(user) ?? { spent: 0, in_flight_usd: 0, tokens_in: 0, tokens_out: 0, running: 0 };
    out.set(user, { ...u, spent: u.spent + x.spent, in_flight_usd: u.in_flight_usd + x.in_flight_usd });
  }
  return out;
}

/** The most agent sessions one run may have: the server's limit, or the account's own if it is lower. */
export async function sessionsLimit(orgId: number): Promise<number> {
  const server = settingNumber("OCTILLION_MAX_SESSIONS_PER_RUN");
  const [p] = await (await getDb()).query<{ n: number | null }>("SELECT max_sessions_per_run AS n FROM usage_policies WHERE org_id = $1", [orgId]);
  return p?.n == null ? server : Math.min(server, Number(p.n));
}

export interface Usage { spent: number; in_flight_usd: number; tokens_in: number; tokens_out: number; running: number }
const NO_USAGE: Usage = { spent: 0, in_flight_usd: 0, tokens_in: 0, tokens_out: 0, running: 0 };
type Member = Omit<MemberRow, "user_id">;
const NO_ROW: Member = { team_id: null, cap_usd: null, adjust_usd: 0, can_run: null, max_concurrent_runs: null };

/** What allocate() works from: a policy (saved, or a draft), the teams, the account's active members and their own
 *  settings (no row: all defaults), live usage per person, the account's allowance and its live spend (connector keys included). */
export interface AllocInput {
  policy: Pick<Policy, "mode" | "reserve_usd" | "default_cap_usd" | "new_members_can_run" | "max_concurrent_runs">;
  teams: Team[];
  members: ({ user_id: string } & Partial<Member>)[];
  usage: Map<string, Usage>;
  cap: number;
  account_spent_usd: number;
}

const cents = (v: number) => Math.round(v * 100) / 100;
const leftOf = (limit: number, spent: number) => Math.max(0, cents(limit - spent));

/**
 * Who gets what, and who is blocked: one pure function, so the page, launches and adaptive runs can't disagree.
 *
 * Pots: the buffer (reserve_usd, which nobody can launch into), each team with a budget (a $0 budget is a real $0), and
 * everyone else, who share R = cap - buffer - team budgets (never below 0). These are set aside in every mode.
 * A person's limit: their own (cap_usd) in every mode; else per mode: pool, none (they draw on their pot); custom, the
 * default cap; even, what is left of their pot after own limits, split between the people in it who can launch and
 * have no own limit, plus their adjustment. With a $0 allowance every limit is $0.
 * A launch is checked in this order, and the first that fails is the reason (`blocked`): the account's allowance,
 * launch access, the person's limit, their pot (team budget or Everyone else), the buffer (the account's spend has
 * reached cap - buffer). `limited_by` is the first of those at 90% or more of its limit.
 */
export function allocate({ policy, teams, members, usage, cap, account_spent_usd }: AllocInput) {
  const zero = cap <= 0;
  const budgeted = new Map(teams.filter((t) => t.budget_usd != null).map((t) => [t.id, t]));
  const buffer_usd = cents(policy.reserve_usd);
  const team_budgets_usd = cents([...budgeted.values()].reduce((s, t) => s + (t.budget_usd ?? 0), 0));
  const rest_usd = Math.max(0, cents(cap - buffer_usd - team_budgets_usd));
  const launchable_usd = Math.max(0, cents(cap - buffer_usd));
  const people = members.map((m) => {
    const r: Member = { ...NO_ROW, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) };
    const team_id = r.team_id != null && teams.some((t) => t.id === r.team_id) ? r.team_id : null;
    return { user_id: m.user_id, ...r, team_id, pot: team_id != null && budgeted.has(team_id) ? team_id : null,
      own_can_run: r.can_run, can_run: r.can_run ?? policy.new_members_can_run, u: usage.get(m.user_id) ?? NO_USAGE };
  });
  const potBudget = (pot: number | null) => (pot == null ? rest_usd : budgeted.get(pot)!.budget_usd ?? 0);
  const potSpent = (pot: number | null) => people.filter((p) => p.pot === pot).reduce((s, p) => s + p.u.spent, 0);
  // Even split, per pot: the pot less its people's own limits, between those who can launch and have none.
  const shareOf = (pot: number | null) => {
    const inPot = people.filter((p) => p.pot === pot);
    const splitters = inPot.filter((p) => p.can_run && p.cap_usd == null).length;
    const own = inPot.reduce((s, p) => s + (p.cap_usd ?? 0), 0);
    return splitters ? Math.max(0, potBudget(pot) - own) / splitters : 0;
  };

  const account = {
    cap_usd: cap, spent_usd: cents(account_spent_usd), launchable_usd, left_usd: leftOf(launchable_usd, account_spent_usd),
    blocked: (zero ? "no_allowance" : cents(account_spent_usd) >= cap ? "account_cap" : cents(account_spent_usd) >= launchable_usd ? "buffer" : null) as LimitCode | null,
  };
  const out = people.map((p) => {
    const limit_source: "own" | "share" | "default" | "pool" = p.cap_usd != null ? "own" : policy.mode === "even" ? "share" : policy.mode === "custom" ? "default" : "pool";
    let limit: number | null =
      limit_source === "own" ? p.cap_usd
      : limit_source === "default" ? policy.default_cap_usd
      : limit_source === "share" ? (p.can_run ? Math.max(0, shareOf(p.pot) + p.adjust_usd) : 0)
      : null;
    if (zero) limit = 0;
    if (limit != null) limit = cents(limit);
    const pot = potBudget(p.pot), spent = p.u.spent;
    // Each check: [code, limit, spent against it]; can't launch and no allowance always fail.
    const checks: [LimitCode, number | null, number][] = [
      ["no_allowance", zero ? 0 : null, 0],
      ["account_cap", zero ? null : cap, account_spent_usd],
      ["launch_access", p.can_run ? null : 0, 0],
      ["person_limit", limit, spent],
      // Everyone else's pot only counts once a team has a budget; until then it is the buffer check below.
      [p.pot == null ? "rest_pot" : "team_budget", p.pot == null && !budgeted.size ? null : pot, potSpent(p.pot)],
      ["buffer", zero || buffer_usd <= 0 ? null : launchable_usd, account_spent_usd],
    ];
    // Spend is compared in cents, like the limits and what is left, so "$0.00 left" is always blocked.
    const fails = ([, l, s]: (typeof checks)[number]) => l != null && cents(s) >= l;
    const blocked = checks.find(fails)?.[0] ?? null;
    // The first money limit reached, launch access aside: what stops an adaptive run that is already going.
    const over_limit = checks.filter(([c]) => c !== "launch_access").find(fails)?.[0] ?? null;
    const limited_by = blocked ?? checks.find(([, l, s]) => l != null && l > 0 && cents(s) >= 0.9 * l)?.[0] ?? null;
    const left = Math.min(...checks.slice(1).filter(([c, l]) => l != null && c !== "launch_access").map(([, l, s]) => leftOf(l!, s)));
    const team = teams.find((t) => t.id === p.team_id);
    const effective_max_concurrent = p.max_concurrent_runs ?? team?.max_concurrent_runs ?? policy.max_concurrent_runs;
    const concurrent_source: "you" | "team" | "account" = p.max_concurrent_runs != null ? "you" : team?.max_concurrent_runs != null ? "team" : "account";
    return { user_id: p.user_id, team_id: p.team_id, pot: p.pot, can_run: p.can_run, own_can_run: p.own_can_run,
      cap_usd: p.cap_usd, adjust_usd: p.adjust_usd, max_concurrent_runs: p.max_concurrent_runs, effective_max_concurrent, concurrent_source,
      limit_usd: limit, limit_source, ...p.u, left_usd: blocked ? 0 : left, blocked, over_limit, limited_by };
  });
  // Per pot, for the page's "Who gets what": what each person in it can spend before own limits and adjustments (null:
  // shared freely), how many can launch, what is running now, and whether the pot is what limits them (90% or more).
  const potFigures = (pot: number | null, budget: number, spent: number) => {
    const inPot = out.filter((x) => x.pot === pot);
    const each_usd = zero ? 0 : policy.mode === "pool" ? null : policy.mode === "custom" ? policy.default_cap_usd : cents(shareOf(pot));
    const limited_by: LimitCode | null = (pot != null || budgeted.size) && spent >= 0.9 * budget && !(budget === 0 && !inPot.length) ? (pot == null ? "rest_pot" : "team_budget") : null;
    return { each_usd, launchers: inPot.filter((x) => x.can_run).length, in_flight_usd: cents(inPot.reduce((s, x) => s + x.in_flight_usd, 0)), limited_by };
  };
  const teamsOut = teams.map((t) => {
    const ms = out.filter((x) => x.team_id === t.id), spent = ms.reduce((s, x) => s + x.spent, 0);
    return { ...t, members: ms.length, spent, left_usd: t.budget_usd == null ? null : leftOf(t.budget_usd, spent),
      ...(t.budget_usd == null ? { each_usd: null, launchers: 0, in_flight_usd: 0, limited_by: null } : potFigures(t.id, t.budget_usd, spent)) };
  });
  const restSpent = potSpent(null);
  return {
    account, buffer_usd, team_budgets_usd, set_aside_usd: cents(buffer_usd + team_budgets_usd),
    over_by_usd: Math.max(0, cents(buffer_usd + team_budgets_usd - cap)),
    rest: { budget_usd: rest_usd, members: out.filter((x) => x.pot == null).length, spent: restSpent, left_usd: leftOf(rest_usd, restSpent), ...potFigures(null, rest_usd, restSpent) },
    teams: teamsOut, members: out,
  };
}
export type Allocation = ReturnType<typeof allocate>;

/** The account's live spend this month, connector keys included (the same figure as Billing's header). */
async function accountSpent(orgId: number) {
  const { orgMonthSpendUsd } = await import("./session-engine.js");
  return orgMonthSpendUsd(orgId);
}

/** What the rules are applied to, read live: the active members (Clerk), their usage, the account's spend and allowance. */
async function live(org: { orgId: number; slug: string }) {
  const { team } = await import("./admin.js");
  const [people, usage, account_spent, { budget, subscription, budget_error }] = await Promise.all([
    team(org.slug), usageByPerson(org.orgId), accountSpent(org.orgId),
    // A failed lookup is not "no allowance": it is flagged, and launches refuse until it works again (fail closed).
    orgBudget(org.orgId).then((b) => ({ ...b, budget_error: false }), () => ({ budget: 0, subscription: null, budget_error: true })),
  ]);
  return { people, usage, account_spent, budget, subscription, budget_error };
}
type Live = Awaited<ReturnType<typeof live>>;
type Saved = Awaited<ReturnType<typeof load>>;

/** The page's picture of a set of rules (saved, or a draft) against live usage: what allocate() says, with names. */
function shape({ policy, teams, rows }: Saved, { people, usage, account_spent, budget, subscription, budget_error }: Live) {
  const active = people.members.filter((m) => m.status === "active");
  const a = allocate({ policy, teams, usage, cap: budget, account_spent_usd: account_spent,
    members: active.map((m) => ({ user_id: m.user_id, ...rows.get(m.user_id) })) });
  const byId = new Map(a.members.map((x) => [x.user_id, x]));
  const members = active.map((m) => ({ email: m.email, name: m.name, role: m.role, account_role: m.account_role, ...byId.get(m.user_id)! }));
  // Who to ask: the people who may change Budget rules (owners and billing managers, src/account-roles.ts).
  const admins = members.filter((m) => canAccount(m.account_role, "budget")).map((m) => ({ name: m.name || m.email || "an admin" }));
  return { policy, budget_usd: budget, budget_error, plan: subscription?.plan ?? null, clerk: people.clerk, admins,
    account: a.account, buffer_usd: a.buffer_usd, set_aside_usd: a.set_aside_usd, over_by_usd: a.over_by_usd, rest: a.rest,
    teams: a.teams, members };
}

/** The full picture for /app Billing, Budget rules: policy, teams, every active member's limit, usage and what blocks them. */
export async function overview(org: { orgId: number; slug: string }) {
  const [saved, lv] = await Promise.all([load(org.orgId), live(org)]);
  return shape(saved, lv);
}

/** Spend over the last 7 days of this month (or the month so far, if shorter), to project from the current rate. */
export interface Recent { usd: number; days: number }

/**
 * Where the month stands: when it resets (UTC, like the budget), and the spend it is on pace for: spend so far plus
 * the current daily rate (the last 7 days, `recent`) times the days left. A whole-month average said "on pace for $8"
 * for an account that only started spending yesterday at $5 a day. Without `recent`, the month so far is the rate.
 * Before the 2nd there is too little to go on, so no pace (null).
 */
export function pace(spent_usd: number, now = new Date(), recent?: Recent) {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const elapsed = Math.max(1 / 24, (now.getTime() - start) / 864e5), left = Math.max(0, (end - now.getTime()) / 864e5);
  const rate = recent && recent.days > 0 ? recent.usd / recent.days : spent_usd / elapsed;
  return { period_end: new Date(end).toISOString(), rate_usd_per_day: cents(rate), projected_usd: now.getUTCDate() < 2 ? null : cents(spent_usd + rate * left) };
}

/**
 * The admin banner on Billing, worked out on every GET (nothing is stored or sent): how much of the allowance is used,
 * once it is 80% or more, and the day (UTC) the month's pace runs out of it, when it is on pace to go over. Null when
 * neither applies, or with no allowance.
 */
export function usageAlert(spent_usd: number, cap: number, now = new Date(), recent?: Recent) {
  if (!(cap > 0)) return null;
  const used_pct = Math.floor((spent_usd / cap) * 100);
  const { projected_usd, rate_usd_per_day } = pace(spent_usd, now, recent);
  let runs_out_on: string | null = null;
  if (projected_usd != null && projected_usd > cap && spent_usd < cap && rate_usd_per_day > 0) {
    // At today's rate, the day what is left of the allowance is used up.
    runs_out_on = new Date(now.getTime() + ((cap - spent_usd) / rate_usd_per_day) * 864e5).toISOString().slice(0, 10);
  }
  return used_pct >= 80 || runs_out_on ? { used_pct, runs_out_on } : null;
}

/** Fewer finished sessions than this this month, and the average spend per session is too noisy to estimate with. */
const AVG_MIN_SESSIONS = 20;

/**
 * The month's figures: the average spend per finished session (a launch's cost estimate) and the spend of the last 7
 * days (the pace behind the usage banner).
 */
export async function monthFigures(orgId: number) {
  // The pace counts runs too (mold_v0-053); the average per session is the sessions' own (a launch's estimate).
  const [r] = await (await getDb()).query<{ finished: number; avg_usd: number | null; recent: number; recent_days: number }>(
    `WITH s AS (${sessionEngine() ? `SELECT a.status, a.queued_at,
                       GREATEST(a.cost_usd, coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.session_id = a.id), 0)) AS usd
                  FROM agent_sessions a WHERE a.org_id = $1 AND a.queued_at >= ${MONTH}`
                  // No session engine tables in this build (mold_v0-049): no sessions, runs only.
                  : "SELECT NULL::text AS status, NULL::timestamptz AS queued_at, NULL::numeric AS usd WHERE false"}),
          rr AS (SELECT r.created_at, ${RUN_USD} AS usd FROM runs r WHERE r.org_id = $1 AND r.created_at >= ${MONTH})
     SELECT count(*) FILTER (WHERE status IN ('completed', 'failed', 'timeout')) AS finished,
            avg(usd) FILTER (WHERE status IN ('completed', 'failed', 'timeout')) AS avg_usd,
            coalesce(sum(usd) FILTER (WHERE queued_at >= greatest(${MONTH}, now() - interval '7 days')), 0)
              + (SELECT coalesce(sum(usd), 0) FROM rr WHERE created_at >= greatest(${MONTH}, now() - interval '7 days')) AS recent,
            extract(epoch FROM now() - greatest(${MONTH}, now() - interval '7 days')) / 86400 AS recent_days
       FROM s`, [orgId]);
  const finished = Number(r?.finished ?? 0);
  return { avg_session_usd: finished >= AVG_MIN_SESSIONS && r?.avg_usd != null ? cents(Number(r.avg_usd)) : null,
    recent: { usd: Number(r?.recent ?? 0), days: Number(r?.recent_days ?? 0) } as Recent };
}

/** The live inputs plus the month's figures, for the page and its preview. */
async function pageLive(org: { orgId: number; slug: string }) {
  const [lv, figures] = await Promise.all([live(org), monthFigures(org.orgId)]);
  return { ...lv, figures };
}
type PageLive = Awaited<ReturnType<typeof pageLive>>;

/**
 * The preview reruns allocate() on every edit, so what it is applied to (people from Clerk, usage, the allowance from
 * Stripe) is read once and kept for 30 seconds per account; only the draft changes between keystrokes. GET /limits
 * always reads fresh and refreshes this.
 */
const PREVIEW_TTL_MS = 30_000;
const previewCache = new Map<number, { at: number; v: Promise<PageLive> }>();
function remember(orgId: number, v: Promise<PageLive>) {
  previewCache.set(orgId, { at: Date.now(), v });
  v.catch(() => previewCache.delete(orgId));
  return v;
}
function cachedLive(org: { orgId: number; slug: string }) {
  const hit = previewCache.get(org.orgId);
  return hit && Date.now() - hit.at < PREVIEW_TTL_MS ? hit.v : remember(org.orgId, pageLive(org));
}

/** The rules' version, for If-Match on PUT /limits/plan: the newest history entry, since every change appends one. */
async function versionOf(q: Queryable, orgId: number) {
  const [r] = await q.query<{ v: number | null }>("SELECT max(id) AS v FROM usage_rule_changes WHERE org_id = $1", [orgId]);
  return String(r?.v ?? 0);
}

/** The figures beside a picture of the rules (GET /limits and the preview both send them): the reset, Octillion's session maximum, the banner. */
function tiles(o: ReturnType<typeof shape>, { figures, budget_error }: PageLive) {
  return { period_end: pace(0).period_end, server_max_sessions: settingNumber("OCTILLION_MAX_SESSIONS_PER_RUN"),
    alert: budget_error ? null : usageAlert(o.account.spent_usd, o.budget_usd, new Date(), figures.recent) };
}

/** GET /limits for an admin: the overview, and the version to send back with a plan. */
export async function page(org: { orgId: number; slug: string }) {
  const [saved, lv, version] = await Promise.all([load(org.orgId), remember(org.orgId, pageLive(org)), getDb().then((db) => versionOf(db, org.orgId))]);
  const o = shape(saved, lv);
  return { ...o, ...tiles(o, lv), version };
}

const $usd = (v: number) => `$${v.toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * "Your budget" in plain words, for a member (who never sees Budget rules): the rules written in the second person,
 * read-only. `a` is allocate()'s picture of the saved rules; `run` the run limits that apply to them.
 */
export function explain(a: Pick<Allocation, "account" | "buffer_usd" | "rest" | "teams" | "members">, userId: string | null,
  run: { max_sessions: number; max_run_usd: number | null }, now = new Date()): string[] {
  const cap = a.account.cap_usd;
  if (cap <= 0) return ["Your account has no prepaid allowance this month, so nobody can launch simulations. Contact Octillion to add one."];
  const out: string[] = [];
  const me = a.members.find((m) => m.user_id === userId);
  if (me) {
    const team = a.teams.find((t) => t.id === me.pot);
    out.push(team ? `You're in ${team.name}, which has its own ${$usd(team.budget_usd ?? 0)} this month.`
      : a.teams.some((t) => t.budget_usd != null) ? `You're in Everyone else, which shares ${$usd(a.rest.budget_usd)}.`
      : `Everyone on the account shares ${$usd(a.rest.budget_usd)}.`);
    const adj = me.adjust_usd ? ` (with your ${me.adjust_usd > 0 ? "+" : "-"}${$usd(Math.abs(me.adjust_usd))} adjustment)` : "";
    out.push(!me.can_run ? "You haven't been allowed to launch simulations yet. Reports and transcripts stay available."
      : me.limit_source === "own" ? `You have your own limit of ${$usd(me.limit_usd ?? 0)} a month.`
      : me.limit_source === "pool" ? "People share it freely, so you have no personal limit. It stops when the budget runs out."
      : me.limit_source === "default" ? `Everyone can spend up to ${$usd(me.limit_usd ?? 0)} a month. The budget still stops at its total.`
      : `People get an equal share, so yours is ${$usd(me.limit_usd ?? 0)}${adj} and changes if people join.`);
    if (me.effective_max_concurrent != null) out.push(`You can have ${plural(me.effective_max_concurrent, "simulation")} running at once.`);
  }
  if (a.buffer_usd > 0) out.push(`${$usd(a.buffer_usd)} of the account's ${$usd(cap)} is held back for runs that go over. Nobody can launch into it.`);
  out.push(`Each simulation can use up to ${plural(run.max_sessions, "agent session")}${run.max_run_usd != null ? ` and spend up to ${$usd(run.max_run_usd)}` : ""}.`);
  out.push(`Spend starts over on ${monthWords(now).reset}.`);
  return out;
}

/**
 * GET /limits for a member: their own row and team (nobody else's), the run limits, and "Your budget": the budget they
 * draw on (their team's, or Everyone else's) with what is left of it, the account's totals, and the plain summary.
 */
export async function memberPage(org: { orgId: number; slug: string }, userId: string | null) {
  const o = await overview(org);
  const me = o.members.find((m) => m.user_id === userId) ?? null;
  const p = o.policy;
  const max_sessions = Math.min(settingNumber("OCTILLION_MAX_SESSIONS_PER_RUN"), p.max_sessions_per_run ?? Infinity);
  const team = me ? o.teams.find((t) => t.id === me.team_id) ?? null : null;
  const budgeted = o.teams.some((t) => t.budget_usd != null);
  const pot = !me ? null : me.pot != null && team
    ? { kind: "team" as const, name: team.name, budget_usd: team.budget_usd ?? 0, left_usd: team.left_usd ?? 0 }
    : { kind: "rest" as const, name: budgeted ? "Everyone else" : "Everyone", budget_usd: o.rest.budget_usd, left_usd: o.rest.left_usd };
  return {
    policy: { mode: p.mode, max_concurrent_runs: p.max_concurrent_runs, max_sessions_per_run: p.max_sessions_per_run, max_run_usd: p.max_run_usd },
    budget_usd: o.budget_usd, budget_error: o.budget_error, admins: o.admins, clerk: o.clerk, can_manage: false, me: userId, period_end: pace(0).period_end,
    members: me ? [me] : [], teams: team ? [team] : [],
    you: { pot, max_sessions, max_run_usd: p.max_run_usd, account: { cap_usd: o.account.cap_usd, spent_usd: o.account.spent_usd, left_usd: leftOf(o.account.cap_usd, o.account.spent_usd) },
      summary: o.budget_error ? [] : explain(o, userId, { max_sessions, max_run_usd: p.max_run_usd }) },
  };
}

/**
 * The line a launch reports beside its run: what is left for the person this month (of their limit, when they have
 * one), and the run's estimated cost at this month's average per session. More than what is left is a warning, not a
 * refusal: the run starts, and the limits stop new launches and adaptive top-ups once they are reached.
 */
export function launchNote(left_usd: number, limit_usd: number | null, sessions: number, avg_session_usd: number | null) {
  const estimate_usd = avg_session_usd == null ? null : cents(avg_session_usd * sessions);
  const line = `${$usd(left_usd)} left${limit_usd != null ? ` of ${$usd(limit_usd)}` : ""} this month.` +
    (estimate_usd == null ? "" : ` ≈ ${$usd(estimate_usd)} for ${plural(sessions, "session")} at this month's average.`);
  const warning = estimate_usd != null && estimate_usd > left_usd
    ? `That's more than the ${$usd(left_usd)} left. The run starts; once the limit is reached, nothing new launches and adaptive runs stop adding sessions.` : null;
  return { left_usd, limit_usd, estimate_usd, line, warning };
}
export type LaunchNote = ReturnType<typeof launchNote>;

/** The end of every refusal: who can change it, and (for money) when the month starts over. */
export function askAdmins(admins: { name: string }[], untilReset: boolean) {
  const names = admins.map((a) => a.name);
  const who = !names.length ? "your account admin" : names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  return `Ask ${who} to change Budget rules on the Billing page${untilReset ? `, or wait until ${monthWords().reset}` : ""}.`;
}

/** The refusal for a money or access check that allocate() says fails, worded for the person launching. */
function refusal(o: Awaited<ReturnType<typeof overview>>, code: LimitCode, me?: Awaited<ReturnType<typeof overview>>["members"][number]): LimitError {
  const { month, reset } = monthWords();
  const info = (set_by: LimitInfo["set_by"], limit_usd: number | null = null, spent = 0) =>
    ({ code, set_by, admins: o.admins, limit_usd, left_usd: limit_usd == null ? null : leftOf(limit_usd, spent) });
  const $ = (v: number) => `$${v.toFixed(2)}`;
  const acc = o.account, t = o.teams.find((x) => x.id === me?.pot);
  switch (code) {
    case "no_allowance":
      return new LimitError("Your account has no prepaid allowance this month, so simulations can't run. Contact Octillion.", 403, info("account", 0));
    case "account_cap":
      return new LimitError(`Your account has used its ${$(acc.cap_usd)} for ${month} (${$(acc.spent_usd)} spent). ` +
        `Results so far stay available; reply to your Octillion contact to raise the allowance, or wait until ${reset}.`, 403, info("account", acc.cap_usd, acc.spent_usd));
    case "launch_access":
      return new LimitError(`You haven't been allowed to launch simulations yet. Reports and transcripts stay available. ${askAdmins(o.admins, false)}`, 403,
        info(me?.own_can_run != null ? "you" : "account"));
    case "person_limit":
      return new LimitError(`You've used your ${$(me!.limit_usd!)} for ${month} (${$(me!.spent)} spent). ${askAdmins(o.admins, true)}`, 403,
        info(me!.cap_usd != null ? "you" : "account", me!.limit_usd, me!.spent));
    case "team_budget":
      return new LimitError(`The ${t!.name} team has used its ${$(t!.budget_usd!)} for ${month}. ${askAdmins(o.admins, true)}`, 403, info("team", t!.budget_usd, t!.spent));
    case "rest_pot":
      return new LimitError(`The shared ${$(o.rest.budget_usd)} for people outside a team budget is used up for ${month}. ${askAdmins(o.admins, true)}`, 403,
        info("account", o.rest.budget_usd, o.rest.spent));
    default: // buffer
      return new LimitError(`Your account has reached the part of its allowance available for launches (${$(acc.launchable_usd)} of ${$(acc.cap_usd)}). ` +
        `The rest is held back for runs that go over. ${askAdmins(o.admins, true)}`, 403, info("account", acc.launchable_usd, acc.spent_usd));
  }
}

/**
 * Before a simulation starts: may this person run, within their limit, their pot (team budget or Everyone else), the
 * buffer and their runs at once? Returns the most sessions this run may have (null = the server default) and the admins
 * to name if a later check refuses. Connector-key callers are not limited here. A refusal is a LimitError with a code,
 * what the limit is and what is left, who set it, and the admins to ask. When the account's allowance could not be
 * looked up, nothing starts (budget_error): a lookup failure must not read as "no limit". Someone not among the active
 * members (say Clerk is unavailable) still meets the account's checks, the buffer among them.
 */
export interface RunCheck {
  maxSessions: number | null; admins: { name: string }[]; left_usd: number | null; limit_usd: number | null;
  /** Runs at once for this person (null: no limit) and who set it; runSimulation counts again under the launch lock. */
  max_runs: number | null; runs_set_by: "you" | "team" | "account" | null;
}

/** "You have 2 simulations running; you can have 2 at once …": the refusal for runs at once. */
export function runsAtOnceError(running: number, maxRuns: number, setBy: "you" | "team" | "account" | null, admins: { name: string }[]) {
  return new LimitError(`You have ${running} simulation${running === 1 ? "" : "s"} running; you can have ${maxRuns} at once ` +
    `(set for ${setBy === "you" ? "you" : setBy === "team" ? "your team" : "the account"}). Wait for one to finish. ${askAdmins(admins, false)}`, 429,
    { code: "runs_at_once", set_by: setBy ?? undefined, admins, limit_usd: null, left_usd: null });
}

/** A viewer may not launch runs or onboard (src/account-roles.ts): the refusal, code viewer_role. */
export function viewerRefusal(admins: { name: string }[] = []) {
  return new LimitError(accountRefusal("launch").message, 403, { code: "viewer_role", admins });
}
/** Before onboarding or a launch: refuse a viewer. The role comes with the connector's Org, else from the team. */
export async function checkLaunchRole(org: Org) {
  if (!org.userId) return;
  const role: AccountRole | undefined = org.role ?? (await (await import("./admin.js")).team(org.slug)).members.find((m) => m.user_id === org.userId)?.account_role;
  if (role && !canAccount(role, "launch")) throw viewerRefusal();
}

export async function checkRun(org: Org): Promise<RunCheck> {
  if (!org.userId) return { maxSessions: null, admins: [], left_usd: null, limit_usd: null, max_runs: null, runs_set_by: null };
  const o = await overview(org);
  if (!canAccount(org.role ?? o.members.find((m) => m.user_id === org.userId)?.account_role ?? "member", "launch")) throw viewerRefusal(o.admins);
  if (o.budget_error)
    throw new LimitError("We couldn't check your account's allowance. Try again in a minute.", 503, { code: "budget_error", admins: o.admins });
  const me = o.members.find((m) => m.user_id === org.userId);
  const blocked = me ? me.blocked : o.account.blocked;
  if (blocked) throw refusal(o, blocked, me);
  if (!me) return { maxSessions: o.policy.max_sessions_per_run, admins: o.admins, left_usd: o.account.left_usd, limit_usd: null, max_runs: null, runs_set_by: null };
  const maxRuns = me.effective_max_concurrent, runsSetBy = me.concurrent_source;
  if (maxRuns != null && me.running >= maxRuns) throw runsAtOnceError(me.running, maxRuns, runsSetBy, o.admins);
  return { maxSessions: o.policy.max_sessions_per_run, admins: o.admins, left_usd: me.left_usd, limit_usd: me.limit_usd, max_runs: maxRuns, runs_set_by: runsSetBy };
}

/**
 * A run platform staff start for a workspace (mold_v0-067; an admin_only start tool on the admin MCP): the account's
 * own launch rules with no person, as an account-level launch: its allowance, its month's cap and the buffer it holds
 * back from launches, fail closed when they cannot be read. A person's own limits do not apply (staff are not one).
 */
export async function checkAccountRun(org: Org): Promise<void> {
  const o = await overview(org);
  if (o.budget_error)
    throw new LimitError("We couldn't check the account's allowance. Try again in a minute.", 503, { code: "budget_error", admins: o.admins });
  if (o.account.blocked) throw refusal(o, o.account.blocked);
}

/**
 * While an adaptive run samples more: has its launcher run out (their limit, their pot, the buffer or the account)?
 * Then the run stops early. Launch access is not rechecked: it governs starting runs, not finishing them. Fails closed:
 * when the allowance or the limits can't be read, the run stops adding sessions (the ones running still finish).
 */
export async function launcherOverLimit(orgId: number, slug: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const o = await overview({ orgId, slug }).catch(() => null);
  if (!o || o.budget_error) return true;
  const me = o.members.find((m) => m.user_id === userId);
  // over_limit skips launch access but still runs every money check after it (a person who can't launch keeps their limits).
  return (me ? me.over_limit : o.account.blocked) != null;
}

// ---------- change history: one plain sentence per save, shown on Budget rules ----------

/** Who made a change: the session's label (stored as updated_by, "customer:<email>") and their user id, for their name. */
export interface Actor { label: string; user: string | null }

const MODE_WORDS: Record<Mode, string> = { pool: "Shared pool", even: "Split evenly", custom: "Custom caps" };
/** Money for a history line: whole dollars without cents ("$50", "$12.50"); empty is `none`. */
const usdWord = (v: number | null, none = "none") =>
  v == null ? none : `${v < 0 ? "-" : ""}$${Number.isInteger(Math.abs(v)) ? Math.abs(v) : Math.abs(v).toFixed(2)}`;
const countWord = (v: number | null, none = "no limit") => (v == null ? none : String(v));
/** "Buffer $0 → $50" when the value changed; nothing when it didn't. */
const diff = <T>(label: string, a: T, b: T, word: (v: T) => string) => (a === b ? [] : [`${label} ${word(a)} → ${word(b)}`]);

/**
 * Append one history entry in the same transaction as the change. Nothing is written when nothing changed (a save
 * that sends the same values). A null actor is Octillion itself (a migration), shown as "System".
 */
async function logChange(q: Queryable, orgId: number, actor: Actor | null, parts: string[], before: unknown, after: unknown) {
  if (!parts.length) return;
  // Every change takes the account's rules lock before its entry, so a plan's version check can't miss one being made.
  await lockRules(q, orgId);
  await q.query("INSERT INTO usage_rule_changes (org_id, actor, actor_user, summary, before, after) VALUES ($1, $2, $3, $4, $5, $6)",
    [orgId, actor?.label ?? null, actor?.user ?? null, parts.join("; "), before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after)]);
}

/**
 * The account's rules lock, held to the end of the transaction. Every writer takes it first, before reading or
 * locking any row, so writers queue in one order (no deadlock) and each reads the rules the last one saved.
 */
const lockRules = (q: Queryable, orgId: number) => q.query("SELECT pg_advisory_xact_lock(7270011, $1)", [orgId]);

/** People's names by user id (Clerk), so history shows a person's current name; past members fall back to their email. */
async function namesOf(slug: string) {
  const { team } = await import("./admin.js");
  const t = await team(slug).catch(() => ({ members: [] as { user_id: string; name: string | null; email: string | null }[] }));
  return new Map(t.members.map((m) => [m.user_id, m.name || m.email || null]));
}
const byName = (names: Map<string, string | null>, actor: string | null, user: string | null) =>
  actor == null && user == null ? "System" : (user && names.get(user)) || actor?.replace(/^customer:/, "") || "Someone";

export interface Change { id: number; at: Date; by_name: string; summary: string }

/** The account's history, newest first, 50 at a time; `before` is the id of the oldest entry already shown. */
export async function history(org: { orgId: number; slug: string }, before?: number): Promise<{ entries: Change[]; next_before: number | null }> {
  const PAGE = 50;
  const db = await getDb();
  const rows = await db.query<{ id: number; at: Date; actor: string | null; actor_user: string | null; summary: string }>(
    `SELECT id, at, actor, actor_user, summary FROM usage_rule_changes WHERE org_id = $1 ${before != null ? "AND id < $3" : ""} ORDER BY id DESC LIMIT $2`,
    before != null ? [org.orgId, PAGE, before] : [org.orgId, PAGE]);
  const names = rows.length ? await namesOf(org.slug) : new Map<string, string | null>();
  const entries = rows.map((r) => ({ id: Number(r.id), at: r.at, by_name: byName(names, r.actor, r.actor_user), summary: r.summary }));
  return { entries, next_before: entries.length === PAGE ? entries.at(-1)!.id : null };
}

/** Who last changed a rule, and when: Budget rules' Set by and Last changed. */
export interface RuleChange { by_name: string; at: Date }

/**
 * Who last changed each rule, from the history's before and after: "policy.<field>" for the account's rules,
 * "team:<id>" for a team's budget or runs at once, "member:<user id>" for a person's own settings. The newest entry
 * that changed a rule wins; a rule no entry changed is missing (Octillion's default, or set before history existed).
 */
export async function ruleChanges(org: { orgId: number; slug: string }): Promise<Record<string, RuleChange>> {
  const rows = await (await getDb()).query<{ at: Date; actor: string | null; actor_user: string | null; before: any; after: any }>(
    "SELECT at, actor, actor_user, before, after FROM usage_rule_changes WHERE org_id = $1 ORDER BY id DESC LIMIT 1000", [org.orgId]);
  const out: Record<string, RuleChange> = {};
  if (!rows.length) return out;
  const names = await namesOf(org.slug);
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const r of rows) {
    const b = typeof r.before === "string" ? JSON.parse(r.before) : r.before, a = typeof r.after === "string" ? JSON.parse(r.after) : r.after;
    if (!a || typeof a !== "object") continue;
    const keys: string[] = [];
    if (a.policy) for (const k of Object.keys(a.policy)) if (!same(b?.policy?.[k], a.policy[k])) keys.push(`policy.${k}`);
    if (a.team?.id != null) keys.push(`team:${a.team.id}`);
    if (Array.isArray(a.teams)) for (const t of a.teams) {
      const was = Array.isArray(b?.teams) ? b.teams.find((x: { id: number }) => x.id === t.id) : undefined;
      if (!same(was?.budget_usd, t.budget_usd) || !same(was?.max_concurrent_runs, t.max_concurrent_runs)) keys.push(`team:${t.id}`);
    }
    if (typeof a.user_id === "string") keys.push(`member:${a.user_id}`);
    if (Array.isArray(a.members)) for (const m of a.members) if (typeof m?.user_id === "string") keys.push(`member:${m.user_id}`);
    for (const k of keys) out[k] ??= { by_name: byName(names, r.actor, r.actor_user), at: r.at };
  }
  return out;
}

// ---------- changes from /app (account admins) ----------

const money = (v: unknown, field: string, allowNegative = false) => {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || (!allowNegative && n < 0) || Math.abs(n) > 1e7) throw new LimitError(`${field} must be a number of dollars`);
  return Math.round(n * 100) / 100;
};
// Counts are 1 or more, or empty for no limit. 0 used to block every launch silently; "can launch" is the way to stop launches.
const count = (v: unknown, field: string, max = 10000) => {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  if (Number.isInteger(n) && n === 0) throw new LimitError(`${field} can't be 0. Leave it empty for no limit, or use "can launch" to stop launches.`);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new LimitError(`${field} must be a whole number from 1 to ${max}`);
  return n;
};
const RUNS = "Runs at once";
const sessions = (v: unknown) => count(v, "Agent sessions per run", settingNumber("OCTILLION_MAX_SESSIONS_PER_RUN"));

type PolicyFields = Omit<Policy, "updated_at" | "updated_by">;
const $cap = (v: number) => `$${v.toFixed(2)}`;

/**
 * The policy after a change: only the fields sent change, each checked. `cap` is the account's allowance, for the
 * checks against it (the buffer and the run dollar cap can't be more); null or 0 (unknown, or none yet) skips them.
 */
function parsePolicy(cur: PolicyFields, p: Partial<Record<keyof Policy, unknown>>, cap: number | null): PolicyFields {
  const mode = (p.mode === undefined ? cur.mode : String(p.mode)) as Mode;
  if (!["pool", "even", "custom"].includes(mode)) throw new LimitError("mode must be pool, even or custom");
  const next: PolicyFields = {
    mode, reserve_usd: p.reserve_usd === undefined ? cur.reserve_usd : money(p.reserve_usd, "reserve_usd") ?? 0,
    default_cap_usd: p.default_cap_usd === undefined ? cur.default_cap_usd : money(p.default_cap_usd, "default_cap_usd"),
    new_members_can_run: p.new_members_can_run === undefined ? cur.new_members_can_run : Boolean(p.new_members_can_run),
    max_concurrent_runs: p.max_concurrent_runs === undefined ? cur.max_concurrent_runs : count(p.max_concurrent_runs, RUNS),
    max_sessions_per_run: p.max_sessions_per_run === undefined ? cur.max_sessions_per_run : sessions(p.max_sessions_per_run),
    max_run_usd: p.max_run_usd === undefined ? cur.max_run_usd : money(p.max_run_usd, "Most a simulation can spend"),
  };
  // Own limits apply in every mode, so custom with no default would just be the shared pool under another name.
  if (next.mode === "custom" && next.default_cap_usd == null)
    throw new LimitError("Custom caps need a default monthly cap for everyone. Enter an amount, or share the budget freely instead.");
  // $0 would block everyone without an own limit; "can launch" is the way to stop launches.
  if (p.default_cap_usd !== undefined && next.default_cap_usd != null && next.default_cap_usd < 0.01)
    throw new LimitError("Each person's default cap must be at least $0.01.");
  // Empty is "no limit"; $0 would stop every adaptive run after its first batch, which "can launch" says better.
  if (next.max_run_usd != null && next.max_run_usd < 0.01) throw new LimitError("Most a simulation can spend must be at least $0.01, or empty for no limit.");
  if (cap != null && cap > 0) {
    if (p.reserve_usd !== undefined && next.reserve_usd > cap) throw new LimitError(`Can't hold back more than your ${$cap(cap)} allowance.`);
    if (p.max_run_usd !== undefined && next.max_run_usd != null && next.max_run_usd > cap) throw new LimitError(`A simulation can't spend more than your ${$cap(cap)} allowance.`);
    if (p.default_cap_usd !== undefined && next.default_cap_usd != null && next.default_cap_usd > cap) throw new LimitError(`Each person's default cap can't be more than your ${$cap(cap)} allowance.`);
  }
  return next;
}

/** The history line's parts for a policy change: "Buffer $0 → $50", one per field that changed. */
function policyParts(cur: PolicyFields, next: PolicyFields) {
  const yesNo = (v: boolean) => (v ? "yes" : "no");
  return [
    ...diff("How budgets are shared:", cur.mode, next.mode, (m) => MODE_WORDS[m]),
    ...diff("Buffer", cur.reserve_usd, next.reserve_usd, (v) => usdWord(v)),
    ...diff("Default cap", cur.default_cap_usd, next.default_cap_usd, (v) => usdWord(v)),
    ...diff("New members can launch:", cur.new_members_can_run, next.new_members_can_run, yesNo),
    ...diff("Runs at once", cur.max_concurrent_runs, next.max_concurrent_runs, (v) => countWord(v)),
    ...diff("Sessions per run", cur.max_sessions_per_run, next.max_sessions_per_run, (v) => countWord(v, "server's limit")),
    ...diff("Most a run can spend", cur.max_run_usd, next.max_run_usd, (v) => usdWord(v, "no limit")),
  ];
}

const policyOnly = ({ updated_at: _a, updated_by: _b, ...p }: Policy): PolicyFields => p;

async function writePolicy(q: Queryable, orgId: number, actor: Actor, next: PolicyFields) {
  await q.query(
    `INSERT INTO usage_policies (org_id, mode, reserve_usd, default_cap_usd, new_members_can_run, max_concurrent_runs, max_sessions_per_run, max_run_usd, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
     ON CONFLICT (org_id) DO UPDATE SET mode = $2, reserve_usd = $3, default_cap_usd = $4, new_members_can_run = $5,
       max_concurrent_runs = $6, max_sessions_per_run = $7, max_run_usd = $8, updated_at = now(), updated_by = $9`,
    [orgId, next.mode, next.reserve_usd, next.default_cap_usd, next.new_members_can_run, next.max_concurrent_runs, next.max_sessions_per_run, next.max_run_usd, actor.label]);
}

/** The allowance for checks against it; a failed lookup skips them (null) rather than refusing an unrelated save. */
const capFor = (orgId: number) => orgBudget(orgId).then((b) => b.budget, () => null);

export async function setPolicy(orgId: number, actor: Actor, p: Partial<Record<keyof Policy, unknown>>) {
  const cap = p.reserve_usd !== undefined || p.max_run_usd !== undefined || p.default_cap_usd !== undefined ? await capFor(orgId) : null;
  await (await getDb()).transaction(async (tx) => {
    // Read under the lock, so only the fields sent change and a save made meanwhile is kept (and in the history's diff).
    await lockRules(tx, orgId);
    const before = policyOnly((await load(orgId, tx)).policy), next = parsePolicy(before, p, cap);
    await writePolicy(tx, orgId, actor, next);
    await logChange(tx, orgId, actor, policyParts(before, next), { policy: before }, { policy: next });
  });
}

const teamWords = (t: { budget_usd: number | null; max_concurrent_runs: number | null }) =>
  [`budget ${usdWord(t.budget_usd)}`, ...(t.max_concurrent_runs != null ? [`runs at once ${t.max_concurrent_runs}`] : [])].join(", ");

/**
 * Add a team, or change one. A change is partial: only the fields sent change (a rename no longer clears the team's
 * budget or runs at once); send null to clear one.
 */
export async function saveTeam(orgId: number, actor: Actor, t: { id?: unknown; name?: unknown; budget_usd?: unknown; max_concurrent_runs?: unknown }) {
  const has = (k: keyof typeof t) => t[k] !== undefined;
  const name = String(t.name ?? "").trim().slice(0, 60);
  if ((!t.id || has("name")) && !name) throw new LimitError("A team needs a name");
  const db = await getDb();
  try {
    if (t.id) {
      const sets: string[] = [], vals: unknown[] = [orgId, Number(t.id)];
      const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (has("name")) set("name", name);
      if (has("budget_usd")) set("budget_usd", money(t.budget_usd, "Team budget"));
      if (has("max_concurrent_runs")) set("max_concurrent_runs", count(t.max_concurrent_runs, RUNS));
      await db.transaction(async (tx) => {
        await lockRules(tx, orgId);
        const cols = "id, name, budget_usd, max_concurrent_runs";
        const read = (sql: string, params: unknown[]) => tx.query<Team>(sql, params).then((r) => r.map((x) => ({ ...x, id: Number(x.id), budget_usd: num(x.budget_usd), max_concurrent_runs: num(x.max_concurrent_runs) })));
        const [before] = await read(`SELECT ${cols} FROM usage_teams WHERE org_id = $1 AND id = $2 FOR UPDATE`, vals.slice(0, 2));
        if (!before) throw new LimitError("No such team", 404);
        if (!sets.length) return;
        const [after] = await read(`UPDATE usage_teams SET ${sets.join(", ")} WHERE org_id = $1 AND id = $2 RETURNING ${cols}`, vals);
        await logChange(tx, orgId, actor, [
          ...(before.name !== after!.name ? [`Renamed team ${before.name} to ${after!.name}`] : []),
          ...diff(`${after!.name} budget`, before.budget_usd, after!.budget_usd, (v) => usdWord(v)),
          ...diff(`${after!.name} runs at once`, before.max_concurrent_runs, after!.max_concurrent_runs, (v) => countWord(v, "account setting")),
        ], { team: before }, { team: after });
      });
      return { id: Number(t.id) };
    }
    const vals = [orgId, name, money(t.budget_usd, "Team budget"), count(t.max_concurrent_runs, RUNS)] as const;
    return await db.transaction(async (tx) => {
      await lockRules(tx, orgId);
      const [r] = await tx.query<{ id: number }>("INSERT INTO usage_teams (org_id, name, budget_usd, max_concurrent_runs) VALUES ($1, $2, $3, $4) RETURNING id", [...vals]);
      const after = { id: Number(r!.id), name, budget_usd: vals[2], max_concurrent_runs: vals[3] };
      await logChange(tx, orgId, actor, [`Added team ${name} (${teamWords(after)})`], null, { team: after });
      return { id: after.id };
    });
  } catch (e) {
    if (/unique|duplicate/i.test((e as Error).message)) throw new LimitError(`There is already a team called ${name}`, 409);
    throw e;
  }
}

/** Remove a team; its people move to Everyone else (their own settings stay). */
export async function deleteTeam(orgId: number, actor: Actor, id: number) {
  await (await getDb()).transaction(async (tx) => {
    await lockRules(tx, orgId);
    const [t] = await tx.query<Team & { people: number }>(
      `SELECT id, name, budget_usd, max_concurrent_runs, (SELECT count(*) FROM usage_members m WHERE m.org_id = $1 AND m.team_id = $2) AS people
         FROM usage_teams WHERE org_id = $1 AND id = $2`, [orgId, id]);
    if (!t) throw new LimitError("No such team", 404);
    await tx.query("DELETE FROM usage_teams WHERE org_id = $1 AND id = $2", [orgId, id]);
    const team = { id: Number(t.id), name: t.name, budget_usd: num(t.budget_usd), max_concurrent_runs: num(t.max_concurrent_runs) }, people = Number(t.people);
    await logChange(tx, orgId, actor, [`Removed team ${t.name} (${teamWords(team)}${people ? `; ${people} ${people === 1 ? "person" : "people"} moved to Everyone else` : ""})`],
      { team, people }, null);
  });
}

/** One person's settings; only the fields sent change. The person must be an active member of the account. */
export async function setMember(org: { orgId: number; slug: string }, actor: Actor, userId: string, m: Record<string, unknown>) {
  const { team } = await import("./admin.js");
  const person = (await team(org.slug)).members.find((x) => x.user_id === userId && x.status === "active");
  if (!person) throw new LimitError("Not an active member of this account", 404);
  const db = await getDb();
  if (m.team_id != null && m.team_id !== "" && !(await db.query("SELECT 1 FROM usage_teams WHERE org_id = $1 AND id = $2", [org.orgId, Number(m.team_id)])).length)
    throw new LimitError("No such team", 404);
  // Read under the rules lock, so only the fields sent change: a plan's reset or another admin's save made meanwhile stays.
  await db.transaction(async (tx) => {
    await lockRules(tx, org.orgId);
    const { rows, teams } = await load(org.orgId, tx);
    const cur = rows.get(userId);
    const pick = <T>(k: string, parse: () => T, fallback: T) => (k in m ? parse() : fallback);
    const next = {
      team_id: pick("team_id", () => (m.team_id == null || m.team_id === "" ? null : Number(m.team_id)), cur?.team_id ?? null),
      cap_usd: pick("cap_usd", () => money(m.cap_usd, "cap_usd"), cur?.cap_usd ?? null),
      adjust_usd: pick("adjust_usd", () => money(m.adjust_usd, "adjust_usd", true) ?? 0, cur?.adjust_usd ?? 0),
      can_run: pick("can_run", () => (m.can_run == null ? null : Boolean(m.can_run)), cur?.can_run ?? null),
      max_concurrent_runs: pick("max_concurrent_runs", () => count(m.max_concurrent_runs, RUNS), cur?.max_concurrent_runs ?? null),
    };
    const before = { team_id: cur?.team_id ?? null, cap_usd: cur?.cap_usd ?? null, adjust_usd: cur?.adjust_usd ?? 0, can_run: cur?.can_run ?? null,
      max_concurrent_runs: cur?.max_concurrent_runs ?? null };
    const teamName = (id: number | null) => (id == null ? "Everyone else" : teams.find((t) => t.id === id)?.name ?? "a removed team");
    const parts = [
      ...diff("team", before.team_id, next.team_id, teamName),
      ...diff("own limit", before.cap_usd, next.cap_usd, (v) => usdWord(v)),
      ...diff("adjustment", before.adjust_usd, next.adjust_usd, (v) => usdWord(v)),
      ...diff("can launch:", before.can_run, next.can_run, (v) => (v == null ? "account setting" : v ? "yes" : "no")),
      ...diff("runs at once", before.max_concurrent_runs, next.max_concurrent_runs, (v) => countWord(v, "team or account setting")),
    ];
    await tx.query(
      `INSERT INTO usage_members (org_id, user_id, team_id, cap_usd, adjust_usd, can_run, max_concurrent_runs) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, user_id) DO UPDATE SET team_id = $3, cap_usd = $4, adjust_usd = $5, can_run = $6, max_concurrent_runs = $7`,
      [org.orgId, userId, next.team_id, next.cap_usd, next.adjust_usd, next.can_run, next.max_concurrent_runs]);
    // One entry per save, so the person's changes read as one sentence: "Alice R.: own limit none → $150, can launch: account setting → no".
    await logChange(tx, org.orgId, actor, parts.length ? [`${person.name || person.email || userId}: ${parts.join(", ")}`] : [], { user_id: userId, ...before }, { user_id: userId, ...next });
  });
}

// ---------- the whole tab at once: a draft previewed, then saved as one plan ----------

/**
 * What Budget rules sends: the policy fields changed, team budgets (null removes one), people reset to the defaults.
 * remove_teams is for the preview only (Teams asks what deleting a team would do before it does); a plan refuses it.
 */
export interface Draft { policy?: Partial<Record<keyof Policy, unknown>>; team_budgets?: unknown; member_resets?: unknown; clear_inactive?: unknown; remove_teams?: unknown }
const DEFAULTS = { cap_usd: null, adjust_usd: 0, can_run: null, max_concurrent_runs: null };
const isDefault = (r: MemberRow) => r.cap_usd == null && !r.adjust_usd && r.can_run == null && r.max_concurrent_runs == null;

/**
 * The saved rules with a draft applied, checked field by field (a bad field is a 422, never over-allocation), and what
 * it changes in words for the history. Inactive values: an adjustment only applies with an equal share, so under any
 * other way of sharing it is listed, and cleared when asked (clear_inactive). A reset keeps the person's team.
 */
function applyDraft(saved: Saved, d: Draft, cap: number | null, names: Map<string, string | null>) {
  const bad = (e: unknown): never => { throw e instanceof LimitError && e.status === 400 ? new LimitError(e.message, 422) : e; };
  if (d.team_budgets !== undefined && !Array.isArray(d.team_budgets)) throw new LimitError("team_budgets must be a list", 422);
  if (d.member_resets !== undefined && !Array.isArray(d.member_resets)) throw new LimitError("member_resets must be a list", 422);
  const before = policyOnly(saved.policy);
  let policy: PolicyFields;
  try { policy = parsePolicy(before, d.policy ?? {}, cap); } catch (e) { bad(e); }
  const parts = policyParts(before, policy!);
  const teams = saved.teams.map((t) => ({ ...t }));
  for (const tb of (d.team_budgets ?? []) as { id?: unknown; budget_usd?: unknown }[]) {
    const t = teams.find((x) => x.id === Number(tb?.id));
    if (!t) throw new LimitError("No such team", 422);
    let v: number | null = null;
    try { v = money(tb.budget_usd, `${t.name} budget`); } catch (e) { bad(e); }
    parts.push(...diff(`${t.name} budget`, t.budget_usd, v, (x) => usdWord(x)));
    t.budget_usd = v;
  }
  // A removed team's people fall to Everyone else: allocate() reads a team it doesn't know as none.
  if (d.remove_teams !== undefined && !Array.isArray(d.remove_teams)) throw new LimitError("remove_teams must be a list", 422);
  const removed = new Set(((d.remove_teams ?? []) as unknown[]).map(Number));
  for (const id of removed) {
    const t = teams.find((x) => x.id === id);
    if (!t) throw new LimitError("No such team", 422);
    parts.push(`Removed team ${t.name}`);
  }
  const rows = new Map([...saved.rows].map(([k, r]) => [k, { ...r }]));
  const who = (id: string) => names.get(id) || id;
  const resets: string[] = [];
  for (const id of new Set(((d.member_resets ?? []) as unknown[]).map(String))) {
    const r = rows.get(id);
    if (!r || isDefault(r)) continue;
    rows.set(id, { ...r, ...DEFAULTS });
    resets.push(id);
    parts.push(`${who(id)}: reset to the defaults`);
  }
  const inactive = policy!.mode === "even" ? [] : [...rows.values()].filter((r) => r.adjust_usd).map((r) => ({ user_id: r.user_id, field: "adjust_usd" as const, value: r.adjust_usd }));
  const cleared = d.clear_inactive ? inactive.map((x) => x.user_id) : [];
  for (const id of cleared) {
    parts.push(`${who(id)}: adjustment ${usdWord(rows.get(id)!.adjust_usd)} cleared (it only applies with an equal share)`);
    rows.set(id, { ...rows.get(id)!, adjust_usd: 0 });
  }
  return { next: { policy: { ...policy!, updated_at: saved.policy.updated_at, updated_by: saved.policy.updated_by }, teams: teams.filter((t) => !removed.has(t.id)), rows },
    parts, inactive, resets, cleared };
}

type Shape = ReturnType<typeof shape>;
type Warning = { code: "over_allocated" | "rest_zero" | "empty_budgeted_team" | "set_amount_exceeds_budget" | "no_personal_limits"; message: string; team_id?: number | null };

/** Plain-English warnings about a draft; none of them stops a save. */
function warningsOf(o: Shape): Warning[] {
  const $ = (v: number) => usdWord(v);
  const out: Warning[] = [];
  if (o.over_by_usd > 0)
    out.push({ code: "over_allocated", message: `Team budgets and the buffer are ${$(o.over_by_usd)} more than your ${$(o.budget_usd)} allowance. Lower a team budget or the buffer.` });
  if (o.budget_usd > 0 && o.rest.budget_usd === 0 && o.rest.members > 0)
    out.push({ code: "rest_zero", message: `Nothing is left for the ${o.rest.members} ${o.rest.members === 1 ? "person" : "people"} outside a team budget, so they can't launch.`, team_id: null });
  for (const t of o.teams)
    if (t.budget_usd != null && !t.members) out.push({ code: "empty_budgeted_team", message: `No one is in ${t.name}, so this ${$(t.budget_usd)} sits unused.`, team_id: t.id });
  if (o.policy.mode === "custom" && o.policy.default_cap_usd != null) {
    const each = o.policy.default_cap_usd;
    for (const pot of [null, ...o.teams.filter((t) => t.budget_usd != null).map((t) => t.id)]) {
      const n = o.members.filter((m) => m.pot === pot && m.limit_source === "default" && m.can_run).length;
      const budget = pot == null ? o.rest.budget_usd : o.teams.find((t) => t.id === pot)!.budget_usd!;
      const name = pot == null ? "Everyone else" : o.teams.find((t) => t.id === pot)!.name;
      if (n > 1 && n * each > budget)
        out.push({ code: "set_amount_exceeds_budget", team_id: pot,
          message: `${n} × ${$(each)} = ${$(cents(n * each))} is more than ${name}'s ${$(budget)}, so the budget runs out first.` });
    }
  }
  if (o.policy.mode === "pool" && o.members.filter((m) => m.can_run && m.cap_usd == null).length > 1)
    out.push({ code: "no_personal_limits", message: "Nobody has a personal limit, so one person can use a whole budget." });
  return out;
}

/**
 * POST /limits/preview: what a draft would do, without saving it. The overview shape for the draft, plus each person
 * whose limit or standing changes (blocked right away first), what is over the allowance, the adjustments the draft
 * makes inactive, how many people lose launch access, and warnings. Live usage is cached for 30 seconds (cachedLive).
 */
export async function preview(org: { orgId: number; slug: string }, d: Draft) {
  const [saved, lv] = await Promise.all([load(org.orgId), cachedLive(org)]);
  const names = new Map(lv.people.members.map((m) => [m.user_id, m.name || m.email || null]));
  const { next, parts, inactive } = applyDraft(saved, d, lv.budget_error ? null : lv.budget, names);
  const before = shape(saved, lv), after = shape(next, lv);
  const was = new Map(before.members.map((m) => [m.user_id, m]));
  const changes = after.members.flatMap((a) => {
    const b = was.get(a.user_id)!;
    const blocked_now = a.blocked != null && b.blocked == null;
    if (a.limit_usd === b.limit_usd && !blocked_now && a.blocked === b.blocked && a.limited_by === b.limited_by) return [];
    return [{ user_id: a.user_id, name: a.name || a.email, before: b.limit_usd, after: a.limit_usd, spent: a.spent, blocked_now, blocked: a.blocked, limited_by: a.limited_by }];
  }).sort((x, y) => Number(y.blocked_now) - Number(x.blocked_now));
  return { ...after, ...tiles(after, lv), summary: parts, changes, over_by_usd: after.over_by_usd, inactive,
    launch_access_stops: after.members.filter((a) => !a.can_run && was.get(a.user_id)!.can_run).length, warnings: warningsOf(after) };
}

/**
 * PUT /limits/plan: save the whole draft in one transaction, and one history entry for it. `version` is the If-Match
 * the page got from GET /limits; if the rules changed since (any save appends history), nothing is written (409).
 * Never refused for over-allocation: the page warns and asks first. Returns the new version.
 */
export async function plan(org: { orgId: number; slug: string }, actor: Actor, d: Draft, version: string | undefined) {
  const want = version?.replace(/^W\//, "").replace(/"/g, "").trim();
  if (!want) throw new LimitError("Send If-Match with the version of the rules you edited (from GET /limits).", 428);
  if (Array.isArray(d.remove_teams) && d.remove_teams.length) throw new LimitError("Delete a team on Teams; a plan doesn't remove teams.", 422);
  const [cap, names] = await Promise.all([capFor(org.orgId), namesOf(org.slug)]);
  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockRules(tx, org.orgId);
    if ((await versionOf(tx, org.orgId)) !== want) throw new LimitError("Someone changed these rules while you were editing.", 409);
    const saved = await load(org.orgId, tx);
    const { next, parts, resets, cleared } = applyDraft(saved, d, cap, names);
    const policy = policyOnly(next.policy);
    if (d.policy && Object.keys(d.policy).length) await writePolicy(tx, org.orgId, actor, policy);
    for (const t of next.teams)
      if (t.budget_usd !== saved.teams.find((x) => x.id === t.id)!.budget_usd)
        await tx.query("UPDATE usage_teams SET budget_usd = $3 WHERE org_id = $1 AND id = $2", [org.orgId, t.id, t.budget_usd]);
    if (resets.length)
      await tx.query("UPDATE usage_members SET cap_usd = NULL, adjust_usd = 0, can_run = NULL, max_concurrent_runs = NULL WHERE org_id = $1 AND user_id = ANY($2)", [org.orgId, resets]);
    if (cleared.length) await tx.query("UPDATE usage_members SET adjust_usd = 0 WHERE org_id = $1 AND user_id = ANY($2)", [org.orgId, cleared]);
    const people = (ids: string[]) => ids.map((id) => ({ user_id: id, ...saved.rows.get(id) }));
    await logChange(tx, org.orgId, actor, parts,
      { policy: policyOnly(saved.policy), teams: saved.teams, members: people([...resets, ...cleared]) },
      { policy, teams: next.teams, members: [...new Set([...resets, ...cleared])].map((id) => ({ user_id: id, ...next.rows.get(id) })) });
    return versionOf(tx, org.orgId);
  });
}
