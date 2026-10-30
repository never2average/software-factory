/**
 * The admin MCP server (/admin/mcp, also /api/admin/mcp): the /admin panel's reads and a few safe changes as tools, so
 * platform staff can ask Claude Code, Cursor or Claude Desktop "what is waiting on me?" or "approve request 42".
 * The customer server (src/server.ts, /mcp) is one account's; this one is every account's, so only platform admins
 * connect, and each tool needs the same permission (src/admin-roles.ts) as the HTTP route it mirrors: a viewer reads
 * everything, changes need support, operator or owner exactly as on the panel.
 *
 * Auth is the customer /mcp's: Clerk is the OAuth server (the 401 points at this resource's protected-resource
 * metadata), the access token names a Clerk user, and that user's platform role (Clerk public_metadata.platform_role,
 * or APP_PLATFORM_ADMINS) is checked on every request. An admin token (src/admin-tokens.ts) acts with the role it
 * was minted for, as on /api/admin. Session tokens and account API keys are refused.
 *
 * Audit: every call is a row in admin_access_log (method MCP, path /admin/mcp/<tool>), like every /api/admin request;
 * every change also writes an admin log line (src/admin.ts log, with the caller's role) as the panel's routes do.
 * Tools reuse the panel's functions; nothing here decides anything a route does not. Secrets never leave: the key
 * vault gives hints, and a legacy API key minted by an approval is reported as issued, never returned.
 */
import { PROFILE } from "./profile.js";
import { ADMIN_SKILL_TEXTS, type AdminSkillName } from "./admin-skills.js";
import type { Express, Request, Response } from "express";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { fitPayload } from "./server.js";
import { bearer } from "./auth.js";
import { resolveAdminToken } from "./admin-tokens.js";
import { adminContext, can, platformRoleFor, refusal, ROLE_LABELS, PERMISSIONS, type Permission, type PlatformRole } from "./admin-roles.js";
import { clerkEnabled, frontendApi, mcpAudience, mcpAudiences, verifyOAuthToken } from "./clerk.js";
import { getDb } from "./db.js";
import * as onboarding from "./admin.js";
import { modelKeys, saveSettingValues } from "./platform-keys.js";
import { hosts, packConfigs, type HostAdminTool } from "./host.js";
import { fillTemplate, summaryValues } from "./text-template.js";
import * as jobs from "./compute-jobs.js";
import * as spend from "./spend.js";
import { computeSummary } from "./compute.js";
import { platformAnalytics } from "./insights.js";
import { listSettings, settingGroups } from "./settings.js";
import { KEY_PREFIX, NS } from "./namespace.js";
import { persistedKey } from "./env-names.js";
import { sessionEngine } from "./host-tables.js";
import { adminGeneratedTools, generatedAdminInstructions } from "./mcp-tools.js";
import { reserveAdminTools } from "./packs.js";
import type { AdminShellToolName, SameNames } from "./shell-tools.js";
import { labelledAnswers } from "./access-request.js";
import { GENERATED_ACCESS_FIELDS } from "./access-request.generated.js";

/** update_setting's example key: a shell setting, or in a build with the session engine (a host pack's tables) the
 * session engine's own spelling, as its admins have always seen it (the stored key prefix, src/settings.ts). */
const SETTING_EXAMPLE = sessionEngine() ? persistedKey("MAX_RUN_SESSIONS") : "DOCS_ANSWERS_DAILY_MAX";

/** Who is calling: the name changes are logged under (their email, or the token's X-Admin-Actor label) and their role. */
export interface AdminCaller { actor: string; role: PlatformRole; userId: string | null; ip?: string }

type Args = Record<string, any>;
interface AdminTool {
  title: string; description: string;
  /** The permission the matching HTTP route needs ("read" = any admin). */
  needs: Permission;
  destructive?: boolean;
  input: z.ZodRawShape;
  run: (a: Args, c: AdminCaller) => Promise<unknown>;
  /** One line for the text result, above the JSON. */
  summary: (d: any, a: Args) => string;
}

const range = { from: z.string().optional().describe("First day, YYYY-MM-DD (default: the page's default period)"), to: z.string().optional().describe("Last day, YYYY-MM-DD") };
const daily = z.boolean().optional().describe("Keep the per-day series (default false: totals and rows only)");
const usd = (x: unknown) => `$${Number(x ?? 0).toFixed(2)}`;
const n = (x: unknown) => Number(x ?? 0);
const pick = <T extends Record<string, any>, K extends keyof T>(o: T, keys: K[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])) as Pick<T, K>;
/** Per-day series (daily_*, daily) are most of a report's size and a chat rarely needs them. */
const dropDaily = (v: any): any => Array.isArray(v) ? v.map(dropDaily)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !/^daily(_|$)/.test(k)).map(([k, x]) => [k, dropDaily(x)])) : v;
const maybeDaily = (d: unknown, a: Args) => (a.include_daily ? d : dropDaily(d));

