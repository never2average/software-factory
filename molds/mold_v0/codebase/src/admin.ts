/**
 * Onboarding admin console (/admin): the work between "someone asked for access" and "they read their first report".
 * Octillion is not the system of record for any of it:
 *  - people (organizations, users, memberships, roles, invitations) live in Clerk (src/clerk.ts); Clerk sends the
 *    invite email and handles sign-in (passwords, Google, Microsoft, GitHub, enterprise SSO);
 *  - money (plans, subscriptions, invoices, cards) lives in Stripe (src/billing.ts); customers self-serve in Stripe;
 *  - Postgres keeps the joins (clerk_org_id, stripe_customer_id), a landing-page request's triage state, and the
 *    product usage Octillion already records (connector events, products, onboarding, simulations).
 * This module reads all three and puts the funnel in one place. Admin actions are logged to stderr; Clerk and Stripe
 * keep their own event history for what changes there.
 *
 * Without CLERK_SECRET_KEY the console falls back to per-org API keys (src/auth.ts), sent by clients in a header (never in
 * the URL). Legacy keys keep working either way, for existing beta users and clients that can only send a header.
 */
import { daySeries, reportRange, sparkSpans } from "./insights.js";
import { asPlatform } from "./tenant-scope.js";
import { createApiKey, createOrg, slugify } from "./auth.js";
import { capture } from "./telemetry.js";
import * as billing from "./billing.js";
import * as experiments from "./experiments.js";
import { parsePlanConfig, PlanConfigError } from "./plan-config.js";
import { clientCatalog } from "./connect-catalog.js";
import { getDb } from "./db.js";
import * as clerk from "./clerk.js";
import * as mail from "./email.js";
import { currentAdminRole } from "./admin-roles.js";
import { accountRoleOf, clerkRoleFor, parseAccountRole, ACCOUNT_ROLE_LABELS, type AccountRole } from "./account-roles.js";

export class AdminError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const publicUrl = () => (process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3333}`).replace(/\/$/, "");
/**
 * One stderr line per admin change, and the same as a PostHog event (without emails) for the onboarding funnel. A
 * platform admin's role (src/admin-roles.ts) goes with it.
 */
export function log(actor: string, action: string, slug: string | null, detail: Record<string, unknown> = {}) {
  const role = currentAdminRole();
  console.error(`admin ${actor} ${action}${slug ? ` org=${slug}` : ""} ${JSON.stringify(detail)}${role ? ` role=${role}` : ""}`);
  const { email: _email, ...safe } = detail;
  capture({ distinctId: `admin:${actor}`, orgSlug: slug }, `admin_${action.replace(/\./g, "_")}`, role ? { ...safe, actor_role: role } : safe);
}

export function integrations() {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  return {
    clerk: clerk.clerkEnabled(), clerk_frontend_api: clerk.frontendApi(), oauth_on_mcp: Boolean(clerk.clerkEnabled() && clerk.frontendApi()),
    stripe: billing.stripeEnabled(), stripe_test_mode: /^(sk|rk)_test_/.test(key), spend_meter: process.env.STRIPE_SPEND_METER || null,
    require_subscription: process.env.OCTILLION_REQUIRE_SUBSCRIPTION === "1",
    default_budget_usd: Number(process.env.OCTILLION_ORG_MONTHLY_BUDGET_USD ?? 0),
  };
}

// ---------- connecting ----------

/**
 * How a person connects: the plain /mcp URL, with Clerk sign-in, or (legacy) with an API key sent in a header. The key
 * never goes in the URL: URLs end up in logs, browser history and screenshots.
 */
export function connectInfo(key?: string) {
  const base = publicUrl();
  const url = `${base}/mcp`;
  // Every client Octillion supports, with its exact way in (src/connect-catalog.ts).
  const signInAvailable = Boolean(clerk.clerkEnabled() && clerk.frontendApi());
  const clients = clientCatalog(url, key, { signInAvailable });
  const subject = "Your Octillion access";
  const body = `Hi,

You now have access to Octillion. Add this connector URL to your AI client:

${url}
${key ? `\nYour personal API key is:\n\n${key}\n\nIt is your login: anyone with it can use your account, so keep it private. Your client sends it as a header\n(Authorization: Bearer <key>); it never goes in the URL. ${signInAvailable ? "Claude and ChatGPT's own apps cannot send it: ask us for a\nsign-in invitation to use them." : "Claude and ChatGPT's own apps cannot send it: use a client that can (listed below)."}\n` : "\nIt has no secret in it: you sign in with your work email (accept the invitation email first).\n"}
Connect it:
${clients.filter((c) => ["claude", "chatgpt", "claude-code", "cursor", "codex"].includes(c.id)).map((c) => `- ${c.client}: ${c.command ? `${c.steps} ${c.command}` : c.steps}`).join("\n")}
Every other client (Copilot, OpenCode, Gemini CLI, VS Code, Windsurf and more) is listed at ${base}/app

Then type: "Get me started with Octillion."

