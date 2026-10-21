/**
 * Transactional email through Resend (https://resend.com/docs/api-reference/emails/send-email). Clerk still sends the
 * account invitations; this is everything else Octillion says by email:
 *
 *   access requests     received (to the requester, and an alert to the operator), declined (with the reason, if
 *                       given), approved (a short welcome beside Clerk's invitation)
 *   library submissions received (operator alert), accepted (credit and when it applies), declined (with the reason)
 *   budget              an account's spend crossing 80% and 100% of its monthly allowance (to owners and billing managers)
 *   due soon            a workspace's records due within their area's window (mold_v0-035, src/schedules.ts dueCheck): one
 *                       list a day to the workspace's own people with the area's notify roles (owners by default)
 *   test                the "Send test email" button on /admin/emails
 *
 * Rules:
 *  - The Resend key is a Key vault provider ("resend", orchestrator/server-only: no env_vars, never handed to an
 *    agent). Sender, reply-to, operator recipients and the on/off switch are Agent configuration settings (Email).
 *  - send() never throws and never blocks the action that triggered it: callers fire it after their own writes
 *    (sendLater). No key, or emails turned off: nothing is sent, and the row says skipped and why.
 *  - Every attempt is a row in email_log, keyed by an idempotency key that names the message, so a retry or a second
 *    trigger never sends it twice (Resend gets the same key as its Idempotency-Key header). A failed or skipped one is
 *    tried again when the same message is triggered again.
 *  - Neither the log, the stderr line nor PostHog ever holds the address: a hash to match on, and the domain.
 *  - Plain text first; the HTML is the same words, with links, no images and no tracking. Signed "— Octillion".
 */
import { createHash, randomUUID } from "node:crypto";
import { asPlatform } from "./tenant-scope.js";
import { getDb } from "./db.js";
import { getProvider, useCredential } from "./keyvault.js";
import { freshSettings, settingText } from "./settings.js";
import * as telemetry from "./telemetry.js";
import * as clerk from "./clerk.js";
import { accountRoleOf, type AccountRole } from "./account-roles.js";
import { PROFILE } from "./profile.js";

export const EMAIL_PROVIDER = "resend";
export const EMAIL_KINDS = ["request_received", "request_alert", "request_declined", "request_approved", "submission_alert", "submission_accepted",
  "submission_declined", "budget_80", "budget_100", "due_soon", "test"] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

export interface Email {
  to: string; subject: string; text: string; html?: string; kind: EmailKind;
  /** Names the message ("request:12:received"): the same key is never sent twice. */
  idempotencyKey: string;
  /** What it is about (ids, an account slug); anything that looks like an address is dropped. */
  meta?: Record<string, unknown>;
}
export interface EmailResult { status: "sent" | "skipped" | "failed" | "duplicate"; id?: number; provider_id?: string | null; error?: string | null }