/** An account row as list_accounts shows it: who they are, where they are in the funnel, money and what needs attention. */
const accountRow = (o: onboarding.AdminOrg) => ({
  ...pick(o, ["slug", "name", "created_at", "stage", "stage_label", "next_step", "members", "pending_invites", "contact", "last_seen", "calls_7d", "errors_7d",
    "sims_running", "month_spend_usd", "budget_usd", "budget_source", "prepaid_allowed", "allowance_usd", "attention"]),
  plan: o.subscription ? pick(o.subscription, ["plan", "status", "renews_at", "cancel_at_period_end"]) : null,
});

/**
 * The tools, in the order clients list them: reads first, then changes. `needs` mirrors http.ts: e.g. POST
 * /requests/:id/approve has need("requests"), so approve_access_request needs "requests" (support and up).
 */
export const ADMIN_TOOLS = {
  list_accounts: {
    title: "Accounts", needs: "read",
    description: `Every customer account across ${PROFILE.name}: funnel stage and next step, people, tool calls and errors in 7 days, model spend this month against its allowance, plan, and what needs attention. Filter with q (name or slug) or attention_only.`,
    input: { q: z.string().optional().describe("Part of the account name or slug"), attention_only: z.boolean().optional().describe("Only accounts with something needing attention"),
             limit: z.number().int().min(1).max(500).optional().describe("Default 100") },
    run: async (a) => {
      const { orgs, stages, stripe_error } = await onboarding.listOrgs(false);
      const needle = String(a.q ?? "").toLowerCase();
      const rows = orgs.filter((o) => (!needle || `${o.slug} ${o.name}`.toLowerCase().includes(needle)) && (!a.attention_only || o.attention.length));
      return { total: rows.length, stripe_error, funnel: onboarding.funnelOf(orgs), stages: stages.map((s) => s.id), accounts: rows.slice(0, a.limit ?? 100).map(accountRow) };
    },
    summary: (d) => `${d.total} account(s); ${d.accounts.filter((x: any) => x.attention.length).length} need attention.`,
  },
  get_account: {
    title: "Account detail", needs: "read",
    description: "One account (by slug): its row from list_accounts plus people and invitations (Clerk), API keys (prefixes only), tool use, recent errors, invoices and links to Clerk and Stripe.",
    input: { slug: z.string().describe("Account slug (list_accounts)") },
    run: async (a) => {
      const d = await onboarding.orgDetail(String(a.slug));
      const { daily: _d, plans: _p, integrations: _i, connect: _c, org, ...rest } = d;
      return { account: accountRow(org), ...rest };
    },
    summary: (d) => `${d.account.name} (${d.account.slug}): ${d.account.stage_label}, ${d.members.length} member(s).`,
  },
  list_access_requests: {
    title: "Access requests", needs: "read",
    description: "Access requests from the landing page, pending first: who asked, the company, their answers and the background research on them. Approve or decline with approve_access_request / decline_access_request.",
    input: { status: z.enum(["pending", "approved", "declined"]).optional().describe("Default: all, pending first"), limit: z.number().int().min(1).max(500).optional().describe("Default 50") },
    run: async (a) => {
      const rows = await onboarding.listRequests(a.status);
      // Each request's answers to the build's own questions under their labels (mold_v0-102, src/access-request.ts).
      const requests = rows.slice(0, a.limit ?? 50).map((r: any) => ({ ...r, answers: Object.fromEntries(labelledAnswers(GENERATED_ACCESS_FIELDS, r.answers).map((x) => [x.label, x.text])) }));
      return { total: rows.length, pending: rows.filter((r: any) => r.status === "pending").length, requests };
    },
    summary: (d) => `${d.total} request(s), ${d.pending} pending.`,
  },
  health_summary: {
    title: "Compute health", needs: "read",
    description: "The Compute page's summary: verdict (what is wrong, worst first), autoscaler tick, queue, running sessions and orchestrators, waits, failures in 24 hours with top reasons, spend today, sandbox limits and the sandbox provider. failures: true adds failures by reason.",
    input: { failures: z.boolean().optional().describe("Also group failed sessions and orchestrator launches by reason"), fresh: z.boolean().optional().describe("Ask the sandbox provider again instead of the cached figures") },
    run: async (a) => {
      const { settings: _s, knobs: _k, ...s } = await computeSummary({ fresh: a.fresh === true });
      return { ...s, ...(a.failures ? { failures: await jobs.computeFailures({}) } : {}) };
    },
    summary: (d) => `${d.verdict.map((v: any) => `${v.level}: ${v.text}`).join(" | ") || "No verdict."} Queue ${d.queue.sessions} session(s); running ${d.running.sessions}; failures 24h ${d.failures_24h.sessions}.`,
  },
  finops_revenue: {
    title: "Revenue", needs: "read",
    description: "FinOps › Revenue: Stripe MRR, collected, paying accounts and gross margin against metered model spend, by account and by plan, for a period. Stripe off or down says so instead of failing.",
    input: { ...range, include_daily: daily },
    run: async (a) => maybeDaily(await (await import("./revenue.js")).revenueReport(a), a),
    summary: (d) => d.stripe?.error ? `Stripe: ${d.stripe.error}` : d.totals ? `MRR ${usd(d.totals.mrr_usd)}, collected ${usd(d.totals.collected_usd)}, ${d.totals.paying_accounts} paying, spend ${usd(d.totals.spend_usd)}.` : "Stripe is not configured.",
  },
  finops_plans: {
    title: "Plans", needs: "read",
    description: `Prepaid plans in Stripe (prices with ${/^[aeiou]/.test(KEY_PREFIX) ? "an" : "a"} ${KEY_PREFIX} lookup key): price, interval, allowance, usage pricing, experiment and weight, trial, and each plan's JSON config (what create_plan takes).`,
    input: {},
    run: () => onboarding.plans(),
    summary: (d) => (d.configured ? `${d.plans.length} plan(s).` : "Stripe is not configured on this server."),
  },
  finops_experiments: {
    title: "Pricing experiments", needs: "read",
    description: "FinOps › Experiments: each pricing experiment's variants (plans), accounts exposed, checkouts, conversions and money collected, for a period.",
    input: { ...range, include_daily: daily },
    run: async (a) => maybeDaily(await (await import("./experiments.js")).experimentsReport(a), a),
    summary: (d) => d.stripe?.error ? `Stripe: ${d.stripe.error}` : d.totals ? `${d.totals.running} running of ${d.totals.experiments} experiment(s); ${d.totals.converted} converted.` : "Stripe is not configured.",
  },
  model_spend: {
    title: "Model spend", needs: "read",
    description: "FinOps › Spend: metered model spend by account, model and provider for a period (sessions and orchestrators). With account (a slug, or 'shared'), that account's breakdown.",
    input: { ...range, account: z.string().optional().describe(`Account slug, or 'shared' for ${PROFILE.name}'s own spend`), include_daily: daily },
    run: async (a) => maybeDaily(a.account ? await spend.accountSpend(String(a.account), a) : await spend.spendReport(a), a),
    summary: (d, a) => (a.account ? `Spend for ${a.account}: ${usd(d.totals?.total_usd ?? d.spent_usd)}.` : `Total ${usd(d.totals.total_usd)} (sessions ${usd(d.totals.session_usd)}, orchestrators ${usd(d.totals.orchestrator_usd)}) across ${d.accounts.length} account(s).`),
  },
  analytics_overview: {
    title: "Platform analytics", needs: "read",
    description: "Insights › Analytics: active accounts and people, tool calls, error rate and latency with change on the previous period, top tools and clients, accounts (with at-risk flags), retention, operations and recent errors.",
    input: { ...range, days: z.number().int().min(1).max(365).optional().describe("Instead of from/to: the last N days"), include_daily: daily },
    run: async (a) => {
      const { facets: _f, filters: _x, ...d } = await platformAnalytics(a);
      return maybeDaily({ ...d, accounts: d.accounts.slice(0, 50), errors: d.errors.slice(0, 20) }, a);
    },
    summary: (d) => `${d.totals.active_accounts} active account(s), ${d.totals.active_people} people, ${d.totals.calls} call(s), ${d.totals.error_pct}% errors over ${d.range.days} day(s).`,
  },
  list_settings: {
    title: "Platform settings", needs: "read",
    description: "Global settings (Compute › Settings and Agent configuration): each key with its value in force, where it comes from (set on /admin, the environment, or the default), limits and who last changed it. Change one with update_setting.",
    // The groups of this build's settings (src/settings.ts: the shell's and its host packs'), read when the server is built.
    // The docs answers' group is changed on the console only.
    get input() { return { group: z.enum(settingGroups().map((g) => g.id).filter((g) => g !== "docs") as [string, ...string[]]).optional() }; },
    run: async (a) => {
      const all = await listSettings();
      return { settings: all.filter((s) => !a.group || s.group === a.group).map((s) => pick(s, ["key", "group", "label", "help", "kind", "value", "default", "source", "options", "min", "max", "updated_at", "updated_by"])) };
    },
    summary: (d) => `${d.settings.length} setting(s); ${d.settings.filter((s: any) => s.source === "set").length} set on /admin.`,
  },
  key_vault_status: {
    title: "Key vault", needs: "read",
    description: "Model and sandbox provider keys: each provider (mode, enabled, keys, last use) and each credential's hint, label, priority, enabled and uses. Never a secret.",
    input: {},
    run: async () => {
      const k = await modelKeys();
      return { unlocked: k.unlocked, providers: k.providers,
        credentials: k.credentials.map((c: any) => pick(c, ["id", "provider", "label", "hint", "priority", "enabled", "uses", "last_used_at", "created_at", "rotated_at", "project_id", "client_email", "bucket", "endpoint"])) };
    },
    summary: (d) => `${d.unlocked ? "Unlocked" : "LOCKED (APP_VAULT_KEY unset)"}; ${d.providers.length} provider(s), ${d.credentials.length} key(s), ${d.providers.filter((p: any) => p.enabled && !p.enabled_keys).length} enabled provider(s) without a key.`,
  },

  // ---------- changes ----------
  approve_access_request: {
    title: "Approve an access request", needs: "requests",
    description: "Approve a pending access request: a new account (name and slug default to the company) with the requester invited as its owner, or with org_slug another person in an existing account. Clerk emails the invitation.",
    input: { id: z.number().int().positive().describe("Access request id (list_access_requests)"), name: z.string().optional().describe("Account name (default: the company)"),
             slug: z.string().optional().describe("Account slug (default: from the name)"), org_slug: z.string().optional().describe("Add them to this existing account instead") },
    run: async (a, c) => {
      const r = await onboarding.approveRequest(c.actor, a.id, pick(a, ["name", "slug", "org_slug"]));
      // Without Clerk the approval mints a legacy API key: it is shown once on the panel, never sent to a chat.
      return { org: r.org, created: r.created, invitation: r.invitation, connector_url: r.secret ? null : r.connector_url,
        key_issued: Boolean(r.key), ...(r.key ? { note: "A legacy API key was issued. Rotate it from the account page on /admin to hand over a link." } : {}) };
    },
    summary: (d) => `Approved: ${d.created ? "new account" : "added to"} ${d.org.name} (${d.org.slug})${d.invitation ? `, invitation sent to ${d.invitation.email}` : ""}.`,
  },
  decline_access_request: {
    title: "Decline an access request", needs: "requests", destructive: true,
    description: "Decline a pending access request. The requester gets a short note, with the reason when one is given.",
    input: { id: z.number().int().positive().describe("Access request id"), reason: z.string().max(1000).optional().describe("Sent to the requester") },
    run: async (a, c) => { await onboarding.declineRequest(c.actor, a.id, a.reason); return { id: a.id, status: "declined" }; },
    summary: (d) => `Request ${d.id} declined.`,
  },
  set_account_allowance: {
    title: "Set an account's allowance", needs: "accounts",
    description: "Set an account's monthly model-spend allowance by hand, in USD (0 to 1,000,000). null clears it, so its plan's allowance (or the default) applies again.",
    input: { slug: z.string(), usd: z.number().min(0).max(1_000_000).nullable().describe("Dollars a month, or null to clear") },
    run: (a, c) => onboarding.setAllowance(c.actor, String(a.slug), a.usd),
    summary: (d) => `${d.slug}: allowance ${d.allowance_usd == null ? "cleared" : usd(d.allowance_usd)}.`,
  },
  allow_prepaid_plans: {
    title: "Allow prepaid plans", needs: "accounts",
    description: "Allow (or stop allowing) an account to subscribe to a prepaid plan from its Billing page. Plans are invite-only.",
    input: { slug: z.string(), allowed: z.boolean() },
    run: (a, c) => onboarding.setPrepaidAllowed(c.actor, String(a.slug), a.allowed),
    summary: (d) => `${d.slug}: prepaid plans ${d.prepaid_allowed ? "allowed" : "not allowed"}.`,
  },
  create_plan: {
    title: "Create a plan", needs: "plans",
    description: "A new prepaid plan in Stripe, from the same JSON config as FinOps › Plans › New plan › JSON (name, interval, base_fee_usd, monthly_budget_usd, usage pricing with tiers, trial_days, experiment, weight, metadata), or the form's fields. Use dry_run: true first: it checks the config and lists what would be made in Stripe without making it.",
    input: { config: z.record(z.string(), z.unknown()).optional().describe("The plan config (src/plan-config.ts); finops_plans shows existing plans' configs"),
             name: z.string().optional(), amount_usd: z.number().optional(), interval: z.enum(["month", "year"]).optional(), monthly_budget_usd: z.number().optional(),
             trial_days: z.number().int().optional(), experiment: z.string().optional(), weight: z.number().optional(), description: z.string().optional(),
             dry_run: z.boolean().optional().describe("Check and preview only; nothing is created") },
    run: async (a, c) => {
      try { return await onboarding.createPlan(c.actor, a); }
      catch (e) {
        // A config's problems come as a list by path, as the JSON editor shows them.
        const problems = (e as { problems?: string[] }).problems;
        if (problems?.length) throw Object.assign(new Error(`${(e as Error).message}\n- ${problems.join("\n- ")}`), { status: 400 });
        throw e;
      }
    },
    summary: (d) => (d.dry_run ? `Dry run: ${d.stripe?.length ?? 0} Stripe object(s) would be made.\n${(d.lines ?? []).join("\n")}` : `Plan created: ${d.lookup_key} (${d.price_id}).`),
  },
  archive_plan: {
    title: "Archive a plan", needs: "plans", destructive: true,
    description: "Archive a plan in Stripe (never deleted): new checkouts can't use it; current subscribers keep it.",
    input: { price_id: z.string().describe("The plan's Stripe price id (finops_plans)") },
    run: (a, c) => onboarding.archivePlan(c.actor, String(a.price_id)),
    summary: (d) => `Archived ${d.lookup_key ?? d.price_id}.`,
  },
  set_plan_experiment: {
    title: "Set a plan's experiment", needs: "plans",
    description: "Put a plan in a pricing experiment with a traffic weight (above 0, at most 100), change its weight, or take it out (experiment empty).",
    input: { price_id: z.string(), experiment: z.string().optional().describe("Experiment name; empty takes the plan out"), weight: z.number().optional().describe("Default 1") },
    run: (a, c) => onboarding.setPlanExperiment(c.actor, String(a.price_id), pick(a, ["experiment", "weight"])),
    summary: (d) => `${d.price_id ?? "Plan"}: ${d.experiment ? `in ${d.experiment} at weight ${d.weight}` : "in no experiment"}.`,
  },
  update_setting: {
    title: "Change a platform setting", needs: "compute",
    description: "Change one global setting (list_settings shows the keys, limits and current values). value null resets it to the environment or default. Every server picks it up within 30 seconds.",
    input: { key: z.string().describe(`Setting key, e.g. ${SETTING_EXAMPLE}`), value: z.union([z.string(), z.number(), z.null()]).describe("New value, or null to reset") },
    run: async (a, c) => {
      await saveSettingValues(c.actor, { [String(a.key)]: a.value });
      const s = (await listSettings({ all: true })).find((x) => x.key === a.key)!; // a setting this build does not list may still be set
      return pick(s, ["key", "label", "value", "source", "updated_at", "updated_by"]);
    },
    summary: (d) => `${d.key} = ${JSON.stringify(d.value)} (${d.source}).`,
  },
} satisfies Record<string, AdminTool>;

