import "server-only";
import { and, eq, isNull, ne } from "drizzle-orm";
import { chatSessions, chatThreadMembers, chatThreads } from "@/agent/lib/db/schema";
import { getOpsDb, listWorkspaceIds, withOrgRls } from "./ops-db";
import { snapshotAccess } from "./chat-snapshot";
import type { GateDecision, SessionOwnership, SessionRight } from "./chat-gate";
import { gateSessionRequest, type GateDb } from "./session-gate";
import { DEFAULT_ORG, workspacesOf } from "./org-context";

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
 * The ownership gate in front of eve's OWN per-session routes, as the web proxy asks it.
 *
 * One implementation with the agent: the reads are lib/session-gate.ts and the rule is `sessionGateDecision`
 * (lib/chat-gate.ts), and the agent (agent/lib/session-guard.ts) runs the same two in front of the same routes. This
 * function only says how the WEB reaches the database — `withOrgRls` per workspace, and the control-plane lists.
 *
 * Nothing here swallows a database error: the proxy answers 503 on one. It used to fail OPEN, and it used to allow a
 * session nobody had a record of; neither is true any more, because the agent now records every session's owner
 * before it hands the id to anyone.
 *
 * tenancy-ok: every tenant-table statement runs inside `withOrgRls(…)`; memberships come from lib/org-context.ts.
 */
export async function gateForSession(
  email: string,
  sessionId: string,
  right: SessionRight,
): Promise<GateDecision & { ownership: SessionOwnership | null }> {
  const me = email.trim().toLowerCase();
  if (!me) return { allow: false, reason: "no-caller", ownership: null };
  if (!getOpsDb()) throw new Error("Database not configured");
  const deps: GateDb = {
    inOrg: (orgId, fn) => withOrgRls(orgId, fn),
    async listOrgs() {
      const ids = await listWorkspaceIds();
      return ids.length ? ids : [DEFAULT_ORG];
    },
    orgsOf: (address) => workspacesOf(address),
  };
  return gateSessionRequest(deps, { kind: "person", email: me }, sessionId, right);
}
