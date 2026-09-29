/**
 * WHO MAY TOUCH AN EVE SESSION — the decision, with no database in it.
 *
 * eve's per-session routes (`POST /eve/v1/session/:id`, `GET …/stream`, `POST …/cancel`) authenticate a caller and
 * then act on ANY session id. This rule is what stands in front of them, in BOTH places a request can arrive:
 *
 *   · the AGENT project itself (agent/lib/session-guard.ts wraps eve's route handlers) — the enforcement point,
 *     because the agent API is its own public deployment and a caller can skip the web app entirely;
 *   · the web app's proxy (app/eve/v1/session/[...segments]/route.ts) — an early refusal on the same rule.
 *
 * Both call {@link sessionGateDecision} over facts read by the same code (lib/session-gate.ts), so the two cannot
 * drift apart. This module imports nothing on purpose — that is what lets scripts/test-chat-access.mjs run it
 * under plain node.
 *
 * THE RULE. Admitted, and nobody else:
 *
 *   · the session's OWNER — the identity recorded by the agent when the session was CREATED (agent_session_owners),
 *     never a row the browser wrote;
 *   · a NON-REVOKED member of a live (un-archived) shared thread on the session (or on its root, for a subagent's
 *     child session) that the OWNER shared — a thread row anybody else wrote confers nothing. A viewer may read;
 *     only a participant may send, answer an approval, or cancel;
 *   · for a WORKSPACE-visible session (a workflow/app/cron step), any member of the session's workspace — to READ;
 *   · a trusted SERVICE principal (agent/lib/service-scope.ts `isServicePrincipal`: eve's schedule app principal,
 *     the front-end's production OIDC token) — only while it NAMES the session's workspace (`x-workspace-scope`), and
 *     only on a session the platform itself runs there: one a service started, or a workflow/app/cron step (a
 *     workspace-visible session: see {@link serviceMayAct}), and their delegated children. Never a person's chat;
 *   · a SESSION-BOUND token (see `SESSION_BOUND_TOKEN_KIND`) for exactly the session it is bound to;
 *   · `eve dev`'s local-dev principal, only where local development is allowed at all.
 *
 * A session nobody has a record of is REFUSED. The old rule allowed it ("the mirror write is debounced"), which is
 * why a brand-new or never-mirrored session was open to every signed-in caller. The agent now records the owner
 * before it returns a new session's id to anyone, so there is no window to protect.
 *
 * Every refusal is answered 404 by both callers, never 403: a stranger must not learn that the id exists.
 */

/** What the request would do. `read` = the event stream; `write` = a message, an approval answer, a cancel. */
export type SessionRight = "read" | "write";

/** Who is asking, as the verified token says — never a client-supplied field. */
export interface GateCaller {
  readonly kind: "person" | "service" | "principal" | "local-dev" | "session-bound" | "none";
  /** A person's verified email (lower-cased by the reader). Present on session-bound tokens too, but not used. */
  readonly email: string | null;
  /** The principal id of a caller with no email (compared against `ownerPrincipal`). */
  readonly principalId?: string | null;
  /** The workspace a SERVICE caller names for this request (`x-workspace-scope`), if any. */
  readonly serviceScope?: string | null;
  /** The one session a session-bound token may touch. */
  readonly boundSessionId?: string | null;
  /**
   * What a session-bound token may do on it (`act`, lib/session-token-kinds.ts SESSION_BOUND_ACT_CLAIM): "read" its
   * stream, or "post" (a write). Anything else — or none — is read-only.
   */
  readonly boundAct?: string | null;
}

/** Who owns the session, as the agent recorded it (or as the legacy rows say, for sessions older than the record). */
export interface SessionOwnership {
  readonly orgId: string;
  readonly ownerEmail: string | null;
  readonly ownerPrincipal: string | null;
  readonly ownerKind: string;
  /** 'owner' — a chat; 'workspace' — a workflow/app/cron step any member of `orgId` may open. */
  readonly visibility: string;
  /** For a subagent's child session: its root, whose shared threads also admit their members here. */
  readonly rootSessionId: string | null;
  /** sha256 of the session's continuation token, when known. */
  readonly tokenSha256: string | null;
  /** Where the answer came from. `legacy` = inferred from pre-guard rows; `lineage` = inherited from the parent. */
  readonly source: "record" | "lineage" | "legacy";
}