// The build reads the shell's own admin tools from src/shell-tools.ts (mold_v0-067): a change here alone does not
// typecheck. A host pack's admin tools (below) are its own, placed among these.
const sameAdminNames: SameNames<keyof typeof ADMIN_TOOLS, AdminShellToolName> = true;
void sameAdminNames;
export type AdminToolName = string;
/**
 * The admin MCP's own tools in the order clients list them: the shell's, with each host pack's (src/host.ts, mold_v0-039)
 * after the shell tool it names (else after the shell's reads).
 */
export function adminTools(): Record<string, AdminTool> {
  const out: [string, AdminTool][] = Object.entries(ADMIN_TOOLS as Record<string, AdminTool>).map(([name, t]) => [name, { ...t }]);
  // A pack may reword a shell tool (mold_v0-049; its pack.json admin_mcp.reword since mold_v0-140): its description and its
  // summary line (a template filled with the result's fields), never its input, permission or run.
  for (const c of packConfigs()) for (const [name, w] of Object.entries(c.admin_mcp?.reword ?? {})) {
    const at = out.find(([n]) => n === name);
    if (!at) throw new Error(`pack ${c.pack}: pack.json admin_mcp.reword names admin tool ${name}, which is not the shell's`);
    if (w.description !== undefined) at[1].description = w.description;
    const template = w.summary_template;
    if (template !== undefined) at[1].summary = (d) => fillTemplate(template, summaryValues(d));
  }
  for (const h of hosts()) for (const [name, t] of Object.entries(h.adminMcp?.tools ?? {})) {
    if (out.some(([n]) => n === name)) throw new Error(`host pack ${h.id}: admin tool ${name} is already the shell's`);
    let lastRead = -1;
    out.forEach(([, x], i) => { if (x.needs === "read") lastRead = i; });
    const at = t.after ? out.findIndex(([n]) => n === t.after) : lastRead;
    if (t.after && at < 0) throw new Error(`host pack ${h.id}: admin tool ${name} comes after ${t.after}, which is no admin tool`);
    const { after: _a, ...tool } = t as HostAdminTool;
    out.splice(at + 1, 0, [name, tool]);
  }
  return Object.fromEntries(out);
}
export const adminToolNames = (): string[] => Object.keys(adminTools());
// The tools generated from the packs (mold_v0-060, src/mcp-tools.ts) come after these and may not take one of their names.
reserveAdminTools(adminToolNames);