Reply to this email with anything that gets in your way.`;
  return { connector_url: url, secret: Boolean(key), clients, email: { subject, body } };
}

// ---------- local facts ----------

interface OrgFacts {
  id: number; slug: string; name: string; created_at: Date; clerk_org_id: string | null; stripe_customer_id: string | null;
  prepaid_allowed: boolean; budget_override_usd: string | number | null;
  active_keys: number; key_last_used: Date | null; first_seen: Date | null; last_seen: Date | null; first_call_at: Date | null;
  onboarded_at: Date | null; onboarding_running: number; onboarding_failed: number; first_sim_at: Date | null; sims_running: number;
  first_report_at: Date | null; calls_7d: number; errors_7d: number; month_spend_usd: number;
}
const ORG_FACTS = `
  SELECT o.id, o.slug, o.name, o.created_at, o.clerk_org_id, o.stripe_customer_id, o.prepaid_allowed, o.budget_override_usd,
    (SELECT count(*) FROM api_keys k WHERE k.org_id = o.id AND k.revoked_at IS NULL) AS active_keys,
    (SELECT max(k.last_used_at) FROM api_keys k WHERE k.org_id = o.id) AS key_last_used,
    (SELECT min(e.at) FROM mcp_events e WHERE e.org_id = o.id) AS first_seen,
    (SELECT max(e.at) FROM mcp_events e WHERE e.org_id = o.id) AS last_seen,
    (SELECT min(e.at) FROM mcp_events e WHERE e.org_id = o.id AND e.method = 'tools/call' AND e.ok) AS first_call_at,
    -- Onboarded: research completed, or a product saved by hand (save_product) without research.
    least((SELECT min(r.finished_at) FROM product_research r WHERE r.org_id = o.id AND r.status = 'completed'),
          (SELECT min(p.created_at) FROM products p WHERE p.org_id = o.id
            AND NOT EXISTS (SELECT 1 FROM product_research r WHERE r.product_id = p.id))) AS onboarded_at,
    (SELECT count(*) FROM product_research r WHERE r.org_id = o.id AND r.status IN ('queued', 'running')) AS onboarding_running,
    (SELECT count(*) FROM product_research r WHERE r.org_id = o.id AND r.status = 'failed') AS onboarding_failed,
    (SELECT min(s.created_at) FROM simulations s WHERE s.org_id = o.id) AS first_sim_at,
    (SELECT count(*) FROM simulations s WHERE s.org_id = o.id AND s.status IN ('queued', 'running')) AS sims_running,
    (SELECT min(e.at) FROM mcp_events e WHERE e.org_id = o.id AND e.name = 'get_visibility_report' AND e.ok) AS first_report_at,
    (SELECT count(*) FROM mcp_events e WHERE e.org_id = o.id AND e.method = 'tools/call' AND e.at > now() - interval '7 days') AS calls_7d,
    (SELECT count(*) FROM mcp_events e WHERE e.org_id = o.id AND NOT e.ok AND e.at > now() - interval '7 days') AS errors_7d,
    (SELECT coalesce(sum(u.cost_usd), 0) FROM gateway_usage u JOIN agent_sessions a ON a.id = u.session_id
      WHERE a.org_id = o.id AND a.queued_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS month_spend_usd
  FROM organizations o`;

// ---------- people, from Clerk ----------

/**
 * A member, keyed by Clerk user id (Clerk's membership endpoints are). Suspended = public_metadata.suspended. `role` is
 * Clerk's (admin or member); `account_role` is the Octillion role (src/account-roles.ts).
 */
export interface Member { id: string; user_id: string; status: "active" | "inactive"; role: "admin" | "member"; account_role: AccountRole; created_at: string | null; email: string | null; name: string | null }
export interface Invite { id: string; email: string; state: clerk.ClerkInvitation["status"]; role: "admin" | "member"; account_role: AccountRole; created_at: string | null; expires_at: string | null }
interface People { members: Member[]; invitations: Invite[]; error?: string }

const toMember = (m: clerk.ClerkMembership): Member => ({
  id: m.public_user_data?.user_id ?? m.id, user_id: m.public_user_data?.user_id ?? "", status: clerk.isSuspended(m) ? "inactive" : "active",
  role: clerk.roleOf(m.role), account_role: accountRoleOf(m), created_at: clerk.iso(m.created_at), email: m.public_user_data?.identifier?.toLowerCase() ?? null,
  name: clerk.displayName(m.public_user_data ?? {}),
});
const toInvite = (x: clerk.ClerkInvitation): Invite => ({
  id: x.id, email: x.email_address.toLowerCase(), state: x.status, role: clerk.roleOf(x.role), account_role: accountRoleOf(x), created_at: clerk.iso(x.created_at), expires_at: clerk.iso(x.expires_at),
});

const peopleCache = new Map<string, { at: number; people: People }>();
async function peopleOf(clerkOrgId: string | null, fresh = false): Promise<People | null> {
  if (!clerkOrgId || !clerk.clerkEnabled()) return null;
  const hit = peopleCache.get(clerkOrgId);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.people;
  let people: People;
  try {
    const [members, invitations] = await Promise.all([clerk.memberships.list(clerkOrgId), clerk.invitations.list(clerkOrgId)]);
    people = { members: members.map(toMember), invitations: invitations.map(toInvite) };
  } catch (err) {
    return { members: [], invitations: [], error: (err as Error).message }; // show the account anyway; do not cache a failure
  }
  peopleCache.set(clerkOrgId, { at: Date.now(), people });
  return people;
}
const forget = (clerkOrgId: string | null) => { if (clerkOrgId) peopleCache.delete(clerkOrgId); };

async function subscriptions(): Promise<{ map: Map<string, billing.SubscriptionSummary>; error?: string }> {
  if (!billing.stripeEnabled()) return { map: new Map() };
  try { return { map: await billing.subscriptionsByCustomer() }; }
  catch (err) { return { map: new Map(), error: (err as Error).message }; }
}

/** Run fn over items, at most n at a time (Clerk rate limits; dozens of orgs, not thousands). */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j]); } }));
  return out;
}

// ---------- the funnel ----------

/** In order. An org's stage is the furthest step it has reached; `next` is what has to happen after that. */
export const STAGES = [
  { id: "created", label: "Account created", next: "Invite the first person" },
  { id: "invited", label: "Invited", next: "Accept the invitation email" },
  { id: "joined", label: "Joined", next: "Add the connector in Claude, ChatGPT or an IDE and sign in" },
  { id: "connected", label: "Connected", next: "Ask: \"Get me started with Octillion\"" },
  { id: "first_call", label: "First tool call", next: "Onboard a product (name, website, docs)" },
  { id: "onboarded", label: "Product onboarded", next: "Run a simulation" },
  { id: "simulated", label: "Simulation run", next: "Open the visibility report" },
  { id: "reported", label: "Report read", next: "Act on the report and re-run" },
] as const;
export type StageId = (typeof STAGES)[number]["id"];

const DAY = 86_400_000;
const daysSince = (d: Date | string | null) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : 0);
const minDate = (xs: (string | null | undefined)[]) => xs.filter(Boolean).sort()[0] ?? null;

function shapeOrg(f: OrgFacts, people: People | null, sub: billing.SubscriptionSummary | null, defaultBudget: number) {
  const members = people?.members ?? [];
  const invites = people?.invitations ?? [];
  const reached: Record<StageId, Date | string | null> = {
    created: f.created_at,
    invited: minDate(invites.map((i) => i.created_at)),
    joined: minDate(members.map((m) => m.created_at)),
    connected: f.first_seen, first_call: f.first_call_at, onboarded: f.onboarded_at, simulated: f.first_sim_at, reported: f.first_report_at,
  };
  let i = STAGES.length - 1;
  while (i > 0 && !reached[STAGES[i].id]) i--;
  const stage = STAGES[i];
  const activeMembers = members.filter((m) => m.status === "active").length;
  const pendingInvites = invites.filter((x) => x.state === "pending");
  const live = sub && ["active", "trialing"].includes(sub.status);
  // Same order as billing.orgBudget: the admin-set allowance, else a live plan's cap, else the default (0 = no runs).
  const override = f.budget_override_usd != null ? Number(f.budget_override_usd) : null;
  const budget = override ?? (live && sub!.monthly_budget_usd != null ? sub!.monthly_budget_usd : defaultBudget);
  const budgetSource = override != null ? "override" : live && sub!.monthly_budget_usd != null ? "plan" : "default";

  const attention: string[] = [];
  if (people?.error) attention.push(`Clerk: ${people.error}`);
  if (!activeMembers && !pendingInvites.length && !Number(f.active_keys)) attention.push("Nobody can get in: no active member, pending invitation or API key");
  const expired = invites.filter((x) => x.state === "expired" && !members.some((m) => (m.email ?? "") === x.email));
  if (expired.length) attention.push(`Invitation expired for ${expired.map((x) => x.email).join(", ")}: resend it`);
  if (Number(f.onboarding_failed) && !f.onboarded_at) attention.push("Product onboarding failed");
  if (Number(f.errors_7d) >= 3) attention.push(`${f.errors_7d} tool errors in the last 7 days`);
  if (sub && ["past_due", "unpaid", "incomplete"].includes(sub.status)) attention.push(`Stripe subscription is ${sub.status.replace("_", " ")}`);
  if (sub?.cancel_at_period_end) attention.push(`Subscription cancels on ${sub.renews_at?.slice(0, 10)}`);
  if (budget > 0 && Number(f.month_spend_usd) >= budget * 0.8) attention.push(`At ${Math.round((Number(f.month_spend_usd) / budget) * 100)}% of the monthly model budget`);
  const since = (d: Date | string | null) => daysSince(d);
  switch (stage.id) {
    case "created": if (f.clerk_org_id && since(f.created_at) >= 1) attention.push(`Created ${since(f.created_at)}d ago, nobody invited`); break;
    case "invited": if (pendingInvites.length && since(reached.invited) >= 2) attention.push(`Invited ${since(reached.invited)}d ago, invitation not accepted`); break;
    case "joined": if (since(reached.joined) >= 1) attention.push(`Joined ${since(reached.joined)}d ago, never connected a client`); break;
    case "connected": if (since(f.first_seen) >= 1) attention.push("Connected but never called a tool (tools may be switched off in the client)"); break;
    case "first_call": if (!Number(f.onboarding_running) && since(f.first_call_at) >= 2) attention.push("Using tools but has not onboarded a product"); break;
    case "onboarded": if (since(f.onboarded_at) >= 2) attention.push("Product onboarded, no simulation yet"); break;
    case "simulated": if (!Number(f.sims_running) && since(f.first_sim_at) >= 2) attention.push("Simulation ran, report never opened"); break;
  }
  return {
    id: f.id, slug: f.slug, name: f.name, created_at: f.created_at, clerk_org_id: f.clerk_org_id, stripe_customer_id: f.stripe_customer_id,
    stage: stage.id, stage_index: i, stage_label: stage.label, next_step: stage.next, reached,
    members: activeMembers, pending_invites: pendingInvites.length, contact: members[0]?.email ?? invites[0]?.email ?? null,
    active_keys: Number(f.active_keys), key_last_used: f.key_last_used, last_seen: f.last_seen,
    calls_7d: Number(f.calls_7d), errors_7d: Number(f.errors_7d), onboarding_running: Number(f.onboarding_running), sims_running: Number(f.sims_running),
    subscription: sub, month_spend_usd: Number(f.month_spend_usd), budget_usd: budget, budget_source: budgetSource,
    prepaid_allowed: Boolean(f.prepaid_allowed), allowance_usd: override, attention,
  };
}
export type AdminOrg = ReturnType<typeof shapeOrg>;

/** Cumulative: how many of `orgs` reached each step (their furthest step is at or past it), so the drop-off between steps is visible. */
export const funnelOf = (orgs: readonly { stage_index: number }[]) =>
  STAGES.map((s, i) => ({ id: s.id, label: s.label, reached: orgs.filter((o) => o.stage_index >= i).length }));

async function shapeAll(rows: OrgFacts[], fresh = false) {
  const subs = await subscriptions();
  const defaultBudget = integrations().default_budget_usd;
  const people = await pool(rows, 5, (r) => peopleOf(r.clerk_org_id, fresh));
  return { orgs: rows.map((r, i) => shapeOrg(r, people[i], r.stripe_customer_id ? subs.map.get(r.stripe_customer_id) ?? null : null, defaultBudget)), stripe_error: subs.error };
}

export async function listOrgs(fresh = true) {
  const rows = await (await getDb()).query<OrgFacts>(`${ORG_FACTS} ORDER BY o.created_at DESC`);
  return { stages: STAGES, ...(await shapeAll(rows, fresh)) };
}

async function factsBySlug(slug: string) {
  const [f] = await (await getDb()).query<OrgFacts>(`${ORG_FACTS} WHERE o.slug = $1`, [slug]);
  if (!f) throw new AdminError(`No organization ${slug}`, 404);
  return f;
}
async function orgBySlug(slug: string, fresh = false) {
  return (await shapeAll([await factsBySlug(slug)], fresh)).orgs[0];
}

/** `q.from` / `q.to` (YYYY-MM-DD): the funnel covers accounts created in that period; everything else is current. */
export async function overview(q: { from?: unknown; to?: unknown } = {}) {
  const db = await getDb();
  const { orgs, stripe_error } = await listOrgs();
  const range = q.from && q.to ? reportRange(q) : null;
  const cohort = range
    ? new Set((await db.query<{ slug: string }>("SELECT slug FROM organizations WHERE created_at >= $1 AND created_at < $2", [range.start, range.end])).map((r) => r.slug))
    : null;
  const inCohort = cohort ? orgs.filter((o) => cohort.has(o.slug)) : orgs;
  const [req] = await db.query<{ pending: number; approved: number; declined: number; oldest_pending: Date | null }>(
    `SELECT count(*) FILTER (WHERE status = 'pending') AS pending, count(*) FILTER (WHERE status = 'approved') AS approved,
            count(*) FILTER (WHERE status = 'declined') AS declined, min(created_at) FILTER (WHERE status = 'pending') AS oldest_pending
       FROM access_requests`);
  const subs = orgs.map((o) => o.subscription).filter(Boolean) as billing.SubscriptionSummary[];
  // The cards' sparklines: one point per day of the period (the last 30 days without one), each the figure as it
  // stood at the end of that day. Pending requests and accounts active in the 7 days to that day come from the
  // database; accounts and reports from the accounts' own dates; paying from Stripe's subscription start and end.
  const span = range ?? reportRange({ days: 30 });
  const perDay = await db.query<{ day: string; pending: unknown; active_7d: unknown }>(
    `/* tenant: internal: admin Onboarding sparklines, counts across all orgs */
     WITH d AS (SELECT generate_series($1::timestamptz, $2::timestamptz - interval '1 day', interval '1 day') AS day)
     SELECT to_char(d.day AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            (SELECT count(*) FROM access_requests q WHERE q.created_at < d.day + interval '1 day'
                AND (q.status = 'pending' OR q.decided_at >= d.day + interval '1 day')) AS pending,
            (SELECT count(DISTINCT e.org_id) FROM mcp_events e WHERE e.method = 'tools/call'
                AND e.at >= d.day - interval '6 days' AND e.at < d.day + interval '1 day') AS active_7d
       FROM d ORDER BY d.day`, [span.start, span.end]);
  const ends = perDay.map((r) => Date.parse(`${r.day}T00:00:00Z`) + DAY);
  const upTo = (dates: (Date | string | null | undefined)[]) => ends.map((e) => dates.filter((x) => x && new Date(x).getTime() < e).length);
  const spans = await billing.paidSpans().catch(() => []);
  return {
    public_url: publicUrl(), integrations: integrations(), stripe_error,
    requests: { pending: Number(req.pending), approved: Number(req.approved), declined: Number(req.declined), oldest_pending: req.oldest_pending },
    funnel: funnelOf(inCohort),
    range: range ? { from: range.from, to: range.to, days: range.days } : null,
    attention: orgs.filter((o) => o.attention.length).map((o) => ({ slug: o.slug, name: o.name, stage_label: o.stage_label, attention: o.attention, contact: o.contact, last_seen: o.last_seen })),
    active_7d: orgs.filter((o) => o.calls_7d > 0).length,
    paying: subs.filter((s) => s.status === "active").length, trialing: subs.filter((s) => s.status === "trialing").length,
    orgs: orgs.length,
    daily: {
      days: perDay.map((r) => r.day),
      pending: perDay.map((r) => Number(r.pending)), active_7d: perDay.map((r) => Number(r.active_7d)),
      accounts: upTo(orgs.map((o) => o.created_at)), reported: upTo(inCohort.map((o) => o.reached.reported)), // as the funnel counts it
      paying: ends.map((e) => new Set(spans.filter((x) => x.from < e && (x.to == null || x.to >= e)).map((x) => x.customer)).size),
    },
  };
}

export async function orgDetail(slug: string) {
  const org = await orgBySlug(slug, true);
  const db = await getDb();
  const people = await peopleOf(org.clerk_org_id);
  const sp = sparkSpans();
  const [keys, tools, clients, errors, products, research, sims, requests, invoices, perDay] = await Promise.all([
    db.query(`SELECT id, label, key_prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE org_id = $1
               ORDER BY revoked_at IS NOT NULL, created_at DESC`, [org.id]),
    db.query(`SELECT name, count(*) AS calls, count(*) FILTER (WHERE NOT ok) AS errors, round(avg(ms)) AS avg_ms, max(at) AS last
                FROM mcp_events WHERE org_id = $1 AND method = 'tools/call' GROUP BY name ORDER BY max(at) DESC`, [org.id]),
    db.query(`SELECT client, count(*) AS n, max(at) AS last FROM mcp_events WHERE org_id = $1 AND client IS NOT NULL
               GROUP BY client ORDER BY max(at) DESC LIMIT 8`, [org.id]),
    db.query(`SELECT at, method, name, error FROM mcp_events WHERE org_id = $1 AND NOT ok ORDER BY at DESC LIMIT 10`, [org.id]),
    db.query(`SELECT slug, name, website_url, created_at FROM products WHERE org_id = $1 ORDER BY created_at`, [org.id]),
    db.query(`SELECT r.id, p.name AS product, r.status, r.stage, r.error, r.created_at, r.finished_at
                FROM product_research r JOIN products p ON p.id = r.product_id WHERE r.org_id = $1 ORDER BY r.created_at DESC LIMIT 10`, [org.id]),
    db.query(`SELECT s.id, s.name, s.status, s.created_at, s.finished_at,
                     (SELECT count(*) FROM agent_sessions a WHERE a.simulation_id = s.id) AS sessions,
                     (SELECT count(*) FROM agent_sessions a WHERE a.simulation_id = s.id AND a.status = 'completed') AS completed
                FROM simulations s WHERE s.org_id = $1 ORDER BY s.created_at DESC LIMIT 10`, [org.id]),
    db.query(`SELECT id, email, company, created_at, status FROM access_requests WHERE org_id = $1 ORDER BY created_at`, [org.id]),
    org.stripe_customer_id && billing.stripeEnabled() ? billing.recentInvoices(org.stripe_customer_id).catch(() => []) : Promise.resolve([]),
    // The cards' sparklines: tool calls, errors and agent sessions per day for 30 days, model spend per day this month
    // (the same measures as calls_7d, errors_7d and month_spend_usd).
    db.query<{ k: string; day: string; v: unknown }>(
      `SELECT 'calls' AS k, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS v FROM mcp_events
        WHERE org_id = $1 AND method = 'tools/call' AND at >= $2 GROUP BY 2
       UNION ALL
       SELECT 'errors', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), count(*) FROM mcp_events WHERE org_id = $1 AND NOT ok AND at >= $2 GROUP BY 2
       UNION ALL
       SELECT 'sessions', to_char(queued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), count(*) FROM agent_sessions WHERE org_id = $1 AND queued_at >= $2 GROUP BY 2
       UNION ALL
       SELECT 'spend', to_char(a.queued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), sum(u.cost_usd) FROM gateway_usage u JOIN agent_sessions a ON a.id = u.session_id
        WHERE a.org_id = $1 AND a.queued_at >= $3 GROUP BY 2`, [org.id, sp.last30, sp.month]),
  ]);
  const testMode = integrations().stripe_test_mode;
  return {
    org, integrations: integrations(), connect: connectInfo(),
    members: people?.members ?? [],
    invitations: people?.invitations ?? [],
    clerk_error: people?.error ?? null,
    // Enterprise SSO (SAML/OIDC) is set up per organization in the Clerk dashboard; there is no hosted admin portal link.
    clerk_dashboard: org.clerk_org_id ? "https://dashboard.clerk.com/" : null,
    plans: billing.stripeEnabled() ? await billing.listPlans().catch(() => []) : [],
    invoices,
    stripe_dashboard: org.stripe_customer_id ? `https://dashboard.stripe.com/${testMode ? "test/" : ""}customers/${org.stripe_customer_id}` : null,
    keys, tools, clients, errors, products, research, simulations: sims, requests,
    daily: {
      days: sp.days30, calls: daySeries(sp.days30, perDay, "calls"), errors: daySeries(sp.days30, perDay, "errors"), sessions: daySeries(sp.days30, perDay, "sessions"),
      month_days: sp.monthDays, spend: daySeries(sp.monthDays, perDay, "spend", true),
    },
  };
}

