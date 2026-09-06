import "server-only";

import { ImapFlow } from "imapflow";
import { and, eq, sql } from "drizzle-orm";
import { connectorSecrets, connectors, customers, inboxItems } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { decryptSecret } from "@/lib/secret-crypto";

/**
 * Pull recent mail into the Inbox staging table.
 *
 * Lives in lib/ and talks to Drizzle directly rather than reusing the agent's
 * email-intake: importing agent runtime code into a Next route is what took
 * /api/ops/health and /api/dataroom down with ERR_REQUIRE_ESM. `imapflow` is a
 * plain dependency, so the IMAP part is safe to use here; the database part is
 * ours.
 *
 * Credentials come from the WORKSPACE'S OWN `gmail` connector, decrypted with
 * that workspace's key — not from platform env vars. Env would have meant every
 * workspace ingesting the same mailbox, which is wrong the moment there are
 * two, and it ignores the per-org secret vault this platform already has. The
 * manifest already declares exactly these names (IMAP_HOST / IMAP_USER /
 * IMAP_PASSWORD / IMAP_PORT / IMAP_SECURE) for kind "gmail".
 *
 * Idempotent by (org_id, source, external_id) — the Message-ID. Re-running
 * updates in place, so a cron every ten minutes cannot duplicate a thread, and
 * a message that was already promoted or archived keeps that status because
 * the upsert deliberately does not touch `status`.
 *
 * KNOWN LIMITS, stated rather than discovered later:
 *   * text/plain is preferred; text/html is tag-stripped, not converted. A
 *     newsletter will look rough. Real correspondence is fine.
 *   * Quoted replies are NOT trimmed, so a long chain repeats itself in every
 *     message. Trimming heuristically risks cutting real content, so the
 *     conservative choice is to keep it and let the reader collapse it.
 *   * Attachments are ignored entirely.
 */

export interface IngestResult {
  scanned: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: string[];
}

/** Everything the staging row needs from one message. */
interface ParsedMessage {
  messageId: string;
  threadKey: string;
  subject: string | null;
  body: string;
  participants: string[];
  occurredAt: Date;
}

const addr = (a?: { address?: string | null }[] | null): string[] =>
  (a ?? []).map((x) => x.address?.toLowerCase()).filter((x): x is string => Boolean(x));

/**
 * Which conversation a message belongs to.
 *
 * The FIRST id in References is the thread root, which is what makes a nine
 * message chain one row instead of nine. In-Reply-To is the fallback for
 * clients that omit References; a message with neither starts its own thread.
 */
function threadKeyFor(messageId: string, references?: string, inReplyTo?: string): string {
  const refs = (references ?? "").match(/<[^>]+>/g);
  if (refs?.length) return refs[0];
  const parent = (inReplyTo ?? "").match(/<[^>]+>/)?.[0];
  return parent ?? messageId;
}

/** Minimal quoted-printable: enough for real mail, no dependency. */
function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Walk the MIME tree for the best readable part. */
function findPart(
  node: unknown,
  want: string,
): { part: string; encoding?: string } | null {
  const n = node as { type?: string; part?: string; encoding?: string; childNodes?: unknown[] };
  if (!n) return null;
  if (n.type === want && n.part) return { part: n.part, encoding: n.encoding };
  for (const child of n.childNodes ?? []) {
    const found = findPart(child, want);
    if (found) return found;
  }
  return null;
}