const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
export const isEmail = (v: unknown): v is string => typeof v === "string" && v.length <= 254 && ADDRESS.test(v.trim());
export const hashAddress = (a: string) => createHash("sha256").update(a.trim().toLowerCase()).digest("hex");
export const domainOf = (a: string) => (a.trim().toLowerCase().split("@")[1] ?? "").slice(0, 200);
const apiUrl = () => (process.env.RESEND_API_URL ?? "https://api.resend.com").replace(/\/$/, "");
/** Where links in emails point (the site the portal and /admin are on). */
export const siteUrl = () => (process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3333}`).replace(/\/$/, "");
const hasAddress = (v: unknown) => /[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,}/i.test(JSON.stringify(v ?? null));
const scrub = (meta: Record<string, unknown>) => Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined && !hasAddress(v)));

/** A message's key for one recipient: the purpose plus a short hash of the address. */
export const keyFor = (purpose: string, to: string) => `${purpose}:${hashAddress(to).slice(0, 16)}`;

/** Whether email can go out now: a Resend key in the vault (provider on) and EMAILS_ENABLED on. */
export async function emailStatus(): Promise<{ enabled: boolean; connected: boolean; from: string; reply_to: string | null }> {
  await freshSettings();
  const [p, [k]] = await Promise.all([getProvider(EMAIL_PROVIDER),
    (await getDb()).query<{ n: number }>("SELECT count(*)::int AS n FROM vault_credentials WHERE provider = $1 AND enabled", [EMAIL_PROVIDER])]);
  return { enabled: settingText("EMAILS_ENABLED") === "on", connected: Boolean(p?.enabled && Number(k?.n) > 0),
           from: settingText("EMAIL_FROM"), reply_to: settingText("EMAIL_REPLY_TO") || null };
}

/** Send one email (or record why not). Never throws. */
export async function send(m: Email): Promise<EmailResult> {
  // Email bookkeeping (email_log) and the provider key are the platform's, whoever triggers the email (src/tenant-scope.ts).
  try { return await asPlatform(() => attempt(m)); }
  catch (e) {
    console.error(`email ${m.kind}: not recorded: ${(e as Error).message}`);
    return { status: "failed", error: (e as Error).message };
  }
}

/** Run a notification without waiting (kept alive on Vercel); errors are logged, never thrown. */
export function fire(p: Promise<unknown>): void {
  const q = p.catch((e) => console.error("email:", (e as Error).message));
  telemetry.keepAlive(q);
}

/** send() without waiting: after the caller's own writes, kept alive on Vercel. Resolves to the result, never rejects. */
export function sendLater(m: Email): Promise<EmailResult> {
  // Email bookkeeping (email_log) and the provider key are the platform's (src/tenant-scope.ts).
  return asPlatform(() => {
  const p = send(m);
  telemetry.keepAlive(p);
  return p;
});
}

async function attempt(m: Email): Promise<EmailResult> {
  const to = String(m.to ?? "").trim().toLowerCase();
  const key = String(m.idempotencyKey ?? "").slice(0, 256);
  if (!key) throw new Error("an idempotency key is required");
  const subject = String(m.subject ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  const db = await getDb();
  // Claim the message: a new row, or another try at one that did not go out (failed, skipped, or stuck sending for
  // ten minutes). Sent or being sent: nothing to do.
  const [row] = await db.query<{ id: number }>(
    `INSERT INTO email_log (kind, to_hash, to_domain, subject, status, idempotency_key, meta) VALUES ($1, $2, $3, $4, 'sending', $5, $6::jsonb)
     ON CONFLICT (idempotency_key) DO UPDATE SET status = 'sending', at = now(), attempts = email_log.attempts + 1, error = NULL, subject = excluded.subject
       WHERE email_log.status IN ('failed', 'skipped') OR (email_log.status = 'sending' AND email_log.at < now() - interval '10 minutes')
     RETURNING id`,
    [m.kind, hashAddress(to), domainOf(to) || "-", subject, key, JSON.stringify(scrub(m.meta ?? {}))]);
  if (!row) return { status: "duplicate" };
  const id = Number(row.id);
  const finish = async (status: "sent" | "skipped" | "failed", extra: { provider_id?: string | null; error?: string | null } = {}): Promise<EmailResult> => {
    const error = extra.error ? extra.error.slice(0, 500) : null;
    await db.query("UPDATE email_log SET status = $2, provider_id = $3, error = $4 WHERE id = $1", [id, status, extra.provider_id ?? null, error]);
    console.error(`email ${m.kind} ${status} to=*@${domainOf(to) || "?"} key=${key}${error ? ` (${error})` : ""}`);
    telemetry.capture({ distinctId: "octillion:email" }, `email_${status}`, { kind: m.kind, to_domain: domainOf(to) || null, ...(error ? { error } : {}) });
    return { status, id, provider_id: extra.provider_id ?? null, error };
  };

  if (!isEmail(to)) return finish("skipped", { error: "No valid address to send to" });
  if (!subject || !String(m.text ?? "").trim()) return finish("skipped", { error: "No subject or text" });
  await freshSettings();
  if (settingText("EMAILS_ENABLED") !== "on") return finish("skipped", { error: "Emails are off (Agent configuration, Send emails)" });
  const provider = await getProvider(EMAIL_PROVIDER);
  if (!provider?.enabled) return finish("skipped", { error: "The Resend provider is off in Key vault" });
  const cred = await useCredential(EMAIL_PROVIDER).catch(() => null);
  if (!cred) return finish("skipped", { error: "No Resend key in Key vault" });

  const replyTo = settingText("EMAIL_REPLY_TO").split(",").map((x) => x.trim()).filter(isEmail);
  const body = {
    from: settingText("EMAIL_FROM"), to: [to], subject, text: m.text, html: m.html ?? htmlOf(m.text),
    ...(replyTo.length ? { reply_to: replyTo } : {}), tags: [{ name: "kind", value: m.kind }],
  };
  try {
    const r = await fetch(`${apiUrl()}/emails`, {
      method: "POST", signal: AbortSignal.timeout(15_000), body: JSON.stringify(body),
      headers: { authorization: `Bearer ${cred.secret}`, "content-type": "application/json", "idempotency-key": key, "user-agent": "Octillion/1.0" },
    });
    const j = await r.json().catch(() => ({})) as { id?: string; message?: string; name?: string };
    if (!r.ok) return finish("failed", { error: `Resend answered ${r.status}${j.name ? ` ${j.name}` : ""}: ${String(j.message ?? "").replaceAll(cred.secret, "…").slice(0, 300)}` });
    return finish("sent", { provider_id: j.id ?? null });
  } catch (e) {
    return finish("failed", { error: `Resend did not answer: ${(e as Error).message}` });
  }
}

// ---------- the words ----------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** The plain text as simple HTML: paragraphs, line breaks and links; nothing else (no images, no tracking). */
export function htmlOf(text: string): string {
  const para = (p: string) => esc(p).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}" style="color:#2563eb">${u}</a>`).replace(/\n/g, "<br>");
  const body = text.trim().split(/\n{2,}/).map((p) => `<p style="margin:0 0 16px">${para(p)}</p>`).join("\n");
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff">
<div style="max-width:560px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111827">
${body}
</div></body></html>`;
}
const SIGN = `— ${PROFILE.email_sender_name}`; // the profile's sender name (src/profile.ts)
const hello = (name?: string | null) => `Hi${name?.trim() ? ` ${name.trim().split(/\s+/)[0]}` : ""},`;
const lines = (...parts: (string | null | false | undefined)[]) => parts.filter((p): p is string => typeof p === "string").join("\n\n");
const money = (usd: number) => `$${usd.toFixed(usd % 1 ? 2 : 0)}`;

// ---------- who gets what ----------

/** Operator alerts: EMAIL_ADMIN_TO, else the platform owners (OCTILLION_PLATFORM_ADMINS addresses and Clerk owners). */
export async function adminRecipients(): Promise<string[]> {
  await freshSettings();
  const set = settingText("EMAIL_ADMIN_TO").split(",").map((x) => x.trim().toLowerCase()).filter(isEmail);
  if (set.length) return [...new Set(set)];
  const out = new Set(clerk.platformAdminEntries().filter(isEmail));
  if (clerk.clerkEnabled()) {
    try {
      const { listAdmins } = await import("./admin-roles.js");
      for (const a of await listAdmins()) if (a.role === "owner" && isEmail(a.email)) out.add(a.email.toLowerCase());
    } catch (e) { console.error("email: platform owners not listed:", (e as Error).message); }
  }
  return [...out];
}

/** The account's people with one of these roles (Clerk memberships; suspended people left out). */
export async function accountRecipients(orgId: number, roles: AccountRole[] = ["owner", "billing"]): Promise<string[]> {
  const [o] = await (await getDb()).query<{ clerk_org_id: string | null }>("SELECT clerk_org_id FROM organizations WHERE id = $1", [orgId]);
  if (!o?.clerk_org_id || !clerk.clerkEnabled()) return [];
  const out = new Set<string>();
  for (const m of await clerk.memberships.list(o.clerk_org_id)) {
    if (clerk.isSuspended(m) || !roles.includes(accountRoleOf(m))) continue;
    const id = m.public_user_data?.identifier;
    const email = isEmail(id) ? id : m.public_user_data?.user_id ? clerk.primaryEmail(await clerk.users.get(m.public_user_data.user_id)).email : null;
    if (isEmail(email)) out.add(email.toLowerCase());
  }
  return [...out];
}

/** The person behind an actor label: "customer:<email>" (the portal) or "ai:<Clerk user id>" (the connector). */
async function personOf(actor: string | null | undefined): Promise<string | null> {
  const [kind, rest] = [String(actor ?? "").split(":")[0], String(actor ?? "").split(":").slice(1).join(":")];
  if (kind === "customer" && isEmail(rest)) return rest.toLowerCase();
  if (kind === "ai" && rest.startsWith("user_") && clerk.clerkEnabled()) {
    try { return clerk.primaryEmail(await clerk.users.get(rest)).email; } catch { return null; }
  }
  return null;
}

const each = (to: string[], build: (to: string) => Email) => Promise.all(to.map((t) => sendLater(build(t))));

// ---------- access requests (src/http.ts, src/admin.ts) ----------

export interface RequestFacts { id: number; email: string; company: string; name?: string | null; product_url?: string | null; message?: string | null }

/** A new access request: "we got it" to the requester, and an alert to the operator. */
export function requestReceived(r: RequestFacts) {
  const meta = { request_id: r.id };
  return Promise.all([
    sendLater({ kind: "request_received", to: r.email, idempotencyKey: `request:${r.id}:received`, meta,
      subject: "We got your request for Octillion",
      text: lines(hello(r.name),
        `Thanks for asking for access to Octillion for ${r.company}. We read every request ourselves and will get back to you by email, usually within a few working days.`,
        "If you want to add anything in the meantime, just reply to this email.",
        SIGN) }),
    adminRecipients().then((to) => each(to, (t) => ({ kind: "request_alert", to: t, idempotencyKey: keyFor(`request:${r.id}:alert`, t), meta,
      subject: `New access request: ${r.company}`.slice(0, 200),
      text: lines(`${r.name?.trim() || "Someone"} from ${r.company} asked for access to Octillion.`,
        [`Email: ${r.email}`, r.product_url ? `Product: ${r.product_url}` : null].filter(Boolean).join("\n"),
        r.message ? `What they said:\n${r.message.slice(0, 1500)}` : null,
        `Review it: ${siteUrl()}/admin/requests`,
        SIGN) }))),
  ]);
}

/** A request declined: a plain, kind note, with the reason when the reviewer gave one. */
export function requestDeclined(r: RequestFacts, reason?: string | null) {
  return sendLater({ kind: "request_declined", to: r.email, idempotencyKey: `request:${r.id}:declined`, meta: { request_id: r.id, with_reason: Boolean(reason) },
    subject: "About your Octillion request",
    text: lines(hello(r.name),
      `Thank you for your interest in Octillion. We can't offer ${r.company} access right now.`,
      reason?.trim() ? `The reason: ${reason.trim()}` : null,
      "This isn't necessarily final. If things change on your side, or you think we've misread something, reply to this email and we'll take another look.",
      SIGN) });
}