/** For the panel's Connect page: each tool, the least role that may call it, and whether it changes something. */
export const adminToolList = () => [...Object.entries(adminTools()).map(([name, t]) => {
  return { name, title: t.title, needs: PERMISSIONS[t.needs], needs_label: ROLE_LABELS[PERMISSIONS[t.needs]], changes: t.needs !== "read", destructive: !!t.destructive };
}), ...adminGeneratedTools().map((t) => ({ name: t.name, title: t.title, needs: PERMISSIONS[t.needs], needs_label: ROLE_LABELS[PERMISSIONS[t.needs]], changes: t.needs !== "read", destructive: !!t.destructive }))];

/** Belt and braces on top of the reshaping above: anything shaped like a secret is masked before it leaves. */
const SECRETISH = /\b(oct_|ogw_|sk-|sk_live_|sk_test_|whsec_)[A-Za-z0-9_-]{8,}/g;
const DROP = new Set(["secret", "ciphertext", "iv", "tag", "key_id"]);
const redact = (v: any): any => typeof v === "string" ? v.replace(SECRETISH, (m, p) => `${p}…redacted`)
  : Array.isArray(v) ? v.map(redact) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k, x]) => !(DROP.has(k) && typeof x === "string")).map(([k, x]) => [k, redact(x)])) : v;

