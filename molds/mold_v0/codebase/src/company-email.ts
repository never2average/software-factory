/**
 * A company's own email, per workspace (mold_v0-192; molds/mold_v0/MOLD.md "The company's own email"). A pack turns it
 * on (pack.json `email`, src/company-email-config.ts); a workspace's admins (owners: "manage") configure it on the
 * console's Settings › Email page (src/email-routes.ts at /api/email):
 *
 *   sender    one per workspace: SMTP, Microsoft 365 (Graph) or Google Workspace (Gmail API). When it is on, the app's
 *             emails to that workspace's people (due dates, usage alerts, invitations, a library item's outcome) go
 *             out through it (src/email.ts asks companySender); otherwise through the app's default sender, as before.
 *             Sign-in codes and the operator's own alerts never use it.
 *   inboxes   mailboxes the intake reads (src/email-intake.ts): IMAP, Graph or Gmail, limited to the folder or label
 *             the pack declares, read only.
 *
 * Credentials are write-only: set or replaced, never returned (no part of them: the console shows "Set", when and by
 * whom). Each is sealed with the workspace's data key (src/orgcrypto.ts sealBytes, AES-256-GCM, the key wrapped by the
 * vault's master key) and bound by additional data to its workspace and its slot, so a sealed value moved to another row
 * or workspace does not open. The tables (sql/migrations/0031_company_email.sql) have no grant for tenant work (a
 * pack's code never reads them) and no admin route, admin MCP tool, operator script or log line shows a workspace's
 * settings, credentials or mail: the platform operator never sees them. Errors are kept with the secret cut out.
 */
import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { vaultUnlocked } from "./keyvault.js";
import { openBytes, sealBytes } from "./orgcrypto.js";
import { EmailPackSchema, type EmailIntake } from "./company-email-config.js";
import { PackError } from "./pack-api.js";
import { packs } from "./packs.js";
import { asPlatform } from "./tenant-scope.js";
import * as wire from "./mail-protocols.js";

