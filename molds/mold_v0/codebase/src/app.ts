/**
 * The customer page (/app, web/app/app and web/components/portal): one place for an account's people to check their setup, learn the
 * workflow, see their team's usage, manage the team and the plan. Sign-in is Clerk (the same identity as the
 * connector's OAuth): the UI sends Clerk's session (the __session cookie on the same origin, or a Bearer session
 * token), and the account is the session's active Clerk organization.
 *
 * Nothing new is stored. Setup and usage come from the connector log the server already keeps (mcp_events, per user);
 * people from Clerk and the plan from Stripe, through src/admin.ts.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { withTenant } from "./tenant-scope.js";
import { workspaceCharges } from "./run-charges.js";
import { z } from "zod";
import * as admin from "./admin.js";
import { orgForClerk, type Org } from "./auth.js";
import { orgBudget } from "./billing.js";
import * as billing from "./billing.js";
import * as experiments from "./experiments.js";
import { getDb } from "./db.js";
import { HIT, orgMonthSpendUsd, SCENARIO_ROWS } from "./session-engine.js";
import { hostTable, sessionEngine } from "./host-tables.js";
import { RUN_USD } from "./run-spend.js";
import { workspaceRunUsage } from "./usage-report.js";
import { endpointLimit } from "./rate-limits.js";
import { currentPopulation } from "./agent-mix.js";
import { errorHints, hosts, setupConfig, setupWorkflow } from "./host.js";
import { PROFILE } from "./profile.js";
import { fill } from "./vocabulary.js";
import { dayKeys, daySeries, reportRange, sparkSpans } from "./insights.js";
import { capture, identifyPerson } from "./telemetry.js";
import * as limits from "./limits.js";
import * as clerk from "./clerk.js";
import { people, signedIn } from "./people.js";
import * as roles from "./account-roles.js";
import { answerDocs, sseStart, streamDocsAnswer, type DocsStreamEvent } from "./docs-answers.js";


const publicUrl = () => (process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3333}`).replace(/\/$/, "");

/**
 * Who is signed in, and for which account: a Clerk user acting in one Clerk organization. `role` is Clerk's (admin or
 * member); `accountRole` is what they may do (src/account-roles.ts).
 */
export interface Session { org: number; slug: string; user: string | null; email: string | null; role: "admin" | "member"; accountRole: roles.AccountRole; clerkOrgId: string | null }

const identified = new Set<string>();

export class AppError extends Error { constructor(message: string, public status = 400, public info: Record<string, unknown> = {}) { super(message); } }

// ---------- what "set up" and "using it fully" mean ----------

/**
 * Each coding agent's share of real-world developer usage (the default developer population, the same mix the agent
 * selector and simulations use), so the connection picker lists agents in the order people actually use them.
 */
async function withUsageShares(c: ReturnType<typeof admin.connectInfo>) {
  const pop = await currentPopulation().catch(() => null);
  const share = new Map<string, number>();
  for (const a of pop?.agents ?? []) share.set(a.harness, (share.get(a.harness) ?? 0) + Number(a.weight || 0));
  const clients = c.clients.map((x) => ({ ...x, share: share.has(x.id) ? Math.round((share.get(x.id) ?? 0) * 1000) / 10 : null }));
  const rank = { chat: 0, agent: 1, editor: 2 } as const;
  clients.sort((a, b) => rank[a.group] - rank[b.group] || (b.share ?? -1) - (a.share ?? -1));
  return { ...c, clients };
}

