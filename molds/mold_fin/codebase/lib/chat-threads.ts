import "server-only";
import { and, eq } from "drizzle-orm";
import { chatThreadMembers, chatThreads } from "@/agent/lib/db/schema";
import { getOpsDb } from "./ops-db";
import { verifyOpsAuth } from "./ops-auth";
import { DEFAULT_ORG, resolveOrgForIdentity } from "./org-context";

/**
 * Shared authorization helpers for the multiplayer chat routes. proxy.ts proves
 * IDENTITY (a verified @onfinance.in Google token); these prove AUTHORIZATION
 * (ownership / membership of a specific thread). The caller email is always the
 * verified token subject — NEVER a client-supplied field.
 */
export type OpsDb = NonNullable<ReturnType<typeof getOpsDb>>;
export type ThreadRow = typeof chatThreads.$inferSelect;
export type MemberRow = typeof chatThreadMembers.$inferSelect;

/** The verified caller email from the Authorization header, or null. */
export async function callerEmail(request: Request): Promise<string | null> {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  return identity?.email ?? null;
}

export type Access = {
  thread: ThreadRow;
  /** 'owner' | 'participant' | 'viewer' — the caller's effective role. */
  role: string;
  member: MemberRow | null;
};

/** Load a thread row by id. Exposed so a caller that has other work to overlap
 *  (verifying the bearer token, say) can start this read first. */
export async function loadThread(db: OpsDb, threadId: string): Promise<ThreadRow | undefined> {
  const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.id, threadId)).limit(1);
  return thread;
}

function loadMember(db: OpsDb, threadId: string, email: string): Promise<MemberRow | undefined> {
  return db
    .select()
    .from(chatThreadMembers)
    .where(and(eq(chatThreadMembers.threadId, threadId), eq(chatThreadMembers.email, email)))
    .limit(1)
    .then((rows) => rows[0]);
}

/**
 * Resolve the caller's access to a thread. The owner always has full access;
 * everyone else must have a non-revoked member row. Returns null when the
 * thread is missing or the caller has no access.
 *
 * The two reads are issued CONCURRENTLY. Waiting for the thread row before
 * asking for the member row costs a second serial database round trip on
 * exactly the callers that are already slowest — shared threads, which by
 * definition are never opened by their owner. One speculative query that an
 * owner throws away is cheaper than an extra round trip for everyone else.
 */
export async function accessFor(
  db: OpsDb,
  threadId: string,
  email: string,
): Promise<Access | null> {
  const [thread, member, org] = await Promise.all([
    loadThread(db, threadId),
    loadMember(db, threadId, email),
    resolveOrgForIdentity(email),
  ]);
  if (thread && (thread.orgId ?? DEFAULT_ORG) !== org.orgId) return null;
  return resolveAccess(db, thread, member, threadId, email);
}

/**
 * The same decision as {@link accessFor} for a caller that has already loaded
 * the thread row. Only reaches the database when the caller is not the owner.
 */
export async function accessForThread(
  db: OpsDb,
  thread: ThreadRow | undefined,
  email: string,
): Promise<Access | null> {
  if (!thread) return null;
  const org = await resolveOrgForIdentity(email);
  if ((thread.orgId ?? DEFAULT_ORG) !== org.orgId) return null;
  if (thread.ownerEmail === email) return { thread, role: "owner", member: null };
  const member = await loadMember(db, thread.id, email);
  return resolveAccess(db, thread, member, thread.id, email);
}

function resolveAccess(
  db: OpsDb,
  thread: ThreadRow | undefined,
  member: MemberRow | undefined,
  threadId: string,
  email: string,
): Access | null {
  if (!thread) return null;
  if (thread.ownerEmail === email) return { thread, role: "owner", member: null };
  if (!member || member.status === "revoked") return null;

  /**
   * Opening the thread IS accepting the invitation.
   *
   * Nothing anywhere ever moved a member off "invited", so the share dialog
   * showed "Can participate · invited" for people who had already read and
   * replied — the owner had no way to tell who had actually turned up. There is
   * no separate accept step to hook, and inventing one would ask a person to
   * confirm something they have just demonstrably done.
   *
   * Best-effort: a failed bookkeeping write must never cost someone access to a
   * thread they are entitled to read.
   */
  if (member.status === "invited") {
    void db
      .update(chatThreadMembers)
      // "accepted" — NOT a new word. The list query filters on
      // ["invited", "accepted"], so inventing "active" here silently removed
      // the thread from "Shared with you" the instant someone opened it.
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(and(eq(chatThreadMembers.threadId, threadId), eq(chatThreadMembers.email, email)))
      .catch(() => undefined);
    return { thread, role: member.role, member: { ...member, status: "accepted" } };
  }
  return { thread, role: member.role, member };
}

/** Public projection of a thread — never leaks the continuation token. */
export function publicThread(
  thread: ThreadRow,
  role: string,
  members?: MemberRow[],
  /**
   * Include the stored transcript.
   *
   * OFF for list responses. The list is polled every 20 seconds and returns
   * every owned and shared thread, so shipping each one's full `clientEvents`
   * meant re-sending the entire history of every conversation, four times a
   * minute, to render a sidebar that shows a title and a timestamp — competing
   * for bandwidth with the very thread the user is waiting to open.
   */
  withEvents = true,
) {
  return {
    id: thread.id,
    clientKey: thread.clientKey,
    eveSessionId: thread.eveSessionId,
    title: thread.title,
    preview: thread.preview,
    customers: thread.customers ?? [],
    forkedFrom: thread.forkedFrom ?? undefined,
    ownerEmail: thread.ownerEmail,
    role,
    turnHolder: thread.turnHolder,
    ...(withEvents ? { clientEvents: thread.clientEvents ?? [] } : {}),
    archived: Boolean(thread.archivedAt),
    updatedAt: thread.updatedAt.toISOString(),
    members: members?.map((m) => ({
      email: m.email,
      role: m.role,
      status: m.status,
    })),
  };
}