/** A request approved: a short welcome that goes with Clerk's invitation (which Clerk sends; this never resends it). */
export function requestApproved(r: RequestFacts, o: { account: string; invited: boolean }) {
  return sendLater({ kind: "request_approved", to: r.email, idempotencyKey: `request:${r.id}:approved`, meta: { request_id: r.id, invited: o.invited },
    subject: "Welcome to Octillion",
    text: lines(hello(r.name),
      `Your request is approved: ${o.account} now has an Octillion account.`,
      "Octillion shows how AI coding agents treat your developer product: we run agents like Claude Code, Codex and Cursor on real programming tasks and report how often they choose your product, who they pick instead, and why.",
      o.invited
        ? `You'll get a separate invitation email to join ${o.account}. Accept it to create your sign-in, then open ${siteUrl()}/app to connect Octillion to your AI assistant and run your first simulation.`
        : `We'll send you your connection details separately. Once you have them, ${siteUrl()}/app walks you through setup.`,
      "Questions? Reply to this email.",
      SIGN) });
}

// ---------- library submissions (src/contributions.ts) ----------

export interface SubmissionFacts { id: string; kind: "persona" | "task"; title: string; org_id: number; org_name: string; org_slug: string; created_by: string | null }
const noun = (k: "persona" | "task") => (k === "persona" ? "developer persona" : "programming task");

