/**
 * The mail intake (mold_v0-192; src/company-email.ts holds the mailboxes, src/mail-protocols.ts the wire): a scheduler
 * job of its own that reads each workspace's connected mailboxes and turns every new message into a record of the area
 * the pack's intake names (pack.json email.intake), its attachments sealed in the workspace's object store.
 *
 *   when       pollIntake(now): the inboxes whose next poll has come, one claimed at a time (FOR UPDATE SKIP LOCKED: two
 *              servers, or a server and the Vercel cron entry, never read one mailbox at once). A server polls from its
 *              own one-minute loop (startEmailIntake, APP_EMAIL_INTAKE=off turns it off); on Vercel the cron entry
 *              (/api/cron/autoscale) does. Each inbox at most every poll_minutes (1 to 1440, default 5); at most
 *              APP_EMAIL_INTAKE_MAX_MESSAGES messages per poll (25), the rest a minute later.
 *   what       only the folder (IMAP, Graph) or label (Gmail) the pack declares, from the read position the inbox keeps
 *              (an IMAP folder's UIDVALIDITY and last UID, a Graph delta link, a Gmail history id); the first poll looks
 *              back backfill_days (7). Read only: EXAMINE and BODY.PEEK on IMAP, read scopes on Graph and Gmail;
 *              nothing is deleted, moved, flagged or marked read.
 *   once       the ledger (workspace_email_messages) is keyed by the sha256 of the message's Message-ID in the workspace's
 *              area (the provider's own id when a message has none): a message is taken in once, however many mailboxes
 *              of the workspace hold it and however often a read position starts again. The record's key is
 *              mail-<24 hex of that hash>.
 *   kept       the record: its title the subject, its fields as the pack maps them (src/company-email-config.ts). Each
 *              attachment (at most max_count, each at most max_bytes) sealed with the workspace's data key under
 *              workspaces/org-<id>/.mail/ (bound to its workspace, message and place); one too large or past the count is
 *              listed with why, not kept. A message larger than 25 MB keeps its header fields only.
 *   failures   an inbox that fails is marked `error` with what failed (no secret) and polled again after 1, 2, 4 ...
 *              minutes (at most an hour, never sooner than its own interval); the others go on. A message that could not
 *              be stored is not marked read in the ledger and its read position does not pass it.
 *   isolation  every write is for the inbox row's own workspace: the record through withTenant (row-level security), the
 *              ledger and the objects under its org_id. Nothing is logged of a message but counts.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { getDb } from "./db.js";
import { vaultUnlocked } from "./keyvault.js";
import { openBytes, sealBytes } from "./orgcrypto.js";
import { inboxError, inboxSecret, intakeOf, intakeSpecs, type InboxRow } from "./company-email.js";
import type { EmailIntake } from "./company-email-config.js";
import { PackError, type PackTool, type Workspace } from "./pack-api.js";
import { asWriter, findArea, listFor, may, workspaceRecords, type Actor, type RecordArea } from "./record-areas.js";
import { keepsFiles, type IntakeSource } from "./company-email-config.js";
import type { StoredFileRef } from "./record-files-config.js";
import { openRecordFile, removeRecordFiles, storeRecordFile } from "./record-files.js";
import { sanitiseHtml } from "./html-sanitise.js";
import { keys, objectStore } from "./storage.js";
import { asPlatform, withTenant } from "./tenant-scope.js";
import { ENV } from "./env-names.js";
import * as wire from "./mail-protocols.js";
import { tracked } from "./scheduler-jobs.js";

const MAX_RAW = 25 * 1024 * 1024;
type FileSource = Extract<IntakeSource, "body_file" | "attachment_files">;
const maxPerPoll = () => Math.min(Math.max(Number(ENV.APP_EMAIL_INTAKE_MAX_MESSAGES) || 25, 1), 200);
const MS_DAY = 86_400_000;

export interface IntakeReport { ran: boolean; why?: string; inboxes: number; taken: number; duplicates: number; failed: number }
/** Whether the build reads mailboxes at all (a pack declares an intake). */
export const intakeWired = () => intakeSpecs().length > 0;

// ---------- one message ----------