/** One row per call in admin_access_log, like every /api/admin request (never the arguments). */
function audit(c: AdminCaller, name: string, status: number) {
  void getDb().then((db) => db.query("INSERT INTO admin_access_log (actor, method, path, status, ip) VALUES ($1, $2, $3, $4, $5)",
    [c.actor.replace(/[^\w.@ :-]/g, "").slice(0, 80) || "admin", "MCP", `/admin/mcp/${name}`, status, (c.ip ?? "").slice(0, 64)])).catch(() => {});
}

/** Run one tool as the caller: the role check, the call (in the caller's admin context, so log() records the role), the audit. */
export async function runAdminTool(c: AdminCaller, name: AdminToolName, args: Args): Promise<CallToolResult> {
  const t = adminTools()[name];
  if (!t) return { isError: true, content: [{ type: "text", text: `No admin tool ${name}` }] };
  return runAdminToolWith(c, name, t, args);
}
/** As runAdminTool, for a tool given whole: the generated ones (mold_v0-060) run through the same role check and audit. */
export async function runAdminToolWith(c: AdminCaller, name: string, t: AdminTool, args: Args): Promise<CallToolResult> {
  const changes = t.needs !== "read";
  if (!can(c.role, t.needs)) {
    audit(c, name, 403);
    if (changes) adminContext.run({ role: c.role }, () => onboarding.log(c.actor, "mcp.refused", null, { tool: name, needs: PERMISSIONS[t.needs] }));
    return { isError: true, content: [{ type: "text", text: `${name} refused: you are ${ROLE_LABELS[c.role]}. ${refusal(t.needs).error}` }] };
  }
  try {
    const data = await adminContext.run({ role: c.role }, () => t.run(args ?? {}, c));
    const structured = fitPayload(redact(JSON.parse(JSON.stringify(data ?? {}))));
    audit(c, name, 200);
    if (changes) adminContext.run({ role: c.role }, () => onboarding.log(c.actor, "mcp.tool", typeof args?.slug === "string" ? args.slug : null,
      { tool: name, ...pick(args ?? {}, ["id", "price_id", "key", "simulation_id", "session_id", "dry_run"]) }));
    const note = structured.truncated ? " (Shortened to fit: narrow the filters or lower limit for the rest.)" : "";
    let line: string;
    try { line = t.summary(structured, args ?? {}); } catch { line = `${t.title}: done.`; } // a shortened payload can lack what the line reads
    return { content: [{ type: "text", text: `${line}${note}\n\n${JSON.stringify(structured)}` }], structuredContent: structured };
  } catch (err) {
    const e = err as Error & { status?: number; code?: unknown };
    const status = typeof e.status === "number" ? e.status : 500;
    // As on /api/admin: the admin sees what went wrong (a bad id, Stripe or Clerk refusing), never a database's raw text.
    const known = e instanceof onboarding.AdminError || /Clerk|Stripe|Setting|Role|Journey|Playbook|PackError/.test(e.constructor?.name ?? "") || status < 500;
    const message = typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) ? `The request could not be completed (database error ${e.code}).`
      : known ? e.message : "Internal error";
    if (!known) console.error(`admin mcp ${name}:`, e);
    audit(c, name, status);
    return { isError: true, content: [{ type: "text", text: redact(message) }] };
  }
}