/** An account published an item to the library: an alert to the operator. */
export function submissionReceived(s: SubmissionFacts) {
  return adminRecipients().then((to) => each(to, (t) => ({ kind: "submission_alert", to: t, idempotencyKey: keyFor(`submission:${s.id}:alert`, t),
    meta: { submission_id: s.id, kind: s.kind, account: s.org_slug },
    subject: `Library submission from ${s.org_name}: ${s.title}`.slice(0, 200),
    text: lines(`${s.org_name} submitted a ${noun(s.kind)} to Octillion's library: "${s.title}".`,
      `Review it: ${siteUrl()}/admin/${s.kind === "persona" ? "personas" : "tasks"}?view=submissions`,
      SIGN) })));
}

/** Who to tell about a decision: the person who submitted it, else the account's owners. */
async function submitterOf(s: SubmissionFacts): Promise<string[]> {
  const p = await personOf(s.created_by);
  return p ? [p] : accountRecipients(s.org_id, ["owner"]);
}

/** Accepted: the credit, and that it comes off the next invoice (or that it is still being added). */
export async function submissionAccepted(s: SubmissionFacts, credit: { usd: number; status: "none" | "pending" | "credited" | null }) {
  const creditLine = !(credit.usd > 0) || credit.status === "none"
    ? null
    : credit.status === "credited"
      ? `As thanks, we've added a ${money(credit.usd)} credit to your account. It comes off your next invoice automatically.`
      : `As thanks, you've earned a ${money(credit.usd)} credit. It is still being added to your account; once it is, it comes off your next invoice automatically. You can see it on ${siteUrl()}/app/billing.`;
  return each(await submitterOf(s), (t) => ({ kind: "submission_accepted", to: t, idempotencyKey: keyFor(`submission:${s.id}:accepted`, t),
    meta: { submission_id: s.id, kind: s.kind, account: s.org_slug, credit_usd: credit.usd, credit_status: credit.status },
    subject: `Your ${noun(s.kind)} is in Octillion's library`,
    text: lines("Hi,",
      `Thanks for sharing "${s.title}". We reviewed it and added it to Octillion's library, where it now helps simulations for everyone.`,
      creditLine,
      "Your own copy stays yours and unchanged.",
      SIGN) }));
}

