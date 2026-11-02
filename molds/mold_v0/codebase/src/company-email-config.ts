/**
 * What a pack declares for a company's own email (mold_v0-192; src/company-email.ts, src/email-intake.ts). Pure: zod
 * only, so src/pack-api.ts (definePack), src/pack-manifest.ts (pack.json) and the build read the same rules.
 *
 *   "email": {
 *     "sender": { "allow": true },
 *     "intake": {
 *       "area": "inbound_mail",            one of the pack's own workspace areas, not fed by a repository
 *       "label": "Regulatory mail",        what the console calls this kind of mailbox (default: the area's label)
 *       "folder": "INBOX",                 the one folder (IMAP, Graph) or label (Gmail) ever read
 *       "fields": { "subject": "subject", "from": "sender", "date": "received_on", "body": "summary", "attachments": "files" },
 *       "set": { "channel": "email" },     constant values for every record
 *       "body_chars": 4000, "backfill_days": 7, "attachments": { "max_bytes": 10485760, "max_count": 20 }
 *     }
 *   }
 *
 * sender.allow: the workspace's admins may give the app their company's own sender (SMTP, Microsoft 365, Google
 * Workspace); the app's notifications to that workspace's people then go out through it. intake: the workspace's admins
 * may connect mailboxes (IMAP, Microsoft 365, Google Workspace) whose new messages become records of `area`, each
 * message once (by its Message-ID), its attachments kept sealed in the workspace's object store. Read only on the
 * mailbox: nothing is deleted, moved or marked.
 *
 * `fields` maps what a message has to the area's own fields (none required; the record's title is the subject):
 *   subject, from (the address), from_name, from_domain, to, cc (addresses, comma-separated), date (when it was sent),
 *   received_at (when the intake read it), body (the text, cut at body_chars), attachments (their names and sizes; a
 *   json field gets a list of {name, size, content_type, sha256}), attachment_count, mailbox (the connection's label),
 *   message_id
 */
import { z } from "zod";

export const INTAKE_SOURCES = ["subject", "from", "from_name", "from_domain", "to", "cc", "date", "received_at", "body", "attachments", "attachment_count", "mailbox", "message_id"] as const;
export type IntakeSource = (typeof INTAKE_SOURCES)[number];
/** The field types each message value may land in. */
export const SOURCE_TYPES: Record<IntakeSource, readonly string[]> = {
  subject: ["text"], from: ["text"], from_name: ["text"], from_domain: ["text"], to: ["text"], cc: ["text"], date: ["date", "text"],
  received_at: ["date", "text"], body: ["text"], attachments: ["text", "json"], attachment_count: ["number"], mailbox: ["text"], message_id: ["text"],
};
const fieldName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "a field of the area");
/** A folder or label name: printable ASCII, no quote or backslash (it goes into an IMAP command quoted). */
const folder = z.string().regex(/^[\x20-\x21\x23-\x5b\x5d-\x7e]{1,100}$/, "printable ASCII, no quote or backslash, up to 100 characters").refine((f) => f.trim() === f, "no leading or trailing space");

export const EmailIntakeSchema = z.object({
  $comment: z.string().max(2000).optional(),
  area: fieldName,
  label: z.string().trim().min(1).max(60).regex(/^[^{}<>]*$/, "plain text").optional(),
  folder: folder.default("INBOX"),
  fields: z.partialRecord(z.enum(INTAKE_SOURCES), fieldName).default({}),
  set: z.record(fieldName, z.union([z.string().max(200), z.number().finite(), z.boolean()])).refine((x) => Object.keys(x).length <= 20, "at most 20 fields").optional(),
  body_chars: z.number().int().min(0).max(20_000).default(4000),
  backfill_days: z.number().int().min(0).max(90).default(7),
  attachments: z.object({
    max_bytes: z.number().int().min(1024).max(25 * 1024 * 1024).default(10 * 1024 * 1024),
    max_count: z.number().int().min(0).max(50).default(20),
  }).strict().default({ max_bytes: 10 * 1024 * 1024, max_count: 20 }),
}).strict();
export const EmailPackSchema = z.object({
  $comment: z.string().max(2000).optional(),
  sender: z.object({ allow: z.boolean() }).strict().optional(),
  intake: EmailIntakeSchema.optional(),
}).strict().refine((e) => e.sender !== undefined || e.intake !== undefined, "email: a sender, an intake, or both");
export type EmailPack = z.output<typeof EmailPackSchema>;
export type EmailIntake = z.output<typeof EmailIntakeSchema>;

interface AreaLike { name: string; scope?: string; repository?: string; fields: readonly { name: string; type?: string }[] }
/** The problems of a pack's email block against its own record areas; [] when it is good. */
export function emailPackProblems(pack: string, raw: unknown, areas: readonly AreaLike[]): string[] {
  const r = EmailPackSchema.safeParse(raw);
  if (!r.success) return r.error.issues.map((i) => `pack ${pack}: email${i.path.length ? `.${i.path.join(".")}` : ""}: ${i.message}`);
  const it = r.data.intake;
  if (!it) return [];
  const out: string[] = [];
  const area = areas.find((a) => a.name === it.area);
  if (!area) return [`pack ${pack}: email.intake.area ${it.area} is not one of this pack's record areas`];
  if ((area.scope ?? "platform") !== "workspace") out.push(`pack ${pack}: email.intake.area ${it.area} is shared (platform): mail is each workspace's own, so a workspace area`);
  if (area.repository) out.push(`pack ${pack}: email.intake.area ${it.area} is fed by repository ${area.repository}: the intake needs an area of its own`);
  const typeOf = (f: string) => area.fields.find((x) => x.name === f)?.type ?? (area.fields.some((x) => x.name === f) ? "text" : null);
  const used = new Map<string, string>();
  for (const [src, f] of Object.entries(it.fields) as [IntakeSource, string][]) {
    const t = typeOf(f);
    if (t === null) { out.push(`pack ${pack}: email.intake.fields.${src}: area ${it.area} has no field ${f}`); continue; }
    if (!SOURCE_TYPES[src].includes(t)) out.push(`pack ${pack}: email.intake.fields.${src}: field ${f} is ${t}; ${src} goes into a ${SOURCE_TYPES[src].join(" or ")} field`);
    if (used.has(f)) out.push(`pack ${pack}: email.intake.fields: ${src} and ${used.get(f)} both write field ${f}`);
    used.set(f, src);
  }
  for (const f of Object.keys(it.set ?? {})) {
    if (typeOf(f) === null) out.push(`pack ${pack}: email.intake.set: area ${it.area} has no field ${f}`);
    if (used.has(f)) out.push(`pack ${pack}: email.intake.set: field ${f} is also written from the message (${used.get(f)})`);
  }
  return out;
}