export type GateReason =
  | "owner"
  | "member"
  | "workspace"
  | "service"
  | "session-bound"
  | "local-dev"
  /** A viewer (or a colleague on a workspace-visible step) asked to send, answer or cancel. */
  | "read-only"
  /** Known, and it is not the caller's. */
  | "not-yours"
  /** No record of the session anywhere. Refused — the old "unknown, allow" branch is gone. */
  | "unknown"
  /** A service named a different workspace than the session's. */
  | "wrong-workspace"
  /** A service named no workspace at all. */
  | "no-workspace"
  /** A session-bound token presented for another session. */
  | "wrong-session"
  /** A session-bound token used for what its `act` does not allow (a post token reading the stream). */
  | "wrong-act"
  /** No verified identity to decide with. */
  | "no-caller";

export type GateRole = "owner" | "participant" | "viewer" | "workspace" | "service" | "session-bound" | "local-dev";

export interface GateInput {
  readonly caller: GateCaller;
  readonly sessionId: string;
  readonly right: SessionRight;
  /** null = no record of this session anywhere. */
  readonly ownership: SessionOwnership | null;
  /**
   * The caller's NON-REVOKED membership of a live thread on this session (or its root) whose owner is the session's
   * owner, or null.
   */
  readonly membership: { readonly role: string } | null;
  /** Is the caller a member of `ownership.orgId`? Only consulted for a workspace-visible session. */
  readonly callerInWorkspace: boolean;
  /** Is local development allowed in this process at all (agent/lib/local-dev.ts)? */
  readonly localDevAllowed: boolean;
  /**
   * TRANSITION — REMOVE AFTER 2026-10-13 (follow-up task: "drop the headerless service door", mold_v1-130).
   *
   * Set by the agent's guard for a stream READ or a CANCEL only. The web app before mold_v1-130 sent
   * `x-workspace-scope` on a step's create alone, and provisioning deploys the agent before the web app, so for the
   * minutes between them — or for good, if the web deploy then fails — its service stream reads and cancels carry no
   * header. When set, a headerless service is admitted to a session that passes {@link serviceMayAct}, in the
   * session's own recorded workspace; never to a person's chat, never to post into anything, never to create.
   */
  readonly headerlessServiceTransition?: boolean;
}

export interface GateDecision {
  readonly allow: boolean;
  readonly reason: GateReason;
  /** What the caller is to this session when allowed — a viewer's stream is served without its resume token. */
  readonly role?: GateRole;
}

const norm = (value: string | null | undefined): string => (value ?? "").trim().toLowerCase();