/** Declined: with the reason the reviewer gave (it is required). */
export async function submissionDeclined(s: SubmissionFacts, reason: string) {
  return each(await submitterOf(s), (t) => ({ kind: "submission_declined", to: t, idempotencyKey: keyFor(`submission:${s.id}:declined`, t),
    meta: { submission_id: s.id, kind: s.kind, account: s.org_slug },
    subject: `About your ${noun(s.kind)} for Octillion's library`,
    text: lines("Hi,",
      `Thanks for sharing "${s.title}". We've decided not to add it to Octillion's library this time.`,
      `The reason: ${reason.trim()}`,
      "Your own copy stays yours and keeps working as before. If you change it, you're welcome to submit it again.",
      SIGN) }));
}

// ---------- budget (after each finished session: src/worker.ts, src/compute-actions.ts) ----------

export const BUDGET_THRESHOLDS = [100, 80] as const;
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

/**
 * When the account's live spend this month has crossed 80% or 100% of its monthly allowance: one email per threshold
 * per month to each owner and billing manager (the idempotency key carries the account, month and threshold). Only
 * the highest threshold crossed is sent, so a jump past both sends one. Never throws.
 */
export async function checkBudget(orgId: number, now = new Date()): Promise<{ threshold: number | null; sent: number }> {
  try {
    const { orgBudget } = await import("./billing.js");
    const { orgMonthSpendUsd } = await import("./queries.js");
    const budget = (await orgBudget(orgId).catch(() => null))?.budget ?? 0;
    if (!(budget > 0)) return { threshold: null, sent: 0 };
    const spent = await orgMonthSpendUsd(orgId);
    const pct = (spent / budget) * 100;
    const threshold = BUDGET_THRESHOLDS.find((t) => pct >= t);
    if (!threshold) return { threshold: null, sent: 0 };
    const purpose = `budget:${orgId}:${monthKey(now)}:${threshold}`;
    // Already sent (or going out) to someone this month: done; no need to ask Clerk who the owners are.
    const db = await getDb();
    if ((await db.query("SELECT 1 FROM email_log WHERE idempotency_key LIKE $1 AND status IN ('sent', 'sending') LIMIT 1", [`${purpose}:%`])).length)
      return { threshold, sent: 0 };
    const [o] = await db.query<{ name: string; slug: string }>("SELECT name, slug FROM organizations WHERE id = $1", [orgId]);
    const to = await accountRecipients(orgId, ["owner", "billing"]);
    if (!to.length) { console.error(`email budget_${threshold}: ${o?.slug ?? orgId} has no owner or billing manager with an email`); return { threshold, sent: 0 }; }
    const { monthWords } = await import("./limits.js");
    const { month, reset } = monthWords(now);
    const over = threshold >= 100;
    const results = await each(to, (t) => ({ kind: over ? "budget_100" : "budget_80", to: t, idempotencyKey: keyFor(purpose, t),
      meta: { account: o?.slug ?? null, month: monthKey(now), threshold, spent_usd: Math.round(spent * 100) / 100, budget_usd: budget },
      subject: over ? `${o?.name ?? "Your account"} has used its Octillion allowance for ${month}` : `${o?.name ?? "Your account"} has used ${threshold}% of its Octillion allowance`,
      text: lines("Hi,",
        `${o?.name ?? "Your account"} has spent ${money(spent)} of its ${money(budget)} monthly allowance for model usage in ${month} (${Math.floor(pct)}%).`,
        over ? `New simulations can't start until the allowance resets on ${reset}, or until it is raised.`
             : `When it reaches 100%, new simulations can't start until the allowance resets on ${reset}.`,
        `Your plan and Budget rules are on ${siteUrl()}/app/billing. You're getting this because you're an owner or billing manager of the account.`,
        SIGN) }));
    return { threshold, sent: results.filter((r) => r.status === "sent").length };
  } catch (e) {
    console.error(`email budget check for ${orgId} failed:`, (e as Error).message);
    return { threshold: null, sent: 0 };
  }
}
/** checkBudget without waiting (after a session finishes). */
export const checkBudgetLater = (orgId: number) => { const p = checkBudget(orgId); telemetry.keepAlive(p); return p; };