// ---------- access requests ----------

export async function listRequests(status?: string) {
  if (status && !["pending", "approved", "declined"].includes(status)) throw new AdminError("status must be pending, approved or declined");
  return (await getDb()).query(
    `SELECT q.id, q.email, q.company, q.product_url, q.message, q.created_at, q.status, q.decided_at, o.slug AS org_slug, o.name AS org_name,
            q.name, q.role, q.team_size, q.agents, q.source, q.docs_url, q.competitors, q.goal, q.timeline, q.heard_from, q.subindustry, q.research, q.research_status, q.research_error, q.researched_at,
            (SELECT json_build_object('id', r.id, 'status', r.status, 'stage', r.stage, 'note', r.note, 'error', r.error, 'created_at', r.created_at, 'finished_at', r.finished_at)
               FROM product_research r WHERE r.kind = 'prospect' AND r.request_id = q.id ORDER BY r.created_at DESC LIMIT 1) AS deep
       FROM access_requests q LEFT JOIN organizations o ON o.id = q.org_id
      WHERE $1::text IS NULL OR q.status = $1
      ORDER BY q.status = 'pending' DESC, q.created_at DESC LIMIT 500`, [status ?? null]);
}

const intId = (v: number) => {
  if (!Number.isSafeInteger(v) || v <= 0) throw new AdminError("Invalid id");
  return v;
};
export const requestExists = async (id: number) => void (await requestById(id));
async function requestById(id: number) {
  intId(id);
  const [r] = await (await getDb()).query<{ id: number; email: string; company: string; status: string; name: string | null }>(
    "SELECT id, email, company, status, name FROM access_requests WHERE id = $1", [id]);
  if (!r) throw new AdminError(`No access request ${id}`, 404);
  return r;
}
const cleanEmail = (v: unknown) => {
  const s = String(v ?? "").trim().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new AdminError("Enter a valid email");
  return s;
};

