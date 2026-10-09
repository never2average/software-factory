/**
 * THE PARENT'S OWN VIEW OF A DELEGATION: what started, what is waiting, what died.
 *
 * `agent/lib/workflow-usage.ts` records a specialist's run from the CHILD's own
 * turn events: `turn.started` opens the `automation_runs` row, the steps add
 * tokens, `turn.completed` / `turn.failed` close it. All of that needs a turn to
 * exist. Two measured cases have no turn to hang on, and both are visible from
 * the PARENT's stream instead — which is what this module reads.
 *
 * 1. A CHILD THAT DIES BEFORE `turn.started`. Recorded verbatim in
 *    scripts/fixtures/subagent-delivery/child-fails.ndjson (from this repo's
 *    real agent under `eve dev`, 2026-09-23):
 *
 *      Step "step//eve@0.25.1//turnStep" failed after 3 retries: Sandbox
 *      bootstrap failed because sandbox.run command exited with code 1: …
 *
 *    `subagent.called`, then straight to an `action.result` — not one turn event
 *    from the child in between. The invocation left NO history at all: not "a
 *    failed run", nothing. The parent IS told: eve's workflowEntry catches the
 *    terminal session failure and calls `createDelegatedSubagentErrorResult`
 *    (eve/dist/src/execution/delegated-parent-result.js), which lands as an
 *    `action.result` whose `result.kind` is `subagent-result` with
 *    `isError: true` and `output.code === "SUBAGENT_EXECUTION_FAILED"`.
 *
 * 2. A CHILD THAT IS PARKED ON A QUESTION. Its turn is open and its row is
 *    `running` — legitimately, for as long as nobody answers. eve proxies the
 *    child's `input.requested` onto the PARENT's stream (this is the whole
 *    subject of #42, where six live sessions ended
 *    `subagent.called → input.requested` and stayed there). That is the only
 *    signal anything has that an open run is waiting rather than dead, and
 *    without it the time-based sweeper in workflow-usage.ts would close live
 *    runs.
 *
 *    A PROXIED QUESTION DOES NOT SAY WHICH CHILD ASKED IT. Measured in
 *    scripts/fixtures/subagent-delivery/child-parks-never-answered.ndjson: the
 *    delegation is `call_000000000000000000000009`, and the proxied request's
 *    `action.callId` is `call_00000000000000000000000a` — the CHILD's own
 *    `ask_question` tool call, passed through verbatim
 *    (`emitProxiedInputRequest`, eve/dist/src/execution/subagent-hitl-proxy.js,
 *    re-emits `hookPayload.event.requests` unchanged). The mapping back to the
 *    child lives in eve's internal state, not on the stream.
 *
 *    So a park marks EVERY delegation the parent still has outstanding, which
 *    is exact for the one-delegation case and an over-approximation when two
 *    run at once. That direction is chosen deliberately: over-marking leaves a
 *    dead run open a while longer (the status quo), under-marking closes a run
 *    that is still working, which is the one outcome the sweeper must never
 *    produce. The mark is cleared per delegation as each one comes back.
 *
 * WHY THIS IS PARENT-SIDE AND NOT IN THE SUBAGENTS' HOOKS. The four specialists
 * that actually run in production ship in a pack (docs/SUBAGENT_PACKS.md) and
 * carry their own copy of `hooks/usage.ts`. #42 was fixed in this repo's ten
 * subagents, did not reach those four, and reported itself green — the exact
 * trap #43 was written to close. The parent of every delegation is the ROOT
 * agent, whose hooks live in `agent/hooks/` and are never pack-supplied, so a
 * fix here reaches every specialist, pack's included, with no pack change.
 *
 * It is a pure state machine on purpose: no database, no eve imports, so the
 * rules below are EXECUTED by scripts/test-subagent-delivery.mjs against the
 * real recorded streams rather than described in a comment.
 *
 * WHY THE CHILD SESSION IS CARRIED FROM `subagent.called`. The failed result
 * carries `subagentName` (measured: "research") but not the child's session id,
 * and the run key needs the session — see `runKeyFor`, where the session IS the
 * invocation. `childSessionId` appears exactly once, on `subagent.called`.
 *
 * WHY THE KEY IS (session, callId) AND NEVER callId ALONE. Call ids are not
 * unique: `agent/lib/unique-tool-call-ids.ts` documents models that COUNT
 * instead of minting ids, and every recorded stream here uses a counter-shaped
 * id — two different sessions, both `call_000000000000000000000002`. This map
 * lives at module scope in a warm serverless instance serving many sessions, so
 * keyed on the call id alone one session's failure would be filed against
 * ANOTHER session's child, inventing a failed run for a specialist that is
 * still working. That is the same hazard that ruled out module-scope turn
 * tracking as the fix for `session.failed`; here the parent session id is on
 * every event, so it is simply part of the key.
 */

/** One delegation the parent is still waiting on. */
export interface PendingDelegation {
  /** The subagent id — the name its `workflows` row carries. */
  readonly name: string;
  /** The child session eve created for this invocation. The run key needs it. */
  readonly childSessionId: string;
}

/** A delegation that has come back, and whether it came back as a failure. */
export interface SettledDelegation extends PendingDelegation {
  readonly failed: boolean;
  /** eve's reason, when it gave one. Only meaningful on a failure. */
  readonly message: string | undefined;
}

/** The shape of `subagent.called`'s data that matters here. */
export interface SubagentCalledData {
  readonly callId?: string;
  readonly childSessionId?: string;
  readonly name?: string;
}

/** The shape of `input.requested`'s data that matters here. */
export interface InputRequestedData {
  readonly requests?: readonly {
    readonly requestId?: string;
    readonly action?: { readonly callId?: string };
  }[];
}