// ---------- due dates (mold_v0-035: src/schedules.ts dueCheck, once a day) ----------

export interface DueItem { key: string; title: string | null; due_on: string }

/**
 * One workspace's records of one area due within its window: one email a day to each of the workspace's own people with
 * one of `roles` (its Clerk organization's members, suspended people left out: accountRecipients). The idempotency key
 * names the workspace, area, day and recipient, so a second check the same day sends nothing twice. Never throws.
 * `delivered` counts recipients whose email went out (now or earlier the same day).
 */
export async function dueSoon(orgId: number, d: { area: string; label: string; within_days: number; roles: AccountRole[]; day: string; items: DueItem[] }):
  Promise<{ recipients: number; delivered: number }> {
  try {
    if (!d.items.length) return { recipients: 0, delivered: 0 };
    const [o] = await asPlatform(async () => (await getDb()).query<{ name: string; slug: string }>("SELECT name, slug FROM organizations WHERE id = $1", [orgId]));
    if (!o) return { recipients: 0, delivered: 0 };
    const to = await asPlatform(() => accountRecipients(orgId, d.roles));
    if (!to.length) { console.error(`email due_soon: ${o.slug} has no ${d.roles.join("/")} with an email`); return { recipients: 0, delivered: 0 }; }
    const n = d.items.length, shown = d.items.slice(0, 50);
    const list = shown.map((x) => `- ${(x.title ?? x.key).replace(/[\r\n]+/g, " ").slice(0, 200)} (${x.key}): due ${x.due_on}`).join("\n");
    const results = await Promise.all(to.map((t) => send({ kind: "due_soon", to: t, idempotencyKey: keyFor(`due:${orgId}:${d.area}:${d.day}`, t),
      meta: { account: o.slug, area: d.area, day: d.day, items: n },
      subject: `${n} ${d.label.toLowerCase()} due within ${d.within_days} day${d.within_days === 1 ? "" : "s"} in ${o.name}`.slice(0, 200),
      text: lines("Hi,",
        `${n === 1 ? "This is" : "These are"} due in ${o.name} within the next ${d.within_days} day${d.within_days === 1 ? "" : "s"}:`,
        list + (n > shown.length ? `\n…and ${n - shown.length} more` : ""),
        `See them on ${siteUrl()}/app/notices. You're getting this because of your role in ${o.name} (${d.roles.join(", ")}).`,
        SIGN) })));
    return { recipients: to.length, delivered: results.filter((r) => r.status === "sent" || r.status === "duplicate").length };
  } catch (e) {
    console.error(`email due_soon for ${orgId} failed:`, (e as Error).message);
    return { recipients: 0, delivered: 0 };
  }
}