/**
 * A new account: the Clerk organization (public_metadata.octillion_slug), the Octillion row joined to it, and a Stripe
 * customer set on both. Without Clerk, a local organization with a legacy API key.
 */
async function newAccount(actor: string, nameIn: string, slugIn: string | undefined, email: string | null) {
  const name = nameIn.trim().slice(0, 200);
  if (!name) throw new AdminError("name is required");
  const slug = slugify(slugIn || name);
  const db = await getDb();
  if ((await db.query("SELECT 1 FROM organizations WHERE slug = $1", [slug])).length)
    throw new AdminError(`The slug ${slug} is taken: pick another, or add this person to that account`, 409);
  let key: string | undefined, clerkOrgId: string | null = null;
  if (clerk.clerkEnabled()) {
    clerkOrgId = (await clerk.organizations.create(name, slug, { octillion_slug: slug })).id;
    await db.query("INSERT INTO organizations (slug, name, clerk_org_id) VALUES ($1, $2, $3)", [slug, name, clerkOrgId]);
  } else {
    key = (await createOrg(name, slug)).key;
    if (email) await db.query("UPDATE api_keys SET label = $2 WHERE org_id = (SELECT id FROM organizations WHERE slug = $1)", [slug, email]);
  }
  if (billing.stripeEnabled()) await ensureCustomer(actor, slug, email).catch((err) => console.error(`stripe customer for ${slug}:`, (err as Error).message));
  log(actor, "org.create", slug, { clerk: Boolean(clerkOrgId) });
  return { slug, name, key };
}

