/**
 * Platform analytics and health for /admin (Analytics): product usage across every account and the state of the
 * machinery behind it, in one view for Octillion staff. Customers see only their own team's usage (/app Usage).
 *
 * PostHog stays the system of record for product analytics and New Relic for traces. This view replicates the
 * numbers an admin checks daily from the records Octillion already keeps (the connector log mcp_events, accounts,
 * simulations, sessions, onboarding research), so it works before either is connected and never disagrees with
 * the account pages. Deeper questions go to PostHog and New Relic (links when configured).
 *
 *   POSTHOG_PROJECT_URL      e.g. https://us.posthog.com/project/12345   (link only)
 *   NEW_RELIC_DASHBOARD_URL  e.g. https://one.newrelic.com/...            (link only)
 */
import * as clerk from "./clerk.js";
import { getDb } from "./db.js";
import { researchJobs, sessionEngine } from "./host-tables.js";

const DAY = 86_400_000;
const isoDay = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? new Date(`${v}T00:00:00Z`) : null);

/**
 * The period a report covers: from/to as YYYY-MM-DD (UTC, both days included), else the last `days` days (default 30),
 * at most 366 days. The previous period is the same length just before it, for the change figures.
 */
export function reportRange(q: { from?: unknown; to?: unknown; days?: unknown }) {
  const today = new Date(Math.floor(Date.now() / DAY) * DAY);
  let from = isoDay(q.from), to = isoDay(q.to);
  if (!from || !to || to < from) {
    const days = Math.min(366, Math.max(1, Number(q.days) || 30));
    to = today; from = new Date(today.getTime() - (days - 1) * DAY);
  }
  if ((to.getTime() - from.getTime()) / DAY > 365) from = new Date(to.getTime() - 365 * DAY);
  const end = new Date(to.getTime() + DAY); // exclusive
  const days = Math.round((end.getTime() - from.getTime()) / DAY);
  const prevFrom = new Date(from.getTime() - days * DAY);
  const lit = (d: Date) => `'${d.toISOString()}'::timestamptz`;
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), days,
    start: from, end, sql: { F: lit(from), T: lit(end), PF: lit(prevFrom) } };
}

/** The UTC days from `start` (included) to `end` (excluded), as YYYY-MM-DD: the points of a daily sparkline. */
export function dayKeys(start: Date, end: Date): string[] {
  const out: string[] = [];
  for (let t = Math.floor(start.getTime() / DAY) * DAY; t < end.getTime(); t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
/** One series per kind `k` from rows of {k, day, v}, zero-filled over `days`. */
export function daySeries(days: string[], rows: { k: string; day: string; v: unknown }[], k: string, round = false): number[] {
  const by = new Map(rows.filter((r) => r.k === k).map((r) => [r.day, Number(r.v ?? 0)]));
  return days.map((d) => (round ? Math.round((by.get(d) ?? 0) * 100) / 100 : by.get(d) ?? 0));
}
/** The last 30 UTC days to today, and this UTC month to today: the two spans the cards' sparklines use. */
export function sparkSpans(now = new Date()) {
  const today = Math.floor(now.getTime() / DAY) * DAY, end = new Date(today + DAY);
  const last30 = new Date(today - 29 * DAY), month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { end, last30, month, days30: dayKeys(last30, end), monthDays: dayKeys(month, end) };
}

// ---------- filters ----------
// Every filter becomes a literal SQL fragment (validated ints, quoted text), never a bind param, so the many subqueries
// below share one shape and no query needs its own parameter list.
const lit = (s: string) => `'${s.replace(/\0/g, "").replace(/'/g, "''")}'`;
const texts = (xs: string[]) => `ARRAY[${xs.map(lit).join(",")}]::text[]`;
const ints = (xs: number[]) => `'{${xs.filter(Number.isInteger).join(",")}}'::int[]`;
const list = (v: unknown): string[] =>
  [...new Set((Array.isArray(v) ? v : v == null ? [] : [v]).flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean))].slice(0, 200);
const flag = (v: unknown) => v === "1" || v === "true" || v === true;
const intIn = (v: unknown, def: number, max: number) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : def; };
const intersect = (a: number[] | null, b: number[] | null) => (a == null ? b : b == null ? a : a.filter((x) => b.includes(x)));

type Orgs = Awaited<ReturnType<(typeof import("./admin.js"))["listOrgs"]>>;
// admin.ts imports this file, so it is loaded on demand (a static import would be a cycle).
const loadOrgs = async (): Promise<Orgs> => (await import("./admin.js")).listOrgs(false);

export type AnalyticsQuery = Record<string, unknown>;

