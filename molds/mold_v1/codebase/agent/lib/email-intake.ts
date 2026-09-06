/**
 * Deterministic email-intake pipeline. This does in code what the intake cron's
 * prompt asked the model to do step by step — read unread inbox mail, match each
 * sender to a customer, and stage a "Needs Triage" DRAFT ticket for every matched
 * customer email — because a multi-step tool chain was unreliable to drive from a
 * prompt. The cron now just calls run_email_intake and summarises the result.
 *
 * Self-contained IMAP read (mirrors agent/lib/email.ts config) so it needs no
 * change to the draft-only email module. Degrades to a no-op when IMAP is unset.
 */
import { ImapFlow, type SearchObject } from "imapflow";
import { nanoid } from "nanoid";
import { createTicket, matchCustomerByEmail } from "./system-of-record.ts";
import type { Ticket } from "./customer-schema.ts";
import { UNASSIGNED_OWNER_EMAIL } from "./unassigned.ts";

function imapConfig(): { host: string; user: string; pass: string; port: number; secure: boolean } | null {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASSWORD;
  if (!host || !user || !pass) return null;
  return {
    host,
    user,
    pass,
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: (process.env.IMAP_SECURE ?? "true") !== "false",
  };
}

/** Best-effort plain-text body from a raw RFC822 source. Never throws. */
function extractPlainText(source?: Buffer): string | undefined {
  if (!source) return undefined;
  const raw = source.toString("utf8");
  const sep = raw.indexOf("\r\n\r\n");
  let body = sep >= 0 ? raw.slice(sep + 4) : raw;
  const boundary = raw.match(/boundary="?([^"\r\n;]+)"?/i)?.[1];
  if (boundary) {
    const part = body.split("--" + boundary).find((p) => /content-type:\s*text\/plain/i.test(p));
    if (part) {
      const s = part.indexOf("\r\n\r\n");
      body = s >= 0 ? part.slice(s + 4) : part;
    }
  }
  body = body
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return body.trim().slice(0, 4000) || undefined;
}

interface RawEmail {
  from?: string;
  subject?: string;
  messageId?: string;
  text?: string;
}

/** Automated/no-reply senders never become tickets. */
const AUTOMATED_RE =
  /(no-?reply|do-?not-?reply|mailer-daemon|postmaster|newsletter|notifications?@|automated|@accounts\.google\.com)/i;
const bareAddr = (s?: string): string =>
  (s ?? "").split(",")[0].trim().replace(/^.*<([^>]+)>.*$/, "$1").trim().toLowerCase();
const isEmail = (s?: string): s is string => !!s && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

/** Provisional classification for a draft (a human refines it on approval). */
function classify(subject: string, text: string): {
  ticketType: Ticket["ticketType"];
  ticketCategory: Ticket["ticketCategory"];
  ticketPriority: Ticket["ticketPriority"];
} {
  const hay = `${subject} ${text}`.toLowerCase();
  const isError = /(error|fail|failing|failed|500|502|503|outage|down|broken|crash|timeout|timing out|not working|unable|cannot|can't|blocked)/.test(hay);
  const isUrgent = /(urgent|critical|asap|production|prod|live|disburse|payout|settlement|breach)/.test(hay);
  return {
    ticketType: isError ? "Bug" : "Question",
    ticketCategory: isError ? "Bug Report" : "Configuration Change Request",
    ticketPriority: isError && isUrgent ? "P1-High" : isError || isUrgent ? "P2-Medium" : "P3-Low",
  };
}

export interface EmailIntakeResult {
  read: number;
  skipped: number;
  staged: Array<{ ticketId: string; customerId: string; customerName: string; subject?: string; created: boolean; matchedOn: string }>;
  unmatched: Array<{ sender: string; subject?: string }>;
  note?: string;
}

/**
 * Read unread inbox mail, match senders to customers, and stage a Needs-Triage
 * draft for each matched customer email. Idempotent (createTicket dedups on the
 * email Message-ID). Fully deterministic — no model in the loop.
 */
export async function runEmailIntake(
  opts: { sinceDays?: number; max?: number } = {},
): Promise<EmailIntakeResult> {
  const cfg = imapConfig();
  if (!cfg) return { read: 0, skipped: 0, staged: [], unmatched: [], note: "IMAP is not configured." };

  const emails: RawEmail[] = [];
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const criteria: SearchObject = { seen: false };
    criteria.since = new Date(Date.now() - (opts.sinceDays ?? 2) * 86_400_000);
    const uids = (await client.search(criteria, { uid: true })) || [];
    const picked = uids.sort((a, b) => b - a).slice(0, opts.max ?? 20);
    if (picked.length > 0) {
      for await (const msg of client.fetch(
        picked.join(","),
        { uid: true, envelope: true, source: true },
        { uid: true },
      )) {
        emails.push({
          from: msg.envelope?.from?.map((a) => a.address).filter(Boolean).join(", ") || undefined,
          subject: msg.envelope?.subject,
          messageId: msg.envelope?.messageId,
          text: extractPlainText(msg.source),
        });
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  const staged: EmailIntakeResult["staged"] = [];
  const unmatched: EmailIntakeResult["unmatched"] = [];
  let skipped = 0;
  for (const e of emails) {
    const sender = bareAddr(e.from);
    if (!sender || AUTOMATED_RE.test(e.from ?? "")) {
      skipped++;
      continue;
    }
    const m = await matchCustomerByEmail(sender);
    if (!m.matched) {
      unmatched.push({ sender, subject: e.subject });
      continue;
    }
    const cls = classify(e.subject ?? "", e.text ?? "");
    const r = await createTicket({
      ticketId: `TCK-${nanoid(8)}`,
      customerId: m.customerId,
      summary: e.subject || "(no subject)",
      description: e.text,
      ticketType: cls.ticketType,
      ticketCategory: cls.ticketCategory,
      ticketPriority: cls.ticketPriority,
      ticketStatus: "Needs Triage",
      ticketOwnerEmail: isEmail(m.fdeOwner) ? m.fdeOwner : UNASSIGNED_OWNER_EMAIL,
      ticketNextStep: "Review inbound email and triage.",
      sourceChannel: "Email",
      externalId: e.messageId,
      reportedByEmail: isEmail(sender) ? sender : undefined,
      customerContactEmail: isEmail(sender) ? sender : undefined,
    });
    staged.push({
      ticketId: r.ticketId,
      customerId: m.customerId,
      customerName: m.customerName,
      subject: e.subject,
      created: r.created,
      matchedOn: m.matchedOn,
    });
  }
  return { read: emails.length, skipped, staged, unmatched };
}