export const PROVIDERS = ["smtp", "graph", "gmail"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_LABELS: Record<Provider, string> = { smtp: "SMTP / IMAP", graph: "Microsoft 365", gmail: "Google Workspace" };

// ---------- what the packs turn on ----------

export interface IntakeSpec { pack: string; intake: EmailIntake }
let cache: { from: unknown; sender: boolean; intakes: IntakeSpec[] } | null = null;
function specs() {
  const list = packs();
  if (cache?.from === list) return cache;
  const parsed = list.filter((p) => p.definition.email).map((p) => ({ pack: p.id, email: EmailPackSchema.parse(p.definition.email) }));
  cache = { from: list, sender: parsed.some((p) => p.email.sender?.allow === true), intakes: parsed.filter((p) => p.email.intake).map((p) => ({ pack: p.pack, intake: p.email.intake! })) };
  return cache;
}
/** Whether a workspace may give the app its own sender (a pack says sender.allow). */
export const senderAllowed = () => specs().sender;
/** The mailbox intakes the packs declare, one per pack. */
export const intakeSpecs = (): IntakeSpec[] => specs().intakes;
/** Whether the build has anything of this (else nothing is mounted, polled or offered). */
export const companyEmailWired = () => senderAllowed() || intakeSpecs().length > 0;
export const intakeOf = (pack: string) => intakeSpecs().find((s) => s.pack === pack) ?? null;

// ---------- checking what a person typed ----------

const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const isAddress = (v: unknown): v is string => typeof v === "string" && v.length <= 254 && ADDRESS.test(v);
const text = (v: unknown, max: number, what: string, required = false): string | null => {
  if (v === undefined || v === null || v === "") { if (required) throw new PackError(`${what} is required`, 400); return null; }
  if (typeof v !== "string" || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw new PackError(`${what}: text of at most ${max} characters on one line`, 400);
  return v.trim();
};
const mailErr = (e: unknown) => (e instanceof wire.MailError ? new PackError(e.message, 400) : e);

/** The settings a person gives (never a secret), per provider and use. */
export type Settings = Record<string, string | number | string[] | null>;
function checkSettings(provider: Provider, use: "sender" | "inbox", b: Record<string, unknown>): Settings {
  const out: Settings = {};
  if (use === "sender") {
    const from = text(b.from_address, 254, "from_address", true)!.toLowerCase();
    if (!isAddress(from)) throw new PackError("from_address: an email address", 400);
    out.from_address = from;
    out.from_name = text(b.from_name, 100, "from_name");
    if (out.from_name && /[<>"@]/.test(out.from_name)) throw new PackError("from_name: a name, without < > \" or @", 400);
    const reply = Array.isArray(b.reply_to) ? b.reply_to : typeof b.reply_to === "string" && b.reply_to ? b.reply_to.split(",") : [];
    const replies = reply.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    if (replies.length > 5 || replies.some((x) => !isAddress(x))) throw new PackError("reply_to: up to 5 email addresses", 400);
    out.reply_to = replies;
  } else {
    out.label = text(b.label, 60, "label", true);
  }
  if (provider === "smtp") {
    const host = text(b.host, 253, "host", true)!.toLowerCase();
    if (!wire.isHostName(host)) throw new PackError("host: a host name, such as mail.example.com", 400);
    const port = Number(b.port ?? (use === "sender" ? 587 : 993));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PackError("port: 1 to 65535", 400);
    const security = String(b.security ?? (port === 465 || port === 993 ? "tls" : "starttls"));
    try { wire.checkSecurity(security); } catch (e) { throw mailErr(e); }
    out.host = host; out.port = port; out.security = security;
    out.username = text(b.username, 254, "username", use === "inbox");
  } else if (provider === "graph") {
    out.tenant_id = text(b.tenant_id, 100, "tenant_id", true);
    if (!/^[A-Za-z0-9.-]+$/.test(out.tenant_id!)) throw new PackError("tenant_id: the directory (tenant) id or its domain", 400);
    out.client_id = text(b.client_id, 200, "client_id", true);
    if (!/^[A-Za-z0-9.@_-]+$/.test(out.client_id!)) throw new PackError("client_id: the application (client) id", 400);
  }
  if (provider !== "smtp") {
    const mb = (text(b.mailbox, 254, "mailbox", use === "inbox") ?? (out.from_address as string)).toLowerCase();
    if (!isAddress(mb)) throw new PackError("mailbox: the mailbox's address", 400);
    out.mailbox = mb;
  } else if (use === "inbox") {
    const mb = text(b.mailbox, 254, "mailbox");
    if (mb && !isAddress(mb.toLowerCase())) throw new PackError("mailbox: the mailbox's address", 400);
    out.mailbox = mb ? mb.toLowerCase() : null;
  }
  return out;
}
function checkSecret(provider: Provider, v: unknown): string {
  if (typeof v !== "string" || !v.length || v.length > 16 * 1024 || v.includes("\u0000")) throw new PackError("the secret: text of up to 16 KB", 400);
  if (provider === "gmail") { try { wire.parseServiceAccount(v); } catch (e) { throw mailErr(e); } return v.trim(); }
  if (/[\r\n]/.test(v)) throw new PackError("the password or client secret is one line", 400);
  if (provider === "graph" && v.length < 8) throw new PackError("the client secret: at least 8 characters", 400);
  return v;
}
const needsSecret = (provider: Provider, s: Settings) => provider !== "smtp" || !!s.username;

// ---------- sealing ----------

const aad = (orgId: number, slot: string, provider: Provider) => JSON.stringify(["company-email/v1", orgId, slot, provider]);
async function seal(orgId: number, slot: string, provider: Provider, secret: string): Promise<string> {
  if (!vaultUnlocked()) throw new PackError("The key vault is locked: nothing is stored unsealed", 503);
  return (await asPlatform(() => sealBytes(orgId, Buffer.from(secret, "utf8"), aad(orgId, slot, provider)))).toString("base64");
}
async function unseal(orgId: number, slot: string, provider: Provider, sealed: string | null): Promise<string | null> {
  if (!sealed) return null;
  return (await asPlatform(() => openBytes(orgId, Buffer.from(sealed, "base64"), aad(orgId, slot, provider)))).toString("utf8");
}
/** A stored error: one line, the secret cut out, at most 300 characters. */
const cleanError = (e: unknown, secrets: (string | null)[] = []) => {
  const kind = e instanceof wire.MailError ? e.kind : "protocol";
  return { kind, message: wire.redact(String((e as Error)?.message ?? e).replace(/[\r\n]+/g, " "), secrets.filter((x): x is string => !!x)).slice(0, 300) };
};

// ---------- the sender ----------

interface SenderRow {
  org_id: number; provider: Provider; settings: Settings; slot: string; sealed: string | null; secret_set_at: Date | null; secret_set_by: string | null;
  enabled: boolean; status: string; last_error: string | null; last_error_kind: string | null; last_tested_at: Date | null; last_sent_at: Date | null;
  sent_count: number; failed_count: number; updated_at: Date; updated_by: string | null;
}
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const senderView = (r: SenderRow) => ({
  provider: r.provider, provider_label: PROVIDER_LABELS[r.provider], settings: r.settings, enabled: r.enabled,
  secret_set: !!r.sealed, secret_set_at: iso(r.secret_set_at), secret_set_by: r.secret_set_by,
  status: !r.enabled ? "paused" : r.status, last_error: r.last_error, last_error_kind: r.last_error_kind,
  hint: r.last_error_kind ? wire.MAIL_HINTS[r.last_error_kind as wire.MailErrorKind] ?? null : null,
  last_tested_at: iso(r.last_tested_at), last_sent_at: iso(r.last_sent_at), sent: Number(r.sent_count), failed: Number(r.failed_count), updated_at: iso(r.updated_at),
});
async function senderRow(orgId: number): Promise<SenderRow | null> {
  const [r] = await asPlatform(async () => (await getDb()).query<SenderRow>("SELECT * FROM workspace_email_senders WHERE org_id = $1", [orgId]));
  return r ?? null;
}
const requireSender = () => { if (!senderAllowed()) throw new PackError("This app sends its emails itself: no workspace sender", 404); };
/** The workspace's sender as its admins see it (never a secret), and what sends now. */
export async function getSender(orgId: number) {
  requireSender();
  const r = await senderRow(orgId);
  return { sender: r ? senderView(r) : null, effective: r?.enabled && (r.sealed || !needsSecret(r.provider, r.settings)) ? "workspace" : "app" };
}
/** Set or replace the sender. Omit `secret` to keep the stored one (same provider); a new provider needs its own. */
export async function putSender(orgId: number, by: string, b: Record<string, unknown>) {
  requireSender();
  const provider = b.provider as Provider;
  if (!PROVIDERS.includes(provider)) throw new PackError(`provider: ${PROVIDERS.join(", ")}`, 400);
  const settings = checkSettings(provider, "sender", (b.settings ?? {}) as Record<string, unknown>);
  const prev = await senderRow(orgId);
  const keep = b.secret === undefined || b.secret === null || b.secret === "";
  if (keep && needsSecret(provider, settings) && !(prev?.sealed && prev.provider === provider)) throw new PackError(provider === "smtp" ? "the password is required with a user name" : "the secret is required", 400);
  const slot = prev?.slot ?? randomBytes(12).toString("hex");
  const sealed = keep ? (prev?.provider === provider && needsSecret(provider, settings) ? prev.sealed : null) : await seal(orgId, slot, provider, checkSecret(provider, b.secret));
  const enabled = b.enabled === undefined ? prev?.enabled ?? true : b.enabled === true;
  await asPlatform(async () => (await getDb()).query(
    `INSERT INTO workspace_email_senders (org_id, provider, settings, slot, sealed, secret_set_at, secret_set_by, enabled, status, created_by, updated_by)
     VALUES ($1, $2, $3::jsonb, $4, $5, CASE WHEN $6 THEN now() END, CASE WHEN $6 THEN $7 END, $8, 'untested', $7, $7)
     ON CONFLICT (org_id) DO UPDATE SET provider = excluded.provider, settings = excluded.settings, sealed = excluded.sealed,
       secret_set_at = CASE WHEN $6 THEN now() WHEN excluded.sealed IS NULL THEN NULL ELSE workspace_email_senders.secret_set_at END,
       secret_set_by = CASE WHEN $6 THEN $7 WHEN excluded.sealed IS NULL THEN NULL ELSE workspace_email_senders.secret_set_by END,
       enabled = excluded.enabled, status = 'untested', last_error = NULL, last_error_kind = NULL, updated_by = $7, updated_at = now()`,
    [orgId, provider, JSON.stringify(settings), slot, sealed, !keep, by, enabled]));
  return getSender(orgId);
}
export async function setSenderEnabled(orgId: number, by: string, enabled: unknown) {
  requireSender();
  if (typeof enabled !== "boolean") throw new PackError("enabled: true or false", 400);
  const rows = await asPlatform(async () => (await getDb()).query("UPDATE workspace_email_senders SET enabled = $2, updated_by = $3, updated_at = now() WHERE org_id = $1 RETURNING org_id", [orgId, enabled, by]));
  if (!rows.length) throw new PackError("No sender to switch: configure one first", 404);
  return getSender(orgId);
}
export async function deleteSender(orgId: number): Promise<boolean> {
  requireSender();
  return (await asPlatform(async () => (await getDb()).query("DELETE FROM workspace_email_senders WHERE org_id = $1 RETURNING org_id", [orgId]))).length > 0;
}

/** One message out through a sender's provider. */
async function deliverVia(r: SenderRow, secret: string | null, m: { to: string; subject: string; text: string; html: string; replyTo?: string[] }): Promise<{ id: string | null }> {
  const s = r.settings;
  const fromAddr = String(s.from_address), fromName = (s.from_name as string | null) || null;
  const from = fromName ? `${fromName} <${fromAddr}>` : fromAddr;
  const replyTo = (m.replyTo?.length ? m.replyTo : (s.reply_to as string[] | null) ?? []).slice(0, 5);
  if (r.provider === "smtp") return wire.smtpSend({ host: String(s.host), port: Number(s.port), security: s.security as wire.Security, username: (s.username as string | null) ?? null }, secret,
    { from: fromAddr, to: m.to, mime: wire.buildMime({ from, to: m.to, replyTo, subject: m.subject, text: m.text, html: m.html }) });
  if (r.provider === "graph") return wire.graphSend({ tenant_id: String(s.tenant_id), client_id: String(s.client_id), mailbox: String(s.mailbox) }, secret ?? "", { from: fromAddr, fromName, to: m.to, replyTo, subject: m.subject, text: m.text, html: m.html });
  return wire.gmailSend({ mailbox: String(s.mailbox) }, secret ?? "", wire.buildMime({ from, to: m.to, replyTo, subject: m.subject, text: m.text, html: m.html }));
}
async function markSender(orgId: number, ok: boolean, err: { kind: string; message: string } | null, counted: boolean, tested: boolean) {
  await asPlatform(async () => (await getDb()).query(
    `UPDATE workspace_email_senders SET status = $2, last_error = $3, last_error_kind = $4,
       sent_count = sent_count + $5, failed_count = failed_count + $6, last_sent_at = CASE WHEN $5 > 0 THEN now() ELSE last_sent_at END,
       last_tested_at = CASE WHEN $7 THEN now() ELSE last_tested_at END WHERE org_id = $1`,
    [orgId, ok ? "connected" : "error", err?.message ?? null, err?.kind ?? null, counted && ok ? 1 : 0, counted && !ok ? 1 : 0, tested]));
}
/**
 * The Test button: sign in (and, given an address, send a test email to it through the workspace's own sender). The
 * answer and the stored status say what failed, by kind, with what to change; never a secret.
 */
export async function testSender(orgId: number, b: { to?: unknown }) {
  requireSender();
  const r = await senderRow(orgId);
  if (!r) throw new PackError("No sender to test: configure one first", 404);
  const to = b?.to === undefined || b?.to === null || b?.to === "" ? null : String(b.to).trim().toLowerCase();
  if (to !== null && !isAddress(to)) throw new PackError("to: an email address", 400);
  const t0 = Date.now();
  let secret: string | null = null;
  try {
    secret = await unseal(orgId, r.slot, r.provider, r.sealed);
    const s = r.settings;
    // Its words are the email adapter's (src/email.ts, the one place a message is written).
    if (to) { const { senderTestMessage } = await import("./email.js"); await deliverVia(r, secret, { to, ...senderTestMessage(PROVIDER_LABELS[r.provider]) }); }
    else if (r.provider === "smtp") await wire.smtpCheck({ host: String(s.host), port: Number(s.port), security: s.security as wire.Security, username: (s.username as string | null) ?? null }, secret);
    else if (r.provider === "graph") await wire.graphCheck({ tenant_id: String(s.tenant_id), client_id: String(s.client_id), mailbox: String(s.mailbox) }, secret ?? "", null);
    else await wire.gmailCheck({ mailbox: String(s.mailbox) }, secret ?? "", null);
    await markSender(orgId, true, null, !!to, true);
    return { ok: true, sent: !!to, ms: Date.now() - t0, error: null, kind: null, hint: null };
  } catch (e) {
    const err = cleanError(e, [secret]);
    await markSender(orgId, false, err, !!to, true);
    return { ok: false, sent: false, ms: Date.now() - t0, error: err.message, kind: err.kind, hint: wire.MAIL_HINTS[err.kind as wire.MailErrorKind] ?? null };
  }
}

/**
 * The workspace's own sender for one message (src/email.ts): null when the build allows none, the workspace has none,
 * it is switched off or it lacks its secret (then the app's default sender sends, as before). Otherwise a function that
 * sends and records the outcome on the sender (its counts, its last error); its error text holds no secret.
 */
export async function companySender(orgId: number): Promise<null | { provider: Provider; deliver(m: { to: string; subject: string; text: string; html: string; replyTo?: string[] }): Promise<{ ok: true; provider_id: string | null } | { ok: false; error: string }> }> {
  if (!senderAllowed() || !Number.isInteger(orgId)) return null;
  const r = await senderRow(orgId).catch(() => null);
  if (!r?.enabled || (needsSecret(r.provider, r.settings) && !r.sealed)) return null;
  return {
    provider: r.provider,
    async deliver(m) {
      let secret: string | null = null;
      try {
        secret = await unseal(orgId, r.slot, r.provider, r.sealed);
        const out = await deliverVia(r, secret, m);
        await markSender(orgId, true, null, true, false).catch(() => null);
        return { ok: true, provider_id: out.id };
      } catch (e) {
        const err = cleanError(e, [secret]);
        await markSender(orgId, false, err, true, false).catch(() => null);
        return { ok: false, error: `${err.kind}: ${err.message}` };
      }
    },
  };
}

// ---------- inboxes ----------

export interface InboxRow {
  id: string; org_id: number; pack: string; provider: Provider; label: string; settings: Settings; slot: string; sealed: string | null;
  secret_set_at: Date | null; secret_set_by: string | null; enabled: boolean; status: string; last_error: string | null; last_error_kind: string | null;
  last_poll_at: Date | null; next_poll_at: Date; failures: number; poll_minutes: number; cursor: Record<string, unknown>; received_count: number;
  created_at: Date; updated_at: Date;
}
export const inboxView = (r: InboxRow) => {
  const spec = intakeOf(r.pack);
  return {
    id: String(r.id), pack: r.pack, intake: spec ? { label: spec.intake.label ?? null, area: spec.intake.area, folder: spec.intake.folder } : null,
    provider: r.provider, provider_label: PROVIDER_LABELS[r.provider], label: r.label, settings: r.settings, enabled: r.enabled,
    secret_set: !!r.sealed, secret_set_at: iso(r.secret_set_at), secret_set_by: r.secret_set_by,
    status: !r.enabled ? "paused" : r.status, last_error: r.last_error, last_error_kind: r.last_error_kind,
    hint: r.last_error_kind ? wire.MAIL_HINTS[r.last_error_kind as wire.MailErrorKind] ?? null : null,
    last_poll_at: iso(r.last_poll_at), next_poll_at: iso(r.next_poll_at), poll_minutes: Number(r.poll_minutes), received: Number(r.received_count),
  };
};
const INBOX_ID = /^\d{1,18}$/;
const MAX_INBOXES = 10;
async function inboxRow(orgId: number, id: unknown): Promise<InboxRow> {
  if (typeof id !== "string" || !INBOX_ID.test(id)) throw new PackError("no such mailbox", 404);
  const [r] = await asPlatform(async () => (await getDb()).query<InboxRow>("SELECT * FROM workspace_email_inboxes WHERE org_id = $1 AND id = $2", [orgId, id]));
  if (!r) throw new PackError("no such mailbox", 404);
  return r;
}
export async function listInboxes(orgId: number) {
  const rows = await asPlatform(async () => (await getDb()).query<InboxRow>("SELECT * FROM workspace_email_inboxes WHERE org_id = $1 ORDER BY id", [orgId]));
  return rows.map(inboxView);
}
/** Connect a mailbox (or replace one's settings: `id`). Omit `secret` to keep the stored one (same provider). */
export async function putInbox(orgId: number, by: string, b: Record<string, unknown>) {
  const specsNow = intakeSpecs();
  if (!specsNow.length) throw new PackError("This app reads no mailbox", 404);
  const prev = b.id === undefined || b.id === null ? null : await inboxRow(orgId, b.id);
  const pack = typeof b.pack === "string" ? b.pack : prev?.pack ?? (specsNow.length === 1 ? specsNow[0]!.pack : null);
  if (!pack || !intakeOf(pack)) throw new PackError(`pack: ${specsNow.map((s) => s.pack).join(", ")}`, 400);
  const provider = b.provider as Provider;
  if (!PROVIDERS.includes(provider)) throw new PackError(`provider: ${PROVIDERS.join(", ")}`, 400);
  const settings = checkSettings(provider, "inbox", (b.settings ?? {}) as Record<string, unknown>);
  const label = settings.label as string;
  delete settings.label;
  const minutes = b.poll_minutes === undefined ? prev?.poll_minutes ?? 5 : Number(b.poll_minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new PackError("poll_minutes: 1 to 1440", 400);
  const keep = b.secret === undefined || b.secret === null || b.secret === "";
  if (keep && !(prev?.sealed && prev.provider === provider)) throw new PackError(provider === "smtp" ? "the password is required" : "the secret is required", 400);
  const slot = prev?.slot ?? randomBytes(12).toString("hex");
  const sealed = keep ? prev!.sealed : await seal(orgId, slot, provider, checkSecret(provider, b.secret));
  const enabled = b.enabled === undefined ? prev?.enabled ?? true : b.enabled === true;
  // Another mailbox, account or provider: its read position starts again (the ledger still drops what was read).
  const canon = (x: Settings) => JSON.stringify(Object.keys(x).sort().map((k) => [k, x[k] ?? null]));
  const same = prev && prev.provider === provider && canon(prev.settings) === canon(settings);
  const db = await getDb();
  if (prev) {
    await asPlatform(() => db.query(
      `UPDATE workspace_email_inboxes SET pack = $3, provider = $4, label = $5, settings = $6::jsonb, sealed = $7, enabled = $8, poll_minutes = $9,
         secret_set_at = CASE WHEN $10 THEN now() ELSE secret_set_at END, secret_set_by = CASE WHEN $10 THEN $11 ELSE secret_set_by END,
         cursor = CASE WHEN $12 THEN cursor ELSE '{}'::jsonb END, status = 'untested', last_error = NULL, last_error_kind = NULL, failures = 0,
         next_poll_at = now(), updated_by = $11, updated_at = now() WHERE org_id = $1 AND id = $2`,
      [orgId, prev.id, pack, provider, label, JSON.stringify(settings), sealed, enabled, minutes, !keep, by, !!same]));
    return inboxView(await inboxRow(orgId, String(prev.id)));
  }
  const [n] = await asPlatform(() => db.query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_email_inboxes WHERE org_id = $1", [orgId]));
  if (Number(n?.n) >= MAX_INBOXES) throw new PackError(`at most ${MAX_INBOXES} mailboxes per workspace`, 409);
  const [r] = await asPlatform(() => db.query<{ id: string }>(
    `INSERT INTO workspace_email_inboxes (org_id, pack, provider, label, settings, slot, sealed, secret_set_at, secret_set_by, enabled, poll_minutes, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now(), $8, $9, $10, $8, $8) RETURNING id`,
    [orgId, pack, provider, label, JSON.stringify(settings), slot, sealed, by, enabled, minutes]));
  return inboxView(await inboxRow(orgId, String(r!.id)));
}
export async function setInboxEnabled(orgId: number, id: unknown, by: string, enabled: unknown) {
  if (typeof enabled !== "boolean") throw new PackError("enabled: true or false", 400);
  const r = await inboxRow(orgId, id);
  // Resumed: polled at once, its back-off forgotten.
  await asPlatform(async () => (await getDb()).query(
    "UPDATE workspace_email_inboxes SET enabled = $3, failures = CASE WHEN $3 THEN 0 ELSE failures END, next_poll_at = CASE WHEN $3 THEN now() ELSE next_poll_at END, updated_by = $4, updated_at = now() WHERE org_id = $1 AND id = $2",
    [orgId, r.id, enabled, by]));
  return inboxView(await inboxRow(orgId, String(r.id)));
}
export async function deleteInbox(orgId: number, id: unknown): Promise<boolean> {
  const r = await inboxRow(orgId, id);
  return (await asPlatform(async () => (await getDb()).query("DELETE FROM workspace_email_inboxes WHERE org_id = $1 AND id = $2 RETURNING id", [orgId, r.id]))).length > 0;
}
/** An inbox's secret, for the intake (src/email-intake.ts) and its Test button: never leaves the server. */
export const inboxSecret = (r: InboxRow) => unseal(r.org_id, r.slot, r.provider, r.sealed);
export const inboxError = cleanError;

/** The Test button: sign in, open the pack's folder or label read-only and count its messages. Nothing is read or changed. */
export async function testInbox(orgId: number, id: unknown) {
  const r = await inboxRow(orgId, id);
  const spec = intakeOf(r.pack);
  if (!spec) throw new PackError("This mailbox's intake is not in this build", 409);
  const t0 = Date.now();
  let secret: string | null = null;
  try {
    secret = await inboxSecret(r);
    const s = r.settings, folder = spec.intake.folder;
    let messages: number | null;
    if (r.provider === "smtp") messages = await wire.imapSession({ host: String(s.host), port: Number(s.port), security: s.security as wire.Security, username: String(s.username) }, secret ?? "", folder, async (box) => box.info.exists);
    else if (r.provider === "graph") messages = (await wire.graphCheck({ tenant_id: String(s.tenant_id), client_id: String(s.client_id), mailbox: String(s.mailbox) }, secret ?? "", folder)).messages;
    else messages = (await wire.gmailCheck({ mailbox: String(s.mailbox) }, secret ?? "", folder)).messages;
    await asPlatform(async () => (await getDb()).query("UPDATE workspace_email_inboxes SET status = 'connected', last_error = NULL, last_error_kind = NULL WHERE org_id = $1 AND id = $2", [orgId, r.id]));
    return { ok: true, folder, messages, ms: Date.now() - t0, error: null, kind: null, hint: null };
  } catch (e) {
    const err = cleanError(e, [secret]);
    await asPlatform(async () => (await getDb()).query("UPDATE workspace_email_inboxes SET status = 'error', last_error = $3, last_error_kind = $4 WHERE org_id = $1 AND id = $2", [orgId, r.id, err.message, err.kind]));
    return { ok: false, folder: spec.intake.folder, messages: null, ms: Date.now() - t0, error: err.message, kind: err.kind, hint: wire.MAIL_HINTS[err.kind as wire.MailErrorKind] ?? null };
  }
}