// ---------- /admin/emails ----------

/** The test button: one email to the address typed in. */
export async function sendTest(actor: string, toIn: unknown) {
  const to = String(toIn ?? "").trim().toLowerCase();
  const r = await send({ kind: "test", to, idempotencyKey: `test:${randomUUID()}`, meta: { by_admin: hashAddress(actor).slice(0, 16) },
    subject: "Octillion test email",
    text: lines("Hi,", `This is a test email from Octillion, sent from ${siteUrl()}/admin/emails. If you can read it, email is working.`, SIGN) });
  return r;
}

/** The log (newest first) and the last 24 hours by status, hour by hour, for the cards. */
export async function emailLog(q: { limit?: unknown } = {}) {
  const limit = Math.min(Math.max(Math.trunc(Number(q.limit) || 1000), 1), 5000);
  const db = await getDb();
  const [rows, hours, status] = await Promise.all([
    db.query(`SELECT id, at, kind, to_domain, subject, status, provider_id, error, attempts, meta FROM email_log ORDER BY at DESC, id DESC LIMIT $1`, [limit]),
    db.query<{ h: number; status: string; n: number }>(
      `SELECT floor(extract(epoch FROM (now() - at)) / 3600)::int AS h, status, count(*)::int AS n FROM email_log
        WHERE at > now() - interval '24 hours' GROUP BY 1, 2`),
    emailStatus(),
  ]);
  const series = (s: string) => Array.from({ length: 24 }, (_, i) => hours.filter((r) => r.status === s && Number(r.h) === 23 - i).reduce((t, r) => t + Number(r.n), 0));
  const total = (s: string) => series(s).reduce((a, b) => a + b, 0);
  return {
    rows, status,
    last_24h: { sent: total("sent"), failed: total("failed"), skipped: total("skipped") },
    series: { sent: series("sent"), failed: series("failed"), skipped: series("skipped") },
    kinds: EMAIL_KINDS,
  };
}