/** The shape of `actions.requested`'s data that matters here. */
export interface ActionsRequestedData {
  readonly actions?: readonly { readonly callId?: string }[];
}

/** The shape of `action.result`'s data that matters here. */
export interface ActionResultData {
  readonly result?: {
    readonly callId?: string;
    readonly kind?: string;
    readonly isError?: boolean;
    readonly output?: unknown;
    readonly subagentName?: string;
  };
}

/**
 * A warm instance can serve sessions for hours, and a delegation that neither
 * fails nor returns (the parent's turn is abandoned, the instance is recycled
 * mid-flight) is never collected by the `action.result` branch. 512 entries is
 * a few tens of bytes each and far more than the handful of delegations any one
 * turn makes; past it the OLDEST is dropped, because an unresolved delegation
 * from hours ago will never resolve. Insertion order is Map iteration order, so
 * the eviction needs no bookkeeping of its own.
 */
const MAX_PENDING = 512;

/** NUL cannot appear in an eve session id or a call id, so the key cannot be ambiguous. */
const keyFor = (sessionId: string, callId: string): string => `${sessionId}\u0000${callId}`;

export interface DelegationTracker {
  /** Remember the call ids the PARENT asked for — see `parked`. */
  declared(sessionId: string, data: ActionsRequestedData): void;
  /** Remember a delegation the parent just started. */
  called(sessionId: string, data: SubagentCalledData): void;
  /**
   * The delegations this `input.requested` parks — the child is WAITING, not
   * dead.
   *
   * A request is a child's only if the parent did not declare its call id
   * itself: the same test `proxiedChildRequestIds` in lib/chat-turn-state.ts
   * uses, and for the same reason — a parent's own approval (`send_email?`)
   * must not exempt a specialist's run from the sweep. The child's id cannot be
   * matched positively because the proxy passes the child's inner tool call
   * through, so exclusion is the only test available.
   */
  parked(sessionId: string, data: InputRequestedData): readonly PendingDelegation[];
  /**
   * The invocation this result ends, or null when the result belongs to
   * something that is not a tracked delegation. Consumed either way: a result
   * is the end of it, whether it succeeded or failed.
   */
  settled(sessionId: string, data: ActionResultData): SettledDelegation | null;
  /** How many delegations are outstanding (the bound is asserted by the tests). */
  readonly size: number;
}

/**
 * True for the error result eve hands a parent when a child session dies.
 *
 * Tested on `isError` rather than on the code string: `isError` is the
 * discriminator eve itself sets (`createDelegatedSubagentErrorResult`), and a
 * future error code would otherwise silently stop being recorded — which is the
 * failure mode this module exists to end.
 */
function isFailedSubagentResult(data: ActionResultData): boolean {
  return data.result?.kind === "subagent-result" && data.result.isError === true;
}

/** The human-readable half of the error payload, if eve supplied one. */
function messageOf(output: unknown): string | undefined {
  if (typeof output === "string") return output || undefined;
  if (output && typeof output === "object") {
    const message = (output as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
    const code = (output as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return undefined;
}

export function createDelegationTracker(): DelegationTracker {
  const pending = new Map<string, PendingDelegation>();
  /** Call ids the parent asked for itself, bounded the same way. */
  const declaredCalls = new Set<string>();
  const bound = <T>(collection: { size: number; keys(): Iterator<T>; delete(key: T): unknown }) => {
    while (collection.size > MAX_PENDING) {
      const oldest = collection.keys().next();
      if (oldest.done) break;
      collection.delete(oldest.value);
    }
  };
  return {
    declared(sessionId, data) {
      if (!sessionId) return;
      for (const action of data.actions ?? []) {
        if (action?.callId) declaredCalls.add(keyFor(sessionId, action.callId));
      }
      bound(declaredCalls);
    },
    called(sessionId, data) {
      // Both ids are required: without the child session there is no run key to
      // write, and without the call id nothing can match a result back to it.
      if (!sessionId || !data.callId || !data.childSessionId || !data.name) return;
      pending.set(keyFor(sessionId, data.callId), {
        name: data.name,
        childSessionId: data.childSessionId,
      });
      bound(pending);
    },
    parked(sessionId, data) {
      if (!sessionId) return [];
      const fromAChild = (data.requests ?? []).some((request) => {
        const callId = request?.action?.callId;
        // No call id at all is the parent's own session-limit prompt, not a
        // child's — the same carve-out proxiedChildRequestIds makes.
        if (!callId) return false;
        return !declaredCalls.has(keyFor(sessionId, callId));
      });
      if (!fromAChild) return [];
      // NOT consumed: every one of these is still outstanding, and a re-park
      // (eve restates the question after a failed answer) must find them again.
      const out: PendingDelegation[] = [];
      const prefix = `${sessionId}\u0000`;
      for (const [key, delegation] of pending) {
        if (key.startsWith(prefix)) out.push(delegation);
      }
      return out;
    },
    settled(sessionId, data) {
      const callId = data.result?.callId;
      if (!sessionId || !callId) return null;
      const key = keyFor(sessionId, callId);
      const delegation = pending.get(key);
      // A result RETIRES the delegation whichever way it went: holding a
      // completed one would make this map grow for the life of the instance.
      pending.delete(key);
      // No `subagent.called` was seen for this call id — a warm instance that
      // began serving mid-session sees only events from the moment it loaded,
      // and the child's session id is the one thing that cannot be
      // reconstructed. Nothing is written rather than a row keyed on a guess,
      // which would collide with some real invocation's.
      if (!delegation) return null;
      return {
        ...delegation,
        failed: isFailedSubagentResult(data),
        message: messageOf(data.result?.output),
      };
    },
    get size() {
      return pending.size;
    },
  };
}
