/**
 * WHO MAY TOUCH AN EVE SESSION — the decision, with no database in it.
 *
 * `app/eve/v1/session/[...segments]/route.ts` is the only thing standing
 * between a signed-in caller and eve's own per-session routes, which
 * authenticate the caller but never ask whether the session is theirs. That
 * gate used to hold its rule inline, on rows it read from an unscoped handle,
 * and the combination is what made it useless: production RLS fails closed, so
 * the unscoped reads returned nothing, and "nothing" was read as "we have no
 * record of this session — let it through".
 *
 * Measured on the live database (2026-09-22) and reproduced on a throwaway
 * Postgres carrying the production fail-closed policy shape
 * (`org_id = current_setting('app.org_id', true)`, FORCE ROW LEVEL SECURITY,
 * app_rw NOBYPASSRLS):
 *
 *     unscoped   chat_sessions 0 · chat_threads 0 · chat_thread_members 0
 *     scoped     chat_sessions 1 · chat_threads 1 · chat_thread_members 1
 *
 * With zero and zero, the gate's "unknown session" branch allowed EVERY session
 * to EVERY signed-in caller: `GET /eve/v1/session/:id/stream` read the whole
 * conversation and a POST sent into it.
 *
 * So the rule lives here, as a pure function over rows the caller has already
 * read PROPERLY, for the same reason `snapshotAccess` does (lib/chat-snapshot.ts):
 * it can then be executed in a test rather than described in a comment, and the
 * gate and its test cannot drift apart. This module imports nothing on purpose —
 * that is what lets `scripts/test-chat-access.mjs` run it under plain node.
 */

/** Why the gate answered the way it did. Logged on every denial. */
export type GateReason =
  /** The caller owns the mirrored chat, or owns a thread on this session. */
  | "owner"
  /** The caller holds a non-revoked member row on a thread for this session. */
  | "member"
  /**
   * We looked in every workspace and found no record of this session at all.
   *
   * THE DELIBERATE ASYMMETRY. The mirror write is debounced, so a session
   * started a second ago is not in the database yet; demanding a record would
   * lock people out of the chat they just started, which is a worse and far
   * more frequent failure than the one this gate closes. A session nobody has
   * ever recorded is unknown to an attacker for exactly the reason it is
   * unknown to us.
   */
  | "unknown"
  /** Known in this workspace, and it is somebody else's. */
  | "not-yours"
  /**
   * Known, but in a DIFFERENT workspace from the caller's.
   *
   * Without this branch, scoping the reads is not enough. An outside work email
   * that the auth gate admits resolves to an isolated `personal:<domain>`
   * workspace (lib/org-context.ts), and a scoped read there returns zero rows
   * for every session in the product — so every session would read as "unknown"
   * and be allowed. Measured on the probe database: a caller scoped to
   * `personal:acme.com` saw 0 sessions / 0 threads for a session that plainly
   * exists in `org-probe`. "We cannot see it" and "it is not there" have to be
   * different answers, and this is the one that tells them apart.
   */
  | "other-workspace"
  /** No verified caller email — nothing to decide with. */
  | "no-caller";

export interface GateInput {
  /** The verified token subject, never a client-supplied field. */
  readonly callerEmail: string;
  /** `chat_sessions.owner_email` for this session, read inside the caller's workspace. */
  readonly mirrorOwners: readonly (string | null | undefined)[];
  /** `chat_threads` rows for this session, read inside the caller's workspace. */
  readonly threads: readonly { readonly ownerEmail: string | null | undefined }[];
  /**
   * True when the caller holds a NON-REVOKED member row on one of those
   * threads. Revocation had no effect here at all: the gate's member lookup
   * carried no status filter while `lib/chat-session-access.ts` and
   * `lib/chat-threads.ts` both use `ne(status, "revoked")`, so a revoked member
   * who kept the session id kept full live read and send access.
   */
  readonly isMember: boolean;
  /**
   * True when a sweep of the OTHER workspaces found this session there. Only
   * consulted when the caller's own workspace has no record of it.
   */
  readonly knownElsewhere: boolean;
}

/**
 * Deny when the session is known to belong to someone else. Allow when nobody
 * anywhere has a record of it.
 */
export function sessionGateDecision(input: GateInput): { allow: boolean; reason: GateReason } {
  const me = input.callerEmail.trim().toLowerCase();
  if (!me) return { allow: false, reason: "no-caller" };

  const owns =
    input.mirrorOwners.some((owner) => owner?.trim().toLowerCase() === me) ||
    input.threads.some((thread) => thread.ownerEmail?.trim().toLowerCase() === me);
  if (owns) return { allow: true, reason: "owner" };
  if (input.isMember) return { allow: true, reason: "member" };

  // Something in THIS workspace carries the session and none of it is the
  // caller's: that is the case the gate exists for.
  if (input.mirrorOwners.length > 0 || input.threads.length > 0) {
    return { allow: false, reason: "not-yours" };
  }
  if (input.knownElsewhere) return { allow: false, reason: "other-workspace" };
  return { allow: true, reason: "unknown" };
}
