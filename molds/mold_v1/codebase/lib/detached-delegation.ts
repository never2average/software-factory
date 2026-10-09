/**
 * A DELEGATION THAT REPORTS LATER — how the app reads eve's per-result delegation (mold_v1-184).
 *
 * The root agent sets `subagents: { batch: "detach" }` (agent/agent.ts; patches/eve+0.25.1.patch, readable source in
 * scripts/eve-patch/). When specialists called in one step come back at different times, eve hands the main agent the
 * results that are in and, for each one still out, a stand-in: an `action.result` (`subagent-result`) whose output is
 * `{ status: "running", childSessionId, name, note }`. The main agent reads it as "this one reports later" and goes on.
 * When that specialist finishes, its result arrives as a turn of its own: an `action.result` for the SAME call id with
 * the real output (or an error, `SUBAGENT_STOPPED` when it was stopped), which eve's client reducer writes over the
 * stand-in on the same delegation card.
 *
 * So on a stream an `action.result` for a delegation is either the result or the stand-in, and every reader that took
 * "an action.result arrived" to mean "the delegation is over" must tell the two apart. This is that test, and the
 * small set of facts built on it. Pure; no eve import.
 */

export interface StreamEventLike {
  readonly type?: string;
  readonly data?: Record<string, unknown> | null;
}

/** The stand-in's output, as the patched eve writes it. */
export interface DetachedOutput {
  readonly status: "running";
  readonly childSessionId: string;
  readonly name?: string;
  readonly note?: string;
}

/** The error code a detachable delegation reports when it is stopped before it finished… */
export const STOPPED_CODE = "SUBAGENT_STOPPED";
/** …and its message, word for word (scripts/eve-patch: createDelegatedSubagentStoppedResult / createStoppedResult). A
 * client sees only this (eve's client reducer keeps an error's message as the card's `errorText`). */
export const STOPPED_MESSAGE = "This specialist was stopped before it finished. It returned no result.";

/** What the chat calls a delegation that reports later. */
export const DETACHED_LABEL = "Working — reports later";
/** One line under such a delegation's card. */
export const DETACHED_NOTE = "Still working in the Control Panel. Its result comes back to the main agent by itself when it finishes.";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Is this delegation OUTPUT the stand-in ("reports later") rather than a result? */
export function isDetachedOutput(output: unknown): output is DetachedOutput {
  return isRecord(output) && output.status === "running" && typeof output.childSessionId === "string" && output.childSessionId.length > 0;
}

/** Is this runtime-action RESULT (an `action.result`'s `data.result`) a delegation's stand-in? */
export function isDetachedResult(result: unknown): boolean {
  return isRecord(result) && result.kind === "subagent-result" && result.isError !== true && isDetachedOutput(result.output);
}

/** Is this event an `action.result` carrying a stand-in? */
export function isDetachedPlaceholderEvent(event: StreamEventLike | null | undefined): boolean {
  return event?.type === "action.result" && isDetachedResult(event.data?.result);
}

/** Did a delegation end because it was stopped (its error output, or the error text a client keeps of it)? */
export function isStoppedDelegation(outputOrText: unknown): boolean {
  if (isRecord(outputOrText)) return outputOrText.code === STOPPED_CODE;
  return typeof outputOrText === "string" && (outputOrText.includes(STOPPED_CODE) || outputOrText.includes(STOPPED_MESSAGE));
}

/**
 * The delegations on a main thread that were handed over as "reports later" and have not reported yet, in the order
 * they were called. A delegation is detached by its stand-in and settled by any later `action.result` for its call.
 */
export function detachedOutstanding(events: readonly (StreamEventLike | null | undefined)[]): { callId: string; name: string; childSessionId: string }[] {
  const called = new Map<string, { name: string; childSessionId?: string }>();
  const out = new Map<string, { callId: string; name: string; childSessionId: string }>();
  for (const e of events) {
    const data = e?.data ?? {};
    if (e?.type === "subagent.called" && typeof data.callId === "string") {
      called.set(data.callId, { name: typeof data.name === "string" && data.name ? data.name : "specialist", childSessionId: typeof data.childSessionId === "string" ? data.childSessionId : undefined });
    } else if (e?.type === "action.result") {
      const result = data.result as { callId?: unknown; output?: unknown } | undefined;
      if (typeof result?.callId !== "string") continue;
      if (isDetachedResult(result)) {
        const output = result.output as DetachedOutput;
        const call = called.get(result.callId);
        out.set(result.callId, { callId: result.callId, name: call?.name ?? output.name ?? "specialist", childSessionId: call?.childSessionId ?? output.childSessionId });
      } else {
        out.delete(result.callId);
      }
    }
  }
  return [...out.values()];
}

/** Did eve mark this `subagent.called` detachable (the delegation reports home itself, also when it is stopped)? */
export function isDetachableCall(event: StreamEventLike | null | undefined): boolean {
  return event?.type === "subagent.called" && event.data?.detachable === true;
}