/** Invite a person: a Clerk invitation (Clerk emails it), or without Clerk a legacy key labelled with their email. */
async function invitePerson(actor: string, slug: string, email: string, role: AccountRole = "member") {
  const f = await factsBySlug(slug);
  if (clerk.clerkEnabled()) {
    const clerkOrgId = f.clerk_org_id ?? (await linkClerk(actor, slug)).clerk_org_id!;
    const c = clerkRoleFor(role);
    const inv = toInvite(await clerk.invitations.send(clerkOrgId, email, c.role, c.metadata));
    forget(clerkOrgId);
    log(actor, "invite.send", slug, { email, invitation: inv.id, role });
    return { invitation: { id: inv.id, email: inv.email, state: inv.state, role: inv.role, account_role: inv.account_role, expires_at: inv.expires_at }, key: undefined as string | undefined };
  }
  const key = await createApiKey(f.id, email);
  log(actor, "key.create", slug, { label: email, key_prefix: key.slice(0, 10) });
  return { invitation: null, key };
}

/** A mailto link is a URL (webmail turns it into an https one): the key never goes in it; the admin pastes it in. */
export const KEY_PLACEHOLDER = "[paste the API key here]";
const result = async (slug: string, email: string | null, extra: { key?: string; invitation?: unknown; created?: boolean }) => {
  const o = await factsBySlug(slug);
  const c = connectInfo(extra.key);
  return { org: { slug: o.slug, name: o.name }, created: extra.created ?? false, invitation: extra.invitation ?? null, key: extra.key ?? null,
           ...c, email: { ...c.email, to: email, mailto: email ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(c.email.subject)}&body=${encodeURIComponent(extra.key ? c.email.body.replaceAll(extra.key, KEY_PLACEHOLDER) : c.email.body)}` : null } };
};

/** Approve a request: a new account (name and slug default to the company), or, with `org_slug`, another person in one. */
export async function approveRequest(actor: string, id: number, opts: { name?: string; slug?: string; org_slug?: string } = {}) {
  const r = await requestById(id);
  if (r.status === "approved") throw new AdminError("This request is already approved", 409);
  let slug: string, created = false, key: string | undefined, invitation: unknown = null;
  if (opts.org_slug) slug = (await factsBySlug(opts.org_slug)).slug;
  else {
    const made = await newAccount(actor, opts.name ?? r.company, opts.slug, r.email);
    slug = made.slug; key = made.key; created = true;
  }
  // Whoever asked for a new account administers it (invites colleagues, manages billing in /app).
  if (!key) ({ key, invitation } = await invitePerson(actor, slug, r.email, created ? "owner" : undefined));
  await (await getDb()).query("UPDATE access_requests SET status = 'approved', org_id = (SELECT id FROM organizations WHERE slug = $2), decided_at = now() WHERE id = $1", [id, slug]);
  log(actor, "request.approve", slug, { request_id: id, email: r.email, new_org: created });
  const out = await result(slug, r.email, { key, invitation, created });
  // A short welcome beside Clerk's invitation (Clerk sends that one); after the write, never in its way.
  mail.fire(mail.requestApproved(r, { account: out.org.name, invited: Boolean(invitation) }));
  return out;
}

/** Decline a request; the requester gets a short note, with `reason` when one is given. */
export async function declineRequest(actor: string, id: number, reasonIn?: unknown) {
  const r = await requestById(id);
  if (r.status === "approved") throw new AdminError("Approved requests cannot be declined: remove the person from the account instead", 409);
  const reason = typeof reasonIn === "string" ? reasonIn.trim().slice(0, 1000) : "";
  await (await getDb()).query("UPDATE access_requests SET status = 'declined', decided_at = now(), decline_reason = $2 WHERE id = $1", [id, reason || null]);
  log(actor, "request.decline", null, { request_id: id, email: r.email, with_reason: Boolean(reason) });
  mail.fire(mail.requestDeclined(r, reason || null));
}

export async function reopenRequest(actor: string, id: number) {
  const r = await requestById(id);
  if (r.status !== "declined") throw new AdminError("Only declined requests can be reopened", 409);
  await (await getDb()).query("UPDATE access_requests SET status = 'pending', decided_at = NULL WHERE id = $1", [id]);
  log(actor, "request.reopen", null, { request_id: id, email: r.email });
}

// ---------- accounts and people ----------

export async function createAccount(actor: string, input: { name?: string; slug?: string; email?: string }) {
  const email = input.email ? cleanEmail(input.email) : null;
  const made = await newAccount(actor, String(input.name ?? ""), input.slug, email);
  let key = made.key, invitation: unknown = null;
  if (email && !key) ({ key, invitation } = await invitePerson(actor, made.slug, email, "owner"));
  return result(made.slug, email, { key, invitation, created: true });
}

export async function invite(actor: string, slug: string, emailIn: unknown, role?: unknown) {
  const email = cleanEmail(emailIn);
  const r = role === undefined ? "member" : parseAccountRole(role);
  if (!r) throw new AdminError(ROLE_CHOICES);
  const { key, invitation } = await invitePerson(actor, slug, email, r);
  return result(slug, email, { key, invitation });
}

/** Resend = revoke the old invitation (if still pending) and send a fresh one, which restarts its 7-day clock. */
export async function resendInvitation(actor: string, slug: string, invitationId: string) {
  const f = await factsBySlug(slug);
  const inv = (await peopleOf(f.clerk_org_id, true))?.invitations.find((x) => x.id === invitationId);
  if (!inv) throw new AdminError("No such invitation in this account", 404);
  if (inv.state === "accepted") throw new AdminError("Already accepted", 409);
  if (inv.state === "pending") await clerk.invitations.revoke(f.clerk_org_id!, inv.id);
  return invite(actor, slug, inv.email, inv.account_role);
}

export async function revokeInvitation(actor: string, slug: string, invitationId: string) {
  const f = await factsBySlug(slug);
  const inv = (await peopleOf(f.clerk_org_id, true))?.invitations.find((x) => x.id === invitationId);
  if (!inv) throw new AdminError("No such invitation in this account", 404);
  if (inv.state !== "pending") throw new AdminError(`The invitation is ${inv.state}`, 409);
  await clerk.invitations.revoke(f.clerk_org_id!, inv.id);
  forget(f.clerk_org_id);
  log(actor, "invite.revoke", slug, { email: inv.email });
}

/**
 * Suspend a person's access (or restore it). Clerk memberships have no deactivated state: suspension is the
 * membership's public_metadata.suspended, enforced by Octillion on /mcp and /api/app within a minute (caches).
 * `memberId` is the Clerk user id.
 */
export async function setMemberActive(actor: string, slug: string, memberId: string, active: boolean) {
  const f = await factsBySlug(slug);
  const people = await peopleOf(f.clerk_org_id, true);
  const m = people?.members.find((x) => x.id === memberId);
  if (!m) throw new AdminError("No such member in this account", 404);
  if (!active) lastOwnerGuard(people!.members, m, "suspend");
  await clerk.memberships.setSuspended(f.clerk_org_id!, m.user_id, !active);
  forget(f.clerk_org_id);
  log(actor, active ? "member.reactivate" : "member.deactivate", slug, { user: m.user_id, email: m.email });
}

const ROLE_CHOICES = "role must be owner, billing, member or viewer";
/** An account always keeps one active owner: the last one can't be demoted or suspended. */
function lastOwnerGuard(members: Member[], m: Member, what: "demote" | "suspend") {
  if (m.account_role !== "owner" || m.status !== "active") return;
  if (members.some((x) => x.id !== m.id && x.account_role === "owner" && x.status === "active")) return;
  throw new AdminError(`${m.email ?? "This person"} is the account's last owner. Make someone else an owner before you ${what === "demote" ? "change their role" : "suspend them"}.`, 409);
}

/**
 * Change a member's account role (owner, billing, member, viewer; admin means owner). Owner is Clerk's org:admin and
 * the rest org:member, with the role in the membership's public_metadata.octillion_role.
 */
export async function setMemberRole(actor: string, slug: string, memberId: string, roleIn: unknown) {
  const role = parseAccountRole(roleIn);
  if (!role) throw new AdminError(ROLE_CHOICES);
  const f = await factsBySlug(slug);
  const people = await peopleOf(f.clerk_org_id, true);
  const m = people?.members.find((x) => x.id === memberId);
  if (!m) throw new AdminError("No such member in this account", 404);
  if (role !== "owner") lastOwnerGuard(people!.members, m, "demote");
  const c = clerkRoleFor(role);
  await clerk.memberships.setRole(f.clerk_org_id!, m.user_id, c.role, c.metadata);
  forget(f.clerk_org_id);
  log(actor, "member.role", slug, { user: m.user_id, role, label: ACCOUNT_ROLE_LABELS[role] });
}

/** Give a legacy account (API keys only) a Clerk organization so people can be invited and sign in. */
export async function linkClerk(actor: string, slug: string) {
  const f = await factsBySlug(slug);
  if (f.clerk_org_id) return { clerk_org_id: f.clerk_org_id };
  if (!clerk.clerkEnabled()) throw new AdminError("Clerk is not configured (CLERK_SECRET_KEY)", 503);
  const c = await clerk.organizations.create(f.name, f.slug, { octillion_slug: f.slug, ...(f.stripe_customer_id ? { stripe_customer_id: f.stripe_customer_id } : {}) });
  await (await getDb()).query("UPDATE organizations SET clerk_org_id = $2 WHERE id = $1", [f.id, c.id]);
  log(actor, "org.link_clerk", slug, { clerk_org_id: c.id });
  return { clerk_org_id: c.id };
}

export async function renameOrg(actor: string, slug: string, nameIn: unknown) {
  const f = await factsBySlug(slug);
  const name = String(nameIn ?? "").trim().slice(0, 200);
  if (!name) throw new AdminError("name cannot be empty");
  await (await getDb()).query("UPDATE organizations SET name = $2 WHERE id = $1", [f.id, name]);
  if (f.clerk_org_id) await clerk.organizations.rename(f.clerk_org_id, name);
  log(actor, "org.rename", slug, { name });
  return orgBySlug(slug);
}

// ---------- billing, in Stripe ----------

/** The Stripe customer for an account, created on first need and recorded on the Clerk organization too. */
export async function ensureCustomer(actor: string, slug: string, email?: string | null) {
  // Writes the account's Stripe link, which only the platform may change (src/tenant-scope.ts).
  return asPlatform(async () => {
  const f = await factsBySlug(slug);
  if (f.stripe_customer_id) return f.stripe_customer_id;
  if (!billing.stripeEnabled()) throw new AdminError("Stripe is not configured (STRIPE_SECRET_KEY)", 503);
  const c = await billing.createCustomer({ name: f.name, email, slug: f.slug, clerkOrgId: f.clerk_org_id });
  await (await getDb()).query("UPDATE organizations SET stripe_customer_id = $2 WHERE id = $1", [f.id, c.id]);
  if (f.clerk_org_id) await clerk.organizations.setMetadata(f.clerk_org_id, { stripe_customer_id: c.id }).catch((err) => console.error("clerk stripe link:", (err as Error).message));
  log(actor, "billing.customer", slug, { customer: c.id });
  return c.id;
});
}

/** A Stripe Checkout link for a plan, to send to the account's billing contact. */
/** Allow (or stop allowing) an account to subscribe to a prepaid plan. Plans are invite-only. */
export async function setPrepaidAllowed(actor: string, slug: string, allowed: unknown) {
  if (typeof allowed !== "boolean") throw new AdminError("allowed must be true or false");
  const [r] = await (await getDb()).query<{ slug: string }>("UPDATE organizations SET prepaid_allowed = $2 WHERE slug = $1 RETURNING slug", [slug, allowed]);
  if (!r) throw new AdminError(`No account ${slug}`, 404);
  log(actor, allowed ? "billing.prepaid_allowed" : "billing.prepaid_revoked", slug, {});
  return { slug, prepaid_allowed: allowed };
}

/** Set an account's monthly allowance by hand (USD; null clears it, so its plan or $0 applies again). */
export async function setAllowance(actor: string, slug: string, usd: unknown) {
  const v = usd === null || usd === "" ? null : Number(usd);
  if (v !== null && (!Number.isFinite(v) || v < 0 || v > 1_000_000)) throw new AdminError("allowance must be a dollar amount from 0 to 1,000,000, or null to clear it");
  const [r] = await (await getDb()).query<{ slug: string }>("UPDATE organizations SET budget_override_usd = $2 WHERE slug = $1 RETURNING slug", [slug, v]);
  if (!r) throw new AdminError(`No account ${slug}`, 404);
  log(actor, "billing.allowance_set", slug, { usd: v });
  return { slug, allowance_usd: v };
}

/**
 * A checkout link for one plan. From the customer's Billing page (requireAllowed) only a plan the account is offered
 * (src/experiments.ts offeredPlans: its own variant of each experiment) may be used. The session and subscription are
 * tagged with the account, and with the experiment and variant when the account was assigned this variant, so the
 * Experiments tab reads the conversion from Stripe; a link an admin sends for another variant is not counted in it.
 */
export async function checkoutLink(actor: string, slug: string, priceId: unknown, returnUrl = `${publicUrl()}/app/billing`, opts: { requireAllowed?: boolean } = {}) {
  const db = await getDb();
  const [o] = await db.query<{ id: number; prepaid_allowed: boolean }>("SELECT id, prepaid_allowed FROM organizations WHERE slug = $1", [slug]);
  if (!o) throw new AdminError(`No account ${slug}`, 404);
  if (opts.requireAllowed && !o.prepaid_allowed) throw new AdminError("Prepaid plans are invite-only: ask your Octillion contact to enable one for this account.", 403);
  const plans = await billing.listPlans();
  const offered = opts.requireAllowed ? await experiments.offeredPlans(o.id, plans) : plans;
  const plan = offered.find((p) => p.price_id === priceId);
  if (!plan) throw new AdminError(opts.requireAllowed && plans.some((p) => p.price_id === priceId) ? "That plan is not offered to this account" : "Unknown plan: use a price whose lookup_key starts with octillion_");
  const [shown] = plan.experiment ? await db.query<{ price_id: string }>("SELECT price_id FROM plan_exposures WHERE org_id = $1 AND experiment = $2", [o.id, plan.experiment]) : [];
  const meta = shown?.price_id === plan.price_id ? experiments.checkoutMeta(slug, plan) : { octillion_slug: slug };
  const customer = await ensureCustomer(actor, slug);
  billing.invalidateSubscriptions();
  log(actor, "billing.checkout_link", slug, { price: plan.price_id, ...(meta.octillion_experiment ? { experiment: meta.octillion_experiment } : {}) });
  return { url: await billing.checkoutUrl(customer, plan.price_id, returnUrl, meta, plan.trial_days, plan.usage.map((u) => u.price_id)) };
}

/** A Stripe customer-portal link: plan changes, card, invoices, cancellation. */
export async function portalLink(actor: string, slug: string, returnUrl = `${publicUrl()}/app/billing`) {
  const customer = await ensureCustomer(actor, slug);
  billing.invalidateSubscriptions();
  log(actor, "billing.portal_link", slug);
  return { url: await billing.portalUrl(customer, returnUrl) };
}

// ---------- plans (Stripe prices with an octillion_ lookup key; FinOps › Plans › New plan) ----------

export async function plans() {
  if (!billing.stripeEnabled()) return { configured: false, plans: [] as billing.Plan[] };
  return { configured: true, plans: await billing.listPlans() };
}

/**
 * A new plan in Stripe. Either the New plan form's fields (name, amount_usd, interval, monthly_budget_usd,
 * lookup_key, experiment, weight, trial_days, description) or a whole JSON plan config ({config}, src/plan-config.ts:
 * base fee, usage pricing on the model-spend meter, tiers, trial, cap, experiment, metadata). Both are checked by
 * parsePlanConfig and made by billing.createPlanFromConfig; {dry_run: true} returns what would be made in Stripe.
 */
export async function createPlan(actor: string, body: Record<string, unknown>) {
  if (!billing.stripeEnabled()) throw new AdminError("Stripe is not set up on this server", 503);
  let cfg;
  try { cfg = parsePlanConfig(body.config != null ? body.config : formConfig(body)); }
  catch (e) { throw e instanceof PlanConfigError ? Object.assign(new AdminError(e.message, 400), { problems: e.problems }) : e; }
  const r = await billing.createPlanFromConfig(cfg, body.dry_run === true);
  if (r.dry_run) return r;
  log(actor, "billing.plan_create", null, { price: r.price_id, usage_prices: r.usage_price_ids, lookup_key: r.lookup_key, base_fee_usd: cfg.base_fee_usd, interval: cfg.interval,
    monthly_budget_usd: cfg.monthly_budget_usd, usage: cfg.usage.map((u) => ({ metric: u.metric, meter: u.meter, included: u.included, tiers: u.tiers.length })),
    experiment: cfg.experiment, weight: cfg.weight, trial_days: cfg.trial_days });
  return { ...r, amount: Math.round(cfg.base_fee_usd * 100), interval: cfg.interval, monthly_budget_usd: cfg.monthly_budget_usd, weight: cfg.weight, trial_days: cfg.trial_days, description: cfg.description };
}

/** The New plan form as a plan config: the price is the base fee; an empty allowance is the price. */
function formConfig(body: Record<string, unknown>) {
  const blank = (v: unknown) => v == null || v === "";
  const n = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v);
  if (!(Number(body.amount_usd) > 0)) throw new AdminError("The price must be more than $0 and at most $100,000");
  const cap = Number(body.monthly_budget_usd), price = Number(body.amount_usd);
  if (!blank(body.monthly_budget_usd) && Number.isFinite(cap) && cap > price * 10) throw new AdminError(`The monthly allowance must be from $0 to $${(price * 10).toLocaleString("en-US")} (ten times the price)`);
  return { name: body.name, interval: body.interval ?? "month", base_fee_usd: n(body.amount_usd), ...(blank(body.monthly_budget_usd) ? {} : { monthly_budget_usd: n(body.monthly_budget_usd) }),
    ...(blank(body.lookup_key) ? {} : { lookup_key: body.lookup_key }), ...(blank(body.description) ? {} : { description: body.description }),
    ...(blank(body.trial_days) ? {} : { trial_days: n(body.trial_days) }), ...(blank(body.experiment) ? {} : { experiment: body.experiment, ...(blank(body.weight) ? {} : { weight: n(body.weight) }) }) };
}

