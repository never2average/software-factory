/**
 * The email adapter (mold_v0-019, 083): the ONE place in the shell that sends email. Nothing else talks to an email
 * provider: every message (its words, its recipients, its idempotency key) is built here and goes out through send().
 *
 *   sign-in             the one-time code and an invitation to a workspace (built-in sign-in, src/builtin-auth.ts; under
 *                       Clerk, Clerk sends its own). Always on while a transport can send: people could not get in otherwise
 *   access requests     received (to the requester, and an alert to the operator), declined, approved (src/http.ts, src/admin.ts)
 *   library             submissions received (operator alert), accepted, declined (src/contributions.ts, a host pack)
 *   usage               an account's spend crossing 80% and 100% of its monthly allowance (to owners and billing
 *                       managers), after a session (src/worker.ts) or a run (src/runs.ts) ends
 *   due dates           a workspace's records due within their area's window (mold_v0-035, src/schedules.ts dueCheck)
 *   billing             billing notices to the operator: a run's charge that could not be delivered (src/run-charges.ts)
 *   test                the "Send test email" button on /admin/emails
 *
 * Which of them go out (mold_v0-019: nothing beyond sign-in and invitations unless the profile turns it on): the app's
 * profile.json `email.notifications` lists the groups that are on (access_requests, library, usage, due_dates, billing;
 * src/profile.ts ProfileEmail); absent, none. APP_EMAIL_NOTIFICATIONS may only narrow that list on a server
 * ("none", or a comma-separated subset), never widen it. A message of a group that is off is logged as skipped, with why.
 *
 * Where they go (the transport): APP_EMAIL_PROVIDER, else the profile's `email.provider`, else resend.
 *   resend   Resend's API (https://resend.com/docs/api-reference/emails/send-email); the key is the Key vault provider
 *            "resend" (orchestrator/server-only: never handed to an agent). Sender, reply-to, operator recipients and
 *            the on/off switch are Agent configuration settings (Email)
 *   test     kept in this process (testOutbox()), for tests and local work; refused when NODE_ENV is production
 *   none     nothing is sent; every message is logged as skipped
 * With no transport that can send (no Resend key, emails switched off, or none), nothing goes out and emailStatus()
 * says so in words: sign-in codes are then the only kind that would be on, and they wait for a key.
 *
 * Rules:
 *  - send() never throws and never blocks the action that triggered it: callers fire it after their own writes
 *    (sendLater).
 *  - Every attempt is a row in email_log, keyed by an idempotency key that names the message, so a retry or a second
 *    trigger never sends it twice (the provider gets the same key as its Idempotency-Key header). A failed or skipped
 *    one is tried again when the same message is triggered again.
 *  - Neither the log, the stderr line nor PostHog ever holds an address or a secret: a hash of the address to match
 *    on and its domain; the subject (which never carries a code); meta with anything that looks like an address
 *    dropped; a provider's error with the key cut out.
 *  - One recipient per message, an address checked here; the subject and every header-like field lose line breaks
 *    (no header injection, whatever a transport does with them).
 *  - Links point only at the console's address from the server's environment (src/console-url.ts consoleUrl), never at
 *    a host a request named.
 *  - Plain text first; the HTML is the same words, with links, no images and no tracking. Signed with the profile's
 *    sender name.
 *  - No product's word is written here (mold_v0-101): the text writes placeholders ({product}, {run}, {runs}, "a {product}")
 *    and the build's vocabulary fills them (src/vocabulary.ts: the neutral words, under the packs' pack.json `words`,
 *    under the profile's `words`). Only the text's own literal parts are filled, never a value someone typed (a company,
 *    a title). The welcome email's pitch is the profile's `email.pitch`, else the landing block's hero subheadline,
 *    else the profile's short_description; the signature is the profile's sender name.
 */
import { createHash, randomUUID } from "node:crypto";
import { asPlatform } from "./tenant-scope.js";
import { getDb } from "./db.js";
import { getProvider, useCredential } from "./keyvault.js";
import { freshSettings, settingText } from "./settings.js";
import * as telemetry from "./telemetry.js";
import * as clerk from "./clerk.js";
import { people } from "./people.js";
import { accountRoleOf, type AccountRole } from "./account-roles.js";
import { PROFILE, type ProfileEmail } from "./profile.js";
import { consoleUrl } from "./console-url.js";
import { ENV } from "./env-names.js";
import { NS } from "./namespace.js";
import { GENERATED_EMAIL_PITCH } from "./profile.generated.js";
import { vocabulary } from "./vocabulary.js";
import { fillWith, type Words } from "./words.js";

