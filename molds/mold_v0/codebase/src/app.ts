/**
 * The customer page (/app, web/app/app and web/components/portal): one place for an account's people to check their setup, learn the
 * workflow, see their team's usage, manage the team and the plan. Sign-in is Clerk (the same identity as the
 * connector's OAuth): the UI sends Clerk's session (the __session cookie on the same origin, or a Bearer session
 * token), and the account is the session's active Clerk organization.
 *
 * Nothing new is stored. Setup and usage come from the connector log Octillion already keeps (mcp_events, per user);
 * people from Clerk and the plan from Stripe, through src/admin.ts.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import * as admin from "./admin.js";
import { orgForClerk } from "./auth.js";
import { orgBudget } from "./billing.js";
import * as billing from "./billing.js";
import * as experiments from "./experiments.js";
import { getDb } from "./db.js";
import { getProduct, HIT, listProducts, orgMonthSpendUsd, saveProduct, saveScenarios, SCENARIO_ROWS } from "./queries.js";
import * as context from "./context.js";
import { getPopulation } from "./populations.js";
import * as playbooks from "./playbooks.js";
import { markStage, playbooksFor, PlaybookError, syncProgress } from "./playbooks.js";
import { TOOL_NAMES } from "./server.js";
import { dayKeys, daySeries, reportRange, sparkSpans } from "./insights.js";
import { capture, identifyPerson } from "./telemetry.js";
import * as journeys from "./journeys.js";
import * as limits from "./limits.js";
import * as clerk from "./clerk.js";
import { clerkSession } from "./session.js";
import * as roles from "./account-roles.js";
import * as priv from "./private.js";
import * as contributions from "./contributions.js";
import { recordPageAction } from "./analytics.js";
import { visibilityRoutes } from "./visibility.js";
import { answerDocs, sseStart, streamDocsAnswer, type DocsStreamEvent } from "./docs-answers.js";

/** The portal surface: library content redacted (src/queries.ts Surface). MCP tool handlers (src/server.ts) never pass it. */
const PORTAL = { redact: true } as const;