/** Normalise the filter params and resolve the ones about accounts (slug, product, plan, billing, stage, at risk) to org ids. */
export async function parseFilters(q: AnalyticsQuery, range: ReturnType<typeof reportRange>, orgsOnce: () => Promise<Orgs>) {
  const db = await getDb();
  const { F, T, PF } = range.sql;
  const filters = {
    account: list(q.account), product: list(q.product), tool: list(q.tool), client: list(q.client),
    plan: list(q.plan), sub_status: list(q.sub_status), stage: list(q.stage), user: list(q.user),
    errors: flag(q.errors), at_risk: flag(q.at_risk), limit: intIn(q.limit, 200, 5000) || 200,
  };
  let orgIds: number[] | null = null, productIds: number[] | null = null;
  const ids = (rows: { id: number }[]) => rows.map((r) => Number(r.id));
  if (filters.account.length)
    orgIds = intersect(orgIds, ids(await db.query<{ id: number }>(`SELECT id FROM organizations WHERE slug = ANY(${texts(filters.account)})`)));
  if (filters.product.length) {
    // Products are the session engine's, a host pack's table (mold_v0-049): with none in this build, none matches.
    const ps = !sessionEngine() ? [] : await db.query<{ id: number; org_id: number }>(`SELECT id, org_id FROM products WHERE lower(name) = ANY(${texts(filters.product.map((x) => x.toLowerCase()))})`);
    productIds = ps.map((p) => Number(p.id));
    orgIds = intersect(orgIds, [...new Set(ps.map((p) => Number(p.org_id)))]);
  }
  if (filters.plan.length || filters.sub_status.length || filters.stage.length) {
    const { orgs } = await orgsOnce();
    orgIds = intersect(orgIds, orgs.filter((o) =>
      (!filters.plan.length || filters.plan.includes(o.subscription?.plan ?? "none")) &&
      (!filters.sub_status.length || filters.sub_status.includes(o.subscription?.status ?? "none")) &&
      (!filters.stage.length || filters.stage.includes(o.stage))).map((o) => Number(o.id)));
  }
  if (filters.at_risk) // the same rule as accounts[].at_risk: at least 5 calls before, and at most half as many now
    orgIds = intersect(orgIds, ids(await db.query<{ id: number }>(
      `SELECT org_id AS id FROM mcp_events WHERE method = 'tools/call' AND at >= ${PF} AND at < ${T} GROUP BY org_id
        HAVING count(*) FILTER (WHERE at < ${F}) >= 5 AND count(*) FILTER (WHERE at >= ${F}) <= count(*) FILTER (WHERE at < ${F}) / 2.0`)));
  const O = orgIds && ints(orgIds), P = productIds && ints(productIds);
  // Tool calls carry no client (only the handshake does), so a client filter also keeps the calls of accounts that
  // connected with that client in this or the previous period (the prev totals and the accounts' trend scan PF..T,
  // so an account that stopped using the client still shows up as at risk).
  const C = filters.client.length ? texts(filters.client) : null;
  const clientOnly = (a: string) => (C ? ` AND split_part(${a}client, ' ', 1) = ANY(${C})` : "");
  const clientOf = (a: string) => (C ? ` AND (split_part(${a}client, ' ', 1) = ANY(${C}) OR (${a}client IS NULL AND ${a}org_id IN
      (SELECT org_id FROM mcp_events WHERE method = 'initialize' AND split_part(client, ' ', 1) = ANY(${C}) AND at >= ${PF} AND at < ${T})))` : "");
  const orgOf = (a: string) => (O ? ` AND ${a}org_id = ANY(${O})` : "");
  // People (Clerk user ids): their own tool calls, and the runs they launched. A future per-person view pins this to the
  // signed-in user server-side, so hiding the picker never widens what someone can see.
  const U = filters.user.length ? texts(filters.user) : null;
  const userOf = (a: string) => (U ? ` AND ${a}user_id = ANY(${U})` : "");
  const byUser = (a: string, kind: "" | "sim" | "session" | "research") => !U ? ""
    : kind === "sim" ? ` AND ${a}created_by = ANY(${U})`
    : kind === "session" ? `/* tenant: internal: admin Analytics (onboarding admin routes), every account */ AND ${a}simulation_id IN (SELECT id FROM simulations WHERE created_by = ANY(${U}))`
    : kind === "research" ? ` AND ${a}org_id IN (SELECT DISTINCT org_id FROM mcp_events WHERE user_id = ANY(${U}))` : "";
  const sql = {
    /** On every mcp_events query; `a` is the table alias with its dot ("e."), or "". */
    EV: (a = "") => orgOf(a) + userOf(a) + clientOf(a) + (filters.tool.length ? ` AND ${a}method = 'tools/call' AND ${a}name = ANY(${texts(filters.tool)})` : "") + (filters.errors ? ` AND NOT ${a}ok` : ""),
    /** The clients query: only the account and client parts apply. */
    CL: (a = "") => orgOf(a) + userOf(a) + clientOnly(a),
    /** Simulations, sessions and research. */
    ORG: (a = "", kind: "" | "sim" | "session" | "research" = "") => orgOf(a) + (P ? ` AND ${a}product_id = ANY(${P})` : "") + byUser(a, kind),
    O, P, scoped: Boolean(O || P || U),
  };
  return { filters, orgIds, productIds, sql };
}

// ---------- growth ----------

const WEEK = 7 * DAY;
/** The Monday (UTC) of the ISO week holding `t` (ms), at 00:00. */
const mondayOf = (t: number) => { const d = Math.floor(t / DAY) * DAY; return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY; };
const isoOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const CLIENT_TOP = 5;

