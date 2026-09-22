import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { chatSessions, chatThreadMembers, chatThreads } from "@/agent/lib/db/schema";
import { withOrgRls } from "./ops-db";
import { snapshotAccess } from "./chat-snapshot";

/**
 * May this caller read (or replace) the transcript of an eve SESSION?
 *
 * lib/chat-threads.ts answers the same question for a THREAD ID, which is what
 * the multiplayer routes are given. The two fast-open routes are given a session
 * id instead — a transcript is keyed by session, because one conversation has
 * one transcript whether or not it was ever shared — so this resolves the rows
 * that decide it and hands them to `snapshotAccess`, which holds the rule
 * itself and is unit-tested without a database.
 *
 * Both reads are workspace-scoped and issued CONCURRENTLY: the thread row (if
 * the conversation was ever shared) and the caller's own mirror row (if it is an
 * ordinary private chat of theirs). Waiting for the first to learn whether the
 * second is needed costs a serial round trip on the path that exists to be fast.
 *
 * tenancy-ok: every statement runs inside `withOrgRls(orgId, …)`, so a row in
 * another workspace is invisible to the query rather than merely filtered out.
 */
export async function accessForSession(
  orgId: string,
  email: string,
  sessionId: string,
): Promise<{ read: boolean; write: boolean }> {
  const me = email.toLowerCase();
  const [threads, mine] = await Promise.all([
    withOrgRls(orgId, (tx) =>
      tx
        .select({ id: chatThreads.id, ownerEmail: chatThreads.ownerEmail })
        .from(chatThreads)
        .where(eq(chatThreads.eveSessionId, sessionId))
        .limit(1),
    ),
    withOrgRls(orgId, (tx) =>
      tx
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .where(and(eq(chatSessions.eveSessionId, sessionId), eq(chatSessions.ownerEmail, me)))
        .limit(1),
    ),
  ]);
  const thread = threads[0];
  // Only asked for when a thread row exists AND the caller is not its owner: an
  // owner's access never depends on a membership row, and an unshared chat has
  // no members to ask about.
  const membership =
    thread && thread.ownerEmail.toLowerCase() !== me
      ? (
          await withOrgRls(orgId, (tx) =>
            tx
              .select({ role: chatThreadMembers.role, status: chatThreadMembers.status })
              .from(chatThreadMembers)
              .where(
                and(
                  eq(chatThreadMembers.threadId, thread.id),
                  eq(chatThreadMembers.email, me),
                  ne(chatThreadMembers.status, "revoked"),
                ),
              )
              .limit(1),
          )
        )[0]
      : undefined;
  return snapshotAccess({ callerEmail: me, thread, membership, ownsMirrorRow: mine.length > 0 });
}