const publicUrl = () => (process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3333}`).replace(/\/$/, "");

/**
 * Who is signed in, and for which account: a Clerk user acting in one Clerk organization. `role` is Clerk's (admin or
 * member); `accountRole` is what they may do (src/account-roles.ts).
 */
export interface Session { org: number; slug: string; user: string | null; email: string | null; role: "admin" | "member"; accountRole: roles.AccountRole; clerkOrgId: string | null }

const identified = new Set<string>();

class AppError extends Error { constructor(message: string, public status = 400, public info: Record<string, unknown> = {}) { super(message); } }

// ---------- what "set up" and "using it fully" mean ----------

/** Tool groups, in workflow order. A group nobody has used yet comes with the prompt that starts it. */
export const TOOL_GROUPS = [
  { id: "start", label: "Get started", tools: ["get_started"], prompt: "Get me started with Octillion." },
  { id: "onboard", label: "Onboard a product", tools: ["onboard_product", "get_onboarding", "save_product", "save_scenarios", "get_product", "list_products"],
    prompt: "Onboard my product: <name>, <website>, <docs link>. It is a <one-line description>." },
  { id: "run", label: "Run simulations", tools: ["run_simulation", "get_simulation", "list_simulations", "cancel_simulation"], prompt: "Run a simulation." },
  { id: "report", label: "Read the visibility report", tools: ["get_visibility_report", "export_visibility_report"], prompt: "Show my visibility report." },
  { id: "evidence", label: "Check the evidence", tools: ["get_agent_session", "get_session_transcript", "search_transcripts"],
    prompt: "Why did agents pick <competitor> on <task>? Show me the transcript." },
  { id: "tune", label: "See who is tested", tools: ["list_agents", "list_developer_profiles", "browse_task_library"],
    prompt: "Which coding agents and developer personas do you test with?" },
  { id: "memory", label: "Build team memory", tools: ["save_to_memory", "search_memory"],
    prompt: "Remember: we lead with <your angle> against <competitor>." },
] as const;

/** Plain-language fixes for errors people hit, matched on the tool's error text. */
const HINTS: [RegExp, string][] = [
  [/budget/i, "The account reached its monthly model budget. Results stay available; an owner or billing manager can change the plan on the Billing tab."],
  [/no active Octillion plan/i, "The account has no active plan. An owner or billing manager can choose one on the Billing tab."],
  [/no (product|products)/i, "Onboard a product first: \"Onboard my product: <name>, <website>, <docs link>.\""],
  [/research failed|403|fetch/i, "Octillion could not read your website or docs. Check that they are public, or paste a short description instead."],
];

/**
 * Each coding agent's share of real-world developer usage (the default developer population, the same mix the agent
 * selector and simulations use), so the connection picker lists agents in the order people actually use them.
 */
async function withUsageShares(c: ReturnType<typeof admin.connectInfo>) {
  const pop = await getPopulation().catch(() => null);
  const share = new Map<string, number>();
  for (const a of pop?.agents ?? []) share.set(a.harness, (share.get(a.harness) ?? 0) + Number(a.weight || 0));
  const clients = c.clients.map((x) => ({ ...x, share: share.has(x.id) ? Math.round((share.get(x.id) ?? 0) * 1000) / 10 : null }));
  const rank = { chat: 0, agent: 1, editor: 2 } as const;
  clients.sort((a, b) => rank[a.group] - rank[b.group] || (b.share ?? -1) - (a.share ?? -1));
  return { ...c, clients };
}

async function setup(s: Session, since?: string) {
  const db = await getDb();
  // Per person (the Clerk user); per account for a session without a user.
  const who = s.user ? "org_id = $1 AND user_id = $2" : "org_id = $1 AND user_id IS NULL";
  const args = s.user ? [s.org, s.user] : [s.org];
  const [m] = await db.query<Record<string, any>>(
    `/* tenant: who = org_id = $1, the session's account */ SELECT min(at) FILTER (WHERE method = 'initialize') AS connected,
            min(at) FILTER (WHERE method = 'tools/list') AS tools_listed,
            min(at) FILTER (WHERE method = 'resources/read' AND name LIKE 'ui://octillion/%') AS dashboard,
            min(at) FILTER (WHERE method = 'tools/call' AND ok) AS first_call,
            count(*) FILTER (WHERE method = 'tools/call') AS calls
       FROM mcp_events WHERE ${who}`, args);
  const clients = await db.query<{ client: string; last: Date }>(
    `/* tenant: who = org_id = $1, the session's account */ SELECT client, max(at) AS last FROM mcp_events WHERE ${who} AND method = 'initialize' AND client IS NOT NULL GROUP BY client ORDER BY max(at) DESC LIMIT 5`, args);
  const used = new Set((await db.query<{ name: string }>(
    `SELECT DISTINCT name FROM mcp_events WHERE org_id = $1 AND method = 'tools/call' AND ok`, [s.org])).map((r) => r.name));
  const errors = await db.query<{ at: Date; name: string | null; error: string | null }>(
    `/* tenant: who = org_id = $1, the session's account */ SELECT at, name, error FROM mcp_events WHERE ${who} AND NOT ok ORDER BY at DESC LIMIT 5`, args);
  const facts = await admin.accountFacts(s.slug);
  const textOnly = clients.length > 0 && clients.every((c) => !/claude-ai|claude\.ai|openai|chatgpt/i.test(c.client));
  const steps = [
    { id: "joined", label: "Join your team's account", done: true, at: null, help: "You accepted the invitation and signed in, so your usage, limits and context belong to your team's account." },
    { id: "connected", label: "Add the Octillion connector to your AI client", done: Boolean(m.connected), at: m.connected,
      help: "Octillion runs inside the AI client you already use. Pick your client under Connection string, follow its one step, then press Test my connection to prove it reaches us." },
    { id: "tools", label: "Switch the Octillion tools on", done: Boolean(m.tools_listed), at: m.tools_listed,
      help: "Your client has to load Octillion's tools before it can use them. In Cursor, switch the Octillion server on in its MCP settings; in other clients, start a new chat." },
    { id: "dashboard", label: "See results as an interactive dashboard", done: Boolean(m.dashboard), at: m.dashboard, optional: true,
      help: textOnly ? "Your client shows results as text. In Claude or ChatGPT, the same answers render as an interactive dashboard with charts and transcripts." : "Ask anything in Claude or ChatGPT and an interactive dashboard, with charts and transcripts, renders under the answer." },
    { id: "first_call", label: "Ask Octillion something", done: Boolean(m.first_call), at: m.first_call, help: "Your first question checks everything works end to end and gives you a guided tour. Type: \"Get me started with Octillion.\"" },
    { id: "onboarded", label: "Onboard your product (team)", done: Boolean(facts.onboarded_at), at: facts.onboarded_at, help: `Octillion researches your product, its packages and competitors, and drafts realistic coding tasks to test. Type: "${TOOL_GROUPS[1].prompt.replace(/^Type:\s*/, "").replace(/^"|"$/g, "")}"` },
    { id: "simulated", label: "Run a simulation (team)", done: Boolean(facts.first_sim_at), at: facts.first_sim_at, help: "Coding agents work your tasks in sandboxes and Octillion records which tools they pick. Type: \"Run a simulation.\" It takes 20 to 60 minutes." },
    { id: "reported", label: "Read the visibility report (team)", done: Boolean(facts.first_report_at), at: facts.first_report_at, help: "The report shows how often agents pick you, where you lose and the transcript evidence for why. Type: \"Show my visibility report.\"" },
  ];
  // Every step has a prompt to paste into the AI client: the one its help names (Type: "…"), or one that checks the step.
  const STEP_PROMPTS: Record<string, string> = {
    connected: "Is Octillion connected? Tell me what it can do.", tools: "Which Octillion tools can you use?", dashboard: "Show my Octillion dashboard.",
  };
  // A viewer can't launch: where the onboarding and simulation prompts would be, a short note instead.
  const viewer = !roles.canAccount(s.accountRole, "launch");
  const VIEWER_NOTE = "Viewers read reports and usage; a Member runs this. Ask an account owner if you need to.";
  const prompted = steps.map((st) => viewer && (st.id === "onboarded" || st.id === "simulated")
    ? { ...st, help: VIEWER_NOTE, prompt: null } : { ...st, prompt: STEP_PROMPTS[st.id] ?? st.help.match(/Type:\s*"(.+?)"/)?.[1] ?? null });
  const groups = TOOL_GROUPS.map((g) => ({ id: g.id, label: g.label, prompt: g.prompt, used: g.tools.filter((t) => used.has(t)).length, total: g.tools.length }));
  let live = null;
  if (since) {
    const [r] = await db.query<{ at: Date; client: string | null }>(
      `/* tenant: who = org_id = $1, the session's account */ SELECT at, client FROM mcp_events WHERE ${who} AND method IN ('initialize', 'tools/list', 'tools/call') AND at > $${args.length + 1} ORDER BY at DESC LIMIT 1`,
      [...args, new Date(since)]);
    live = r ?? null;
  }
  return {
    steps: prompted, done: steps.filter((x) => x.done && !("optional" in x && x.optional)).length, total: steps.filter((x) => !("optional" in x && x.optional)).length,
    clients, calls: Number(m.calls), groups, coverage: groups.filter((g) => g.used > 0).length / groups.length,
    next: groups.find((g) => g.used === 0) ?? null,
    errors: errors.map((e) => ({ ...e, hint: HINTS.find(([re]) => re.test(e.error ?? ""))?.[1] ?? null })),
    connect: await withUsageShares(admin.connectInfo()), live, viewer_note: viewer ? VIEWER_NOTE : null,
  };
}

/**
 * /app Usage for a period, optionally for some people only (?user=id,id): their own tool calls, the runs they launched
 * and those runs' model spend. Without a filter it is the whole team. `people` lists who can be picked: everyone on the
 * team plus anyone who used Octillion in the period.
 */
async function usage(s: Session, q: { from?: unknown; to?: unknown; days?: unknown; user?: unknown; use_case?: unknown }) {
  const range = reportRange(q), days = range.days;
  const list = (v: unknown) => [...new Set(String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean))].slice(0, 200);
  const users = list(q.user), useCases = list(q.use_case);
  const db = await getDb();
  // A use case is its stages' tools: tool calls narrow to those (simulations and spend belong to no single use case).
  const templates = await playbooks.listTemplates({ promotedOnly: true, orgId: s.org });
  const ucTools = useCases.length ? [...new Set(templates.filter((t) => useCases.includes(t.id)).flatMap((t) => t.stages.flatMap((st) => st.tools)))] : null;
  const toolSql = ucTools ? ` AND name = ANY('{${ucTools.map((t) => t.replace(/[^\w]/g, "")).join(",")}}'::text[])` : "";
  const ev = (users.length ? " AND user_id = ANY($4)" : "") + toolSql;
  const sim = users.length ? " AND created_by = ANY($4)" : "";
  const p = users.length ? [s.org, range.start, range.end, users] : [s.org, range.start, range.end];
  const month = "date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";
  const [daily, tools, people, runs, spentBy, byTool, perDay] = await Promise.all([
    db.query<{ day: string; calls: number; errors: number; people: number }>(
      `SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day, count(*) AS calls, count(*) FILTER (WHERE NOT ok) AS errors,
              count(DISTINCT user_id) AS people
         FROM mcp_events WHERE org_id = $1 AND method = 'tools/call' AND at >= $2 AND at < $3${ev} GROUP BY 1 ORDER BY 1`, p),
    db.query<{ name: string; calls: number; errors: number; avg_ms: number }>(
      `SELECT name, count(*) AS calls, count(*) FILTER (WHERE NOT ok) AS errors, round(avg(ms)) AS avg_ms
         FROM mcp_events WHERE org_id = $1 AND method = 'tools/call' AND at >= $2 AND at < $3${ev} GROUP BY name ORDER BY count(*) DESC`, p),
    db.query<{ user_id: string; calls: number }>(
      `SELECT user_id, count(*) FILTER (WHERE method = 'tools/call'${toolSql}) AS calls
         FROM mcp_events WHERE org_id = $1 AND at >= $2 AND at < $3 AND user_id IS NOT NULL GROUP BY user_id`, [s.org, range.start, range.end]),
    db.query<{ simulations: number; sessions: number; completed: number }>(
      `SELECT (SELECT count(*) FROM simulations WHERE org_id = $1 AND created_at >= $2 AND created_at < $3${sim}) AS simulations,
              count(*) AS sessions, count(*) FILTER (WHERE status = 'completed') AS completed
         FROM agent_sessions WHERE org_id = $1 AND queued_at >= $2 AND queued_at < $3
          ${users.length ? "AND simulation_id IN (SELECT id FROM simulations WHERE org_id = $1 AND created_by = ANY($4))" : ""}`, p),
    // This month's spend on the selected people's runs (session cost, or the gateway's live total while it runs).
    users.length ? db.query<{ usd: number }>(
      `SELECT coalesce(sum(GREATEST(s.cost_usd, coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.session_id = s.id), 0))), 0)::float AS usd
         FROM agent_sessions s JOIN simulations r ON r.id = s.simulation_id
        WHERE s.org_id = $1 AND r.created_by = ANY($2) AND s.queued_at >= ${month}`, [s.org, users]) : Promise.resolve(null),
    // Tool calls by tool for the people picked but any use case: each use case's count in the Use cases filter.
    db.query<{ name: string; calls: number }>(
      `SELECT name, count(*) AS calls FROM mcp_events WHERE org_id = $1 AND method = 'tools/call' AND at >= $2 AND at < $3${users.length ? " AND user_id = ANY($4)" : ""} GROUP BY name`, p),
    // The cards' sparklines: simulations and finished agent sessions per day of the period, and model spend per day
    // this month (each with the same people filter as its card).
    db.query<{ k: string; day: string; v: unknown }>(
      `SELECT 'simulations' AS k, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS v
         FROM simulations WHERE org_id = $1 AND created_at >= $2 AND created_at < $3${sim} GROUP BY 2
       UNION ALL
       SELECT 'completed', to_char(queued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), count(*) FILTER (WHERE status = 'completed')
         FROM agent_sessions WHERE org_id = $1 AND queued_at >= $2 AND queued_at < $3
          ${users.length ? "AND simulation_id IN (SELECT id FROM simulations WHERE org_id = $1 AND created_by = ANY($4))" : ""} GROUP BY 2
       UNION ALL
       SELECT 'spend', to_char(s.queued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
              coalesce(sum(GREATEST(s.cost_usd, coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.session_id = s.id), 0))), 0)::float
         FROM agent_sessions s WHERE s.org_id = $1 AND s.queued_at >= ${month}
          ${users.length ? "AND s.simulation_id IN (SELECT id FROM simulations WHERE org_id = $1 AND created_by = ANY($4))" : ""} GROUP BY 2`, p),
  ]);
  const periodDays = dayKeys(range.start, range.end), monthDays = sparkSpans().monthDays;
  const toolCalls = new Map(byTool.map((x) => [x.name, Number(x.calls)]));
  const t = await admin.team(s.slug);
  const callsOf = new Map(people.map((x) => [x.user_id, Number(x.calls)]));
  const known = new Set(t.members.map((m) => m.user_id));
  const [{ budget }, spent] = await Promise.all([orgBudget(s.org).catch(() => ({ budget: 0 })), orgMonthSpendUsd(s.org)]);
  const charts = await usageCharts(s, range, users, p, byTool, budget, t.members);
  return {
    charts,
    days, range: { from: range.from, to: range.to }, daily, tools, runs: runs[0], filters: { user: users, use_case: useCases },
    use_cases: templates.map((t) => ({ id: t.id, name: t.name, own: Boolean((t as { own?: boolean }).own),
      calls: [...new Set(t.stages.flatMap((st) => st.tools))].reduce((n, x) => n + (toolCalls.get(x) ?? 0), 0) })),
    people: [
      ...t.members.map((m) => ({ user_id: m.user_id, email: m.email ?? m.name ?? "Unnamed member", me: m.user_id === s.user, calls: callsOf.get(m.user_id) ?? 0 })),
      ...people.filter((x) => !known.has(x.user_id)).map((x) => ({ user_id: x.user_id, email: "Former member", me: false, calls: Number(x.calls) })),
    ],
    active_people: users.length ? users.filter((u) => callsOf.get(u)).length : people.filter((x) => Number(x.calls)).length,
    spend: { month_usd: spentBy ? Number(spentBy[0]?.usd ?? 0) : spent, budget_usd: budget, filtered: Boolean(spentBy) },
    series: {
      days: periodDays, people: periodDays.map((d) => Number(daily.find((x) => x.day === d)?.people ?? 0)),
      simulations: daySeries(periodDays, perDay, "simulations"), completed: daySeries(periodDays, perDay, "completed"),
      month_days: monthDays, spend: daySeries(monthDays, perDay, "spend", true),
    },
  };
}

/**
 * The Usage page's charts beyond the cards, for the caller's account only (every query is `WHERE org_id = $1`), with the
 * same people filter ($4) and period ($2..$3) as the rest of /usage. Weeks are ISO weeks (Monday, UTC).
 *   workflow       each workflow group (TOOL_GROUPS): how many of its tools were called, of how many, and the calls
 *   clients        tool calls by AI client family; a call counts for its caller's latest handshake before it
 *   sims_weekly    simulations created per week, completed vs the rest
 *   harnesses      agent sessions of those simulations by harness, and how many completed
 *   spend_by       this month's model spend by person (billing roles: Billing manager, Owner) or else by simulation
 *   allowance_usd  the monthly allowance, for billing roles only (null otherwise)
 *   recent         the ten latest simulations in the period with their sessions and hit rate
 */
async function usageCharts(s: Session, range: ReturnType<typeof reportRange>, users: string[], p: unknown[],
  byTool: { name: string; calls: number }[], budget: number, members: { user_id: string; email?: string | null; name?: string | null }[]) {
  const db = await getDb();
  const billingRole = roles.canAccount(s.accountRole, "billing");
  const ev = users.length ? " AND user_id = ANY($4)" : "";
  const simBy = users.length ? " AND sim.created_by = ANY($4)" : "";
  const sesBy = users.length ? " AND s.simulation_id IN (SELECT id FROM simulations WHERE org_id = $1 AND created_by = ANY($4))" : "";
  const wk = (c: string) => `to_char(date_trunc('week', ${c} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
  const month = "date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";
  const cost = "/* tenant: per session, of agent_sessions rows already filtered by org_id */ GREATEST(s.cost_usd, coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.session_id = s.id), 0))";
  const [clients, sims, harnesses, spendBy, recent] = await Promise.all([
    db.query<{ client: string; calls: unknown }>(
      `WITH ev AS (
         SELECT coalesce(user_id, '') AS p, at, method = 'tools/call' AS is_call, CASE WHEN method = 'initialize' THEN split_part(client, ' ', 1) END AS fam
           FROM mcp_events
          WHERE org_id = $1${ev} AND ((method = 'tools/call' AND at >= $2 AND at < $3) OR (method = 'initialize' AND client IS NOT NULL AND at < $3))),
       grouped AS (SELECT *, count(fam) OVER (PARTITION BY p ORDER BY at, is_call ROWS UNBOUNDED PRECEDING) AS g FROM ev),
       tagged AS (SELECT at, is_call, max(fam) OVER (PARTITION BY p, g) AS fam FROM grouped)
       SELECT coalesce(nullif(fam, ''), 'unknown') AS client, count(*) AS calls FROM tagged WHERE is_call AND at >= $2 GROUP BY 1 ORDER BY 2 DESC`, p),
    db.query<{ week: string; completed: unknown; other: unknown }>(
      `SELECT ${wk("created_at")} AS week, count(*) FILTER (WHERE status = 'completed') AS completed, count(*) FILTER (WHERE status <> 'completed') AS other
         FROM simulations sim WHERE org_id = $1 AND created_at >= $2 AND created_at < $3${simBy} GROUP BY 1`, p),
    db.query<{ harness: string; sessions: unknown; completed: unknown }>(
      `SELECT s.harness, count(*) AS sessions, count(*) FILTER (WHERE s.status = 'completed') AS completed
         FROM agent_sessions s WHERE s.org_id = $1 AND s.queued_at >= $2 AND s.queued_at < $3${sesBy} GROUP BY 1 ORDER BY 2 DESC`, p),
    // This month's spend, like the card: by who launched the run (billing roles), else by simulation.
    db.query<{ key: string | null; name: string | null; usd: number }>(
      `SELECT ${billingRole ? "sim.created_by AS key, NULL AS name" : "sim.id AS key, sim.name AS name"}, sum(${cost})::float AS usd
         FROM agent_sessions s JOIN simulations sim ON sim.id = s.simulation_id AND sim.org_id = $1
        WHERE s.org_id = $1 AND s.queued_at >= ${month}${sesBy.replace("$4", "$2")}
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`, users.length ? [s.org, users] : [s.org]),
    db.query<{ id: string; name: string; status: string; created_at: Date; created_by: string | null; product: string; sessions: unknown; scored: unknown; hits: unknown }>(
      `SELECT sim.id, sim.name, sim.status, sim.created_at, sim.created_by, pr.name AS product, count(s.id) AS sessions,
              count(s.id) FILTER (WHERE s.verdict IS NOT NULL) AS scored, count(s.id) FILTER (WHERE s.verdict IS NOT NULL AND ${HIT}) AS hits
         FROM simulations sim JOIN products pr ON pr.id = sim.product_id AND pr.org_id = $1
         LEFT JOIN agent_sessions s ON s.simulation_id = sim.id AND s.org_id = $1 LEFT JOIN ${SCENARIO_ROWS} sc ON sc.id = s.scenario_id
        WHERE sim.org_id = $1 AND sim.created_at >= $2 AND sim.created_at < $3${simBy}
        GROUP BY sim.id, pr.name ORDER BY sim.created_at DESC LIMIT 10`, p),
  ]);
  // Every ISO week the period touches, oldest first.
  const DAY = 86_400_000, mon = (t: number) => { const d = Math.floor(t / DAY) * DAY; return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY; };
  const weeks: string[] = [];
  for (let t = mon(range.start.getTime()); t < range.end.getTime(); t += 7 * DAY) weeks.push(new Date(t).toISOString().slice(0, 10));
  const partial = (w: string) => Date.parse(`${w}T00:00:00Z`) + 7 * DAY > range.end.getTime() || Date.parse(`${w}T00:00:00Z`) < range.start.getTime();
  const simW = new Map(sims.map((r) => [r.week, r]));
  const calls = new Map(byTool.map((x) => [x.name, Number(x.calls)]));
  const who = new Map(members.map((m) => [m.user_id, m.email ?? m.name ?? null]));
  const label = (id: string | null) => (id ? (id === s.user ? "You" : who.get(id) ?? "Former member") : "Connector key");
  return {
    workflow: TOOL_GROUPS.map((g) => ({ id: g.id, label: g.label, total: g.tools.length,
      used: g.tools.filter((x) => calls.get(x)).length, calls: g.tools.reduce((n, x) => n + (calls.get(x) ?? 0), 0) })),
    clients: clients.map((c) => ({ client: c.client, calls: Number(c.calls) })),
    sims_weekly: weeks.map((week) => ({ week, completed: Number(simW.get(week)?.completed ?? 0), other: Number(simW.get(week)?.other ?? 0), partial: partial(week) })),
    harnesses: harnesses.map((h) => ({ harness: h.harness, sessions: Number(h.sessions), completed: Number(h.completed) })),
    spend_by: { kind: billingRole ? ("person" as const) : ("simulation" as const),
      rows: spendBy.map((r) => ({ key: r.key, name: billingRole ? label(r.key) : r.name ?? r.key ?? "", usd: Math.round(Number(r.usd) * 100) / 100 })) },
    allowance_usd: billingRole ? Number(budget) || null : null,
    recent: recent.map((r) => ({ id: r.id, name: r.name, product: r.product, status: r.status, created_at: r.created_at,
      by: label(r.created_by),
      sessions: Number(r.sessions), scored: Number(r.scored), hits: Number(r.hits), hit_pct: Number(r.scored) ? Math.round((Number(r.hits) / Number(r.scored)) * 1000) / 10 : null })),
  };
}

async function billingView(s: Session) {
  const f = await admin.accountFacts(s.slug);
  const { budget, subscription, source } = await orgBudget(s.org).catch(() => ({ budget: 0, subscription: null, source: "default" as const }));
  // Plans are invite-only: only an account an admin has allowed sees them (and may check out).
  return {
    enabled: billing.stripeEnabled(), customer: Boolean(f.stripe_customer_id), subscription, budget_usd: budget, budget_source: source,
    prepaid_allowed: Boolean(f.prepaid_allowed), month_spend_usd: await orgMonthSpendUsd(s.org),
    // Plans are invite-only; in a pricing experiment the account sees only its own variant (src/experiments.ts).
    plans: billing.stripeEnabled() && f.prepaid_allowed ? (await experiments.offeredPlans(s.org, await billing.listPlans()).catch(() => [] as billing.Plan[])).map((p) => ({ price_id: p.price_id, name: p.name, amount: p.amount, currency: p.currency, interval: p.interval, monthly_budget_usd: p.monthly_budget_usd, trial_days: p.trial_days, description: p.description,
      usage: p.usage.map((u) => ({ metric: u.metric, summary: u.summary })) })) : [],
  };
}

/**
 * Usage-based billing for this month (UTC): live model spend (gateway, includes running sessions), what has been
 * metered to Stripe (finished sessions; src/billing.ts reportSessionSpend), daily spend, a straight-line projection,
 * and who and which agents spent it.
 */
async function billingUsage(s: Session) {
  const db = await getDb();
  const month = "date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";
  // A session's cost: what it recorded when it finished, or the gateway's live total while it runs (whichever is larger).
  const sc = `sc AS (SELECT s.*, GREATEST(s.cost_usd, coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.session_id = s.id), 0))::float AS usd
                FROM agent_sessions s WHERE s.org_id = $1 AND s.queued_at >= ${month})`;
  const daily = await db.query<{ day: string; usd: number; sessions: number }>(
    `WITH ${sc} SELECT to_char(date_trunc('day', queued_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, sum(usd)::float AS usd, count(*)::int AS sessions
       FROM sc GROUP BY 1 ORDER BY 1`, [s.org]);
  const [m] = await db.query<{ metered: number; finished: number; running: number }>(
    `SELECT coalesce(sum(cost_usd) FILTER (WHERE status IN ('completed', 'failed', 'timeout', 'cancelled')), 0)::float AS metered,
            count(*) FILTER (WHERE status IN ('completed', 'failed', 'timeout', 'cancelled'))::int AS finished,
            count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS running
       FROM agent_sessions WHERE org_id = $1 AND queued_at >= ${month}`, [s.org]);
  const byAgent = await db.query<{ agent: string; usd: number; sessions: number }>(
    `WITH ${sc} SELECT coalesce(agent_id, harness || '/' || model) AS agent, sum(usd)::float AS usd, count(*)::int AS sessions
       FROM sc GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, [s.org]);
  const byPerson = await db.query<{ user_id: string | null; usd: number; runs: number }>(
    `/* tenant: sc is this account's sessions (org_id = $1) */ WITH ${sc} SELECT r.created_by AS user_id, sum(sc.usd)::float AS usd, count(DISTINCT r.id)::int AS runs
       FROM sc JOIN simulations r ON r.id = sc.simulation_id GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, [s.org]);
  const all = roles.canAccount(s.accountRole, "billing");
  const people = all ? (await admin.team(s.slug)).members : [];
  const now = new Date(), start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const spent = daily.reduce((a, d) => a + Number(d.usd), 0);
  const elapsed = Math.max(1 / 24, (now.getTime() - start) / 86_400_000), days = (end - start) / 86_400_000;
  // Project from the current rate (the last 7 days of this month), not the whole-month average: the same rule as
  // Budget rules (src/limits.ts pace).
  const since = Math.max(start, now.getTime() - 7 * 86_400_000);
  const recent = { usd: daily.filter((d) => Date.parse(`${d.day}T00:00:00Z`) + 86_400_000 > since).reduce((a, d) => a + Number(d.usd), 0), days: (now.getTime() - since) / 86_400_000 };
  const { budget } = await orgBudget(s.org).catch(() => ({ budget: 0 }));
  return {
    period: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), days, elapsed_days: elapsed },
    spent_usd: spent, budget_usd: budget, projected_usd: limits.pace(spent, now, recent).projected_usd ?? spent,
    metered_usd: Number(m?.metered ?? 0), in_flight_usd: Math.max(0, spent - Number(m?.metered ?? 0)),
    sessions: { finished: m?.finished ?? 0, running: m?.running ?? 0 },
    meter: { enabled: Boolean(process.env.STRIPE_SPEND_METER && billing.stripeEnabled()), event: process.env.STRIPE_SPEND_METER ?? null },
    daily, by_agent: byAgent,
    // Members see only their own line; owners and billing managers see everyone, by email.
    by_person: byPerson.filter((p) => all || p.user_id === s.user).map((p) => {
      const who = people.find((x) => x.user_id === p.user_id);
      return { ...p, label: p.user_id == null ? "Connector key" : p.user_id === s.user ? "You" : who?.email ?? who?.name ?? "Former member" };
    }),
  };
}