/**
 * An attachment as the ledger lists it. `object_key`: its sealed object under .mail/ (bound to the ledger row); or, when the
 * intake keeps attachments as files on the record (mold_v0-220: email.intake.fields.attachment_files), `file`: its stored
 * file's reference (src/record-files.ts), the one copy, which the record's card and this list both read.
 */
export interface StoredAttachment { n: number; name: string; content_type: string; size: number; sha256: string; object_key: string | null; skipped?: string; file?: StoredFileRef }
const attAad = (orgId: number, row: number, n: number, sha: string) => `mail-attachment:v1:org-${orgId}:${row}:${n}:${sha}`;
const listAad = (orgId: number, row: number) => `mail-attachments:v1:org-${orgId}:${row}`;
const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** The record's fields from one message, as the pack maps them (absent values left out). */
export function recordData(it: EmailIntake, mail: wire.ParsedMail, mailbox: string, atts: StoredAttachment[], at: Date, notes: string[], areaFields: readonly { name: string; type?: string; max_length?: number; multiple?: boolean }[], files: MessageFiles = {}): Record<string, unknown> {
  const kept = atts.filter((a) => !a.skipped);
  const values: Record<string, unknown> = {
    subject: mail.subject || null, from: mail.from, from_name: mail.from_name, from_domain: mail.from?.split("@")[1] ?? null,
    to: mail.to.join(", ") || null, cc: mail.cc.join(", ") || null, date: mail.date, received_at: at.toISOString(),
    body: [notes.join(" "), it.body_chars ? mail.text.slice(0, it.body_chars) : ""].filter(Boolean).join("\n\n") || null,
    attachment_count: kept.length, mailbox, message_id: mail.message_id,
  };
  const out: Record<string, unknown> = {};
  for (const [src, field] of Object.entries(it.fields) as [keyof typeof values | "attachments" | FileSource, string][]) {
    const f = areaFields.find((x) => x.name === field);
    // Files on the record (mold_v0-220): references to what takeMessage kept, never their bytes.
    if (src === "body_file" || src === "attachment_files") {
      const refs = (src === "body_file" ? files.body : files.attachments) ?? [];
      if (refs.length) out[field] = f?.multiple ? refs : refs[0];
      continue;
    }
    let v: unknown = src === "attachments"
      ? ((f?.type ?? "text") === "json" ? atts.map((a) => ({ name: a.name, size: a.size, content_type: a.content_type, ...(a.skipped ? { skipped: a.skipped } : { sha256: a.sha256 }) }))
        : atts.map((a) => `${a.name} (${kb(a.size)}${a.skipped ? `, not kept: ${a.skipped}` : ""})`).join("; ") || null)
      : values[src];
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "string") v = v.replace(/\u0000/g, "").slice(0, f?.max_length ?? 20_000);
    out[field] = v;
  }
  return { ...out, ...(it.set ?? {}) };
}

/** The files takeMessage kept for a message's record (mold_v0-220). */
export interface MessageFiles { body?: StoredFileRef[]; attachments?: StoredFileRef[] }

/**
 * The message's body as files for its record (mold_v0-220): its HTML, sanitised (scripts, handlers and the rest gone;
 * remote images kept as addresses, blocked at preview until the reader asks), else its text; a `multiple` field both.
 */
async function keepBody(orgId: number, area: RecordArea, key: string, it: EmailIntake, mail: wire.ParsedMail): Promise<StoredFileRef[]> {
  const field = it.fields.body_file ? area.fields.find((f) => f.name === it.fields.body_file) : undefined;
  if (!field) return [];
  const out: StoredFileRef[] = [];
  const html = mail.html ? sanitiseHtml(mail.html, { remoteImages: "keep" }).html.trim() : "";
  if (html) out.push(await storeRecordFile(orgId, area, key, { name: "message.html", content_type: "text/html", data: Buffer.from(html, "utf8") }));
  if ((!html || field.multiple) && mail.text) out.push(await storeRecordFile(orgId, area, key, { name: "message.txt", content_type: "text/plain", data: Buffer.from(mail.text, "utf8") }));
  return out;
}

/**
 * Take one message in for an inbox's workspace: the ledger row first (a duplicate stops there), then the attachments,
 * then the record; anything failing undoes the ledger row and the objects, so the message is taken in on a later poll.
 */