// ---------- skills: playbooks for recurring jobs, as MCP prompts (slash commands in the client) ----------

const say = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

/**
 * Skills shipped with the admin MCP server: each chains the tools above for one recurring job and ends with a written
 * result. Reads only, except where a step proposes a change, which waits for the user's yes. Listed on Admin › Connect.
 */
export const ADMIN_SKILLS = {
  ops_review: {
    title: "Daily operations review",
    description: "Health, stuck or failed runs, waiting access requests and accounts needing attention, in one short report with next steps.",
    args: {},
    text: () => ADMIN_SKILL_TEXTS.ops_review(PROFILE.name),
  },
  triage_requests: {
    title: "Triage access requests",
    description: "Every pending access request with who they are, fit and a recommendation to approve or decline; acts only on your yes.",
    args: {},
    text: () => ADMIN_SKILL_TEXTS.triage_requests(PROFILE.name),
  },
  account_review: {
    title: "Account review",
    description: "One account end to end: stage, people, usage, spend against its allowance, plan and runs, what is wrong and the next step.",
    args: { account: z.string().describe("Account slug or name (list_accounts finds it)") },
    text: (a: Parameters<typeof ADMIN_SKILL_TEXTS.account_review>[1]) => ADMIN_SKILL_TEXTS.account_review(PROFILE.name, a),
  },
  finops_digest: {
    title: "FinOps digest",
    description: "Revenue, plans, pricing experiments and model spend for a period: MRR, collected, margin, anomalies and experiment results.",
    args: { from: z.string().optional().describe("First day, YYYY-MM-DD (default: this month)"), to: z.string().optional().describe("Last day, YYYY-MM-DD") },
    text: (a: Parameters<typeof ADMIN_SKILL_TEXTS.finops_digest>[1]) => ADMIN_SKILL_TEXTS.finops_digest(PROFILE.name, a),
  },
  pricing_experiment: {
    title: "Set up a pricing experiment",
    description: "Design an A/B test between plans: drafts each variant's JSON config, dry-runs it in Stripe, and creates them only on your yes.",
    args: { experiment: z.string().describe("Experiment name, e.g. growth-price-q4"), idea: z.string().describe("What to test, e.g. Growth at $499 vs $399 with higher usage rates") },
    text: (a: Parameters<typeof ADMIN_SKILL_TEXTS.pricing_experiment>[1]) => ADMIN_SKILL_TEXTS.pricing_experiment(PROFILE.name, a),
  },
  cost_check: {
    title: "Model cost check",
    description: "Where model spend goes and whether anything is off: by provider and account, unpriced usage, and accounts near their allowance.",
    args: { from: z.string().optional().describe("First day, YYYY-MM-DD"), to: z.string().optional().describe("Last day, YYYY-MM-DD") },
    text: (a: Parameters<typeof ADMIN_SKILL_TEXTS.cost_check>[1]) => ADMIN_SKILL_TEXTS.cost_check(PROFILE.name, a),
  },
} satisfies Record<string, { title: string; description: string; args: Record<string, z.ZodType>; text: (a: any) => string }>;