/** AI clients that draw a tool's widget under the answer (MCP Apps): a person whose every client is another sees results as text. */
const WIDGET_CLIENTS = /claude-ai|claude\.ai|openai|chatgpt/i;
/** A LIKE pattern for text that starts with `prefix` (its own %, _ and \ taken literally). */
const startsWith = (prefix: string) => `${prefix.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * The Setup page: joining, connecting a client, its tools and a first call, from the connector log, then the product's
 * own steps (mold_v0-140: the host pack's pack.json `setup`, src/host.ts SetupConfig; with zero packs, none):
 *   steps        each placed after a step (`after`, else last), done when the person read a resource whose address starts
 *                with a prefix (`resource:<prefix>`, their widget) or when the account reached one of the session engine's
 *                stages (`stage:<id>`: onboarded, simulated, reported); `optional` ones are not counted; `help_text_only`
 *                is its help for someone whose every AI client shows results as text; `launch` ones (they start work) show
 *                `viewer_note` instead to someone who may not launch
 *   shell_steps  the shell's steps (joined, connected, tools, first_call) in the product's words
 *   workflow     the tool groups that make up using it fully: per group, how many of its tools the account has called
 *                (coverage, and the next group nobody has used, with the prompt that starts it)
 * and a plain-language fix for each recent error from the packs' pack.json mcp.error_hints.
 */
async function setup(s: Session, since?: string) {
  const db = await getDb();
  const P = PROFILE.name;
  const cfg = setupConfig();
  // Per person (the Clerk user); per account for a session without a user.
  const who = s.user ? "org_id = $1 AND user_id = $2" : "org_id = $1 AND user_id IS NULL";
  const args = s.user ? [s.org, s.user] : [s.org];
  const own = cfg.steps ?? [];
  const resources = own.filter((st) => st.done_when.startsWith("resource:"));
  const [m] = await db.query<Record<string, any>>(
    `/* tenant: who = org_id = $1, the session's account */ SELECT min(at) FILTER (WHERE method = 'initialize') AS connected,
            min(at) FILTER (WHERE method = 'tools/list') AS tools_listed,${resources.map((_st, i) => `
            min(at) FILTER (WHERE method = 'resources/read' AND name LIKE $${args.length + i + 1}) AS resource_${i},`).join("")}
            min(at) FILTER (WHERE method = 'tools/call' AND ok) AS first_call,
            count(*) FILTER (WHERE method = 'tools/call') AS calls
       FROM mcp_events WHERE ${who}`, [...args, ...resources.map((st) => startsWith(st.done_when.slice("resource:".length)))]);
  const clients = await db.query<{ client: string; last: Date }>(
    `/* tenant: who = org_id = $1, the session's account */ SELECT client, max(at) AS last FROM mcp_events WHERE ${who} AND method = 'initialize' AND client IS NOT NULL GROUP BY client ORDER BY max(at) DESC LIMIT 5`, args);
  const workflow = cfg.workflow ?? [];
  // The account's tools in use (everyone's), for the workflow's coverage.
  const used = new Set(workflow.length ? (await db.query<{ name: string }>(
    `SELECT DISTINCT name FROM mcp_events WHERE org_id = $1 AND method = 'tools/call' AND ok`, [s.org])).map((r) => r.name) : []);
  const errors = await db.query<{ at: Date; name: string | null; error: string | null }>(
    `/* tenant: who = org_id = $1, the session's account */ SELECT at, name, error FROM mcp_events WHERE ${who} AND NOT ok ORDER BY at DESC LIMIT 5`, args);
  const stageAt = own.some((st) => st.done_when.startsWith("stage:")) ? admin.engineStagesAt(await admin.accountFacts(s.slug)) : {};
  const textOnly = clients.length > 0 && clients.every((c) => !WIDGET_CLIENTS.test(c.client));
  const shellWords = (id: string, label: string, help: string) => ({ label: cfg.shell_steps?.[id]?.label ?? label, help: cfg.shell_steps?.[id]?.help ?? help });
  type Step = { id: string; label: string; done: boolean; at: Date | string | null; optional?: true; help: string };
  const steps: Step[] = [
    { id: "joined", ...shellWords("joined", "Join your team's account", "You accepted the invitation and signed in, so your usage, limits and context belong to your team's account."), done: true, at: null },
    { id: "connected", ...shellWords("connected", `Add the ${P} connector to your AI client`,
      `${P} runs inside the AI client you already use. Pick your client under Connection string, follow its one step, then press Test my connection to prove it reaches us.`), done: Boolean(m.connected), at: m.connected },
    { id: "tools", ...shellWords("tools", `Switch the ${P} tools on`,
      `Your client has to load ${P}'s tools before it can use them. In Cursor, switch the ${P} server on in its MCP settings; in other clients, start a new chat.`), done: Boolean(m.tools_listed), at: m.tools_listed },
    { id: "first_call", ...shellWords("first_call", `Ask ${P} something`, `Your first question checks everything works end to end. Type: "What can ${P} do?"`), done: Boolean(m.first_call), at: m.first_call },
  ];
  for (const st of own) {
    const at = st.done_when.startsWith("resource:") ? m[`resource_${resources.indexOf(st)}`] ?? null : stageAt[st.done_when.slice("stage:".length)] ?? null;
    const step: Step = { id: st.id, label: st.label, done: Boolean(at), at, ...(st.optional ? { optional: true as const } : {}), help: textOnly && st.help_text_only ? st.help_text_only : st.help };
    const after = st.after ? steps.findIndex((x) => x.id === st.after) : -1;
    if (after >= 0) steps.splice(after + 1, 0, step); else steps.push(step);
  }
  // Every step has a prompt to paste into the AI client: the one it declares, or the one its help names (Type: "…").
  const STEP_PROMPTS: Record<string, string | undefined> = {
    connected: `Is ${P} connected? Tell me what it can do.`, tools: `Which ${P} tools can you use?`,
    ...Object.fromEntries([...Object.entries(cfg.shell_steps ?? {}).map(([id, w]) => [id, w.prompt]), ...own.map((st) => [st.id, st.prompt])].filter(([, x]) => x !== undefined)),
  };
  // Someone who may not launch: where a step that starts work would ask them to, the product's note instead.
  const viewer = !roles.canAccount(s.accountRole, "launch") && cfg.viewer_note !== undefined;
  const launch = new Set(own.filter((st) => st.launch).map((st) => st.id));
  const prompted = steps.map((st) => viewer && launch.has(st.id)
    ? { ...st, help: cfg.viewer_note!, prompt: null } : { ...st, prompt: STEP_PROMPTS[st.id] ?? st.help.match(/Type:\s*"(.+?)"/)?.[1] ?? null });
  const groups = workflow.map((g) => ({ id: g.id, label: g.label, prompt: g.prompt, used: g.tools.filter((t) => used.has(t)).length, total: g.tools.length }));
  const hints = errorHints().map((h) => ({ re: new RegExp(h.match, "i"), text: h.text }));
  let live = null;
  if (since) {
    const [r] = await db.query<{ at: Date; client: string | null }>(
      `/* tenant: who = org_id = $1, the session's account */ SELECT at, client FROM mcp_events WHERE ${who} AND method IN ('initialize', 'tools/list', 'tools/call') AND at > $${args.length + 1} ORDER BY at DESC LIMIT 1`,
      [...args, new Date(since)]);
    live = r ?? null;
  }
  return {
    steps: prompted, done: steps.filter((x) => x.done && !x.optional).length, total: steps.filter((x) => !x.optional).length,
    clients, calls: Number(m.calls), groups, coverage: groups.length ? groups.filter((g) => g.used > 0).length / groups.length : 0,
    next: groups.find((g) => g.used === 0) ?? null,
    errors: errors.map((e) => ({ ...e, hint: hints.find((h) => h.re.test(e.error ?? ""))?.text ?? null })),
    connect: await withUsageShares(admin.connectInfo()), live, viewer_note: viewer ? cfg.viewer_note! : null,
  };
}