export const EMAIL_PROVIDER = "resend";
export const EMAIL_KINDS = ["request_received", "request_alert", "request_declined", "request_approved", "submission_alert", "submission_accepted",
  "submission_declined", "budget_80", "budget_100", "due_soon", "test",
  // Built-in sign-in (mold_v0-004, src/builtin-auth.ts): the one-time code, and an invitation to a workspace.
  "sign_in_code", "invitation",
  // A billing notice to the operator (mold_v0-083): a run's charge that could not be delivered.
  "billing_notice"] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

/** The groups a profile turns on (`email.notifications`), and the kinds in each. Sign-in and test are always on. */
export const NOTIFICATION_GROUPS = {
  access_requests: ["request_received", "request_alert", "request_declined", "request_approved"],
  library: ["submission_alert", "submission_accepted", "submission_declined"],
  usage: ["budget_80", "budget_100"],
  due_dates: ["due_soon"],
  billing: ["billing_notice"],
} as const satisfies Record<string, readonly EmailKind[]>;
export type NotificationGroup = keyof typeof NOTIFICATION_GROUPS;
export const ALWAYS_ON: readonly EmailKind[] = ["sign_in_code", "invitation", "test"];
export const groupOf = (k: EmailKind): NotificationGroup | null =>
  (Object.entries(NOTIFICATION_GROUPS) as [NotificationGroup, readonly EmailKind[]][]).find(([, ks]) => ks.includes(k))?.[0] ?? null;

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
/** Where links in emails point: the console (src/console-url.ts), from the server's environment only. */
export const siteUrl = () => consoleUrl();
const hasAddress = (v: unknown) => /[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,}/i.test(JSON.stringify(v ?? null));
const scrub = (meta: Record<string, unknown>) => Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined && !hasAddress(v)));
/** A header-like value on one line: line breaks and other control characters go. */
const oneLine = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, max);
/** The subject as the log keeps it: an address typed into a name (a company, a workspace) never reaches the log. */
const logSubject = (subject: string) => subject.replace(/[^\s@<>,;"]+@[^\s@<>,;"]+/g, "*@…");
/** A sender: "Name <address>" or an address, with no line break and no second address. */
const SENDER = /^(?:[^\r\n<>@,;"]{0,100} ?<[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+>|[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+)$/;

/** A message's key for one recipient: the purpose plus a short hash of the address. */
export const keyFor = (purpose: string, to: string) => `${purpose}:${hashAddress(to).slice(0, 16)}`;

// ---------- which messages are on (the profile) ----------

let testEmailProfile: ProfileEmail | null | undefined;
/** Tests only: the profile's `email` in place of the build's (undefined: the build's again). */
export function setEmailProfileForTest(p: ProfileEmail | null | undefined) { testEmailProfile = p; }
const profileEmail = (): ProfileEmail => (testEmailProfile !== undefined ? testEmailProfile : (PROFILE as { email?: ProfileEmail }).email) ?? {};

/** The notification groups that are on: the profile's, narrowed by APP_EMAIL_NOTIFICATIONS (never widened). */
export function notificationsOn(): Set<NotificationGroup> {
  const known = Object.keys(NOTIFICATION_GROUPS) as NotificationGroup[];
  const fromProfile = new Set((profileEmail().notifications ?? []).filter((g): g is NotificationGroup => known.includes(g as NotificationGroup)));
  const raw = (ENV.APP_EMAIL_NOTIFICATIONS ?? "").trim().toLowerCase();
  if (!raw) return fromProfile;
  if (raw === "none" || raw === "off") return new Set();
  const narrowed = new Set(raw.split(",").map((x) => x.trim()));
  return new Set([...fromProfile].filter((g) => narrowed.has(g)));
}
/** Whether a kind may go out at all (before any transport is asked): sign-in and test always, the rest by the profile. */
export function kindOn(kind: EmailKind): { on: boolean; why: string | null } {
  if (ALWAYS_ON.includes(kind)) return { on: true, why: null };
  const g = groupOf(kind);
  if (g && notificationsOn().has(g)) return { on: true, why: null };
  return { on: false, why: `Turned off: the profile's email.notifications does not list ${g ?? kind}` };
}

// ---------- the transports ----------

export type TransportId = "resend" | "test" | "none";
export interface OutgoingEmail { from: string; to: string; reply_to: string[]; subject: string; text: string; html: string; kind: EmailKind; idempotencyKey: string }
interface Transport {
  id: TransportId;
  /** Why it cannot send now (null: it can), without sending anything. */
  notReady(): Promise<string | null>;
  deliver(m: OutgoingEmail): Promise<{ ok: true; provider_id: string | null } | { ok: false; skipped?: boolean; error: string }>;
}

/** The transport in force: APP_EMAIL_PROVIDER, else the profile's email.provider, else resend. */
export function transportId(): TransportId {
  const v = (ENV.APP_EMAIL_PROVIDER || profileEmail().provider || "resend").trim().toLowerCase();
  return v === "test" || v === "none" ? v : "resend";
}

const resendUrl = () => (process.env.RESEND_API_URL ?? "https://api.resend.com").replace(/\/$/, "");
const resend: Transport = {
  id: "resend",
  async notReady() {
    const p = await getProvider(EMAIL_PROVIDER);
    if (!p?.enabled) return "The Resend provider is off in Key vault";
    const [k] = await (await getDb()).query<{ n: number }>("SELECT count(*)::int AS n FROM vault_credentials WHERE provider = $1 AND enabled", [EMAIL_PROVIDER]);
    return Number(k?.n) > 0 ? null : "No Resend key in Key vault";
  },
  async deliver(m) {
    const cred = await useCredential(EMAIL_PROVIDER).catch(() => null);
    if (!cred) return { ok: false, skipped: true, error: "No Resend key in Key vault" };
    const body = { from: m.from, to: [m.to], subject: m.subject, text: m.text, html: m.html, ...(m.reply_to.length ? { reply_to: m.reply_to } : {}), tags: [{ name: "kind", value: m.kind }] };
    try {
      const r = await fetch(`${resendUrl()}/emails`, {
        method: "POST", signal: AbortSignal.timeout(15_000), body: JSON.stringify(body),
        headers: { authorization: `Bearer ${cred.secret}`, "content-type": "application/json", "idempotency-key": m.idempotencyKey, "user-agent": `${PROFILE.name.replace(/[^A-Za-z0-9.-]+/g, "-") || "app"}/1.0` },
      });
      const j = await r.json().catch(() => ({})) as { id?: string; message?: string; name?: string };
      if (!r.ok) return { ok: false, error: `Resend answered ${r.status}${j.name ? ` ${j.name}` : ""}: ${String(j.message ?? "").replaceAll(cred.secret, "…").slice(0, 300)}` };
      return { ok: true, provider_id: j.id ?? null };
    } catch (e) {
      return { ok: false, error: `Resend did not answer: ${String((e as Error).message).replaceAll(cred.secret, "…")}` };
    }
  },
};

const OUTBOX: (OutgoingEmail & { at: string })[] = [];
/** The test transport's messages, oldest first (this process only). */
export const testOutbox = (): readonly (OutgoingEmail & { at: string })[] => OUTBOX;
/** Tests only: empty the test transport's outbox. */
export const clearTestOutbox = () => void OUTBOX.splice(0);
const test: Transport = {
  id: "test",
  async notReady() { return process.env.NODE_ENV === "production" ? "The test transport is not used in production (APP_EMAIL_PROVIDER=test)" : null; },
  async deliver(m) {
    const why = await this.notReady();
    if (why) return { ok: false, skipped: true, error: why };
    OUTBOX.push({ ...m, at: new Date().toISOString() });
    if (OUTBOX.length > 1000) OUTBOX.splice(0, OUTBOX.length - 1000);
    return { ok: true, provider_id: `test_${OUTBOX.length}` };
  },
};
const none: Transport = {
  id: "none",
  async notReady() { return "No email transport (email.provider is none)"; },
  async deliver() { return { ok: false, skipped: true, error: "No email transport (email.provider is none)" }; },
};
const TRANSPORTS: Record<TransportId, Transport> = { resend, test, none };

/**
 * Whether email can go out now, in words the admin pages show: the transport, whether it can send, the on/off switch,
 * which kinds are on, and one sentence. `enabled`/`connected` keep their meaning (switch on; a transport that can send).
 */
export async function emailStatus(): Promise<{ enabled: boolean; connected: boolean; provider: TransportId; from: string; reply_to: string | null;
  why_not: string | null; on: EmailKind[]; notifications: NotificationGroup[]; summary: string }> {
  await freshSettings();
  const t = TRANSPORTS[transportId()];
  const why = await t.notReady().catch((e) => `The ${t.id} transport could not be checked: ${(e as Error).message}`);
  const enabled = settingText("EMAILS_ENABLED") === "on";
  const groups = [...notificationsOn()];
  const on = EMAIL_KINDS.filter((k) => kindOn(k).on);
  const sending = enabled && !why;
  const summary = !sending
    ? `Not sending email (${!enabled ? "emails are switched off in Agent configuration" : why}). Sign-in codes and invitations are the only kinds on, and they wait for it${groups.length ? `; ${groups.join(", ")} too` : ""}.`
    : groups.length ? `Sending through ${t.id}: sign-in codes, invitations and ${groups.join(", ")}.`
    : `Sending through ${t.id}: sign-in codes and invitations only (the profile turns on no other notifications).`;
  return { enabled, connected: !why, provider: t.id, from: settingText("EMAIL_FROM"), reply_to: settingText("EMAIL_REPLY_TO") || null,
           why_not: sending ? null : (!enabled ? "Emails are off (Agent configuration, Send emails)" : why), on, notifications: groups, summary };
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
  const key = oneLine(m.idempotencyKey, 256);
  if (!key) throw new Error("an idempotency key is required");
  if (!(EMAIL_KINDS as readonly string[]).includes(m.kind)) throw new Error(`unknown email kind ${String(m.kind).slice(0, 40)}`);
  const subject = oneLine(m.subject, 200);
  const db = await getDb();
  // Claim the message: a new row, or another try at one that did not go out (failed, skipped, or stuck sending for
  // ten minutes). Sent or being sent: nothing to do.
  const [row] = await db.query<{ id: number }>(
    `INSERT INTO email_log (kind, to_hash, to_domain, subject, status, idempotency_key, meta) VALUES ($1, $2, $3, $4, 'sending', $5, $6::jsonb)
     ON CONFLICT (idempotency_key) DO UPDATE SET status = 'sending', at = now(), attempts = email_log.attempts + 1, error = NULL, subject = excluded.subject
       WHERE email_log.status IN ('failed', 'skipped') OR (email_log.status = 'sending' AND email_log.at < now() - interval '10 minutes')
     RETURNING id`,
    [m.kind, hashAddress(to), domainOf(to) || "-", logSubject(subject), key, JSON.stringify(scrub(m.meta ?? {}))]);
  if (!row) return { status: "duplicate" };
  const id = Number(row.id);
  const t = TRANSPORTS[transportId()];
  const finish = async (status: "sent" | "skipped" | "failed", extra: { provider_id?: string | null; error?: string | null } = {}): Promise<EmailResult> => {
    // An error never carries the address (a provider may echo it back).
    const error = extra.error ? extra.error.replaceAll(to || "\u0000", "*@" + (domainOf(to) || "?")).slice(0, 500) : null;
    await db.query("UPDATE email_log SET status = $2, provider_id = $3, error = $4 WHERE id = $1", [id, status, extra.provider_id ?? null, error]);
    console.error(`email ${m.kind} ${status} via ${t.id} to=*@${domainOf(to) || "?"} key=${key}${error ? ` (${error})` : ""}`);
    telemetry.capture({ distinctId: `${NS}:email` }, `email_${status}`, { kind: m.kind, transport: t.id, to_domain: domainOf(to) || null, ...(error ? { error } : {}) });
    return { status, id, provider_id: extra.provider_id ?? null, error };
  };

  if (!isEmail(to)) return finish("skipped", { error: "No valid address to send to" });
  if (!subject || !String(m.text ?? "").trim()) return finish("skipped", { error: "No subject or text" });
  const gate = kindOn(m.kind);
  if (!gate.on) return finish("skipped", { error: gate.why });
  await freshSettings();
  if (settingText("EMAILS_ENABLED") !== "on") return finish("skipped", { error: "Emails are off (Agent configuration, Send emails)" });
  const from = oneLine(settingText("EMAIL_FROM"), 320);
  if (!SENDER.test(from)) return finish("skipped", { error: "The sender (Agent configuration, Email, From) is not Name <address> or an address" });
  const why = await t.notReady();
  if (why) return finish("skipped", { error: why });
  const replyTo = settingText("EMAIL_REPLY_TO").split(",").map((x) => x.trim()).filter(isEmail).slice(0, 5);
  const out = await t.deliver({ from, to, reply_to: replyTo, subject, text: String(m.text), html: m.html ?? htmlOf(String(m.text)), kind: m.kind, idempotencyKey: key });
  if (out.ok) return finish("sent", { provider_id: out.provider_id });
  return finish(out.skipped ? "skipped" : "failed", { error: out.error });
}

// ---------- the words ----------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** The plain text as simple HTML: paragraphs, line breaks and links; nothing else (no images, no tracking). */
export function htmlOf(text: string): string {
  // Only links on the console's own address become links: a URL someone typed into a name (a workspace, a company, a
  // title) stays plain text, so an email signed by the product never carries a clickable link to another site.
  const home = esc(siteUrl());
  const para = (p: string) => esc(p).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => (u === home || u.startsWith(`${home}/`) || u.startsWith(`${home}?`) ? `<a href="${u}" style="color:#2563eb">${u}</a>` : u)).replace(/\n/g, "<br>");
  const body = text.trim().split(/\n{2,}/).map((p) => `<p style="margin:0 0 16px">${para(p)}</p>`).join("\n");
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff">
<div style="max-width:560px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111827">
${body}
</div></body></html>`;
}

/** What the words are made from: the build's profile, its vocabulary and its landing block. */
export interface EmailWordsInput {
  name: string; sender_name: string; short_description: string;
  /** The profile's `email.pitch`, else the landing block's hero subheadline (src/landing.ts); null: neither. */
  pitch: string | null;
  /** The build's words (src/vocabulary.ts vocabulary()). */
  words: Readonly<Words>;
}
export interface EmailWords {
  /** The product's name ({product}), and the signature's (the sender's name). */
  product: string; sender: string;
  /** One or two sentences saying what the product does, for the welcome email; null: none to say. */
  pitch: string | null;
  /** A text with its placeholders filled ({product}, {run}, {Runs}, "a {product}"). */
  fill(text: string): string;
  /** A tagged template: its literal parts filled, its values (a company, a title) as they are. */
  t(parts: TemplateStringsArray, ...values: unknown[]): string;
}
/** A word or sentence from the profile, on one line and of a bounded length. */
const plainLine = (v: unknown, max: number) => oneLine(v, max);
const sentence = (v: string) => (/[.!?]$/.test(v) ? v : `${v}.`);

/** The emails' words from what a build declares (pure: the tests pass other builds' inputs). */
export function wordsFor(i: EmailWordsInput): EmailWords {
  const product = plainLine(i.name, 80) || "Workspace";
  const fill = (text: string) => fillWith(i.words, product, text);
  const own = plainLine(i.pitch, 400), short = plainLine(i.short_description, 300);
  return {
    product, sender: plainLine(i.sender_name, 100) || product,
    pitch: own ? sentence(fill(own)) : short ? `${product}: ${sentence(short)}` : null,
    fill, t: (parts, ...values) => parts.reduce((out, part, k) => out + fill(part) + (k < values.length ? String(values[k]) : ""), ""),
  };
}
let testWords: EmailWordsInput | undefined;
/** Tests only: another build's inputs in place of this one's (undefined: this build's again). */
export function setEmailWordsForTest(i: EmailWordsInput | undefined) { testWords = i; }
/** This build's email words. */
export const emailWords = (): EmailWords => wordsFor(testWords ?? {
  name: PROFILE.name, sender_name: PROFILE.email_sender_name, short_description: PROFILE.short_description,
  // The build's own profile (not the tests' notification switch): its email.pitch, else the landing block's.
  pitch: (PROFILE as { email?: ProfileEmail }).email?.pitch ?? GENERATED_EMAIL_PITCH, words: vocabulary(),
});
/** The signature: the profile's sender name (src/profile.ts). */
const sign = (w: EmailWords = emailWords()) => `— ${w.sender}`;
const hello = (name?: string | null) => `Hi${name?.trim() ? ` ${name.trim().split(/\s+/)[0]}` : ""},`;
const lines = (...parts: (string | null | false | undefined)[]) => parts.filter((p): p is string => typeof p === "string").join("\n\n");
const money = (usd: number) => `$${usd.toFixed(usd % 1 ? 2 : 0)}`;

// ---------- who gets what ----------

/** Operator alerts: EMAIL_ADMIN_TO, else the platform owners (APP_PLATFORM_ADMINS addresses and Clerk owners). */
export async function adminRecipients(): Promise<string[]> {
  await freshSettings();
  const set = settingText("EMAIL_ADMIN_TO").split(",").map((x) => x.trim().toLowerCase()).filter(isEmail);
  if (set.length) return [...new Set(set)];
  const out = new Set(clerk.platformAdminEntries().filter(isEmail));
  if (people().enabled()) {
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
  const dir = people();
  if (!o?.clerk_org_id || !dir.enabled()) return [];
  const out = new Set<string>();
  for (const m of await dir.memberships.list(o.clerk_org_id)) {
    if (clerk.isSuspended(m) || !roles.includes(accountRoleOf(m))) continue;
    const id = m.public_user_data?.identifier;
    const email = isEmail(id) ? id : m.public_user_data?.user_id ? clerk.primaryEmail(await dir.users.get(m.public_user_data.user_id)).email : null;
    if (isEmail(email)) out.add(email.toLowerCase());
  }
  return [...out];
}

/** The person behind an actor label: "customer:<email>" (the portal) or "ai:<Clerk user id>" (the connector). */
async function personOf(actor: string | null | undefined): Promise<string | null> {
  const [kind, rest] = [String(actor ?? "").split(":")[0], String(actor ?? "").split(":").slice(1).join(":")];
  if (kind === "customer" && isEmail(rest)) return rest.toLowerCase();
  if (kind === "ai" && rest.startsWith("user_") && people().enabled()) {
    try { return clerk.primaryEmail(await people().users.get(rest)).email; } catch { return null; }
  }
  return null;
}

const each = (to: string[], build: (to: string) => Email) => Promise.all(to.map((t) => sendLater(build(t))));

// ---------- access requests (src/http.ts, src/admin.ts) ----------

export interface RequestFacts { id: number; email: string; company: string; name?: string | null; product_url?: string | null; message?: string | null }

/** A new access request: "we got it" to the requester, and an alert to the operator. */
export function requestReceived(r: RequestFacts) {
  const meta = { request_id: r.id };
  const w = emailWords();
  return Promise.all([
    sendLater({ kind: "request_received", to: r.email, idempotencyKey: `request:${r.id}:received`, meta,
      subject: w.t`We got your request for {product}`,
      text: lines(hello(r.name),
        w.t`Thanks for asking for access to {product} for ${r.company}. We read every request ourselves and will get back to you by email, usually within a few working days.`,
        "If you want to add anything in the meantime, just reply to this email.",
        sign(w)) }),
    adminRecipients().then((to) => each(to, (t) => ({ kind: "request_alert", to: t, idempotencyKey: keyFor(`request:${r.id}:alert`, t), meta,
      subject: `New access request: ${r.company}`.slice(0, 200),
      text: lines(w.t`${r.name?.trim() || "Someone"} from ${r.company} asked for access to {product}.`,
        [`Email: ${r.email}`, r.product_url ? `Product: ${r.product_url}` : null].filter(Boolean).join("\n"),
        r.message ? `What they said:\n${r.message.slice(0, 1500)}` : null,
        `Review it: ${siteUrl()}/admin/requests`,
        sign(w)) }))),
  ]);
}

/** A request declined: a plain, kind note, with the reason when the reviewer gave one. */
export function requestDeclined(r: RequestFacts, reason?: string | null) {
  const w = emailWords();
  return sendLater({ kind: "request_declined", to: r.email, idempotencyKey: `request:${r.id}:declined`, meta: { request_id: r.id, with_reason: Boolean(reason) },
    subject: w.t`About your {product} request`,
    text: lines(hello(r.name),
      w.t`Thank you for your interest in {product}. We can't offer ${r.company} access right now.`,
      reason?.trim() ? `The reason: ${reason.trim()}` : null,
      "This isn't necessarily final. If things change on your side, or you think we've misread something, reply to this email and we'll take another look.",
      sign(w)) });
}