/** For the Connect page: each skill, what it does and what it asks for. */
export const adminSkillList = () => Object.entries(ADMIN_SKILLS).map(([name, s]) => ({ name, title: s.title, description: s.description, args: Object.keys(s.args) }));

export function createAdminServer(c: AdminCaller): McpServer {
  const tools = adminTools();
  const server = new McpServer(
    { name: `${PROFILE.mcp_server_name}-admin`, version: "1.0.0" },
    { instructions:
        `${PROFILE.name}'s admin panel across every customer account, for ${PROFILE.name} staff. Reads: ${Object.entries(tools).filter(([, t]) => t.needs === "read").map(([n]) => n).join(", ")}. ` +
        "Changes (each needs a role; refusals name it): approve/decline_access_request, " +
        `set_account_allowance, allow_prepaid_plans, create_plan (dry_run first), archive_plan, set_plan_experiment, ${["update_setting", ...hostChanges(tools)].join(", ")}. ` +
        "Skills (prompts, slash commands): ops_review, triage_requests, account_review, finops_digest, pricing_experiment, cost_check. " +
        `Confirm with the user before any change. This connection is ${c.actor}, role ${ROLE_LABELS[c.role]}.` + generatedAdminInstructions() },
  );
  for (const [name, t] of Object.entries(tools)) {
    const read = t.needs === "read";
    server.registerTool(name, {
      title: t.title,
      description: read ? t.description : `${t.description} Needs the ${ROLE_LABELS[PERMISSIONS[t.needs]]} role.`,
      inputSchema: t.input,
      annotations: { readOnlyHint: read, destructiveHint: !!t.destructive, idempotentHint: read || name === "set_account_allowance" || name === "allow_prepaid_plans" || name === "update_setting",
                     openWorldHint: ["approve_access_request", "decline_access_request", "create_plan", "archive_plan", "set_plan_experiment"].includes(name) },
    }, (args: Args) => runAdminTool(c, name, args));
  }
  // The tools generated from the packs (mold_v0-060): shared records for staff, and the customer tools a pack made admin-only.
  for (const g of adminGeneratedTools()) {
    const t: AdminTool = { title: g.title, description: g.description, needs: g.needs, destructive: g.destructive, input: g.input, run: (a, caller) => g.run(a, caller), summary: g.summary };
    server.registerTool(g.name, {
      title: g.title,
      description: g.needs === "read" ? g.description : `${g.description} Needs the ${ROLE_LABELS[PERMISSIONS[g.needs]]} role.`,
      inputSchema: g.input,
      annotations: g.annotations,
    }, (args: Args) => runAdminToolWith(c, g.name, t, args));
  }
  for (const [name, sk] of Object.entries(ADMIN_SKILLS))
    server.registerPrompt(name, { title: sk.title, description: sk.description, argsSchema: sk.args }, (a: any) => say(skillText(name, sk.text(a))));
  return server;
}

/** The host packs' changes among the admin tools (mold_v0-049: the session engine's cancel), named after the shell's. */
const hostChanges = (tools: Record<string, AdminTool>) => Object.entries(tools).filter(([n, t]) => t.needs !== "read" && !(n in ADMIN_TOOLS)).map(([n]) => n);
/**
 * A skill's text with each pack's steps (its own tools in them, mold_v0-049; pack.json admin_mcp.skills since mold_v0-140):
 * each {from, to} replaces one exact passage, in pack order. A passage the text no longer has is refused loudly, never
 * silently lost (the build refuses it first: scripts/gen-packs.mjs reads src/admin-skills.ts).
 */