/** Does this caller get `right` on this session? Pure: every fact it needs is an argument. */
export function sessionGateDecision(input: GateInput): GateDecision {
  const { caller, ownership, right } = input;

  // A token minted for ONE session (server-side queue delivery) is that and nothing more: it is never an owner, a
  // member or a person anywhere else, whatever email it carries. Checked first so no rule below can widen it.
  if (caller.kind === "session-bound") {
    if (!caller.boundSessionId || caller.boundSessionId !== input.sessionId) return { allow: false, reason: "wrong-session" };
    if (!ownership) return { allow: false, reason: "unknown" };
    // Bound AND minted for the session's owner — a bound token for someone else's session proves nothing.
    if (!norm(caller.email) || norm(caller.email) !== norm(ownership.ownerEmail)) return { allow: false, reason: "not-yours" };
    // The token's act decides the right, here as well as at its door (agent/lib/queue-delivery-auth.ts): only a
    // POST token writes (sends, answers, cancels) — a READ token, or one naming no act, never does, whatever door
    // let it in; and a POST token never reads.
    const act = caller.boundAct ?? null;
    if (right === "write" && act !== "post") return { allow: false, reason: "read-only" };
    if (right === "read" && act === "post") return { allow: false, reason: "wrong-act" };
    return { allow: true, reason: "session-bound", role: "session-bound" };
  }

  if (caller.kind === "local-dev") {
    return input.localDevAllowed ? { allow: true, reason: "local-dev", role: "local-dev" } : { allow: false, reason: "no-caller" };
  }

  if (caller.kind === "service") {
    // It used to be refused only when it named a DIFFERENT workspace: naming none admitted it to every session of
    // every workspace, and naming one to every person's private chat in it (mold_v1-130).
    const named = caller.serviceScope?.trim();
    if (!named) {
      // TRANSITION — remove after 2026-10-13 (see GateInput.headerlessServiceTransition): the workspace is the
      // session's own, and only a session the platform runs qualifies.
      if (input.headerlessServiceTransition && ownership && serviceMayAct(ownership)) {
        return { allow: true, reason: "service", role: "service" };
      }
      return { allow: false, reason: "no-workspace" };
    }
    if (!ownership) return { allow: false, reason: "unknown" };
    if (named !== ownership.orgId) return { allow: false, reason: "wrong-workspace" };
    if (!serviceMayAct(ownership)) return { allow: false, reason: "not-yours" };
    return { allow: true, reason: "service", role: "service" };
  }

  if (caller.kind === "none") return { allow: false, reason: "no-caller" };
  const me = norm(caller.email);
  const principal = caller.principalId?.trim() ?? "";
  if (!me && !principal) return { allow: false, reason: "no-caller" };
  if (!ownership) return { allow: false, reason: "unknown" };

  const ownsByEmail = Boolean(me) && me === norm(ownership.ownerEmail);
  const ownsByPrincipal = !me && Boolean(principal) && principal === (ownership.ownerPrincipal ?? "").trim();
  if (ownsByEmail || ownsByPrincipal) return { allow: true, reason: "owner", role: "owner" };

  if (me && input.membership) {
    const role = norm(input.membership.role);
    if (role === "viewer") {
      return right === "read" ? { allow: true, reason: "member", role: "viewer" } : { allow: false, reason: "read-only" };
    }
    // 'participant' (and an 'owner' member row, should one exist) may send, answer and cancel — what the
    // multiplayer relay (app/api/ops/threads/[id]/messages) has always allowed them.
    return { allow: true, reason: "member", role: "participant" };
  }

  // A workflow/app/cron step is the workspace's to LOOK AT (the run timeline), not to steer: a colleague reads it,
  // like a shared thread's viewer, and never sends, answers an approval or cancels. The run's own initiator is its
  // owner and keeps full rights; cancelling a whole run goes through the ops API, which checks the workspace itself.
  if (me && ownership.visibility === "workspace" && input.callerInWorkspace) {
    return right === "read" ? { allow: true, reason: "workspace", role: "workspace" } : { allow: false, reason: "read-only" };
  }
  return { allow: false, reason: "not-yours" };
}

/**
 * Is this a session the PLATFORM runs, which its service identity may therefore act on (read, steer, cancel)?
 *
 *   · one a service STARTED (`ownerKind` "service": a cron, app refresh or on-demand run step, recorded at creation by
 *     agent/lib/session-guard.ts), or a delegated child / re-started continuation of one (both inherit the record);
 *   · a workflow, app or cron STEP a person started — workspace-visible, which only a service or the web app's signed
 *     step grant can make a session (lib/session-token-kinds.ts), or legacy journal/app evidence
 *     (lib/session-gate.ts readLegacyOwnership). The run-cancel fan-out reaches these as the service.
 *
 * A person's ordinary chat is neither, so no service call reaches it, whatever workspace it names.
 */
export function serviceMayAct(ownership: SessionOwnership): boolean {
  return ownership.ownerKind === "service" || ownership.visibility === "workspace";
}

/**
 * The right a request needs, from its method and the path segments AFTER `/eve/v1/session/:id`. A stream read is
 * the only read; anything else — a message, an approval answer, a cancel, a verb eve adds later — is a write.
 */
export function rightFor(method: string, rest: readonly string[]): SessionRight {
  const verb = method.toUpperCase();
  if ((verb === "GET" || verb === "HEAD") && rest.length === 1 && rest[0] === "stream") return "read";
  return "write";
}