export async function takeMessage(row: Pick<InboxRow, "id" | "org_id" | "pack" | "label">, it: EmailIntake, raw: Buffer, providerId: string, headersOnly = false, at = new Date()): Promise<"taken" | "duplicate"> {
  const orgId = row.org_id;
  const area = findArea(it.area);
  if (!area || area.pack !== row.pack) throw new Error(`the intake's area ${it.area} is not in this build`);
  const mail = wire.parseMail(raw, { headersOnly: headersOnly || raw.length > MAX_RAW });
  const hash = wire.messageKey(mail.message_id, `${row.id}:${providerId}`);
  const key = `mail-${hash.slice(0, 24)}`;
  const db = await getDb();
  const [led] = await asPlatform(() => db.query<{ id: string }>(
    `INSERT INTO workspace_email_messages (org_id, inbox_id, pack, area, message_hash, record_key) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (org_id, pack, area, message_hash) DO NOTHING RETURNING id`, [orgId, row.id, row.pack, it.area, hash, key]));
  if (!led) return "duplicate";
  const ledId = Number(led.id);
  const put: string[] = [];
  const kept: StoredFileRef[] = [];
  try {
    const { atts, files } = await keepFiles(orgId, ledId, area, key, it, mail, put, kept);
    const notes = headersOnly || raw.length > MAX_RAW ? ["(This message was larger than the intake reads: its text and attachments were not kept.)"] : [];
    const data = recordData(it, mail, row.label, atts, at, notes, area.fields, files);
    try {
      // mold_v0-236: the row is the intake's (its message's ledger entry names it).
      await asWriter({ by: "intake", id: `message:${ledId}` }, () => withTenant(orgId, () => workspaceRecords(row.pack, orgId).create(it.area, key, { title: (mail.subject || "(no subject)").slice(0, 300), data })));
    } catch (e) {
      // Already there (written before its ledger row was lost to a rollback): the record stands.
      if (!(e instanceof PackError && e.status === 409)) throw e;
    }
    const sealed = (await asPlatform(() => sealBytes(orgId, Buffer.from(JSON.stringify(atts)), listAad(orgId, ledId)))).toString("base64");
    await asPlatform(() => db.query("UPDATE workspace_email_messages SET attachments = $3, files = $4 WHERE org_id = $1 AND id = $2", [orgId, ledId, sealed, keepsFiles(it) ? "kept" : null]));
    return "taken";
  } catch (e) {
    await asPlatform(() => db.query("DELETE FROM workspace_email_messages WHERE org_id = $1 AND id = $2", [orgId, ledId])).catch(() => null);
    if (put.length) await objectStore().then((s) => s.remove(put)).catch(() => null);
    await removeRecordFiles(orgId, area.name, kept);
    throw e;
  }
}

/**
 * A message's attachments and body, kept: each attachment (at most max_count, each at most max_bytes) as a file on the
 * record when the intake maps attachment_files (one copy, src/record-files.ts), else sealed under .mail/ as before; the
 * body as files when it maps body_file. `put` and `kept` collect what was written, for the caller to undo.
 */
async function keepFiles(orgId: number, ledId: number, area: RecordArea, key: string, it: EmailIntake, mail: wire.ParsedMail, put: string[], kept: StoredFileRef[]): Promise<{ atts: StoredAttachment[]; files: MessageFiles }> {
  const atts: StoredAttachment[] = [];
  const asFiles = !!it.fields.attachment_files;
  const store = mail.attachments.length && !asFiles ? await objectStore() : null;
  for (const [i, a] of mail.attachments.entries()) {
    const n = i + 1, sha = createHash("sha256").update(a.data).digest("hex");
    const meta = { n, name: a.name, content_type: a.content_type, size: a.data.length, sha256: sha, object_key: null as string | null };
    if (i >= it.attachments.max_count) { atts.push({ ...meta, skipped: `more than ${it.attachments.max_count} attachments` }); continue; }
    if (a.data.length > it.attachments.max_bytes) { atts.push({ ...meta, skipped: `larger than ${kb(it.attachments.max_bytes)}` }); continue; }
    if (asFiles) {
      const file = await storeRecordFile(orgId, area, key, { name: a.name, content_type: a.content_type, data: a.data });
      kept.push(file);
      atts.push({ ...meta, file });
      continue;
    }
    const objectKey = keys.mail(orgId, ledId, n);
    await store!.put(objectKey, await asPlatform(() => sealBytes(orgId, a.data, attAad(orgId, ledId, n, sha))), "application/octet-stream");
    put.push(objectKey);
    atts.push({ ...meta, object_key: objectKey });
  }
  const body = await keepBody(orgId, area, key, it, mail);
  kept.push(...body);
  return { atts, files: { body, attachments: atts.flatMap((a) => (a.file ? [a.file] : [])) } };
}