/** A request approved: a short welcome that goes with Clerk's invitation (which Clerk sends; this never resends it). */
export function requestApproved(r: RequestFacts, o: { account: string; invited: boolean }) {
  const w = emailWords();
  return sendLater({ kind: "request_approved", to: r.email, idempotencyKey: `request:${r.id}:approved`, meta: { request_id: r.id, invited: o.invited },
    subject: w.t`Welcome to {product}`,
    text: lines(hello(r.name),
      w.t`Your request is approved: ${o.account} now has a {product} {account}.`,
      w.pitch,
      o.invited
        ? w.t`You'll get a separate invitation email to join ${o.account}. Accept it to create your sign-in, then open ${siteUrl()}/app to connect {product} to your AI assistant and run your first {run}.`
        : `We'll send you your connection details separately. Once you have them, ${siteUrl()}/app walks you through setup.`,
      "Questions? Reply to this email.",
      sign(w)) });
}

// ---------- library submissions (src/contributions.ts) ----------

export interface SubmissionFacts { id: string; kind: "persona" | "task"; title: string; org_id: number; org_name: string; org_slug: string; created_by: string | null }
const noun = (k: "persona" | "task") => (k === "persona" ? "developer persona" : "programming task");

/** An account published an item to the library: an alert to the operator. */
export function submissionReceived(s: SubmissionFacts) {
  const w = emailWords();
  return adminRecipients().then((to) => each(to, (t) => ({ kind: "submission_alert", to: t, idempotencyKey: keyFor(`submission:${s.id}:alert`, t),
    meta: { submission_id: s.id, kind: s.kind, account: s.org_slug },
    subject: `Library submission from ${s.org_name}: ${s.title}`.slice(0, 200),
    text: lines(w.t`${s.org_name} submitted a ${noun(s.kind)} to {product}'s library: "${s.title}".`,
      `Review it: ${siteUrl()}/admin/${s.kind === "persona" ? "personas" : "tasks"}?view=submissions`,
      sign(w)) })));
}

