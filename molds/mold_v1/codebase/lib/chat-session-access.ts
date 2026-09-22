import "server-only";
import { and, eq, isNull, ne } from "drizzle-orm";
import { chatSessions, chatThreadMembers, chatThreads } from "@/agent/lib/db/schema";
import { getOpsDb, listWorkspaceIds, withOrgRls } from "./ops-db";
import { snapshotAccess } from "./chat-snapshot";
import { sessionGateDecision, type GateReason } from "./chat-gate";
import { tenancyEnabled } from "./org-context";

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
 * the conversation was ever shared) and the mirror rows for the session (if it
 * is an ordinary private chat). Waiting for the first to learn whether the
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
  const [threads, mirrors] = await Promise.all([
    withOrgRls(orgId, (tx) =>
      tx
        .select({ id: chatThreads.id, ownerEmail: chatThreads.ownerEmail })
        .from(chatThreads)
        /**
         * An UN-SHARED thread must stop deciding access.
         *
         * `DELETE /api/ops/threads/:id` un-shares by stamping `archived_at`;
         * nothing ever looked at it here. So a thread whose owner had taken it
         * back still matched, its members still matched it, and every one of
         * them kept reading the cached transcript and the replay — un-sharing
         * removed a row from a sidebar and nothing else.
         *
         * Filtering archived rows out is also what keeps the OWNER working:
         * with no thread row the decision falls through to their own mirror row
         * below, which is exactly the private chat it has gone back to being.
         */
        .where(and(eq(chatThreads.eveSessionId, sessionId), isNull(chatThreads.archivedAt)))
        .limit(1),
    ),
    withOrgRls(orgId, (tx) =>
      tx
        .select({ ownerEmail: chatSessions.ownerEmail })
        .from(chatSessions)
        /**
         * EVERY mirror row for the session, not just the caller's.
         *
         * This used to ask "is there a chat_sessions row for this session owned
         * by ME", and `POST /api/ops/chat-sessions` would write exactly such a
         * row for any `eveSessionId` a caller cared to name. Its only guard
         * refused a session that already had a `chat_threads` row owned by
         * someone else — which an unshared private chat, by definition, does
         * not have. So a colleague could mint a claim on somebody's private
         * session and then read, overwrite or delete their cached transcript
         * (the most complete copy of a conversation this system stores) through
         * /api/ops/chat-snapshots and /api/ops/chat-replay.
         *
         * The write path now refuses to create a second owner (see that route),
         * but rows minted before it did still exist, so the READ rule has to be
         * unambiguous on its own: the claim counts only when the caller is the
         * ONLY person claiming the session. Two claimants means the row proves
         * nothing about whose conversation it is, and a transcript is not
         * something to hand over on a maybe.
         */
        .where(eq(chatSessions.eveSessionId, sessionId)),
    ),
  ]);
  const thread = threads[0];
  const claimants = new Set(
    mirrors
      .map((row) => row.ownerEmail?.trim().toLowerCase())
      .filter((owner): owner is string => Boolean(owner)),
  );
  const ownsMirrorRow = claimants.size === 1 && claimants.has(me);
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
  return snapshotAccess({ callerEmail: me, thread, membership, ownsMirrorRow });
}

/**
 * The ownership gate in front of eve's OWN per-session routes.
 *
 * The rule is `sessionGateDecision` (lib/chat-gate.ts); this is the part that
 * has to read rows, and reading them wrong is the entire bug it replaces. Three
 * queries on the bare `getOpsDb()` handle returned 0 / 0 / 0 under the
 * production fail-closed policy, and the gate read that as "we have no record
 * of this session" and allowed every signed-in caller into every conversation.
 *
 * Nothing here swallows a database error. The caller decides what a failure
 * means — the gate route fails OPEN on one, loudly and deliberately, because
 * locking people out of their own conversations is the worse failure — and that
 * choice is only defensible while it stays the EXCEPTION. It stops being
 * defensible the moment the everyday path also produces "we could not see", so
 * the everyday path has to be a scoped read that actually works.
 *
 * tenancy-ok: every statement in this file runs inside `withOrgRls(…)`. The one
 * cross-workspace read is the workspace LIST, which belongs to lib/ops-db.ts
 * with the rest of the tenancy mechanism rather than to a handle held here.
 */