/**
 * /app Usage for a period, optionally for some people only (?user=id,id): their own tool calls, the runs they launched
 * and those runs' model spend. Without a filter it is the whole team. `people` lists who can be picked: everyone on the
 * team plus anyone who used the app in the period.
 */
async function usage(s: Session, q: { from?: unknown; to?: unknown; days?: unknown; user?: unknown; use_case?: unknown }) {
  const range = reportRange(q), days = range.days;
  const list = (v: unknown) => [...new Set(String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean))].slice(0, 200);
  const users = list(q.user), useCases = list(q.use_case);
  const db = await getDb();
  // Use cases are a host pack's (its own /usage, src/host.ts): the shell has none, so a use-case filter narrows nothing.
  const toolSql = "";
  const ev = (users.length ? " AND user_id = ANY($4)" : "") + toolSql;
  const sim = users.length ? " AND created_by = ANY($4)" : "";
  const p = users.length ? [s.org, range.start, range.end, users] : [s.org, range.start, range.end];
  const month = "date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";
  // The session engine's tables are a host pack's (mold_v0-049): with none, no simulations or sessions, runs only.
  const eng = sessionEngine();
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
    !eng ? Promise.resolve([{ simulations: 0, sessions: 0, completed: 0 }]) : db.query<{ simulations: number; sessions: number; completed: number }>(
      `SELECT (SELECT count(*) FROM simulations WHERE org_id = $1 AND created_at >= $2 AND created_at < $3${sim}) AS simulations,
              count(*) AS sessions, count(*) FILTER (WHERE status = 'completed') AS completed
         FROM agent_sessions WHERE org_id = $1 AND queued_at >= $2 AND queued_at < $3
          ${users.length ? "AND simulation_id IN (SELECT id FROM simulations WHERE org_id = $1 AND created_by = ANY($4))" : ""}`, p),
    // This month's spend on the selected people's runs (session cost, or the gateway's live total while it runs).
    // And on the runs they started (mold_v0-053).
    users.length ? db.query<{ usd: number }>(
      `SELECT ${!eng ? "0" : `(SELECT coalesce(sum(GREATEST(s.cost_usd, coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.session_id = s.id), 0))), 0)
                 FROM agent_sessions s JOIN simulations r ON r.id = s.simulation_id
                WHERE s.org_id = $1 AND r.created_by = ANY($2) AND s.queued_at >= ${month})`}
            + (SELECT coalesce(sum(${RUN_USD}), 0) FROM runs r WHERE r.org_id = $1 AND r.requested_by = ANY($2) AND r.created_at >= ${month}) AS usd`,
      [s.org, users]) : Promise.resolve(null),
    // Tool calls by tool for the people picked but any use case: each use case's count in the Use cases filter.
    db.query<{ name: string; calls: number }>(
      `SELECT name, count(*) AS calls FROM mcp_events WHERE org_id = $1 AND method = 'tools/call' AND at >= $2 AND at < $3${users.length ? " AND user_id = ANY($4)" : ""} GROUP BY name`, p),
    // The cards' sparklines: simulations and finished agent sessions per day of the period, and model spend per day
    // this month (each with the same people filter as its card).
    db.query<{ k: string; day: string; v: unknown }>(
      `${eng ? `SELECT 'simulations' AS k, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS v
         FROM simulations WHERE org_id = $1 AND created_at >= $2 AND created_at < $3${sim} GROUP BY 2
       UNION ALL
       SELECT 'completed', to_char(queued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), count(*) FILTER (WHERE status = 'completed')
         FROM agent_sessions WHERE org_id = $1 AND queued_at >= $2 AND queued_at < $3
          ${users.length ? "AND simulation_id IN (SELECT id FROM simulations WHERE org_id = $1 AND created_by = ANY($4))" : ""} GROUP BY 2
       UNION ALL
       ` : ""}SELECT 'spend', day, sum(v)::float FROM (${eng ? `
         SELECT to_char(s.queued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                GREATEST(s.cost_usd, coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.session_id = s.id), 0)) AS v
           FROM agent_sessions s WHERE s.org_id = $1 AND s.queued_at >= ${month}
            ${users.length ? "AND s.simulation_id IN (SELECT id FROM simulations WHERE org_id = $1 AND created_by = ANY($4))" : ""}
         UNION ALL` : ""}
         -- Runs (mold_v0-053): the same day rule, by who started them.
         SELECT to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, ${RUN_USD} AS v
           FROM runs r WHERE r.org_id = $1 AND r.created_at >= ${month}${users.length ? " AND r.requested_by = ANY($4)" : ""}
            ${eng ? "" : "AND $2::timestamptz IS NOT NULL AND $3::timestamptz IS NOT NULL"}) x GROUP BY 2`, p),
  ]);
  const periodDays = dayKeys(range.start, range.end), monthDays = sparkSpans().monthDays;
  const toolCalls = new Map(byTool.map((x) => [x.name, Number(x.calls)]));
  const t = await admin.team(s.slug);
  const callsOf = new Map(people.map((x) => [x.user_id, Number(x.calls)]));
  const known = new Set(t.members.map((m) => m.user_id));
  const [{ budget }, spent] = await Promise.all([orgBudget(s.org).catch(() => ({ budget: 0 })), orgMonthSpendUsd(s.org)]);
  const charts = await usageCharts(s, range, users, p, byTool, budget, t.members);
  // Runs (mold_v0-008): their tool calls' people and cost, per run, kind and person, only when the period has any.
  const runUsage = await workspaceRunUsage(s.org, range.start, range.end, users);
  const label = (id: string | null) => (id?.startsWith("schedule:") ? "Schedule" : id?.startsWith("staff:") ? "Staff" : id ? (id === s.user ? "You" : t.members.find((m) => m.user_id === id)?.email ?? "Former member") : "Connector key");
  // Spend per person is for billing roles (as Spend by person below); everyone else sees their own line.
  const billing = roles.canAccount(s.accountRole, "billing");
  return {
    ...(runUsage.runs ? { run_usage: { ...runUsage, by_person: runUsage.by_person.filter((x) => billing || x.user_id === s.user).map((x) => ({ ...x, label: label(x.user_id) })),
      recent: runUsage.recent.map((x) => ({ ...x, by: label(x.requested_by) })) } } : {}),
    charts,
    days, range: { from: range.from, to: range.to }, daily, tools, runs: runs[0], filters: { user: users, use_case: useCases },
    use_cases: [] as { id: string; name: string; own: boolean; calls: number }[],
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
  // The session engine's tables are a host pack's (mold_v0-049): with none, no simulations or sessions, runs only.
  const eng = sessionEngine();
  const [clients, sims, harnesses, spendBy, recent] = await Promise.all([
    db.query<{ client: string; calls: unknown }>(
      `WITH ev AS (
         SELECT coalesce(user_id, '') AS p, at, method = 'tools/call' AS is_call, CASE WHEN method = 'initialize' THEN split_part(client, ' ', 1) END AS fam
           FROM mcp_events
          WHERE org_id = $1${ev} AND ((method = 'tools/call' AND at >= $2 AND at < $3) OR (method = 'initialize' AND client IS NOT NULL AND at < $3))),
       grouped AS (SELECT *, count(fam) OVER (PARTITION BY p ORDER BY at, is_call ROWS UNBOUNDED PRECEDING) AS g FROM ev),
       tagged AS (SELECT at, is_call, max(fam) OVER (PARTITION BY p, g) AS fam FROM grouped)
       SELECT coalesce(nullif(fam, ''), 'unknown') AS client, count(*) AS calls FROM tagged WHERE is_call AND at >= $2 GROUP BY 1 ORDER BY 2 DESC`, p),
    !eng ? Promise.resolve([] as { week: string; completed: unknown; other: unknown }[]) : db.query<{ week: string; completed: unknown; other: unknown }>(
      `SELECT ${wk("created_at")} AS week, count(*) FILTER (WHERE status = 'completed') AS completed, count(*) FILTER (WHERE status <> 'completed') AS other
         FROM simulations sim WHERE org_id = $1 AND created_at >= $2 AND created_at < $3${simBy} GROUP BY 1`, p),
    !eng ? Promise.resolve([] as { harness: string; sessions: unknown; completed: unknown }[]) : db.query<{ harness: string; sessions: unknown; completed: unknown }>(
      `SELECT s.harness, count(*) AS sessions, count(*) FILTER (WHERE s.status = 'completed') AS completed
         FROM agent_sessions s WHERE s.org_id = $1 AND s.queued_at >= $2 AND s.queued_at < $3${sesBy} GROUP BY 1 ORDER BY 2 DESC`, p),
    // This month's spend, like the card: by who launched the run (billing roles), else by simulation; runs (mold_v0-053)
    // by who started them, else by their kind.
    db.query<{ key: string | null; name: string | null; usd: number }>(
      `SELECT key, name, sum(usd)::float AS usd FROM (${eng ? `
         SELECT ${billingRole ? "sim.created_by AS key, NULL AS name" : "sim.id AS key, sim.name AS name"}, ${cost} AS usd
           FROM agent_sessions s JOIN simulations sim ON sim.id = s.simulation_id AND sim.org_id = $1
          WHERE s.org_id = $1 AND s.queued_at >= ${month}${sesBy.replace("$4", "$2")}
         UNION ALL` : ""}
         SELECT ${billingRole ? "r.requested_by AS key, NULL AS name" : "'run:' || r.pack || '/' || r.kind AS key, r.kind AS name"}, ${RUN_USD} AS usd
           FROM runs r WHERE r.org_id = $1 AND r.created_at >= ${month}${users.length ? " AND r.requested_by = ANY($2)" : ""}) x
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`, users.length ? [s.org, users] : [s.org]),
    !eng ? Promise.resolve([] as { id: string; name: string; status: string; created_at: Date; created_by: string | null; product: string; sessions: unknown; scored: unknown; hits: unknown }[])
    : db.query<{ id: string; name: string; status: string; created_at: Date; created_by: string | null; product: string; sessions: unknown; scored: unknown; hits: unknown }>(
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
  const label = (id: string | null) => (id?.startsWith("schedule:") ? "Schedule" : id?.startsWith("staff:") ? "Staff" : id ? (id === s.user ? "You" : who.get(id) ?? "Former member") : "Connector key");
  return {
    // The Setup page's workflow groups (pack.json setup.workflow, mold_v0-140): each group's tools called in the period.
    workflow: setupWorkflow().map((g) => ({ id: g.id, label: g.label, total: g.tools.length,
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
    // Price per run (mold_v0-019, src/run-charges.ts): this month's run charges, only when the app bills runs (or has billed
    // them). The latest rows are everyone's for billing roles, a member's own runs otherwise.
    ...await workspaceCharges(s.org, { person: roles.canAccount(s.accountRole, "billing") ? null : s.user ?? "" }).then((c) => (c ? { run_charges: c } : {})),
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
  // The session engine's tables are a host pack's (mold_v0-049): with none, no sessions, runs only.
  const eng = sessionEngine();
  const daily = !eng ? [] as { day: string; usd: number; sessions: number }[] : await db.query<{ day: string; usd: number; sessions: number }>(
    `WITH ${sc} SELECT to_char(date_trunc('day', queued_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, sum(usd)::float AS usd, count(*)::int AS sessions
       FROM sc GROUP BY 1 ORDER BY 1`, [s.org]);
  const [m] = !eng ? [{ metered: 0, finished: 0, running: 0 }] : await db.query<{ metered: number; finished: number; running: number }>(
    `SELECT coalesce(sum(cost_usd) FILTER (WHERE status IN ('completed', 'failed', 'timeout', 'cancelled')), 0)::float AS metered,
            count(*) FILTER (WHERE status IN ('completed', 'failed', 'timeout', 'cancelled'))::int AS finished,
            count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS running
       FROM agent_sessions WHERE org_id = $1 AND queued_at >= ${month}`, [s.org]);
  const byAgent = !eng ? [] as { agent: string; usd: number; sessions: number }[] : await db.query<{ agent: string; usd: number; sessions: number }>(
    `WITH ${sc} SELECT coalesce(agent_id, harness || '/' || model) AS agent, sum(usd)::float AS usd, count(*)::int AS sessions
       FROM sc GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, [s.org]);
  const byPerson = !eng ? [] as { user_id: string | null; usd: number; runs: number }[] : await db.query<{ user_id: string | null; usd: number; runs: number }>(
    `/* tenant: sc is this account's sessions (org_id = $1) */ WITH ${sc} SELECT r.created_by AS user_id, sum(sc.usd)::float AS usd, count(DISTINCT r.id)::int AS runs
       FROM sc JOIN simulations r ON r.id = sc.simulation_id GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, [s.org]);
  // Runs (mold_v0-053): their spend by day and by who started them, merged in only when this month has any.
  const runRows = await db.query<{ day: string; user_id: string | null; usd: number; live: boolean }>(
    `SELECT to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, r.requested_by AS user_id, ${RUN_USD}::float AS usd,
            r.status IN ('queued', 'running') AS live
       FROM runs r WHERE r.org_id = $1 AND r.created_at >= ${month}`, [s.org]);
  let runInFlight = 0;
  for (const x of runRows) {
    const d = daily.find((y) => y.day === x.day);
    if (d) d.usd = Number(d.usd) + Number(x.usd);
    else daily.push({ day: x.day, usd: Number(x.usd), sessions: 0 });
    const p = byPerson.find((y) => y.user_id === x.user_id);
    if (p) p.usd = Number(p.usd) + Number(x.usd);
    else byPerson.push({ user_id: x.user_id, usd: Number(x.usd), runs: 0 });
    if (x.live) runInFlight += Number(x.usd);
  }
  if (runRows.length) { daily.sort((a, b) => a.day.localeCompare(b.day)); byPerson.sort((a, b) => b.usd - a.usd); byPerson.splice(8); }
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
    // Metered: finished sessions (what Stripe was sent). In flight: the rest of the sessions' spend, and running runs'.
    metered_usd: Number(m?.metered ?? 0),
    in_flight_usd: runRows.length ? Math.max(0, spent - Number(m?.metered ?? 0) - runRows.filter((x) => !x.live).reduce((a, x) => a + Number(x.usd), 0)) : Math.max(0, spent - Number(m?.metered ?? 0)),
    sessions: { finished: m?.finished ?? 0, running: m?.running ?? 0 },
    ...(runRows.length ? { runs: { finished: runRows.filter((x) => !x.live).length, running: runRows.filter((x) => x.live).length,
      usd: runRows.reduce((a, x) => a + Number(x.usd), 0), in_flight_usd: runInFlight } } : {}),
    meter: { enabled: Boolean(process.env.STRIPE_SPEND_METER && billing.stripeEnabled()), event: process.env.STRIPE_SPEND_METER ?? null },
    daily, by_agent: byAgent,
    // Members see only their own line; owners and billing managers see everyone, by email.
    by_person: byPerson.filter((p) => all || p.user_id === s.user).map((p) => {
      const who = people.find((x) => x.user_id === p.user_id);
      return { ...p, label: p.user_id == null ? "Connector key" : p.user_id.startsWith("schedule:") ? "Schedule" : p.user_id.startsWith("staff:") ? "Staff" : p.user_id === s.user ? "You" : who?.email ?? who?.name ?? "Former member" };
    }),
  };
}

// ---------- routes ----------

/**
 * Under Clerk, a signed-in person with no account membership may still hold a pending invitation to one: Clerk's
 * invitation link carries a ticket that only its sign-in and sign-up pages consume, so someone already signed in (say,
 * with an organization they made themselves active) never accepts it. Here the server accepts it for them: an
 * invitation to an organization that is an account, addressed to one of the person's verified email addresses, becomes
 * a membership with the invitation's role and metadata (the account role), and the invitation is revoked (used).
 * Memberships are read fresh first (an invitation accepted in the browser a moment ago). One check per person at a
 * time, and a miss is remembered for ten seconds.
 */
const inviteChecks = new Map<string, { at: number; p: Promise<{ m: clerk.ClerkMembership; org: Org } | null> }>();
function acceptPendingInvitation(userId: string) {
  const hit = inviteChecks.get(userId);
  if (hit && Date.now() - hit.at < 10_000) return hit.p;
  const p = (async () => {
    for (const x of (await clerk.memberships.forUser(userId, true)).filter((x) => x.organization).sort((a, b) => a.created_at - b.created_at)) {
      if (clerk.isSuspended(x)) continue;
      const org = await orgForClerk(x.organization!.id);
      if (org) return { m: x, org };
    }
    const user = await clerk.users.get(userId, true);
    const verified = new Set(user.email_addresses.filter((e) => e.verification?.status === "verified").map((e) => e.email_address.toLowerCase()));
    for (const inv of await clerk.pendingInvitationsForUser(userId)) {
      const email = inv.email_address.toLowerCase();
      if (!verified.has(email)) { console.log(`clerk invitation not accepted: user=${userId} org=${inv.organization_id} invitation=${inv.id}: ${email} is not a verified address of theirs`); continue; }
      const org = await orgForClerk(inv.organization_id);
      if (!org) continue;
      let m = await clerk.createMembership(inv.organization_id, userId, inv.role, inv.public_metadata).catch(async (err) => {
        // Accepted meanwhile (in the browser, or by another request): use the membership that is there.
        const there = (await clerk.memberships.forUser(userId, true)).find((x) => x.organization?.id === inv.organization_id);
        if (!there) throw err;
        return there;
      });
      await clerk.invitations.revoke(inv.organization_id, inv.id).catch((err) => console.error(`clerk invitation revoke ${inv.id}:`, (err as Error).message));
      if (!m.organization) m = (await clerk.memberships.forUser(userId, true)).find((x) => x.organization?.id === inv.organization_id) ?? m;
      console.log(`clerk invitation accepted by the server: user=${userId} org=${inv.organization_id} account=${org.slug} invitation=${inv.id} role=${inv.role}`);
      if (!m.organization || clerk.isSuspended(m)) continue;
      return { m, org };
    }
    return null;
  })().catch((err) => { console.error(`clerk invitation check for ${userId}:`, (err as Error).message); return null; });
  inviteChecks.set(userId, { at: Date.now(), p });
  return p;
}

/**
 * The portal's sign-in check, shared by /api/app and the packs' /api/packs/<id> (src/pack-routes.ts): a Clerk session of
 * a person in an account, which sets res.locals.session and runs the rest of the request under row-level security
 * for that account (withTenant).
 */
export async function customerSession(req: Request, res: Response, next: NextFunction) {
  // The server's sign-in (src/people.ts): Clerk's session, or the built-in session cookie (mold_v0-004).
  const dir = people();
  if (!dir.enabled()) return void res.status(503).json({ error: "Sign-in is not configured (CLERK_SECRET_KEY)" });
  const c = await signedIn(req);
  if (!c) return void res.status(401).json({ error: "Sign in", sign_in_url: dir.provider === "clerk" ? "/sign-in" : "/auth/sign-in" });
  let ms = (await dir.memberships.forUser(c.userId)).filter((m) => m.organization).sort((a, b) => a.created_at - b.created_at);
  // The session's active organization when it is an account; else (no active one, or one the person made for
  // themselves that is no account) the person's oldest membership of an account that is not suspended.
  const active = c.orgId ? ms.find((x) => x.organization!.id === c.orgId) : undefined;
  let m = active, org = active ? await orgForClerk(active.organization!.id) : null;
  if (active && org && clerk.isSuspended(active)) return void res.status(403).json({ error: "Your access to this account was suspended. Ask your account admin.", code: "suspended" });
  if (!org) {
    m = undefined;
    for (const x of ms) {
      if (clerk.isSuspended(x)) continue;
      const o = await orgForClerk(x.organization!.id);
      if (o) { m = x; org = o; break; }
    }
  }
  if (!m && dir.provider === "clerk") {
    const got = await acceptPendingInvitation(c.userId);
    if (got) { m = got.m; org = got.org; ms = (await dir.memberships.forUser(c.userId)).filter((x) => x.organization).sort((a, b) => a.created_at - b.created_at); }
  }
  if (!m && ms.some((x) => clerk.isSuspended(x))) return void res.status(403).json({ error: "Your access to this account was suspended. Ask your account admin.", code: "suspended" });
  if (!m && !ms.length) return void res.status(403).json({ error: fill("You are not in a {product} {account} yet. Ask your admin to invite you."), code: "no_account" });
  if (!m || !org) return void res.status(403).json({ error: fill("This organization is not a {product} {account}. {product} is invite-only for now: ask your {product} contact for an invitation."), code: "no_account" });
  const user = await dir.users.get(c.userId);
  const s: Session = { org: org.orgId, slug: org.slug, user: c.userId, email: clerk.primaryEmail(user).email, role: clerk.roleOf(m.role),
    accountRole: roles.accountRoleOf(m), clerkOrgId: m.organization!.id };
  if (!identified.has(c.userId)) {
    identified.add(c.userId);
    identifyPerson(c.userId, { email: s.email ?? undefined, name: clerk.displayName(user) ?? undefined, account: org.slug, account_name: org.name, role: s.accountRole });
    capture({ distinctId: c.userId, orgSlug: org.slug }, "app_signed_in", { method: dir.provider });
  }
  res.locals.session = s;
  res.locals.memberships = ms;
  // Pack routes (src/pack-routes.ts) ask cookie-authenticated changes for a CSRF header.
  res.locals.viaCookie = c.viaCookie;
  // Row-level security (src/tenant-scope.ts): the rest of the request reaches this organization's rows only.
  withTenant(org.orgId, () => next());
}

export function appRouter() {
  const r = express.Router();

  // The API behind the portal pages. Sign-in and sign-out happen in the UI, with Clerk.
  const api = express.Router();
  // Small bodies everywhere except imports (memory, use cases, personas, tasks), which parse their own.
  const small = express.json({ limit: "16kb" });
  api.use((req, res, next) => (hosts().some((h) => h.routes?.appLargeBody?.(req)) ? next() : small(req, res, next)));
  api.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  api.use(customerSession);
  // Under the built-in sign-in (a long-lived cookie, mold_v0-004) a change riding the cookie carries X-Pack-Request: 1,
  // which a page on another site cannot send (CSRF), as the data, keys and pack routes already ask. Clerk's is unchanged.
  api.use((req, res, next) => (people().provider === "builtin" && res.locals.viaCookie && req.method !== "GET" && req.method !== "HEAD" && req.get("x-pack-request") !== "1"
    ? void res.status(403).json({ error: "Missing X-Pack-Request header" }) : next()));
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
  const orgOf = async (res: Response): Promise<Org> => ({ orgId: S(res).org, slug: S(res).slug, name: (await admin.accountFacts(S(res).slug)).name, userId: S(res).user ?? undefined, role: S(res).accountRole });
  // A host pack's own portal routes (src/host.ts, mold_v0-039) come first: a path it serves replaces the shell's (its
  // Setup and Usage pages in place of the neutral ones below).
  // The console's portal layout asks this before it draws a page (mold_v0-098): 200 when the person has an account open
  // here, else customerSession's 403 (no_account: the console shows its own page for it). Ahead of the host packs' routes.
  api.get("/access", (_req, res) => void res.json({ ok: true }));
  for (const h of hosts()) h.routes?.app?.(api, { S, need, can, actor, orgOf, AppError });

  api.get("/me", async (_req, res) => {
    const s = S(res);
    const f = await admin.accountFacts(s.slug);
    const ms = res.locals.memberships as clerk.ClerkMembership[];
    res.json({ email: s.email, user_id: s.user, role: s.role, org_role: `org:${s.role}`, account: { name: f.name, slug: f.slug, clerk_org_id: s.clerkOrgId },
               account_role: s.accountRole, role_label: roles.ACCOUNT_ROLE_LABELS[s.accountRole], permissions: perms(res), needs: roles.ACCOUNT_PERMISSIONS,
               roles: [...roles.ACCOUNT_ROLES].reverse().map((r) => ({ id: r, label: roles.ACCOUNT_ROLE_LABELS[r], help: roles.accountRoleHelp(r) })),
               via: people().provider, organizations: ms.map((m) => ({ clerk_org_id: m.organization!.id, name: m.organization!.name, role: clerk.roleOf(m.role),
                 account_role: roles.accountRoleOf(m), suspended: clerk.isSuspended(m) })),
               integrations: { clerk: people().provider === "clerk", stripe: billing.stripeEnabled() } });
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
  api.get("/usage", async (req, res) => void res.json(await usage(S(res), req.query)));
  api.get("/team", async (_req, res) => void res.json({ ...(await admin.team(S(res).slug, true)), me: S(res).user, can_manage: can(res, "team"), permissions: perms(res) }));
  // At most so many invitations an hour per workspace (each also issues a key; mold_v0-018, src/rate-limits.ts).
  // Permission first, so someone who may not invite cannot use up the workspace's quota.
  api.post("/team/invitations", (_req, res, next) => { need(res, "team"); next(); },
    endpointLimit("invite", (_req, res) => (res.locals.session as Session).slug) as express.RequestHandler, async (req, res) => {
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
  // Remove someone from the account (mold_v0-004): their membership, their sessions in it and their member keys go.
  api.post("/team/members/:id/remove", async (req, res) => {
    need(res, "team");
    const t = await admin.team(S(res).slug, true);
    if (t.members.find((m) => m.id === req.params.id)?.user_id === S(res).user) throw new AppError("You cannot remove yourself");
    res.json(await admin.removeMember(actor(res), S(res).slug, String(req.params.id)));
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
  api.get("/billing", async (_req, res) => {
    const extras = await Promise.all(hosts().map((h) => h.routes?.billingExtras?.(S(res).org) ?? {}));
    res.json({ ...(await billingView(S(res))), can_manage: can(res, "billing"), permissions: perms(res),
      // Whether the build's host pack onboards products (mold_v0-100: the page's copy names it only then).
      onboards_products: hostTable("products"), ...Object.assign({}, ...extras) });
  });
  api.get("/billing/usage", async (_req, res) => void res.json(await billingUsage(S(res))));
  api.post("/billing/portal", async (_req, res) => { need(res, "billing"); res.json(await admin.portalLink(actor(res), S(res).slug, `${publicUrl()}/app#billing`)); });
  api.post("/billing/checkout", async (req, res) => { need(res, "billing"); res.json(await admin.checkoutLink(actor(res), S(res).slug, req.body?.price_id, `${publicUrl()}/app#billing`, { requireAllowed: true })); });
  api.use((err: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => {
    const hostError = hosts().some((h) => (h.routes?.appErrors ?? []).some((C) => err instanceof C));
    if (!(err instanceof AppError || hostError || err instanceof limits.LimitError || err instanceof admin.AdminError || err instanceof clerk.ClerkError || err instanceof billing.StripeError)) return next(err);
    // A Budget rules refusal also says which rule (code), the limit and what's left, who set it and the admins to ask.
    res.status(err.status ?? 400).json({ error: err.message, ...(err instanceof limits.LimitError || err instanceof AppError ? err.info : {}) });
  });
  r.use("/api/app", api);
  return r;
}