/** Who to tell about a decision: the person who submitted it, else the account's owners. */
async function submitterOf(s: SubmissionFacts): Promise<string[]> {
  const p = await personOf(s.created_by);
  return p ? [p] : accountRecipients(s.org_id, ["owner"]);
}

/** Accepted: the credit, and that it comes off the next invoice (or that it is still being added). */
export async function submissionAccepted(s: SubmissionFacts, credit: { usd: number; status: "none" | "pending" | "credited" | null }) {
  const w = emailWords();
  const creditLine = !(credit.usd > 0) || credit.status === "none"
    ? null
    : credit.status === "credited"
      ? w.t`As thanks, we've added a ${money(credit.usd)} credit to your {account}. It comes off your next invoice automatically.`
      : w.t`As thanks, you've earned a ${money(credit.usd)} credit. It is still being added to your {account}; once it is, it comes off your next invoice automatically. You can see it on ${siteUrl()}/app/billing.`;
  return each(await submitterOf(s), (t) => ({ kind: "submission_accepted", to: t, idempotencyKey: keyFor(`submission:${s.id}:accepted`, t),
    meta: { submission_id: s.id, kind: s.kind, account: s.org_slug, credit_usd: credit.usd, credit_status: credit.status },
    subject: w.t`Your ${noun(s.kind)} is in {product}'s library`,
    text: lines("Hi,",
      w.t`Thanks for sharing "${s.title}". We reviewed it and added it to {product}'s library, where it now helps {runs} for everyone.`,
      creditLine,
      "Your own copy stays yours and unchanged.",
      sign(w)) }));
}