// ---------- one inbox ----------

async function pollInbox(row: InboxRow, now: Date): Promise<{ taken: number; duplicates: number; more: boolean }> {
  const spec = intakeOf(row.pack)!;
  const it = spec.intake;
  const secret = await inboxSecret(row);
  if (!secret) throw new wire.MailError("auth_failed", "no secret is stored for this mailbox");
  const s = row.settings, max = maxPerPoll();
  const since = new Date(now.getTime() - it.backfill_days * MS_DAY);
  let taken = 0, duplicates = 0, more = false;
  const count = (r: "taken" | "duplicate") => { if (r === "taken") taken++; else duplicates++; };
  const save = (cursor: Record<string, unknown>) => asPlatform(async () => (await getDb()).query(
    "UPDATE workspace_email_inboxes SET cursor = $3::jsonb WHERE org_id = $1 AND id = $2", [row.org_id, row.id, JSON.stringify(cursor)]));
  if (row.provider === "smtp") {
    await wire.imapSession({ host: String(s.host), port: Number(s.port), security: s.security as wire.Security, username: String(s.username) }, secret, it.folder, async (box) => {
      const cur = row.cursor as { uidvalidity?: string; last_uid?: number };
      // A new folder or a changed UIDVALIDITY (the folder was rebuilt): read again from backfill_days; the ledger drops repeats.
      const fresh = !cur.uidvalidity || cur.uidvalidity !== box.info.uidvalidity;
      let last = fresh ? 0 : Number(cur.last_uid ?? 0);
      const uids = fresh ? (it.backfill_days ? await box.search(1, since) : []) : await box.search(last + 1, null);
      if (fresh && !it.backfill_days) last = Math.max(0, (box.info.uidnext ?? 1) - 1);
      const batch = uids.slice(0, max);
      more = uids.length > batch.length;
      try {
        for (const uid of batch) {
          const [m] = await box.fetch([uid], MAX_RAW);
          if (m) count(await takeMessage(row, it, m.raw, `imap:${box.info.uidvalidity}:${uid}`, m.headers_only, now));
          last = Math.max(last, uid);
        }
      } finally { await save({ uidvalidity: box.info.uidvalidity, last_uid: last }); }
    });
  } else if (row.provider === "graph") {
    const g = { tenant_id: String(s.tenant_id), client_id: String(s.client_id), mailbox: String(s.mailbox) };
    const cur = row.cursor as { delta?: string };
    const ch = await wire.graphChanges(g, secret, it.folder, cur.delta ?? null, since, max);
    for (const id of ch.ids) count(await takeMessage(row, it, await wire.graphMime(g, ch.token, id), `graph:${id}`, false, now));
    if (ch.next) await save({ delta: ch.next });
    more = ch.more;
  } else {
    const g = { mailbox: String(s.mailbox) };
    const cur = row.cursor as { history?: string };
    const ch = await wire.gmailChanges(g, secret, it.folder, cur.history ?? null, since, max);
    for (const id of ch.ids) count(await takeMessage(row, it, await wire.gmailRaw(ch.token, id), `gmail:${id}`, false, now));
    if (ch.next) await save({ history: ch.next });
    more = ch.more;
  }
  return { taken, duplicates, more };
}

