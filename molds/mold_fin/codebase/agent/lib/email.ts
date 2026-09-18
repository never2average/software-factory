/**
 * ============================================================================
 *  DRAFT-ONLY EMAIL — INTENTIONALLY HAS NO SEND CAPABILITY. DO NOT ADD ONE.
 * ============================================================================
 *
 * This module talks to email over IMAP only:
 *   - listInbox(): IMAP SEARCH + FETCH to read the inbox.
 *   - createDraft(): IMAP APPEND to the Drafts mailbox with the \Draft flag.
 *
 * There is deliberately NO SMTP transport here. SMTP is the send protocol;
 * omitting it entirely means "never send" is a structural guarantee, not a
 * policy toggle. Creating a draft is an IMAP APPEND, which never transmits mail.
 *
 * If you are tempted to add nodemailer / an SMTP client / a `send()` function to
 * this file: don't. Sending must be a human action in their mail client. Any
 * change here should go through review (see CODEOWNERS).
 *
 * Configuration (env, e.g. a shared FDE ops mailbox or an app-password inbox):
 *   IMAP_HOST, IMAP_PORT (default 993), IMAP_SECURE (default true),
 *   IMAP_USER, IMAP_PASSWORD, IMAP_DRAFTS_MAILBOX (default "Drafts").
 */
import { ImapFlow, type SearchObject } from "imapflow";

export class EmailNotConfiguredError extends Error {
  constructor() {
    super(
      "IMAP is not configured. Set IMAP_HOST, IMAP_USER, and IMAP_PASSWORD (and optionally IMAP_PORT/IMAP_SECURE/IMAP_DRAFTS_MAILBOX) in .env.local.",
    );
    this.name = "EmailNotConfiguredError";
  }
}

interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  draftsMailbox: string;
}

function readConfig(): ImapConfig | null {
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
    draftsMailbox: process.env.IMAP_DRAFTS_MAILBOX ?? "Drafts",
  };
}

async function withClient<T>(
  fn: (client: ImapFlow, cfg: ImapConfig) => Promise<T>,
): Promise<T> {
  const cfg = readConfig();
  if (!cfg) throw new EmailNotConfiguredError();
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client, cfg);
  } finally {
    await client.logout().catch(() => {});
  }
}

export interface EmailSummary {
  uid: number;
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  messageId?: string;
}

export interface ListInboxInput {
  from?: string;
  subject?: string;
  unseenOnly?: boolean;
  sinceDays?: number;
  max: number;
}

/** Read the inbox over IMAP. Returns the newest matching messages first. */
export async function listInbox(input: ListInboxInput): Promise<EmailSummary[]> {
  return withClient(async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const criteria: SearchObject = {};
      if (input.unseenOnly) criteria.seen = false;
      if (input.from) criteria.from = input.from;
      if (input.subject) criteria.subject = input.subject;
      if (input.sinceDays) {
        criteria.since = new Date(Date.now() - input.sinceDays * 86_400_000);
      }

      const uids = (await client.search(criteria, { uid: true })) || [];
      if (uids.length === 0) return [];
      // Newest first, capped.
      const picked = uids.sort((a, b) => b - a).slice(0, input.max);

      const out: EmailSummary[] = [];
      for await (const msg of client.fetch(
        picked.join(","),
        { uid: true, envelope: true },
        { uid: true },
      )) {
        const env = msg.envelope;
        const addr = (a?: { name?: string; address?: string }[]) =>
          a?.map((x) => x.address).filter(Boolean).join(", ") || undefined;
        out.push({
          uid: msg.uid,
          from: addr(env?.from),
          to: addr(env?.to),
          subject: env?.subject,
          date: env?.date ? new Date(env.date).toISOString() : undefined,
          messageId: env?.messageId,
        });
      }
      return out.sort((a, b) => b.uid - a.uid);
    } finally {
      lock.release();
    }
  });
}

export interface DraftInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  /** RFC822 Message-ID of the message being replied to, for proper threading. */
  inReplyTo?: string;
}

function buildMime(input: DraftInput): string {
  const lines = [
    `Date: ${new Date().toUTCString()}`,
    `To: ${input.to}`,
    input.cc ? `Cc: ${input.cc}` : null,
    input.bcc ? `Bcc: ${input.bcc}` : null,
    `Subject: ${input.subject}`,
    input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : null,
    input.inReplyTo ? `References: ${input.inReplyTo}` : null,
    'Content-Type: text/plain; charset="UTF-8"',
    "MIME-Version: 1.0",
    "",
    input.body,
  ].filter((l): l is string => l !== null);
  return lines.join("\r\n");
}

/**
 * Create a draft via IMAP APPEND to the Drafts mailbox. This does NOT send —
 * the message lands in Drafts for a human to review and send from their client.
 */
export async function createDraft(
  input: DraftInput,
): Promise<{ mailbox: string; uid?: number }> {
  return withClient(async (client, cfg) => {
    const mime = buildMime(input);
    const res = await client.append(cfg.draftsMailbox, mime, ["\\Draft"]);
    return { mailbox: cfg.draftsMailbox, uid: res ? res.uid : undefined };
  });
}