const experimentOf = (body: Record<string, unknown>) => {
  const raw = body.experiment == null ? "" : String(body.experiment).trim();
  const experiment = raw ? billing.experimentKey(raw) : null;
  if (raw && !experiment) throw new AdminError("The experiment name needs letters or digits");
  const weight = body.weight == null || body.weight === "" ? 1 : Number(body.weight);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 100) throw new AdminError("The traffic weight must be above 0 and at most 100");
  return { experiment, weight };
};

/** Put a plan in a pricing experiment, change its weight, or take it out (experiment empty). Stripe price metadata. */
export async function setPlanExperiment(actor: string, priceId: string, body: Record<string, unknown>) {
  if (!billing.stripeEnabled()) throw new AdminError("Stripe is not set up on this server", 503);
  const { experiment, weight } = experimentOf(body);
  const r = await billing.setPlanExperiment(priceId, experiment, weight);
  log(actor, "billing.plan_experiment", null, r);
  return r;
}

/** Archive a plan in Stripe (never deleted): new checkouts can't use it; current subscribers keep it. */
export async function archivePlan(actor: string, priceId: string) {
  if (!billing.stripeEnabled()) throw new AdminError("Stripe is not set up on this server", 503);
  const r = await billing.archivePlan(priceId);
  log(actor, "billing.plan_archive", null, { price: r.price_id, lookup_key: r.lookup_key });
  return r;
}