/** Poll every inbox whose time has come (each claimed by one poller), then mark it: its status, counts and next poll. */
export async function pollIntake(now = new Date(), opts: { limit?: number } = {}): Promise<IntakeReport> {
  const report: IntakeReport = { ran: false, inboxes: 0, taken: 0, duplicates: 0, failed: 0 };
  if (!intakeWired()) return { ...report, why: "no pack declares a mail intake" };
  if (!vaultUnlocked()) return { ...report, why: "the key vault is locked: no mailbox secret can be opened" };
  report.ran = true;
  const db = await getDb();
  const packsHere = intakeSpecs().map((x) => x.pack);
  for (let i = 0; i < (opts.limit ?? 20); i++) {
    // Claimed for 15 minutes: a poller that dies leaves it to be polled again then.
    const [row] = await asPlatform(() => db.query<InboxRow>(
      `/* tenant: the intake's claim across workspaces; each poll then works for the claimed row's own workspace (org_id) */
       UPDATE workspace_email_inboxes SET next_poll_at = $1::timestamptz + interval '15 minutes'
        WHERE id = (SELECT id FROM workspace_email_inboxes WHERE enabled AND next_poll_at <= $1::timestamptz AND pack = ANY($2::text[])
                     ORDER BY next_poll_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`, [now.toISOString(), packsHere]));
    if (!row) break;
    report.inboxes++;
    try {
      const r = await pollInbox(row, now);
      report.taken += r.taken; report.duplicates += r.duplicates;
      await asPlatform(() => db.query(
        `UPDATE workspace_email_inboxes SET status = 'connected', last_error = NULL, last_error_kind = NULL, failures = 0, last_poll_at = $3::timestamptz,
           received_count = received_count + $4, next_poll_at = $3::timestamptz + make_interval(mins => CASE WHEN $5 THEN 1 ELSE poll_minutes END)
         WHERE org_id = $1 AND id = $2`, [row.org_id, row.id, now.toISOString(), r.taken, r.more]));
    } catch (e) {
      report.failed++;
      const err = inboxError(e);
      await asPlatform(() => db.query(
        `UPDATE workspace_email_inboxes SET status = 'error', last_error = $3, last_error_kind = $4, failures = failures + 1, last_poll_at = $5::timestamptz,
           next_poll_at = $5::timestamptz + make_interval(mins => GREATEST(poll_minutes, LEAST(60, power(2, LEAST(failures, 6))::int)))
         WHERE org_id = $1 AND id = $2`, [row.org_id, row.id, err.message, err.kind, now.toISOString()])).catch(() => null);
    }
  }
  return report;
}

// ---------- the one-off backfill of message files (mold_v0-220) ----------

export interface BackfillReport { ran: boolean; why?: string; inboxes: number; scanned: number; filled: number; not_found: number; failed: number }
const BACKFILL_MAX_DAYS = 90;
const backfillMax = () => Math.min(Math.max(Number(ENV.APP_EMAIL_BACKFILL_MAX_MESSAGES) || 500, 1), 5000);

/**
 * Messages taken in before the intake kept bodies and attachments as files (their ledger rows' `files` is NULL) get them
 * once: each mailbox that brought such messages is read again, read only as always, over the window they came in
 * (from the oldest one's arrival less backfill_days, at most 90 days back, at most APP_EMAIL_BACKFILL_MAX_MESSAGES
 * messages), and a message whose Message-ID hash (the ledger's key) matches gets its body and attachments kept as files
 * on its record; nothing else of the record changes. What the window does not hold any more (deleted, moved, too old) is
 * marked `not_found` and never looked for again; every match `backfilled`. One mailbox at a time, claimed for 30
 * minutes (two pollers never read one at once); a mailbox that fails is tried again after that. Runs with the intake's
 * loop and the Vercel cron entry, and does nothing once no row is waiting.
 */
