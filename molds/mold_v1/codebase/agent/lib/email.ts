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
 * Configuration: the CALLING WORKSPACE'S OWN mailbox (agent/lib/workspace-mailbox.ts) — its `gmail` connector's
 * IMAP_* secrets, or the deployment's IMAP_* env mailbox only for the workspace IMAP_WORKSPACE binds it to. A
 * workspace never reads, lists or drafts into another workspace's mailbox.
 */
import { ImapFlow, type SearchObject } from "imapflow";
import { mailboxFor } from "./workspace-mailbox.ts";

export class EmailNotConfiguredError extends Error {
  constructor(reason?: string) {
    super(
      reason ??
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

async function withClient<T>(
  orgId: string | null | undefined,
  fn: (client: ImapFlow, cfg: ImapConfig) => Promise<T>,
): Promise<T> {
  const lookup = await mailboxFor(orgId);
  if (!lookup.mailbox) throw new EmailNotConfiguredError(lookup.reason);
  const cfg: ImapConfig = lookup.mailbox;
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
export async function listInbox(
  input: ListInboxInput,
  /** The caller's workspace: its own mailbox is read, and no other. */
  orgId: string | null,
): Promise<EmailSummary[]> {
  return withClient(orgId, async (client) => {
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
  /** The caller's workspace: the draft goes into its own mailbox, and no other. */
  orgId: string | null,
): Promise<{ mailbox: string; uid?: number }> {
  return withClient(orgId, async (client, cfg) => {
    const mime = buildMime(input);
    const res = await client.append(cfg.draftsMailbox, mime, ["\\Draft"]);
    return { mailbox: cfg.draftsMailbox, uid: res ? res.uid : undefined };
  });
}