export const skillText = (name: string, text: string) => packConfigs().reduce((x, c) => (c.admin_mcp?.skills?.[name] ?? []).reduce((t, st) => {
  if (!t.includes(st.from)) throw new Error(`pack ${c.pack}: the shell's admin skill ${name} no longer reads "${st.from.slice(0, 60)}…" (pack.json admin_mcp.skills)`);
  return t.replace(st.from, () => st.to);
}, x), text);

// ---------- HTTP: /admin/mcp and /api/admin/mcp, with OAuth discovery like /mcp ----------

export const ADMIN_MCP_PATHS = ["/admin/mcp", "/api/admin/mcp"] as const;

/**
 * The resource an access token is for: the admin path on the customer /mcp's origin (CLERK_MCP_AUDIENCE, else
 * PUBLIC_URL), so clients that check the metadata's resource against the URL they were given find a match.
 */
export const adminMcpResource = (p: string = ADMIN_MCP_PATHS[0]) => `${mcpAudience().replace(/\/mcp$/, "")}${p}`;

/** The caller for a bearer token: a Clerk OAuth access token of a platform admin, or an admin token (its role). */
export async function adminCallerFor(req: Request): Promise<{ caller: AdminCaller } | { status: 401 | 403; message: string }> {
  const t = bearer(req.headers.authorization);
  if (!t) return { status: 401, message: `Sign in to ${PROFILE.name} as a platform admin` };
  const tok = await resolveAdminToken(t);
  if (tok) return { caller: { actor: `token:${tok.label}`, role: tok.role, userId: null } };
  // Issued for the admin MCP (either path): a token naming the customer /mcp is refused here, as an admin one is on /mcp.
  const claims = await verifyOAuthToken(t, mcpAudiences().flatMap((a) => ADMIN_MCP_PATHS.map((p) => `${a.replace(/\/mcp$/, "")}${p}`)));
  if (!claims) return { status: 401, message: `Sign in to ${PROFILE.name} as a platform admin (send a Clerk OAuth access token)` };
  const { email, role } = await platformRoleFor(claims.userId).catch(() => ({ email: null, role: null }));
  if (!role) return { status: 403, message: `${email ?? "This account"} is not a platform admin. Ask an Owner on /admin/admins.` };
  return { caller: { actor: email ?? claims.userId, role, userId: claims.userId } };
}

export function mountAdminMcp(app: Express, publicUrl: string) {
  const oauthServer = () => (clerkEnabled() ? frontendApi() : null);
  // Protected-resource metadata for each path (RFC 9728: the resource's path after the well-known prefix). The
  // /.well-known CORS handling is http.ts's.
  for (const p of ADMIN_MCP_PATHS) app.get(`/.well-known/oauth-protected-resource${p}`, (_req, res) => {
    const as = oauthServer();
    if (!as) return void res.status(404).json({ error: "OAuth is not configured" });
    res.json({ resource: adminMcpResource(p), authorization_servers: [as], bearer_methods_supported: ["header"], scopes_supported: ["profile", "email"], resource_name: `${PROFILE.name} admin` });
  });
  const refuse = (res: Response, p: string, status: 401 | 403, message: string) => {
    if (status === 401) res.set("WWW-Authenticate", oauthServer()
      ? `Bearer error="unauthorized", error_description="Sign in to ${PROFILE.name} as a platform admin", resource_metadata="${publicUrl}/.well-known/oauth-protected-resource${p}"`
      : `Bearer realm="${NS}-admin"`);
    res.status(status).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message } });
  };
  for (const p of ADMIN_MCP_PATHS) {
    app.use(p, (req, res, next) => {
      const t0 = Date.now();
      res.set({ "Access-Control-Expose-Headers": "WWW-Authenticate", "Cache-Control": "no-store" });
      res.on("finish", () => {
        const msgs = Array.isArray(req.body) ? req.body : req.body ? [req.body] : [];
        const rpc = msgs.map((m: any) => (m?.method === "tools/call" ? `tools/call:${m?.params?.name}` : m?.method)).filter(Boolean).join(",");
        console.error(`admin-mcp ${req.method} ${res.statusCode} actor=${res.locals.adminActor ?? "-"} rpc=${rpc || "-"} ${Date.now() - t0}ms`);
      });
      next();
    });
    app.post(p, express.json({ limit: "1mb" }), async (req, res) => {
      const who = await adminCallerFor(req);
      if (!("caller" in who)) return refuse(res, p, who.status, who.message);
      res.locals.adminActor = who.caller.actor;
      // Stateless, like /mcp: a fresh server per request, bound to the caller (and their IP, for the audit rows).
      const server = createAdminServer({ ...who.caller, ip: String(req.ip ?? "") });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
    app.all(p, (_req, res) => void res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
  }
}