export async function backfillMessageFiles(now = new Date(), opts: { limit?: number } = {}): Promise<BackfillReport> {
  const report: BackfillReport = { ran: false, inboxes: 0, scanned: 0, filled: 0, not_found: 0, failed: 0 };
  const specs = intakeSpecs().filter((x) => keepsFiles(x.intake));
  if (!specs.length) return { ...report, why: "no intake keeps files" };
  if (!vaultUnlocked()) return { ...report, why: "the key vault is locked" };
  report.ran = true;
  const db = await getDb();
  for (let i = 0; i < (opts.limit ?? 1); i++) {
    const [row] = await asPlatform(() => db.query<InboxRow>(
      `/* tenant: the backfill's claim across workspaces; the work is then for the claimed row's own workspace (org_id) */
       UPDATE workspace_email_inboxes SET files_backfill_at = $1::timestamptz + interval '30 minutes'
        WHERE id = (SELECT i.id FROM workspace_email_inboxes i
                     WHERE i.enabled AND i.pack = ANY($2::text[]) AND (i.files_backfill_at IS NULL OR i.files_backfill_at <= $1::timestamptz)
                       AND EXISTS (SELECT 1 FROM workspace_email_messages m WHERE m.org_id = i.org_id AND m.inbox_id = i.id AND m.files IS NULL)
                     ORDER BY i.id LIMIT 1 FOR UPDATE OF i SKIP LOCKED)
        RETURNING *`, [now.toISOString(), specs.map((x) => x.pack)]));
    if (!row) break;
    report.inboxes++;
    try {
      const r = await backfillInbox(row, now);
      report.scanned += r.scanned; report.filled += r.filled; report.not_found += r.not_found;
    } catch (e) {
      report.failed++;
      console.error(`mail intake: a mailbox's file backfill failed (${inboxError(e).kind})`);
    }
  }
  return report;
}

async function backfillInbox(row: InboxRow, now: Date): Promise<{ scanned: number; filled: number; not_found: number }> {
  const it = intakeOf(row.pack)!.intake;
  const area = findArea(it.area);
  if (!area || area.pack !== row.pack) return { scanned: 0, filled: 0, not_found: 0 };
  const db = await getDb();
  const pending = await asPlatform(() => db.query<{ id: string; message_hash: string; record_key: string; received_at: Date }>(
    `SELECT id, message_hash, record_key, received_at FROM workspace_email_messages
      WHERE org_id = $1 AND inbox_id = $2 AND pack = $3 AND area = $4 AND files IS NULL ORDER BY id`, [row.org_id, row.id, row.pack, it.area]));
  const waiting = new Map(pending.map((p) => [p.message_hash, p]));
  const oldest = Math.min(...pending.map((p) => new Date(p.received_at).getTime()));
  const since = new Date(Math.max(now.getTime() - BACKFILL_MAX_DAYS * MS_DAY, oldest - (it.backfill_days + 2) * MS_DAY));
  const secret = await inboxSecret(row);
  if (!secret) throw new wire.MailError("auth_failed", "no secret is stored for this mailbox");
  const max = backfillMax();
  let scanned = 0, filled = 0;
  const one = async (raw: Buffer, providerId: string) => {
    scanned++;
    const mail = wire.parseMail(raw);
    const hit = waiting.get(wire.messageKey(mail.message_id, `${row.id}:${providerId}`));
    if (!hit) return;
    waiting.delete(hit.message_hash);
    if (await fillRecord(row, it, area, Number(hit.id), hit.record_key, mail)) filled++;
  };
  const s = row.settings;
  if (row.provider === "smtp") {
    await wire.imapSession({ host: String(s.host), port: Number(s.port), security: s.security as wire.Security, username: String(s.username) }, secret, it.folder, async (box) => {
      for (const uid of (await box.search(1, since)).slice(-max)) {
        if (!waiting.size) break;
        const [m] = await box.fetch([uid], MAX_RAW);
        if (m && !m.headers_only) await one(m.raw, `imap:${box.info.uidvalidity}:${uid}`);
      }
    });
  } else if (row.provider === "graph") {
    const g = { tenant_id: String(s.tenant_id), client_id: String(s.client_id), mailbox: String(s.mailbox) };
    const ch = await wire.graphChanges(g, secret, it.folder, null, since, max);
    for (const id of ch.ids.slice(0, max)) { if (!waiting.size) break; await one(await wire.graphMime(g, ch.token, id), `graph:${id}`); }
  } else {
    const g = { mailbox: String(s.mailbox) };
    const ch = await wire.gmailChanges(g, secret, it.folder, null, since, max);
    for (const id of ch.ids.slice(-max)) { if (!waiting.size) break; await one(await wire.gmailRaw(ch.token, id), `gmail:${id}`); }
  }
  // What the window no longer holds is not looked for again.
  const left = [...waiting.values()].map((p) => p.id);
  if (left.length) await asPlatform(() => db.query("UPDATE workspace_email_messages SET files = 'not_found' WHERE org_id = $1 AND id = ANY($2::bigint[]) AND files IS NULL", [row.org_id, left]));
  return { scanned, filled, not_found: left.length };
}