export async function gateForSession(
  orgId: string,
  email: string,
  sessionId: string,
): Promise<{ allow: boolean; reason: GateReason }> {
  const me = email.trim().toLowerCase();
  if (!me) return { allow: false, reason: "no-caller" };

  const [mirrors, threads] = await Promise.all([
    withOrgRls(orgId, (tx) =>
      tx
        .select({ ownerEmail: chatSessions.ownerEmail })
        .from(chatSessions)
        .where(eq(chatSessions.eveSessionId, sessionId)),
    ),
    withOrgRls(orgId, (tx) =>
      tx
        .select({ id: chatThreads.id, ownerEmail: chatThreads.ownerEmail })
        .from(chatThreads)
        .where(eq(chatThreads.eveSessionId, sessionId)),
    ),
  ]);

  /**
   * A REVOKED member is not a member.
   *
   * The gate's member lookup carried no status filter at all, while the two
   * neighbouring access helpers both use `ne(status, "revoked")`. So revoking
   * someone cut them out of the shared-thread proxy and the transcript cache
   * and left them full live read-and-send access to the session itself, for as
   * long as they kept the id — which is the one thing revocation is for.
   */
  let isMember = false;
  if (threads.length > 0) {
    const rows = await withOrgRls(orgId, (tx) =>
      tx
        .select({ threadId: chatThreadMembers.threadId })
        .from(chatThreadMembers)
        .where(and(eq(chatThreadMembers.email, me), ne(chatThreadMembers.status, "revoked"))),
    );
    const mine = new Set(rows.map((r) => r.threadId));
    isMember = threads.some((t) => mine.has(t.id));
  }

  // Only when this workspace has no record at all: is the session somebody
  // else's, somewhere else? See the "other-workspace" note in lib/chat-gate.ts.
  const knownElsewhere =
    mirrors.length === 0 && threads.length === 0
      ? await sessionExistsOutside(orgId, sessionId)
      : false;

  return sessionGateDecision({
    callerEmail: me,
    mirrorOwners: mirrors.map((m) => m.ownerEmail),
    threads,
    isMember,
    knownElsewhere,
  });
}

/**
 * Is this session recorded in some OTHER workspace?
 *
 * One lookup per workspace, each inside its own scope — the shape of
 * `acrossOrgsRls`, deliberately NOT that function: it logs a workspace that
 * fails and carries on, which would turn a database error into "not recorded
 * there", and "not recorded anywhere" is what this gate reads as permission.
 * Errors propagate here so the caller treats them as the failure they are.
 *
 * There are two workspaces, and this only runs while the caller's own has no
 * record of the session — which is the debounce window at the start of a brand
 * new chat, and never afterwards.
 */
async function sessionExistsOutside(orgId: string, sessionId: string): Promise<boolean> {
  const db = getOpsDb();
  if (!db) return false;
  // Pre-tenancy there is one implicit workspace, so there is no "outside".
  if (!(await tenancyEnabled(db))) return false;
  for (const workspace of await listWorkspaceIds()) {
    if (workspace === orgId) continue; // already read, above
    const [thread] = await withOrgRls(workspace, (tx) =>
      tx
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(eq(chatThreads.eveSessionId, sessionId))
        .limit(1),
    );
    if (thread) return true;
    const [mirror] = await withOrgRls(workspace, (tx) =>
      tx
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .where(eq(chatSessions.eveSessionId, sessionId))
        .limit(1),
    );
    if (mirror) return true;
  }
  return false;
}