export async function ingestEmail(orgId: string, sinceDays = 7, max = 100): Promise<IngestResult> {
  const result: IngestResult = { scanned: 0, inserted: 0, updated: 0, skipped: 0, errors: [] };
  const db = getOpsDb();
  if (!db) {
    result.errors.push("Database not configured.");
    return result;
  }
  /**
   * The workspace's own mail credentials, from its gmail connector.
   *
   * connector_secrets is RLS-STRICT — it denies when the org GUC is unset — so
   * this read must happen inside withOrgRls. That is deliberate: credentials
   * are the one table where permissive-by-default would be wrong.
   */
  const secrets = await withOrgRls(orgId, async (tx) => {
    const [conn] = await tx
      .select({ id: connectors.id, ownerEmail: connectors.ownerEmail })
      .from(connectors)
      .where(and(eq(connectors.orgId, orgId), eq(connectors.kind, "gmail"), eq(connectors.enabled, true)))
      .limit(1);
    if (!conn) return null;
    const rows = await tx
      .select()
      .from(connectorSecrets)
      .where(and(eq(connectorSecrets.orgId, orgId), eq(connectorSecrets.connectorId, conn.id)));
    const out: Record<string, string> = {};
    for (const r of rows) {
      try {
        out[r.name] = decryptSecret(
          { ciphertext: r.ciphertext, iv: r.iv, tag: r.tag, keyVersion: r.keyVersion },
          orgId,
          conn.ownerEmail,
        );
      } catch {
        // A secret we cannot decrypt is reported by name, never by value.
        result.errors.push(`Could not decrypt ${r.name} — was OPS_SECRETS_KEY rotated without re-encrypting?`);
      }
    }
    return out;
  });

  if (!secrets) {
    // Not an error: a workspace with no mail connector simply has no email to
    // ingest, and this reads better in a cron log than a stack trace.
    result.errors.push("No enabled 'gmail' connector in this workspace — add one and store its secrets.");
    return result;
  }
  const host = secrets.IMAP_HOST;
  const user = secrets.IMAP_USER;
  const pass = secrets.IMAP_PASSWORD;
  if (!host || !user || !pass) {
    const missing = ["IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD"].filter((n) => !secrets[n]);
    result.errors.push(`The gmail connector is missing: ${missing.join(", ")}.`);
    return result;
  }

  // Customer matching is by sender domain. Loaded once — the alternative is a
  // query per message, and an inbox sync is the wrong place to make N of them.
  const accounts = await withOrgRls(orgId, (tx) =>
    tx
      .select({ id: customers.customerId, domain: customers.companyDomain })
      .from(customers)
      .where(eq(customers.orgId, orgId)),
  );
  const byDomain = new Map(
    accounts.filter((a) => a.domain).map((a) => [a.domain!.toLowerCase().replace(/^@/, ""), a.id]),
  );

  const client = new ImapFlow({
    host,
    port: Number(secrets.IMAP_PORT ?? 993),
    secure: secrets.IMAP_SECURE !== "false",
    auth: { user, pass },
    logger: false,
  });

  const parsed: ParsedMessage[] = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - sinceDays * 86_400_000);
      for await (const msg of client.fetch(
        { since },
        { uid: true, envelope: true, bodyStructure: true, headers: ["references", "in-reply-to"] },
      )) {
        if (parsed.length >= max) break;
        result.scanned++;
        const env = msg.envelope;
        const messageId = env?.messageId;
        if (!messageId) {
          // Without a Message-ID there is no stable dedupe key, and ingesting
          // it would create a duplicate on every sync.
          result.skipped++;
          continue;
        }

        const headerText = msg.headers?.toString() ?? "";
        const references = /^references:\s*(.+)$/im.exec(headerText)?.[1];
        const inReplyTo = /^in-reply-to:\s*(.+)$/im.exec(headerText)?.[1];

        let body = "";
        try {
          const plain = findPart(msg.bodyStructure, "text/plain");
          const html = plain ? null : findPart(msg.bodyStructure, "text/html");
          const target = plain ?? html;
          if (target) {
            const dl = await client.download(String(msg.uid), target.part, { uid: true });
            const chunks: Buffer[] = [];
            for await (const chunk of dl.content) chunks.push(chunk as Buffer);
            const raw = Buffer.concat(chunks);
            const enc = (target.encoding ?? "").toLowerCase();
            const text =
              enc === "base64"
                ? Buffer.from(raw.toString("utf8"), "base64").toString("utf8")
                : enc === "quoted-printable"
                  ? decodeQuotedPrintable(raw.toString("utf8"))
                  : raw.toString("utf8");
            body = plain ? text : stripHtml(text);
          }
        } catch (e) {
          // A body we cannot read is not a reason to lose the message — the
          // envelope alone still tells the operator it happened.
          result.errors.push(`body unreadable for ${messageId}: ${e instanceof Error ? e.message : e}`);
        }

        parsed.push({
          messageId,
          threadKey: threadKeyFor(messageId, references, inReplyTo),
          subject: env?.subject ?? null,
          body: body.trim(),
          participants: [...new Set([...addr(env?.from), ...addr(env?.to), ...addr(env?.cc)])],
          occurredAt: env?.date ? new Date(env.date) : new Date(),
        });
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    result.errors.push(`IMAP: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  } finally {
    await client.logout().catch(() => {});
  }

  for (const m of parsed) {
    const sender = m.participants[0] ?? "";
    const domain = sender.split("@")[1]?.toLowerCase();
    const customerId = domain ? byDomain.get(domain) ?? null : null;
    try {
      const [row] = await withOrgRls(orgId, (tx) =>
        tx
          .insert(inboxItems)
          .values({
            orgId,
            source: "email",
            externalId: m.messageId,
            threadKey: m.threadKey,
            subject: m.subject,
            preview: (m.body.split("\n").find((l) => l.trim()) ?? "").slice(0, 140),
            body: m.body,
            participants: m.participants,
            occurredAt: m.occurredAt,
            customerId,
          })
          .onConflictDoUpdate({
            target: [inboxItems.orgId, inboxItems.source, inboxItems.externalId],
            // `status` and `readAt` are deliberately absent: a re-sync must not
            // un-archive something already dealt with, or mark a read thread
            // unread again.
            set: {
              threadKey: m.threadKey,
              subject: m.subject,
              body: m.body,
              participants: m.participants,
              occurredAt: m.occurredAt,
              customerId,
            },
          })
          .returning({ id: inboxItems.id, createdAt: inboxItems.createdAt }),
      );
      // A row whose createdAt is this run is new; anything older was updated.
      if (row && Date.now() - row.createdAt.getTime() < 5_000) result.inserted++;
      else result.updated++;
    } catch (e) {
      result.errors.push(`${m.messageId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