/** One record's body and attachments kept as files from its message read again; its other fields as they are. */
async function fillRecord(row: InboxRow, it: EmailIntake, area: RecordArea, ledId: number, key: string, mail: wire.ParsedMail): Promise<boolean> {
  const orgId = row.org_id, db = await getDb();
  const recs = workspaceRecords(row.pack, orgId);
  const record = await withTenant(orgId, () => recs.get(it.area, key));
  if (!record) {
    await asPlatform(() => db.query("UPDATE workspace_email_messages SET files = 'not_found' WHERE org_id = $1 AND id = $2", [orgId, ledId]));
    return false;
  }
  const put: string[] = [], kept: StoredFileRef[] = [];
  try {
    const before = await attachmentsOf(orgId, it.area, key);
    const { atts, files } = await keepFiles(orgId, ledId, area, key, it, mail, put, kept);
    const data: Record<string, unknown> = { ...record.data };
    const field = (src: "body_file" | "attachment_files") => area.fields.find((f) => f.name === it.fields[src]);
    for (const [src, refs] of [["body_file", files.body ?? []], ["attachment_files", files.attachments ?? []]] as const) {
      const f = field(src);
      if (f && refs.length) data[f.name] = f.multiple ? refs : refs[0];
    }
    await asWriter({ by: "intake", id: `message:${ledId}` }, () => withTenant(orgId, () => recs.update(it.area, key, { title: record.title, data })));
    const sealed = (await asPlatform(() => sealBytes(orgId, Buffer.from(JSON.stringify(atts)), listAad(orgId, ledId)))).toString("base64");
    await asPlatform(() => db.query("UPDATE workspace_email_messages SET attachments = $3, files = 'backfilled' WHERE org_id = $1 AND id = $2", [orgId, ledId, sealed]));
    // The attachments' old sealed copies under .mail/ (now kept as the record's files): removed.
    const old = it.fields.attachment_files ? before.flatMap((a) => (a.object_key ? [a.object_key] : [])) : [];
    if (old.length) await objectStore().then((st) => st.remove(old)).catch(() => null);
    return true;
  } catch (e) {
    if (put.length) await objectStore().then((st) => st.remove(put)).catch(() => null);
    await removeRecordFiles(orgId, area.name, kept);
    throw e;
  }
}

let timer: NodeJS.Timeout | null = null;
let busy = false;
/** The server's loop: a poll every minute (Vercel has no loop: its cron entry polls). */
export function startEmailIntake(everyMs = 60_000): boolean {
  if (timer || (ENV.APP_EMAIL_INTAKE ?? "on").toLowerCase() === "off" || !intakeWired()) return false;
  const run = () => {
    if (busy) return;
    busy = true;
    // mold_v0-220: the one-off backfill of message files runs after the poll, as part of the same job (nothing to do once no row waits).
    tracked("email_intake", async () => ({ ...(await pollIntake()), files_backfill: await backfillMessageFiles() })).then((r) => {
      if (r.taken || r.failed) console.error(`mail intake: ${r.inboxes} mailbox(es), ${r.taken} message(s) taken in, ${r.failed} failed`);
      const b = r.files_backfill;
      if (b.filled || b.failed) console.error(`mail intake: ${b.filled} earlier message(s) got their files, ${b.not_found} not found, ${b.failed} mailbox(es) failed`);
    })
      .catch((e) => console.error("mail intake:", (e as Error).message)).finally(() => { busy = false; });
  };
  timer = setInterval(run, everyMs);
  timer.unref();
  setTimeout(run, 7_000).unref();
  return true;
}
export function stopEmailIntake() { if (timer) clearInterval(timer); timer = null; }

// ---------- reading what was taken in ----------