// ---------- legacy API keys (beta links, header-only clients) ----------

export async function issueKey(actor: string, slug: string, label?: string) {
  const f = await factsBySlug(slug);
  const l = String(label ?? "").trim().slice(0, 200) || "extra";
  // Labelled with a member's email: the key is that person's, so their calls are theirs (not "Connector key").
  const owner = l.includes("@") ? (await team(slug).catch(() => null))?.members.find((m) => (m.email ?? "").toLowerCase() === l.toLowerCase())?.user_id ?? null : null;
  const key = await createApiKey(f.id, l, owner);
  log(actor, "key.create", slug, { label: l, key_prefix: key.slice(0, 10) });
  return result(slug, l.includes("@") ? l : null, { key });
}

async function keyOf(slug: string, keyId: number) {
  intId(keyId);
  const f = await factsBySlug(slug);
  const [k] = await (await getDb()).query<{ id: number; label: string; key_prefix: string; revoked_at: Date | null; user_id: string | null }>(
    "SELECT id, label, key_prefix, revoked_at, user_id FROM api_keys WHERE id = $1 AND org_id = $2", [keyId, f.id]);
  if (!k) throw new AdminError(`No key ${keyId} in ${slug}`, 404);
  return { f, k };
}

export async function revokeKey(actor: string, slug: string, keyId: number) {
  const { f, k } = await keyOf(slug, keyId);
  if (k.revoked_at) throw new AdminError("This key is already revoked", 409);
  await (await getDb()).query("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND org_id = $2", [k.id, f.id]);
  log(actor, "key.revoke", slug, { label: k.label, key_prefix: k.key_prefix });
}

/** Revoke a key and issue its replacement under the same label and for the same person (a leaked link). */
export async function rotateKey(actor: string, slug: string, keyId: number) {
  const { f, k } = await keyOf(slug, keyId);
  if (!k.revoked_at) await (await getDb()).query("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND org_id = $2", [k.id, f.id]);
  const key = await createApiKey(f.id, k.label, k.user_id);
  log(actor, "key.rotate", slug, { label: k.label, user_id: k.user_id, old_prefix: k.key_prefix, key_prefix: key.slice(0, 10) });
  return result(slug, k.label.includes("@") ? k.label : null, { key });
}

// ---------- for the customer page (src/app.ts) ----------

/** An account's people from Clerk (cached for a minute unless `fresh`), shaped for display. */
export async function team(slug: string, fresh = false) {
  const f = await factsBySlug(slug);
  const people = await peopleOf(f.clerk_org_id, fresh);
  return {
    clerk: Boolean(f.clerk_org_id && clerk.clerkEnabled()), error: people?.error ?? null,
    members: people?.members ?? [],
    invitations: (people?.invitations ?? []).filter((x) => x.state === "pending" || x.state === "expired"),
  };
}
export { factsBySlug as accountFacts, STAGES as ACCOUNT_STAGES };