// ---------- routes ----------

export function appRouter() {
  const r = express.Router();

  // The API behind the portal pages. Sign-in and sign-out happen in the UI, with Clerk.
  const api = express.Router();
  // Small bodies everywhere except imports (memory, use cases, personas, tasks), which parse their own.
  const small = express.json({ limit: "16kb" });
  api.use((req, res, next) => (req.path === "/context/memories/import" || req.path === "/journeys/import" || (req.method === "POST" && (req.path === "/personas" || req.path === "/tasks")) ? next() : small(req, res, next)));
  api.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  api.use(async (req, res, next) => {
    if (!clerk.clerkEnabled()) return void res.status(503).json({ error: "Sign-in is not configured (CLERK_SECRET_KEY)" });
    const c = await clerkSession(req);
    if (!c) return void res.status(401).json({ error: "Sign in", sign_in_url: "/sign-in" });
    const ms = (await clerk.memberships.forUser(c.userId)).filter((m) => m.organization).sort((a, b) => a.created_at - b.created_at);
    // The session's active organization; without one, the person's oldest membership that is not suspended.
    const m = c.orgId ? ms.find((x) => x.organization!.id === c.orgId) : ms.find((x) => !clerk.isSuspended(x));
    if (!m) return void res.status(403).json({ error: "You are not in an Octillion account yet. Ask your admin to invite you.", code: "no_account" });
    if (clerk.isSuspended(m)) return void res.status(403).json({ error: "Your access to this account was suspended. Ask your account admin.", code: "suspended" });
    const org = await orgForClerk(m.organization!.id);
    if (!org) return void res.status(403).json({ error: "This organization is not an Octillion account. Octillion is invite-only for now: ask your Octillion contact for an invitation.", code: "no_account" });
    const user = await clerk.users.get(c.userId);
    const s: Session = { org: org.orgId, slug: org.slug, user: c.userId, email: clerk.primaryEmail(user).email, role: clerk.roleOf(m.role),
      accountRole: roles.accountRoleOf(m), clerkOrgId: m.organization!.id };
    if (!identified.has(c.userId)) {
      identified.add(c.userId);
      identifyPerson(c.userId, { email: s.email ?? undefined, name: clerk.displayName(user) ?? undefined, account: org.slug, account_name: org.name, role: s.accountRole });
      capture({ distinctId: c.userId, orgSlug: org.slug }, "app_signed_in", { method: "clerk" });
    }
    res.locals.session = s;
    res.locals.memberships = ms;
    next();
  });
  const S = (res: Response) => res.locals.session as Session;
  /** Refuse unless the person's role has the permission: 403 in plain words, with a code and the role it needs. */
  const need = (res: Response, p: roles.AccountPermission) => {
    if (roles.canAccount(S(res).accountRole, p)) return;
    const r = roles.accountRefusal(p);
    throw new AppError(r.message, 403, { code: r.code, needs: r.needs });
  };
  const can = (res: Response, p: roles.AccountPermission) => roles.canAccount(S(res).accountRole, p);
  const perms = (res: Response) => roles.accountPermissionsOf(S(res).accountRole);
  const actor = (res: Response) => `customer:${S(res).email ?? S(res).slug}`;

  api.get("/me", async (_req, res) => {
    const s = S(res);
    const f = await admin.accountFacts(s.slug);
    const ms = res.locals.memberships as clerk.ClerkMembership[];
    res.json({ email: s.email, user_id: s.user, role: s.role, org_role: `org:${s.role}`, account: { name: f.name, slug: f.slug, clerk_org_id: s.clerkOrgId },
               account_role: s.accountRole, role_label: roles.ACCOUNT_ROLE_LABELS[s.accountRole], permissions: perms(res), needs: roles.ACCOUNT_PERMISSIONS,
               roles: [...roles.ACCOUNT_ROLES].reverse().map((r) => ({ id: r, label: roles.ACCOUNT_ROLE_LABELS[r], help: roles.ACCOUNT_ROLE_HELP[r] })),
               via: "clerk", organizations: ms.map((m) => ({ clerk_org_id: m.organization!.id, name: m.organization!.name, role: clerk.roleOf(m.role),
                 account_role: roles.accountRoleOf(m), suspended: clerk.isSuspended(m) })),
               integrations: { clerk: true, stripe: billing.stripeEnabled() } });
  });
  api.get("/setup", async (req, res) => void res.json(await setup(S(res), typeof req.query.since === "string" ? req.query.since : undefined)));
  // Forget an AI client in your own list (a test script, an old machine): its connections stop counting as a client.
  // Only a signed-in person, and only their own events: a caller with no person would reach every keyless event of the
  // account. Logged, since the client name on those events is gone for good.
  api.delete("/clients/:client", async (req, res) => {
    const s = S(res);
    if (!s.user) throw new AppError("Sign in as a person to remove a client from your list", 403);
    const client = String(req.params.client);
    const r = await (await getDb()).query(
      "UPDATE mcp_events SET client = NULL WHERE org_id = $1 AND user_id = $3 AND client = $2 RETURNING id", [s.org, client, s.user]);
    admin.log(actor(res), "client.remove", s.slug, { client, user_id: s.user, removed: r.length });
    res.json({ removed: r.length });
  });
  api.post("/setup/test", async (_req, res) => {
    capture({ distinctId: S(res).user ?? `org:${S(res).slug}`, orgSlug: S(res).slug }, "app_connection_test_started");
    res.json({ since: new Date().toISOString() });
  });
  // Journeys on Setup: use-case pipelines with real progress (src/playbooks.ts).
  api.get("/journeys", async (_req, res) => {
    await syncProgress({ orgId: S(res).org, slug: S(res).slug }, S(res).user ?? undefined).catch((e) => console.error("journey sync:", e.message));
    res.json({ journeys: await playbooksFor(S(res).org) });
  });
  // The account's own use cases (Add use case on /app/adoption): anyone adds; whoever added it or an admin removes.
  api.post("/journeys", async (req, res) => {
    need(res, "edit");
    const id = await playbooks.createUseCase({ orgId: S(res).org, slug: S(res).slug }, actor(res), req.body ?? {}, TOOL_NAMES);
    capture({ distinctId: S(res).user ?? `org:${S(res).slug}`, orgSlug: S(res).slug }, "use_case_added", { journey: id });
    res.status(201).json({ id });
  });
  api.delete("/journeys/:id", async (req, res) => {
    need(res, "edit");
    await playbooks.deleteUseCase(S(res).org, String(req.params.id), actor(res), can(res, "manage"));
    res.status(204).end();
  });
  // Import use cases from a file: up to 100, names the account already has are skipped.
  api.post("/journeys/import", express.json({ limit: "1mb" }), async (req, res) => {
    need(res, "edit");
    const r = await playbooks.importUseCases({ orgId: S(res).org, slug: S(res).slug }, actor(res), req.body?.items, TOOL_NAMES);
    capture({ distinctId: S(res).user ?? `org:${S(res).slug}`, orgSlug: S(res).slug }, "use_cases_imported", { imported: r.imported, skipped: r.skipped });
    res.json(r);
  });
  // Adoption person by person: who uses each use case, how far they got, where they are stuck, who can help, and the
  // open help requests. from/to (YYYY-MM-DD) pick who was active; user=a,b narrows to those people.
  api.get("/adoption", async (req, res) => {
    const s = S(res);
    const range = req.query.from || req.query.to ? reportRange(req.query) : null;
    const users = String(req.query.user ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 200);
    const [rows, t, help, calls] = await Promise.all([playbooks.adoptionByPerson(s.org, { start: range?.start, end: range?.end, users }), admin.team(s.slug), playbooks.helpRequests(s.org),
      // Who used each workflow part: tool calls by person (null = a connector key, not a signed-in person).
      (await getDb()).query<{ user_id: string | null; name: string; calls: number; last: Date }>(
        `SELECT user_id, name, count(*)::int AS calls, max(at) AS last FROM mcp_events
          WHERE org_id = $1 AND method = 'tools/call' AND name IS NOT NULL AND ($2::timestamptz IS NULL OR at >= $2) AND ($3::timestamptz IS NULL OR at < $3)
          GROUP BY user_id, name`, [s.org, range?.start ?? null, range?.end ?? null])]);
    const who = new Map(t.members.map((m) => [m.user_id, m.email ?? m.name ?? null]));
    const label = (id: string | null) => (id ? (id === s.user ? "You" : who.get(id) ?? "Former member") : null);
    res.json({ me: s.user, use_cases: rows.map((r) => ({ ...r, helper_label: label(r.helper), helper_email: r.helper ? who.get(r.helper) ?? null : null,
      people: r.people.map((x) => ({ ...x, label: label(x.user_id), email: who.get(x.user_id) ?? null })) })),
      help: help.map((h) => ({ ...h, requester_label: label(h.requester), requester_email: who.get(h.requester) ?? null,
        helper_label: label(h.helper), helper_email: h.helper ? who.get(h.helper) ?? null : null })),
      members: t.members.filter((m) => m.user_id).map((m) => ({ user_id: m.user_id, label: label(m.user_id),
        calls: calls.reduce((n, c) => n + (c.user_id === m.user_id ? Number(c.calls) : 0), 0) })),
      workflow: TOOL_GROUPS.map((g) => {
        const byUser = new Map<string | null, { used: Set<string>; calls: number; last: Date | null }>();
        for (const c of calls) {
          if (!(g.tools as readonly string[]).includes(c.name) || (users.length && (!c.user_id || !users.includes(c.user_id)))) continue;
          const u = byUser.get(c.user_id) ?? { used: new Set<string>(), calls: 0, last: null };
          u.used.add(c.name); u.calls += Number(c.calls); u.last = !u.last || c.last > u.last ? c.last : u.last;
          byUser.set(c.user_id, u);
        }
        return { id: g.id, people: [...byUser].map(([id, u]) => ({ user_id: id, label: id ? label(id) : "Connector key", email: id ? who.get(id) ?? null : null,
          used: u.used.size, total: g.tools.length, calls: u.calls, last: u.last })).sort((a, b) => b.used - a.used || b.calls - a.calls) };
      }) });
  });
  // Help requests: ask the team, pick one up, close it (asker or helper), hand it back (helper) or withdraw it (asker).
  api.post("/adoption/help", async (req, res) => {
    need(res, "edit");
    const s = S(res);
    if (!s.user) throw new AppError("Sign in as a person to ask for help");
    const id = await playbooks.askForHelp(s.org, String(req.body?.journey_id ?? ""), s.user, req.body?.note);
    capture({ distinctId: s.user, orgSlug: s.slug }, "help_requested", { journey: String(req.body?.journey_id ?? "") });
    res.status(201).json({ id });
  });
  api.post("/adoption/help/:id/:action", async (req, res) => {
    const s = S(res), id = Number(req.params.id), action = String(req.params.action);
    if (!s.user) throw new AppError("Sign in as a person to help");
    need(res, "edit");
    if (action === "pick") await playbooks.pickUpHelp(s.org, id, s.user);
    else if (action === "done" || action === "release" || action === "cancel") await playbooks.updateHelp(s.org, id, s.user, action);
    else throw new AppError("action must be pick, done, release or cancel", 404);
    capture({ distinctId: s.user, orgSlug: s.slug }, `help_${action === "pick" ? "picked_up" : action}`, { request: id });
    res.status(204).end();
  });
  api.post("/journeys/:id/view", async (req, res) => {
    capture({ distinctId: S(res).user ?? `org:${S(res).slug}`, orgSlug: S(res).slug }, "journey_viewed", { journey: String(req.params.id) });
    res.status(204).end();
  });
  // Stages with no tool (shipping a docs change) are marked by the person; recorded for everyone in the account.
  api.post("/journeys/:id/stages/:stage", async (req, res) => {
    need(res, "edit");
    await markStage({ orgId: S(res).org, slug: S(res).slug }, S(res).user, String(req.params.id), String(req.params.stage), req.body?.done !== false);
    res.status(204).end();
  });
  api.get("/usage", async (req, res) => void res.json(await usage(S(res), req.query)));
  // Pick rate (/app/pick-rate): its charts, filters, saved reports and exports (src/visibility.ts).
  visibilityRoutes(api, { S, need, fail: (m, status, info) => new AppError(m, status, info), accountName: async (slug) => (await admin.accountFacts(slug)).name });
  api.get("/team", async (_req, res) => void res.json({ ...(await admin.team(S(res).slug, true)), me: S(res).user, can_manage: can(res, "team"), permissions: perms(res) }));
  api.post("/team/invitations", async (req, res) => {
    need(res, "team");
    const r = await admin.invite(actor(res), S(res).slug, req.body?.email, req.body?.role ?? "member");
    res.status(201).json({ invitation: r.invitation, key: r.key, connector_url: r.connector_url });
  });
  api.post("/team/invitations/:id/resend", async (req, res) => { need(res, "team"); await admin.resendInvitation(actor(res), S(res).slug, String(req.params.id)); res.status(204).end(); });
  api.post("/team/invitations/:id/revoke", async (req, res) => { need(res, "team"); await admin.revokeInvitation(actor(res), S(res).slug, String(req.params.id)); res.status(204).end(); });
  for (const [verb, on] of [["deactivate", false], ["reactivate", true]] as const)
    api.post(`/team/members/:id/${verb}`, async (req, res) => {
      need(res, "team");
      const t = await admin.team(S(res).slug, true);
      if (t.members.find((m) => m.id === req.params.id)?.user_id === S(res).user) throw new AppError("You cannot remove yourself");
      await admin.setMemberActive(actor(res), S(res).slug, String(req.params.id), on);
      res.status(204).end();
    });
  api.post("/team/members/:id/role", async (req, res) => {
    need(res, "team");
    if (String(req.params.id) === S(res).user) throw new AppError("Ask another owner to change your own role");
    await admin.setMemberRole(actor(res), S(res).slug, String(req.params.id), req.body?.role);
    res.status(204).end();
  });
  // Usage limits (src/limits.ts): owners and billing managers split the budget across teams and people, roll out
  // running, cap throughput. Everyone sees their own allowance; only they see and change everyone's.
  api.get("/limits", async (_req, res) => {
    const s = S(res), org = { orgId: s.org, slug: s.slug };
    if (can(res, "budget")) {
      // `version` goes back as If-Match on PUT /limits/plan, so a save can't overwrite someone else's change unseen. It is
      // in the body, not an ETag: spend changes under the same version, and a 304 would show stale figures.
      // `changed`: who last changed each rule and when (Budget rules' Set by and Last changed), from the history.
      const [o, changed] = await Promise.all([limits.page(org), limits.ruleChanges(org)]);
      return void res.json({ ...o, changed, can_manage: true, me: s.user, permissions: perms(res) });
    }
    // A member: their own row and team, and "Your budget" (what is left, the budget they draw on, the rules in plain words).
    res.json({ ...(await limits.memberPage(org, s.user)), permissions: perms(res) });
  });
  // Every change below also appends a plain-sentence entry to the account's history (GET /limits/history).
  const limitsAdmin = (res: Response) => need(res, "budget");
  const by = (res: Response): limits.Actor => ({ label: actor(res), user: S(res).user });
  api.get("/limits/history", async (req, res) => {
    limitsAdmin(res);
    const before = req.query.before == null || req.query.before === "" ? undefined : Number(req.query.before);
    if (before !== undefined && !(Number.isInteger(before) && before > 0)) throw new AppError("before must be the id of a history entry");
    res.json(await limits.history({ orgId: S(res).org, slug: S(res).slug }, before));
  });
  // The whole tab at once: preview a draft (no writes), then save it as one plan (one transaction, one history entry).
  api.post("/limits/preview", async (req, res) => { limitsAdmin(res); res.json(await limits.preview({ orgId: S(res).org, slug: S(res).slug }, req.body ?? {})); });
  api.put("/limits/plan", async (req, res) => {
    limitsAdmin(res);
    const version = await limits.plan({ orgId: S(res).org, slug: S(res).slug }, by(res), req.body ?? {}, req.get("if-match"));
    res.setHeader("ETag", `"${version}"`);
    res.status(204).end();
  });
  api.put("/limits/policy", async (req, res) => { limitsAdmin(res); await limits.setPolicy(S(res).org, by(res), req.body ?? {}); res.status(204).end(); });
  api.post("/limits/teams", async (req, res) => { limitsAdmin(res); res.status(201).json(await limits.saveTeam(S(res).org, by(res), { ...req.body, id: undefined })); });
  api.put("/limits/teams/:id", async (req, res) => { limitsAdmin(res); res.json(await limits.saveTeam(S(res).org, by(res), { ...req.body, id: Number(req.params.id) })); });
  api.delete("/limits/teams/:id", async (req, res) => { limitsAdmin(res); await limits.deleteTeam(S(res).org, by(res), Number(req.params.id)); res.status(204).end(); });
  api.put("/limits/members/:userId", async (req, res) => {
    limitsAdmin(res);
    await limits.setMember({ orgId: S(res).org, slug: S(res).slug }, by(res), String(req.params.userId), req.body ?? {});
    res.status(204).end();
  });

  // Context (src/context.ts): the company's (owners edit), the person's own, and product profiles (owners edit).
  // Product reads and writes raise plain errors for user mistakes (an unknown product, a bad field): show them as 400s.
  const q = <T>(p: Promise<T>) => p.catch((e: Error) => { throw new AppError(e.message, /no product|not found|unknown/i.test(e.message) ? 404 : 400); });
  const orgOf = async (res: Response) => ({ orgId: S(res).org, slug: S(res).slug, name: (await admin.accountFacts(S(res).slug)).name, userId: S(res).user ?? undefined, role: S(res).accountRole });
  api.get("/context", async (_req, res) => {
    const s = S(res), org = await orgOf(res);
    res.json({ company: await context.getCompany(s.org), person: s.user ? await context.getPerson(s.org, s.user) : null,
               products: ((await listProducts(org)) as any).products.map((p: any) => ({ slug: p.slug, name: p.name })), styles: context.ANSWER_STYLES,
               can_manage: can(res, "manage"), permissions: perms(res), preview: await context.contextForAI(org) });
  });
  api.put("/context/company", async (req, res) => { need(res, "manage"); res.json(await context.saveCompany(S(res).org, actor(res), req.body ?? {})); });
  api.put("/context/me", async (req, res) => {
    need(res, "edit");
    res.json(await context.savePerson(S(res).org, S(res).user!, req.body ?? {}));
  });
  // Memory: anyone who may edit adds company and product memory and their own; owners add to anyone's and delete any
  // item, everyone else deletes what they added. Viewers only read.
  const memorySubject = async (res: Response, scope: string, subject: unknown) => {
    const s = S(res);
    if (scope !== "user") return String(subject ?? "");
    const id = String(subject || s.user || "");
    if (!id) throw new AppError("Sign in as a person to keep personal memory");
    if (id !== s.user) {
      need(res, "manage");
      if (!(await admin.team(s.slug)).members.some((m) => m.user_id === id)) throw new AppError("Not a member of this account", 404);
    }
    return id;
  };
  api.get("/context/memories", async (req, res) => {
    const scope = String(req.query.scope ?? "") as context.MemoryScope;
    if (!context.MEMORY_SCOPES.includes(scope)) throw new AppError("scope must be company, user or product");
    const me = actor(res), admin_ = can(res, "manage"), edit = can(res, "edit");
    const memories = await context.listMemories(S(res).org, scope, scope === "product" && !req.query.subject ? "" : await memorySubject(res, scope, req.query.subject));
    // Items saved from chat (save_to_memory) are by "ai:<user id>": shown as the AI client, editable by that person.
    const mineAi = `ai:${S(res).user ?? ""}`;
    res.json({ memories: memories.map((m) => ({ ...m, created_by: m.created_by?.startsWith("ai:") ? "AI client" : m.created_by?.replace(/^customer:/, "") ?? null,
      can_delete: admin_ || (edit && (m.created_by === me || (!!S(res).user && m.created_by === mineAi))) })), kinds: context.MEMORY_KINDS, permissions: perms(res) });
  });
  api.post("/context/memories", async (req, res) => {
    need(res, "edit");
    const scope = String(req.body?.scope ?? "");
    res.status(201).json(await context.addMemory(S(res).org, actor(res), req.body ?? {}, await memorySubject(res, scope, req.body?.subject)));
  });
  api.post("/context/memories/import", express.json({ limit: "2mb" }), async (req, res) => {
    need(res, "edit");
    const scope = String(req.body?.scope ?? "") as context.MemoryScope;
    if (!context.MEMORY_SCOPES.includes(scope)) throw new AppError("scope must be company, user or product");
    res.json(await context.importMemories(S(res).org, actor(res), scope, await memorySubject(res, scope, req.body?.subject), req.body?.items));
  });
  api.put("/context/memories/:id", async (req, res) => {
    const m = await context.getMemory(S(res).org, Number(req.params.id));
    if (!m) throw new AppError("Not found", 404);
    need(res, "edit");
    if (m.created_by !== actor(res) && !(S(res).user && m.created_by === `ai:${S(res).user}`)) need(res, "manage");
    res.json(await context.updateMemory(S(res).org, m.id, req.body ?? {}));
  });
  api.delete("/context/memories/:id", async (req, res) => {
    const m = await context.getMemory(S(res).org, Number(req.params.id));
    if (!m) throw new AppError("Not found", 404);
    need(res, "edit");
    if (m.created_by !== actor(res) && !(S(res).user && m.created_by === `ai:${S(res).user}`)) need(res, "manage");
    await context.deleteMemory(S(res).org, m.id);
    res.status(204).end();
  });
  // Users: owners see and edit everyone's context; everyone else only their own.
  api.get("/context/users", async (_req, res) => {
    const s = S(res);
    const t = await admin.team(s.slug);
    const members = t.members.filter((m) => can(res, "manage") || m.user_id === s.user)
      .map((m) => ({ user_id: m.user_id, email: m.email, name: m.name, role: m.role, account_role: m.account_role, active: m.status === "active" }));
    if (s.user && !members.some((m) => m.user_id === s.user)) members.unshift({ user_id: s.user, email: null, name: null, role: s.role, account_role: s.accountRole, active: true });
    const [ctx, counts] = await Promise.all([context.getPeople(s.org, members.map((m) => m.user_id)), context.memoryCounts(s.org, "user")]);
    res.json({ users: members.map((m) => ({ ...m, me: m.user_id === s.user, context: ctx[m.user_id], memories: counts[m.user_id] ?? 0 })), can_manage: can(res, "manage"), permissions: perms(res) });
  });
  api.put("/context/users/:userId", async (req, res) => {
    const s = S(res), id = String(req.params.userId);
    need(res, "edit");
    if (id !== s.user) {
      need(res, "manage");
      if (!(await admin.team(s.slug)).members.some((m) => m.user_id === id)) throw new AppError("Not a member of this account", 404);
    }
    res.json(await context.savePerson(s.org, id, req.body ?? {}));
  });
  // Portal reads and writes of a product pass PORTAL: tasks onboarding picked from Octillion's library show by title only
  // (the MCP tools return them whole). Every /api/app route that returns a product, persona list or task does the same.
  api.get("/context/products/:slug", async (req, res) => void res.json(await q(getProduct(await orgOf(res), String(req.params.slug), PORTAL))));
  api.post("/context/products", async (req, res) => {
    need(res, "manage");
    const name = String(req.body?.name ?? "").trim();
    if (!name) throw new AppError("A product needs a name");
    res.status(201).json(await q(saveProduct(await orgOf(res), { name, description: req.body?.description || undefined, website_url: req.body?.website_url || undefined, docs_url: req.body?.docs_url || undefined }, PORTAL)));
  });
  api.put("/context/products/:slug", async (req, res) => {
    need(res, "manage");
    const b = req.body ?? {}, org = await orgOf(res);
    await q(getProduct(org, String(req.params.slug), PORTAL)); // an unknown slug is a 404 here, not a new product
    res.json(await q(saveProduct(org, { product: String(req.params.slug), name: b.name, description: b.description, category: b.category,
      website_url: b.website_url, docs_url: b.docs_url, aliases: b.aliases, packages: b.packages, domains: b.domains, competitors: b.competitors }, PORTAL)));
  });
  api.put("/context/products/:slug/scenarios/:id", async (req, res) => {
    need(res, "manage");
    await q(saveScenarios(await orgOf(res), String(req.params.slug), [{ id: Number(req.params.id), active: Boolean(req.body?.active) } as any]));
    res.status(204).end();
  });

  // ---------- Developer personas and Programming tasks: the account's own (src/private.ts) ----------
  // The same functions and input checks as the MCP tools save_personas, import_tasks and save_scenarios; each write
  // is recorded as that tool's page action, so journey stages complete from the page as from the AI client.
  // Like q(), but a database error (SQLSTATE) gets a generic message, as on the connector: its text can echo other rows.
  const qp = <T>(p: Promise<T>) => p.catch((e: Error & { code?: unknown }) => {
    if (e instanceof AppError) throw e;
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) throw new AppError(`The request could not be completed (database error ${e.code}). Check the values and try again.`);
    throw new AppError(e.message, /^No (persona|task|product|open submission)s? |not found|unknown/i.test(e.message) ? 404 : 400);
  });
  const checked = <T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: any } }, v: unknown, root: string): T => {
    const r = schema.safeParse(v);
    if (!r.success) throw new AppError(priv.inputIssues(r.error, root));
    return r.data;
  };
  api.get("/personas", async (_req, res) => {
    const org = await orgOf(res);
    // Only the account's own (the portal never lists Octillion's shared personas; onboarding's picked copies by name).
    const own = await qp(priv.listPersonas(org, [], PORTAL));
    await recordPageAction(org, "list_personas", { every: 3_600_000 });
    res.json({ personas: own.personas, permissions: perms(res), publish: { credit_usd: (await contributions.discountUsd()).persona } });
  });
  // New persona, edits by slug and Import: the save_personas shape ({ personas: [...] }, 1-20 at a time).
  api.post("/personas", express.json({ limit: "256kb" }), async (req, res) => {
    need(res, "edit");
    const org = await orgOf(res);
    const r = await qp(priv.savePersonas(org, checked(priv.personasInputSchema, req.body?.personas, "personas") as priv.PersonaInput[], PORTAL));
    await recordPageAction(org, "save_personas");
    res.status(201).json(r);
  });
  api.patch("/personas/:slug", async (req, res) => {
    need(res, "edit");
    const org = await orgOf(res), slug = String(req.params.slug), b = req.body ?? {};
    const keys = Object.keys(b);
    const r = keys.length === 1 && keys[0] === "active"
      ? await qp(priv.setPersonaActive(org, slug, Boolean(b.active), PORTAL))
      : await qp(priv.savePersonas(org, [checked(priv.personaInputSchema, { ...b, slug }, "persona") as priv.PersonaInput], PORTAL));
    await recordPageAction(org, "save_personas");
    res.json(r);
  });
  api.delete("/personas/:slug", async (req, res) => {
    need(res, "manage");
    await qp(priv.deletePersona(await orgOf(res), String(req.params.slug)));
    res.status(204).end();
  });

  api.get("/tasks", async (_req, res) => {
    const org = await orgOf(res);
    const [sets, detail, products] = await Promise.all([qp(priv.listTaskSets(org)), priv.taskSetDetails(org), listProducts(org)]);
    await recordPageAction(org, "list_task_sets", { every: 3_600_000 });
    res.json({ task_sets: sets.task_sets, tasks: detail.tasks, runs: detail.runs,
      products: ((products as any).products as any[]).map((p) => ({ slug: p.slug, name: p.name })), permissions: perms(res),
      publish: { credit_usd: (await contributions.discountUsd()).task } });
  });
  // Create a task set, add tasks to one (same name) and Import: the import_tasks shape.
  api.post("/tasks", express.json({ limit: "1mb" }), async (req, res) => {
    need(res, "edit");
    const org = await orgOf(res), b = req.body ?? {};
    const input = checked(z.object(priv.importTasksInputShape), { task_set: b.task_set, description: b.description || undefined, tasks: b.tasks }, "");
    const r = await qp(priv.importTasks(org, { product: b.product ? String(b.product) : undefined, ...input } as Parameters<typeof priv.importTasks>[1]));
    await recordPageAction(org, "import_tasks");
    res.status(201).json(r);
  });
  // An edit may clear the repo (null) or set the platform back to automatic ("").
  const taskPatch = priv.taskInputSchema.partial().extend({ repo_url: z.string().nullable().optional(), platform: z.union([priv.taskInputSchema.shape.platform.unwrap(), z.literal("")]).optional(), active: z.boolean().optional() });
  api.patch("/tasks/:id", async (req, res) => {
    need(res, "edit");
    const org = await orgOf(res), id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new AppError("No such task", 404);
    const r = await qp(priv.updateTask(org, id, checked(taskPatch, req.body ?? {}, "task") as Parameters<typeof priv.updateTask>[2]));
    await recordPageAction(org, r.set ? "import_tasks" : "save_scenarios");
    res.json(r);
  });
  // No library routes in the portal: it never browses or picks from Octillion's task library (the AI client can, over MCP:
  // browse_task_library and save_scenarios {library_task_id}).

  // Publish to Octillion's library (src/contributions.ts): the account's own personas and tasks only, Member or above.
  // Octillion reviews each request; an accepted one earns a credit on the next invoice. Withdraw while it waits.
  api.post("/personas/:slug/publish", async (req, res) => {
    need(res, "edit");
    res.status(201).json(await qp(contributions.publish(await orgOf(res), actor(res), "persona", String(req.params.slug))));
  });
  api.post("/tasks/:id/publish", async (req, res) => {
    need(res, "edit");
    res.status(201).json(await qp(contributions.publish(await orgOf(res), actor(res), "task", String(req.params.id))));
  });
  api.post("/submissions/:id/withdraw", async (req, res) => {
    need(res, "edit");
    res.json(await qp(contributions.withdraw(await orgOf(res), String(req.params.id))));
  });

  // Journey tips (src/journeys.ts): everything waiting for this person, dismiss one, or turn tips off.
  api.get("/nudges", async (_req, res) => void res.json(await journeys.nudgesForApp(S(res).org, S(res).user)));
  api.post("/nudges/:id/dismiss", async (req, res) => { await journeys.dismiss(S(res).org, S(res).slug, S(res).user, Number(req.params.id)); res.status(204).end(); });
  api.post("/nudges/mute", async (req, res) => { await journeys.setMuted(S(res).org, S(res).slug, S(res).user, req.body?.muted !== false); res.status(204).end(); });
  // "Ask AI" in the Cmd+K bar (src/docs-answers.ts): any signed-in person; the customer guide only, never the internal docs.
  api.post("/docs/answer", async (req, res) => {
    const s = S(res);
    const r = await answerDocs("customer", req.body?.question, { userKey: s.user ?? `org:${s.slug}`, orgId: s.org });
    capture({ distinctId: s.user ?? `org:${s.slug}`, orgSlug: s.slug }, "docs_answer_asked", { answered: r.answer != null, reason: r.reason, sources: r.sources.length });
    res.json(r);
  });
  // The same, streamed as server-sent events (sources, the text as it is written, the cleaned answer).
  api.post("/docs/answer/stream", async (req, res) => {
    const s = S(res);
    const who = s.user ?? `org:${s.slug}`;
    let started = false, last: DocsStreamEvent | null = null;
    await streamDocsAnswer("customer", req.body?.question, { userKey: who, orgId: s.org }, (e) => {
      if (!started) { sseStart(res); started = true; }
      res.write(`data: ${JSON.stringify(e)}\n\n`);
      last = e;
    });
    const done = last as DocsStreamEvent | null;
    if (done?.type === "done") capture({ distinctId: who, orgSlug: s.slug }, "docs_answer_asked", { answered: done.answer != null, reason: done.reason, streamed: true });
    res.end();
  });
  api.get("/billing", async (_req, res) => void res.json({ ...(await billingView(S(res))), can_manage: can(res, "billing"), permissions: perms(res),
    contributions: await contributions.creditsFor(S(res).org) }));
  api.get("/billing/usage", async (_req, res) => void res.json(await billingUsage(S(res))));
  api.post("/billing/portal", async (_req, res) => { need(res, "billing"); res.json(await admin.portalLink(actor(res), S(res).slug, `${publicUrl()}/app#billing`)); });
  api.post("/billing/checkout", async (req, res) => { need(res, "billing"); res.json(await admin.checkoutLink(actor(res), S(res).slug, req.body?.price_id, `${publicUrl()}/app#billing`, { requireAllowed: true })); });
  api.use((err: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (!(err instanceof AppError || err instanceof PlaybookError || err instanceof context.ContextError || err instanceof limits.LimitError || err instanceof journeys.JourneyError || err instanceof admin.AdminError || err instanceof clerk.ClerkError || err instanceof billing.StripeError)) return next(err);
    // A Budget rules refusal also says which rule (code), the limit and what's left, who set it and the admins to ask.
    res.status(err.status ?? 400).json({ error: err.message, ...(err instanceof limits.LimitError || err instanceof AppError ? err.info : {}) });
  });
  r.use("/api/app", api);
  return r;
}