/** Declined: with the reason the reviewer gave (it is required). */
export async function submissionDeclined(s: SubmissionFacts, reason: string) {
  const w = emailWords();
  return each(await submitterOf(s), (t) => ({ kind: "submission_declined", to: t, idempotencyKey: keyFor(`submission:${s.id}:declined`, t),
    meta: { submission_id: s.id, kind: s.kind, account: s.org_slug },
    subject: w.t`About your ${noun(s.kind)} for {product}'s library`,
    text: lines("Hi,",
      w.t`Thanks for sharing "${s.title}". We've decided not to add it to {product}'s library this time.`,
      `The reason: ${reason.trim()}`,
      "Your own copy stays yours and keeps working as before. If you change it, you're welcome to submit it again.",
      sign(w)) }));
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
  if (!kindOn("budget_80").on) return { threshold: null, sent: 0 }; // usage alerts are off unless the profile lists usage
  try {
    const { orgBudget } = await import("./billing.js");
    const { orgMonthSpendUsd } = await import("./session-engine.js");
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
    const w = emailWords();
    const results = await each(to, (t) => ({ kind: over ? "budget_100" : "budget_80", to: t, idempotencyKey: keyFor(purpose, t),
      meta: { account: o?.slug ?? null, month: monthKey(now), threshold, spent_usd: Math.round(spent * 100) / 100, budget_usd: budget },
      subject: over ? w.t`${o?.name ?? w.fill("Your {account}")} has used its {product} allowance for ${month}` : w.t`${o?.name ?? w.fill("Your {account}")} has used ${threshold}% of its {product} allowance`,
      text: lines("Hi,",
        w.t`${o?.name ?? w.fill("Your {account}")} has spent ${money(spent)} of its ${money(budget)} monthly allowance for model usage in ${month} (${Math.floor(pct)}%).`,
        over ? w.t`New {runs} can't start until the allowance resets on ${reset}, or until it is raised.`
             : w.t`When it reaches 100%, new {runs} can't start until the allowance resets on ${reset}.`,
        w.t`Your plan and Budget rules are on ${siteUrl()}/app/billing. You're getting this because you're an {owner} or billing manager of the {account}.`,
        sign(w)) }));
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
 * names the workspace, area, the notices listed (`batch`, their ids) and the recipient, so the same list never goes to
 * the same person twice, and a list with other notices is another email. Never throws. `delivered` counts recipients
 * whose email went out (now or before).
 */
export async function dueSoon(orgId: number, d: { area: string; label: string; within_days: number; roles: AccountRole[]; day: string; items: DueItem[]; batch: string[] }):
  Promise<{ recipients: number; delivered: number }> {
  if (!kindOn("due_soon").on) return { recipients: 0, delivered: 0 }; // due-date emails are off unless the profile lists due_dates
  try {
    if (!d.items.length) return { recipients: 0, delivered: 0 };
    const [o] = await asPlatform(async () => (await getDb()).query<{ name: string; slug: string }>("SELECT name, slug FROM organizations WHERE id = $1", [orgId]));
    if (!o) return { recipients: 0, delivered: 0 };
    const to = await asPlatform(() => accountRecipients(orgId, d.roles));
    if (!to.length) { console.error(`email due_soon: ${o.slug} has no ${d.roles.join("/")} with an email`); return { recipients: 0, delivered: 0 }; }
    const n = d.items.length, shown = d.items.slice(0, 50);
    const list = shown.map((x) => `- ${(x.title ?? x.key).replace(/[\r\n]+/g, " ").slice(0, 200)} (${x.key}): due ${x.due_on}`).join("\n");
    const results = await Promise.all(to.map((t) => send({ kind: "due_soon", to: t, idempotencyKey: keyFor(`due:${orgId}:${d.area}:${createHash("sha256").update(d.batch.join(",")).digest("hex").slice(0, 16)}`, t),
      meta: { account: o.slug, area: d.area, day: d.day, items: n },
      subject: `${n} ${d.label.toLowerCase()} due within ${d.within_days} day${d.within_days === 1 ? "" : "s"} in ${o.name}`.slice(0, 200),
      text: lines("Hi,",
        `${n === 1 ? "This is" : "These are"} due in ${o.name} within the next ${d.within_days} day${d.within_days === 1 ? "" : "s"}:`,
        list + (n > shown.length ? `\n…and ${n - shown.length} more` : ""),
        `See them on ${siteUrl()}/app/notices. You're getting this because of your role in ${o.name} (${d.roles.join(", ")}).`,
        sign()) })));
    return { recipients: to.length, delivered: results.filter((r) => r.status === "sent" || r.status === "duplicate").length };
  } catch (e) {
    console.error(`email due_soon for ${orgId} failed:`, (e as Error).message);
    return { recipients: 0, delivered: 0 };
  }
}

// ---------- sign-in (mold_v0-004, 083: src/builtin-auth.ts builds no message of its own) ----------

/** A sign-in code: to the address that asked, only when it may sign in (the caller decides); the code is in the text, never the subject or the log. */
export function signInCode(c: { id: number | string; to: string; code: string; minutes: number }) {
  return sendLater({ kind: "sign_in_code", to: c.to, idempotencyKey: `sign-in-code:${c.id}`,
    subject: emailWords().t`Your {product} sign-in code`,
    text: lines(`Your sign-in code is ${c.code}`, `It works once, for ${c.minutes} minutes.`,
      emailWords().t`If you didn't ask to sign in to {product}, ignore this email: nobody can sign in without the code.`, sign()) });
}

/**
 * An invitation to a workspace: to the invited address only, linking to the console's sign-in page (consoleUrl, from
 * the server's environment; the place to go after it is a fixed path, never one a request named).
 */
export function invitation(i: { id: string; to: string; account: string; accountSlug: string; role: string; google: boolean; days: number }) {
  const w = emailWords();
  return sendLater({ kind: "invitation", to: i.to, idempotencyKey: `invitation:${i.id}`, meta: { invitation: i.id, account: i.accountSlug },
    subject: w.t`You're invited to ${oneLine(i.account, 80)} on {product}`,
    text: lines(`Hi,`, w.t`You're invited to join ${i.account} on {product} as ${i.role}.`,
      `To accept, sign in with this address (${i.to}): ${siteUrl()}/auth/sign-in?redirect_url=%2Fapp`,
      `We'll email you a sign-in code${i.google ? ", or you can continue with Google if this address is your Google account" : ""}. If you already use ${w.product}, accept the invitation on your profile page once signed in. The invitation is good for ${i.days} days.`,
      `If you weren't expecting it, ignore this email.`, sign()) });
}

// ---------- billing notices (mold_v0-083: src/run-charges.ts) ----------

/**
 * A run's charge (or credit) that could not be delivered after every try: one email per charge to the operator
 * (adminRecipients), naming the run and the workspace, never the customer's billing identifiers. Off unless the
 * profile lists billing.
 */
export async function billingNotice(n: { charge_id: string; run_id: string; kind: "charge" | "credit"; account: string | null; amount: string; tries: number; error: string }) {
  if (!kindOn("billing_notice").on) return [];
  const to = await adminRecipients();
  return each(to, (t) => ({ kind: "billing_notice", to: t, idempotencyKey: keyFor(`billing:${n.kind}:${n.charge_id}:gave-up`, t),
    meta: { charge_id: n.charge_id, run_id: n.run_id, account: n.account, tries: n.tries },
    // "run" here is the shell's own run charges (src/run-charges.ts; the console's FinOps, Run charges), not a pack's word.
    subject: `A run ${n.kind} could not be delivered (${n.run_id})`,
    text: lines("Hi,",
      `The ${n.kind} of ${n.amount} for run ${n.run_id}${n.account ? ` in ${n.account}` : ""} was not delivered after ${n.tries} tries, and is no longer retried by itself.`,
      // Stripe's identifiers (cus_…, sub_…) and any address in the error stay out of the email.
      `The last error: ${oneLine(n.error.replace(/\b(cus|sub|si|pi|in|ch|card|pm|src|acct|ba|seti)_[A-Za-z0-9]+/g, "$1_…").replace(/[^\s@<>,;"]+@[^\s@<>,;"]+/g, "*@…"), 300)}`,
      `Credit it or send it again by hand on ${siteUrl()}/admin (FinOps, Run charges).`,
      sign()) }));
}

// ---------- /admin/emails ----------

/** The test button: one email to the address typed in. */
export async function sendTest(actor: string, toIn: unknown) {
  const to = String(toIn ?? "").trim().toLowerCase();
  const r = await send({ kind: "test", to, idempotencyKey: `test:${randomUUID()}`, meta: { by_admin: hashAddress(actor).slice(0, 16) },
    subject: emailWords().t`{product} test email`,
    text: lines("Hi,", emailWords().t`This is a test email from {product}, sent from ${siteUrl()}/admin/emails. If you can read it, email is working.`, sign()) });
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
