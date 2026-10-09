import "server-only";
import { getOpsDb, withOrgRls } from "./ops-db";
import type { GateDecision, SessionOwnership, SessionRight } from "./chat-gate";
import { gateSessionRequest, readTranscriptAccess, type GateDb } from "./session-gate";
import { workspacesOf } from "./org-context";

/**
 * How the WEB reaches the database for the shared gate reads: `withOrgRls` in the request's workspace, and the
 * caller's own memberships. There is no workspace list here — a request reads the one workspace it is in.
 */
function webGateDb(): GateDb {
  return {
    inOrg: (orgId, fn) => withOrgRls(orgId, fn),
    orgsOf: (address) => workspacesOf(address),
  };
}

/**
 * May this caller read (or replace) the transcript of an eve SESSION?
 *
 * lib/chat-threads.ts answers the same question for a THREAD ID, which is what the multiplayer routes are given. The
 * two fast-open routes (/api/ops/chat-snapshots, /api/ops/chat-replay) are given a session id instead — a transcript
 * is keyed by session, because one conversation has one transcript whether or not it was ever shared.
 *
 * The rule is lib/session-gate.ts `readTranscriptAccess`: the session gate's own decision on the agent's record of who
 * owns the session (agent_session_owners), in THIS workspace. It used to be decided from the chat list — the caller
 * owned an unshared session when they were its ONLY in-workspace `chat_sessions` claimant — and those rows are
 * written by the browser, so a colleague could be the sole claimant of a session its owner had not mirrored and read
 * or overwrite its cached transcript (mold_v1-129).
 *
 * tenancy-ok: every tenant statement runs inside `withOrgRls(orgId, …)` (via the GateDb above); memberships come from
 * lib/org-context.ts.
 */
export async function accessForSession(
  orgId: string,
  email: string,
  sessionId: string,
): Promise<{ read: boolean; write: boolean }> {
  if (!getOpsDb()) return { read: false, write: false };
  return readTranscriptAccess(webGateDb(), orgId, email, sessionId);
}

/**
 * The ownership gate in front of eve's OWN per-session routes, as the web proxy asks it.
 *
 * One implementation with the agent: the reads are lib/session-gate.ts and the rule is `sessionGateDecision`
 * (lib/chat-gate.ts), and the agent (agent/lib/session-guard.ts) runs the same two in front of the same routes. This
 * function only says how the WEB reaches the database — `withOrgRls` in the request's workspace (`workspace`, the
 * caller's resolved workspace: orgContextForRequest), and the caller's own memberships. A session recorded in any
 * other workspace is not found, and refused like one nobody recorded.
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
  /** The request's workspace, or null when it names one the caller is not in (then only `named` is read). */
  workspace: string | null,
  /** The workspace the request names when it is not `workspace` (a guest's link): read for a guest only. */
  named: string | null = null,
): Promise<GateDecision & { ownership: SessionOwnership | null }> {
  const me = email.trim().toLowerCase();
  if (!me) return { allow: false, reason: "no-caller", ownership: null };
  if (!getOpsDb()) throw new Error("Database not configured");
  return gateSessionRequest(webGateDb(), { kind: "person", email: me }, sessionId, right, { workspace, named });
}