/**
 * The Growth block of Analytics (usage only, no money), in six queries plus the accounts listing the page already
 * loads. Weekly series cover the last 12 ISO weeks (Monday to Sunday, UTC) to the range's last day, or the whole range
 * when it is longer; the last week is `partial` when the range ends before it does. Every filter applies unless noted.
 *   accounts_daily  accounts created up to the end of each day of the range (account and product filters only)
 *   weekly          per week: accounts and people with a tool call, tool calls, calls per active person, and the %
 *                   change in calls vs the week before
 *   stickiness      per day: distinct people with a tool call that day / in the 30 days to that day (DAU/MAU)
 *   client_mix      tool calls per week by AI client family (split_part(client, ' ', 1)). Tool calls carry no client, so
 *                   each call counts for the client of its caller's latest handshake (same account and person) before
 *                   it, else "unknown"; the top 5 families over the window, the rest as Other
 *   sims_weekly     simulations created per week, completed vs the rest (account, product and user filters)
 *   funnel          access requests made in the range, then the overview funnel (admin.funnelOf, same stages and rule)
 *                   for the accounts created in the range; access requests ignore the filters (they have no account)
 */
async function growth(range: ReturnType<typeof reportRange>, { sql, orgIds }: Awaited<ReturnType<typeof parseFilters>>, orgsOnce: () => Promise<Orgs>,
  newDailyP: Promise<{ day: string; n: number }[]>) {
  const db = await getDb();
  const { F, T } = range.sql, { EV, CL, ORG, O } = sql;
  const calls = "method = 'tools/call'", person = "coalesce(user_id, 'org:' || org_id)";
  const endMs = range.end.getTime(), lastWeek = mondayOf(endMs - DAY);
  const firstWeek = Math.min(mondayOf(range.start.getTime()), lastWeek - 11 * WEEK);
  const weeks: string[] = [];
  for (let t = firstWeek; t <= lastWeek; t += WEEK) weeks.push(isoOf(t));
  const W0 = `'${new Date(firstWeek).toISOString()}'::timestamptz`, WP = `'${new Date(firstWeek - WEEK).toISOString()}'::timestamptz`;
  const wk = (c: string) => `to_char(date_trunc('week', ${c} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;

  const [base, weekly, sticky, mix, sims, orgs, newDaily] = await Promise.all([
    db.query<{ before: unknown; requests: unknown }>(
      `SELECT (SELECT count(*) FROM organizations WHERE created_at < ${F}${O ? ` AND id = ANY(${O})` : ""}) AS before,
              (SELECT count(*) FROM access_requests WHERE created_at >= ${F} AND created_at < ${T}) AS requests`),
    db.query<{ week: string; accounts: unknown; people: unknown; calls: unknown }>(
      `SELECT ${wk("at")} AS week, count(DISTINCT org_id) AS accounts, count(DISTINCT ${person}) AS people, count(*) AS calls
         FROM mcp_events WHERE ${calls} AND at >= ${WP} AND at < ${T}${EV()} GROUP BY 1`),
    db.query<{ day: string; dau: unknown; mau: unknown }>(
      `/* tenant: internal: admin Analytics (onboarding admin routes), every account */ WITH a AS (SELECT DISTINCT ${person} AS p, (at AT TIME ZONE 'UTC')::date AS d FROM mcp_events
                   WHERE ${calls} AND at >= ${F} - interval '29 days' AND at < ${T}${EV()}),
            days AS (SELECT generate_series('${range.from}'::date, '${range.to}'::date, interval '1 day')::date AS day)
       SELECT to_char(days.day, 'YYYY-MM-DD') AS day, count(DISTINCT a.p) FILTER (WHERE a.d = days.day) AS dau, count(DISTINCT a.p) AS mau
         FROM days JOIN a ON a.d > days.day - 30 AND a.d <= days.day GROUP BY days.day`),
    // Each call takes the client of the latest handshake by the same account and person at or before it: number the
    // handshakes per caller in time order (a handshake sorts before a call at the same instant), then a call's group
    // is the count of handshakes up to it.
    db.query<{ week: string; client: string; calls: unknown }>(
      `WITH ev AS (
         SELECT org_id, ${person} AS p, at, method = 'tools/call' AS is_call, CASE WHEN method = 'initialize' THEN split_part(client, ' ', 1) END AS fam
           FROM mcp_events
          WHERE (${calls} AND at >= ${W0} AND at < ${T}${EV()}) OR (method = 'initialize' AND client IS NOT NULL AND at < ${T}${CL()})),
       grouped AS (SELECT *, count(fam) OVER (PARTITION BY org_id, p ORDER BY at, is_call ROWS UNBOUNDED PRECEDING) AS g FROM ev),
       tagged AS (SELECT at, is_call, max(fam) OVER (PARTITION BY org_id, p, g) AS fam FROM grouped)
       SELECT ${wk("at")} AS week, coalesce(nullif(fam, ''), 'unknown') AS client, count(*) AS calls
         FROM tagged WHERE is_call AND at >= ${W0} GROUP BY 1, 2`),
    !sessionEngine() ? Promise.resolve([] as { week: string; completed: unknown; other: unknown }[]) : db.query<{ week: string; completed: unknown; other: unknown }>(
      `/* tenant: internal: admin Analytics (onboarding admin routes), every account */ SELECT ${wk("created_at")} AS week, count(*) FILTER (WHERE status = 'completed') AS completed, count(*) FILTER (WHERE status IS DISTINCT FROM 'completed') AS other
         FROM simulations WHERE created_at >= ${W0} AND created_at < ${T}${ORG("", "sim")} GROUP BY 1`),
    orgsOnce().then((x) => x.orgs, () => null),
    newDailyP,
  ]);

  // Accounts over time: the count before the range, plus each day's new accounts.
  let total = Number(base[0]?.before ?? 0);
  const born = new Map(newDaily.map((r) => [r.day, Number(r.n)]));
  const days = dayKeys(range.start, range.end);
  const accounts_daily = days.map((day) => ({ day, total: (total += born.get(day) ?? 0) }));

  const wkBy = new Map(weekly.map((r) => [r.week, { accounts: Number(r.accounts), people: Number(r.people), calls: Number(r.calls) }]));
  const weeklyRows = weeks.map((week) => {
    const t = Date.parse(`${week}T00:00:00Z`), cur = wkBy.get(week), c = cur?.calls ?? 0, p = wkBy.get(isoOf(t - WEEK))?.calls ?? 0;
    return { week, accounts: cur?.accounts ?? 0, people: cur?.people ?? 0, calls: c,
      calls_per_person: cur?.people ? Math.round((c / cur.people) * 10) / 10 : null,
      change_pct: p ? Math.round(((c - p) / p) * 1000) / 10 : null, partial: t + WEEK > endMs };
  });

  const stBy = new Map(sticky.map((r) => [r.day, r]));
  const stickiness = days.map((day) => {
    const r = stBy.get(day), dau = Number(r?.dau ?? 0), mau = Number(r?.mau ?? 0);
    return { day, dau, mau, pct: mau ? Math.round((dau / mau) * 1000) / 10 : null };
  });

  // The top families over the whole window keep their own series; the rest fold into Other.
  const byClient = new Map<string, number>();
  for (const r of mix) byClient.set(r.client, (byClient.get(r.client) ?? 0) + Number(r.calls));
  const ranked = [...byClient].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
  const keep = ranked.slice(0, CLIENT_TOP), hasOther = ranked.length > CLIENT_TOP;
  const clientsList = [...keep, ...(hasOther ? ["Other"] : [])];
  const mixBy = new Map<string, number[]>(weeks.map((w) => [w, clientsList.map(() => 0)]));
  for (const r of mix) {
    const row = mixBy.get(r.week), i = keep.indexOf(r.client);
    if (row) row[i >= 0 ? i : keep.length] += Number(r.calls);
  }
  const client_mix = { clients: clientsList, weeks: weeks.map((week) => ({ week, calls: mixBy.get(week)! })) };

  const simBy = new Map(sims.map((r) => [r.week, r]));
  const sims_weekly = weeks.map((week) => ({ week, completed: Number(simBy.get(week)?.completed ?? 0), other: Number(simBy.get(week)?.other ?? 0) }));

  // The overview's funnel (same stages, same rule), for the accounts created in the range.
  let funnel: { id: string; label: string; reached: number; pct: number | null }[] | null = null;
  if (orgs) {
    const { funnelOf } = await import("./admin.js");
    const ids = orgIds ? new Set(orgIds) : null;
    const cohort = orgs.filter((o) => { const t = new Date(o.created_at).getTime(); return t >= range.start.getTime() && t < endMs && (!ids || ids.has(Number(o.id))); });
    const f = new Map(funnelOf(cohort).map((s) => [s.id, s.reached]));
    const steps = [
      { id: "requests", label: "Access requests", reached: Number(base[0]?.requests ?? 0) },
      { id: "created", label: "Accounts", reached: f.get("created") ?? 0 },
      { id: "onboarded", label: "Onboarded", reached: f.get("onboarded") ?? 0 },
      { id: "simulated", label: "First simulation", reached: f.get("simulated") ?? 0 },
      { id: "reported", label: "First report", reached: f.get("reported") ?? 0 },
    ];
    funnel = steps.map((s, i) => ({ ...s, pct: i && steps[i - 1].reached ? Math.round((s.reached / steps[i - 1].reached) * 100) : null }));
  }

  return { accounts_daily, weekly: weeklyRows, stickiness, client_mix, sims_weekly, funnel };
}

const memo = <T>(f: () => Promise<T>) => { let p: Promise<T> | null = null; return () => (p ??= f()); };

/**
 * What the filter lists offer, for the period but not narrowed by the filters themselves. `counts` says how many
 * records each value has: tool calls in the period for an account, person and tool; connections (handshakes) for a
 * client; accounts for a product name, plan, billing status and stage.
 */
async function facets(range: ReturnType<typeof reportRange>, orgsOnce: () => Promise<Orgs>) {
  const db = await getDb();
  const { F, T } = range.sql;
  const [accounts, products, tools, clients, people] = await Promise.all([
    db.query<{ slug: string; name: string; calls: unknown }>(`SELECT o.slug, o.name, coalesce(c.n, 0) AS calls FROM organizations o LEFT JOIN
      (SELECT org_id, count(*) AS n FROM mcp_events WHERE method = 'tools/call' AND at >= ${F} AND at < ${T} GROUP BY org_id) c ON c.org_id = o.id ORDER BY lower(o.name)`),
    !sessionEngine() ? Promise.resolve([] as { name: string; n: unknown }[]) : db.query<{ name: string; n: unknown }>(`SELECT name, count(DISTINCT org_id) AS n FROM products GROUP BY name ORDER BY 1`),
    db.query<{ name: string; n: unknown }>(`/* tenant: internal: admin Analytics (onboarding admin routes), every account */ SELECT name, count(*) AS n FROM mcp_events WHERE method = 'tools/call' AND name IS NOT NULL AND at >= ${F} AND at < ${T} GROUP BY name ORDER BY 1`),
    db.query<{ client: string; n: unknown }>(`/* tenant: internal: admin Analytics (onboarding admin routes), every account */ SELECT split_part(client, ' ', 1) AS client, count(*) AS n FROM mcp_events WHERE method = 'initialize' AND client IS NOT NULL AND at >= ${F} AND at < ${T} GROUP BY 1 ORDER BY 1`),
    db.query<{ user_id: string; account: string; calls: unknown }>(
      `SELECT e.user_id, min(o.name) AS account, count(*) FILTER (WHERE e.method = 'tools/call') AS calls FROM mcp_events e JOIN organizations o ON o.id = e.org_id
        WHERE e.user_id IS NOT NULL AND e.at >= ${F} AND e.at < ${T} GROUP BY e.user_id ORDER BY count(*) DESC LIMIT 300`),
  ]);
  // Emails from Clerk (cached a minute per user); without Clerk, or on a lookup error, the id stands in.
  const users = await Promise.all(people.map(async (u) => {
    let email: string | null = null, name: string | null = null;
    if (clerk.clerkEnabled()) try { const cu = await clerk.users.get(u.user_id); email = clerk.primaryEmail(cu).email; name = clerk.displayName(cu); } catch { /* keep the id */ }
    return { id: u.user_id, email, name, account: u.account };
  }));
  const tally = (xs: string[]) => { const m: Record<string, number> = {}; for (const x of xs) m[x] = (m[x] ?? 0) + 1; return m; };
  const num = <R,>(xs: R[], k: (r: R) => string, v: (r: R) => unknown) => Object.fromEntries(xs.map((r) => [k(r), Number(v(r) ?? 0) || 0]));
  const counts: Record<string, Record<string, number>> = {
    account: num(accounts, (a) => a.slug, (a) => a.calls), user: num(people, (u) => u.user_id, (u) => u.calls), product: num(products, (p) => p.name, (p) => p.n),
    tool: num(tools, (t) => t.name, (t) => t.n), client: num(clients.filter((c) => c.client), (c) => c.client, (c) => c.n), plan: {}, sub_status: {}, stage: {},
  };
  let plans: string[] = [], subStatuses = ["active", "trialing", "past_due", "canceled", "none"], stages: { id: string; label: string }[] = [];
  try {
    const { orgs, stages: st } = await orgsOnce();
    plans = [...new Set(orgs.map((o) => o.subscription?.plan ?? "none"))].sort();
    subStatuses = [...new Set([...subStatuses, ...orgs.map((o) => o.subscription?.status ?? "none")])];
    stages = st.map((s) => ({ id: s.id, label: s.label }));
    counts.plan = tally(orgs.map((o) => o.subscription?.plan ?? "none"));
    counts.sub_status = tally(orgs.map((o) => o.subscription?.status ?? "none"));
    counts.stage = tally(orgs.map((o) => o.stage));
  } catch { /* Stripe or WorkOS down: the lists stay empty, the report still loads */ }
  return { accounts: accounts.map(({ slug, name }) => ({ slug, name })), users, products: products.map((p) => p.name), tools: tools.map((t) => t.name),
    clients: clients.map((c) => c.client).filter(Boolean), plans, sub_statuses: subStatuses, stages, counts };
}

/**
 * The Analytics and Health report. Filters (comma-separated lists): account (slugs), product (names), tool, client,
 * plan, sub_status, stage, errors=1, at_risk=1; limit caps the accounts rows (default 200, at most 5000).
 */
export async function platformAnalytics(q: AnalyticsQuery) {
  const range = reportRange(q);
  const { days } = range, { F, T, PF } = range.sql;
  const db = await getDb();
  const orgsOnce = memo(loadOrgs);
  const [parsed, facetLists] = await Promise.all([parseFilters(q, range, orgsOnce), facets(range, orgsOnce)]);
  const { filters, sql: { EV, CL, ORG, O, scoped } } = parsed;
  // The session engine's tables are a host pack's (mold_v0-049): with none in this build its figures are 0.
  const eng = sessionEngine(), research = researchJobs();
  const GW = scoped ? (eng ? `gateway_usage g JOIN agent_sessions s ON s.id = g.session_id WHERE g.last_at >= ${F} AND g.last_at < ${T}${ORG("s.", "session")}`
                           : `gateway_usage g WHERE false`)
    : `gateway_usage g WHERE g.last_at >= ${F} AND g.last_at < ${T}`;
  // In the period, and in the period just before it.
  const inW = (c: string) => `${c} >= ${F} AND ${c} < ${T}`, inP = (c: string) => `${c} >= ${PF} AND ${c} < ${F}`;
  const calls = "method = 'tools/call'";
  const person = "coalesce(user_id, 'org:' || org_id)";

  // accounts created per day, for the New accounts sparkline and Accounts over time
  const newDailyP = db.query<{ day: string; n: number }>(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*) AS n FROM organizations WHERE ${inW("created_at")}${O ? ` AND id = ANY(${O})` : ""} GROUP BY 1 ORDER BY 1`);
  const growthP = growth(range, parsed, orgsOnce, newDailyP);
  const [totals, prev, daily, tools, clients, accounts, retention, ops, errors, newAccounts, errorsTotal, newDaily, opsDaily, growthReport] = await Promise.all([
    db.query<Record<string, number>>(
      `SELECT count(DISTINCT org_id) FILTER (WHERE ${calls}) AS active_accounts, count(DISTINCT ${person}) FILTER (WHERE ${calls}) AS active_people,
              count(*) FILTER (WHERE ${calls}) AS calls, count(*) FILTER (WHERE ${calls} AND NOT ok) AS errors,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) FILTER (WHERE ${calls}) AS p50_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) FILTER (WHERE ${calls}) AS p95_ms
         FROM mcp_events WHERE ${inW("at")}${EV()}`),
    db.query<Record<string, number>>(
      `SELECT count(DISTINCT org_id) FILTER (WHERE ${calls}) AS active_accounts, count(DISTINCT ${person}) FILTER (WHERE ${calls}) AS active_people,
              count(*) FILTER (WHERE ${calls}) AS calls
         FROM mcp_events WHERE ${inP("at")}${EV()}`),
    db.query(
      `SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day, count(DISTINCT org_id) AS accounts, count(DISTINCT ${person}) AS people,
              count(*) AS calls, count(*) FILTER (WHERE NOT ok) AS errors, round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)) AS p95_ms
         FROM mcp_events WHERE ${calls} AND ${inW("at")}${EV()} GROUP BY 1 ORDER BY 1`),
    db.query(
      `SELECT name, count(DISTINCT org_id) AS accounts, count(DISTINCT ${person}) AS people, count(*) AS calls,
              round(100.0 * count(*) FILTER (WHERE NOT ok) / count(*), 1) AS error_pct,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)) AS p50_ms, round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)) AS p95_ms
         FROM mcp_events WHERE ${calls} AND ${inW("at")}${EV()} GROUP BY name ORDER BY count(DISTINCT org_id) DESC, count(*) DESC`),
    // Client families from the connection handshake: "claude-ai 0.1.0" -> claude-ai.
    db.query(
      `SELECT split_part(client, ' ', 1) AS client, count(DISTINCT org_id) AS accounts, count(DISTINCT ${person}) AS people, count(*) AS connections
         FROM mcp_events WHERE method = 'initialize' AND client IS NOT NULL AND ${inW("at")}${CL()} GROUP BY 1 ORDER BY 2 DESC, 4 DESC LIMIT 12`),
    db.query(
      `SELECT o.slug, o.name, ${eng ? "(SELECT string_agg(p.name, ', ' ORDER BY p.name) FROM products p WHERE p.org_id = o.id)" : "NULL::text"} AS products, count(*) FILTER (WHERE ${inW("e.at")}) AS calls, count(*) FILTER (WHERE ${inP("e.at")}) AS prev_calls,
              count(*) FILTER (WHERE ${inW("e.at")} AND NOT e.ok) AS errors, count(DISTINCT ${person.replace(/user_id|org_id/g, (c) => `e.${c}`)}) FILTER (WHERE ${inW("e.at")}) AS people,
              max(e.at) AS last_seen, count(*) OVER () AS total
         FROM mcp_events e JOIN organizations o ON o.id = e.org_id
        WHERE e.${calls} AND e.at >= ${PF} AND e.at < ${T}${EV("e.")} GROUP BY o.id, o.slug, o.name
        ORDER BY count(*) FILTER (WHERE ${inW("e.at")}) DESC, o.name LIMIT ${filters.limit}`),
    // Weekly retention by account: the week of an account's first tool call, then the share active in each later week.
    db.query<{ cohort: string; size: number; week: number; active: number }>(
      `WITH firsts AS (SELECT org_id, date_trunc('week', min(at)) AS cohort FROM mcp_events WHERE ${calls}${EV()} GROUP BY org_id),
            act AS (SELECT DISTINCT org_id, date_trunc('week', at) AS wk FROM mcp_events WHERE ${calls}${EV()})
       SELECT to_char(f.cohort, 'YYYY-MM-DD') AS cohort, (SELECT count(*) FROM firsts f2 WHERE f2.cohort = f.cohort) AS size,
              (extract(epoch FROM a.wk - f.cohort) / 604800)::int AS week, count(DISTINCT a.org_id) AS active
         FROM firsts f JOIN act a ON a.org_id = f.org_id
        WHERE f.cohort >= date_trunc('week', now()) - interval '7 weeks'
        GROUP BY f.cohort, a.wk ORDER BY f.cohort, week`),
    db.query<Record<string, number>>(
      `/* tenant: internal: admin Analytics (onboarding admin routes), every account */ SELECT ${eng ? `(SELECT count(*) FROM simulations WHERE ${inW("created_at")}${ORG("", "sim")}) AS sims,
              (SELECT count(*) FROM simulations WHERE ${inW("created_at")} AND status = 'completed'${ORG("", "sim")}) AS sims_completed,
              (SELECT count(*) FROM simulations WHERE status IN ('queued', 'running')${ORG("", "sim")}) AS sims_open,
              (SELECT count(*) FROM agent_sessions WHERE ${inW("queued_at")}${ORG("", "session")}) AS sessions,
              (SELECT count(*) FROM agent_sessions WHERE ${inW("queued_at")} AND status = 'completed'${ORG("", "session")}) AS sessions_completed,
              (SELECT count(*) FROM agent_sessions WHERE ${inW("queued_at")} AND status IN ('failed', 'timeout')${ORG("", "session")}) AS sessions_failed,
              (SELECT count(*) FROM agent_sessions WHERE status = 'queued'${ORG("", "session")}) AS sessions_queued,
              (SELECT coalesce(sum(cost_usd), 0) FROM agent_sessions WHERE ${inW("queued_at")}${ORG("", "session")}) AS model_cost_usd,`
            : "0 AS sims, 0 AS sims_completed, 0 AS sims_open, 0 AS sessions, 0 AS sessions_completed, 0 AS sessions_failed, 0 AS sessions_queued, 0 AS model_cost_usd,"}
              ${research ? `(SELECT count(*) FROM product_research WHERE kind = 'product' AND ${inW("created_at")}${ORG("", "research")}) AS onboardings,
              (SELECT count(*) FROM product_research WHERE kind = 'product' AND ${inW("created_at")} AND status = 'failed'${ORG("", "research")}) AS onboardings_failed,`
            : "0 AS onboardings, 0 AS onboardings_failed,"}
              (SELECT coalesce(sum(g.errors), 0) FROM ${GW}) AS gateway_errors,
              (SELECT coalesce(sum(g.requests), 0) FROM ${GW}) AS gateway_requests`),
    db.query(
      `SELECT e.at, o.name AS account, o.slug, e.method, e.name, e.client, e.error, e.ms
         FROM mcp_events e JOIN organizations o ON o.id = e.org_id WHERE NOT e.ok AND ${inW("e.at")}${EV("e.")} ORDER BY e.at DESC LIMIT 15`),
    db.query<{ n: number }>(`SELECT count(*) AS n FROM organizations WHERE ${inW("created_at")}${O ? ` AND id = ANY(${O})` : ""}`),
    db.query<{ n: number }>(`/* tenant: internal: admin Analytics (onboarding admin routes), every account */ SELECT count(*) AS n FROM mcp_events WHERE NOT ok AND ${inW("at")}${EV()}`),
    newDailyP,
    // The Health figures day by day, for their sparklines (same filters as ops). Queued is the autoscaler's daily peak.
    db.query<Record<string, unknown>>(
      `/* tenant: internal: admin Analytics (onboarding admin routes), every account */ WITH days AS (
         SELECT NULL::text AS day, 0::bigint AS sims, 0::bigint AS sims_completed, 0::bigint AS sessions, 0::bigint AS sessions_failed, 0::numeric AS model_cost_usd,
                0::bigint AS onboardings, 0::bigint AS onboardings_failed, 0::numeric AS gateway_errors, 0::numeric AS gateway_requests, 0 AS queued WHERE false${eng ? `
         UNION ALL
         SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*) AS sims, count(*) FILTER (WHERE status = 'completed') AS sims_completed,
                0 AS sessions, 0 AS sessions_failed, 0 AS model_cost_usd, 0 AS onboardings, 0 AS onboardings_failed, 0 AS gateway_errors, 0 AS gateway_requests, 0 AS queued
           FROM simulations WHERE ${inW("created_at")}${ORG("", "sim")} GROUP BY 1
         UNION ALL
         SELECT to_char(date_trunc('day', queued_at), 'YYYY-MM-DD'), 0, 0, count(*), count(*) FILTER (WHERE status IN ('failed', 'timeout')), coalesce(sum(cost_usd), 0), 0, 0, 0, 0, 0
           FROM agent_sessions WHERE ${inW("queued_at")}${ORG("", "session")} GROUP BY 1` : ""}${research ? `
         UNION ALL
         SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD'), 0, 0, 0, 0, 0, count(*), count(*) FILTER (WHERE status = 'failed'), 0, 0, 0
           FROM product_research WHERE kind = 'product' AND ${inW("created_at")}${ORG("", "research")} GROUP BY 1` : ""}
         UNION ALL
         SELECT to_char(date_trunc('day', g.last_at), 'YYYY-MM-DD'), 0, 0, 0, 0, 0, 0, 0, sum(g.errors), sum(g.requests), 0 FROM ${GW} GROUP BY 1
         UNION ALL
         SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD'), 0, 0, 0, 0, 0, 0, 0, 0, 0, max(queued) FROM autoscaler_ticks WHERE ${inW("at")} GROUP BY 1)
       SELECT day, sum(sims) AS sims, sum(sims_completed) AS sims_completed, sum(sessions) AS sessions, sum(sessions_failed) AS sessions_failed,
              sum(model_cost_usd) AS model_cost_usd, sum(onboardings) AS onboardings, sum(onboardings_failed) AS onboardings_failed,
              sum(gateway_errors) AS gateway_errors, sum(gateway_requests) AS gateway_requests, max(queued) AS queued
         FROM days GROUP BY day ORDER BY day`),
    growthP,
  ]);

  const t = totals[0] ?? {}, p = prev[0] ?? {};
  const change = (now: number, before: number) => (Number(before) ? Math.round(((Number(now) - Number(before)) / Number(before)) * 100) : null);
  const cohorts = new Map<string, { cohort: string; size: number; weeks: number[] }>();
  for (const r of retention) {
    const c = cohorts.get(r.cohort) ?? { cohort: r.cohort, size: Number(r.size), weeks: [] };
    c.weeks[Number(r.week)] = Math.round((Number(r.active) / Math.max(1, Number(r.size))) * 100);
    cohorts.set(r.cohort, c);
  }
  return {
    days, range: { from: range.from, to: range.to, days },
    links: { posthog: process.env.POSTHOG_PROJECT_URL || null, new_relic: process.env.NEW_RELIC_DASHBOARD_URL || null,
             posthog_events: Boolean(process.env.POSTHOG_API_KEY), tracing: Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT) },
    totals: {
      active_accounts: Number(t.active_accounts ?? 0), active_people: Number(t.active_people ?? 0), calls: Number(t.calls ?? 0),
      error_pct: Number(t.calls) ? Math.round((Number(t.errors) / Number(t.calls)) * 1000) / 10 : 0,
      p50_ms: t.p50_ms == null ? null : Math.round(Number(t.p50_ms)), p95_ms: t.p95_ms == null ? null : Math.round(Number(t.p95_ms)),
      new_accounts: Number(newAccounts[0]?.n ?? 0),
      change: { active_accounts: change(t.active_accounts, p.active_accounts), active_people: change(t.active_people, p.active_people), calls: change(t.calls, p.calls) },
    },
    daily, new_daily: newDaily.map((r) => ({ day: r.day, n: Number(r.n) })), tools, clients,
    ops_daily: opsDaily.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === "day" ? v : Number(v ?? 0)]))),
    accounts: accounts.map(({ total: _t, ...a }: any) => ({ ...a, calls: Number(a.calls), prev_calls: Number(a.prev_calls),
      trend: change(a.calls, a.prev_calls), at_risk: Number(a.prev_calls) >= 5 && Number(a.calls) <= Number(a.prev_calls) / 2 })),
    retention: [...cohorts.values()].map((c) => ({ ...c, weeks: Array.from({ length: 8 }, (_, i) => c.weeks[i] ?? null) })),
    ops: Object.fromEntries(Object.entries(ops[0] ?? {}).map(([k, v]) => [k, Number(v)])),
    errors, errors_total: Number(errorsTotal[0]?.n ?? 0),
    accounts_total: Number((accounts[0] as any)?.total ?? 0),
    growth: growthReport,
    filters, facets: facetLists,
  };
}