/** A record's attachments as the ledger keeps them (opened with its workspace's key), for people who may read its area. */
export async function attachmentsOf(orgId: number, area: string, recordKey: string): Promise<StoredAttachment[]> {
  const rows = await asPlatform(async () => (await getDb()).query<{ id: string; attachments: string | null }>(
    "SELECT id, attachments FROM workspace_email_messages WHERE org_id = $1 AND area = $2 AND record_key = $3", [orgId, area, recordKey]));
  const out: StoredAttachment[] = [];
  for (const r of rows) if (r.attachments)
    out.push(...JSON.parse((await asPlatform(() => openBytes(orgId, Buffer.from(r.attachments!, "base64"), listAad(orgId, Number(r.id))))).toString("utf8")) as StoredAttachment[]);
  return out;
}
/** One attachment's bytes, for a person of the workspace who may read the area. */
export async function readAttachment(orgId: number, actor: Actor, area: string, recordKey: string, n: number): Promise<{ name: string; content_type: string; data: Buffer }> {
  const a = findArea(area);
  if (!a || !intakeSpecs().some((s) => s.intake.area === area) || !may(a, "read", actor)) throw new PackError("no such attachment", 404);
  const [row] = await asPlatform(async () => (await getDb()).query<{ id: string }>(
    "SELECT id FROM workspace_email_messages WHERE org_id = $1 AND area = $2 AND record_key = $3 ORDER BY id LIMIT 1", [orgId, area, recordKey]));
  const att = row ? (await attachmentsOf(orgId, area, recordKey)).find((x) => x.n === n && (x.object_key || x.file)) : null;
  if (!row || !att) throw new PackError("no such attachment", 404);
  if (att.file) return { name: att.name, content_type: att.content_type, data: await openRecordFile(orgId, a, recordKey, att.file) };
  const sealed = await (await objectStore()).get(att.object_key!);
  if (!sealed) throw new PackError("the attachment's object is missing", 410);
  const data = await asPlatform(() => openBytes(orgId, sealed, attAad(orgId, Number(row.id), att.n, att.sha256)));
  return { name: att.name, content_type: att.content_type, data };
}

// ---------- MCP: list_intake_items ----------

/** The shell's intake tool, when a pack declares an intake (none with zero packs: the MCP surface is unchanged). */
export function intakeTools(): PackTool[] {
  const specs = intakeSpecs();
  if (!specs.length) return [];
  const areas = specs.map((s) => s.intake.area) as [string, ...string[]];
  return [{
    name: "list_intake_items",
    title: "List mail taken in",
    description: `List the messages the workspace's connected mailboxes brought in, newest first: each record's key, subject, sender and when it was received, with its attachments' names and sizes (read the record with get_record for every field). Areas: ${specs.map((s) => `${s.intake.area}${s.intake.label ? ` (${s.intake.label})` : ""}`).join("; ")}.`,
    inputSchema: {
      area: z.enum(areas).optional().describe("The intake's record area (default: the first)"),
      limit: z.number().int().min(1).max(100).optional().describe("Items per page (default 25)"),
      after: z.string().max(200).optional().describe("The next value of the previous page"),
    },
    annotations: { title: "List mail taken in", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (ws: Workspace, args: { area?: string; limit?: number; after?: string }) => {
      const area = args.area ?? areas[0];
      const spec = specs.find((s) => s.intake.area === area);
      if (!spec) throw new PackError(`no intake area ${String(area).slice(0, 64)}`, 404);
      const actor = { role: ws.role, userId: ws.userId };
      // The area's own read rule (its roles) applies, as for list_records.
      const page = await listFor(ws.id, area, { limit: args.limit ?? 25, after: args.after, sort: "-updated_at" }, actor);
      const f = spec.intake.fields;
      const items = await Promise.all(page.records.map(async (r) => ({
        key: r.key, subject: r.title,
        ...(f.from ? { from: r.data[f.from] ?? null } : {}), ...(f.date ? { date: r.data[f.date] ?? null } : {}), ...(f.received_at ? { received_at: r.data[f.received_at] ?? null } : {}),
        received: r.updated_at,
        attachments: (await attachmentsOf(ws.id, area, r.key)).map((a) => ({ n: a.n, name: a.name, size: a.size, content_type: a.content_type, ...(a.skipped ? { not_kept: a.skipped } : {}) })),
      })));
      return { area, label: spec.intake.label ?? findArea(area)?.label ?? area, items, next: page.next };
    },
  }] as unknown as PackTool[];
}