const ERROR_KINDS = ["tool", "session", "onboarding"] as const;
/** Every failure in the period, newest first, one page at a time: tool calls, agent sessions, or onboarding research. */
export async function platformErrors(q: AnalyticsQuery) {
  const range = reportRange(q);
  const { F, T } = range.sql;
  const { sql: { EV, ORG } } = await parseFilters(q, range, memo(loadOrgs));
  const kind = ERROR_KINDS.find((k) => k === q.kind) ?? "tool";
  const offset = intIn(q.offset, 0, 1_000_000), limit = intIn(q.limit, 50, 1000) || 50;
  const inW = (c: string) => `${c} >= ${F} AND ${c} < ${T}`;
  const [select, from] = {
    tool: [`e.at, o.name AS account, o.slug, e.method, e.name, split_part(e.client, ' ', 1) AS client, e.error, e.ms`,
      `mcp_events e JOIN organizations o ON o.id = e.org_id WHERE NOT e.ok AND ${inW("e.at")}${EV("e.")}`],
    session: [`coalesce(s.ended_at, s.queued_at) AS at, o.name AS account, o.slug, p.name AS product, s.simulation_id, s.model, s.harness, s.status,
        s.error_message AS error, s.cost_usd`,
      `agent_sessions s JOIN organizations o ON o.id = s.org_id JOIN products p ON p.id = s.product_id
        WHERE s.status IN ('failed', 'timeout') AND ${inW("s.queued_at")}${ORG("s.", "session")}`],
    onboarding: [`coalesce(r.finished_at, r.created_at) AS at, o.name AS account, o.slug, p.name AS product, r.stage, r.error`,
      `product_research r JOIN organizations o ON o.id = r.org_id JOIN products p ON p.id = r.product_id
        WHERE r.status = 'failed' AND ${inW("r.created_at")}${ORG("r.", "research")}`],
  }[kind];
  // Sessions and onboarding research are the session engine's, a host pack's tables (mold_v0-049): none without them.
  if ((kind === "session" && !sessionEngine()) || (kind === "onboarding" && !researchJobs()))
    return { kind, rows: [], total: 0, offset, limit, range: { from: range.from, to: range.to, days: range.days } };
  const db = await getDb();
  const [rows, total] = await Promise.all([
    db.query(`SELECT ${select} FROM ${from} ORDER BY 1 DESC LIMIT ${limit} OFFSET ${offset}`),
    db.query<{ n: number }>(`SELECT count(*) AS n FROM ${from}`),
  ]);
  return { kind, rows: kind === "session" ? rows.map((r: any) => ({ ...r, cost_usd: Number(r.cost_usd) })) : rows,
    total: Number(total[0]?.n ?? 0), offset, limit, range: { from: range.from, to: range.to, days: range.days } };
}
