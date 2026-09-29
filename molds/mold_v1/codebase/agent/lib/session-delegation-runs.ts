/**
 * RUN HISTORY FOR DELEGATIONS, RECORDED FROM THE PARENT'S STREAM AS THE SESSION GUARD SERVES IT (mold_v1-129).
 *
 * agent/lib/delegation-failures.ts decides, from the PARENT's events, which delegation died before its child could
 * record a run (`action.result` flagged isError) and which is parked on a question (`input.requested`). Both need the
 * child's session id, and that appears in exactly one event: `subagent.called`.
 *
 * That was wired as an authored hook (agent/hooks/delegation-runs.ts). In eve 0.25.1 an authored hook NEVER receives
 * `subagent.called`: the event is written by the action-dispatch step (eve/dist/src/execution/
 * dispatch-runtime-actions-step.js), which hands it to the channel ADAPTER (`callAdapterEventHandler`) and to the
 * stream, and never to `dispatchStreamEventHooks` — only the turn step's events reach hooks
 * (execution/workflow-steps.js). The channel adapter cannot subscribe to it either (defineChannel's `eventTypes` list
 * omits it). So the tracker never learned a single child, `settled` always returned null, and neither a failed
 * delegation's row nor a park mark was ever written: the hook was dead code that reported itself wired
 * (scripts/test-subagent-delivery.mjs section 10 now asserts the eve fact).
 *
 * The one place `subagent.called` is observable is the stream, and every read of a parent's stream goes through the
 * session guard (agent/lib/session-guard.ts), which already reads its own output line by line to record a child's
 * owner (agent/lib/session-lineage-stream.ts). So the same pass feeds the tracker here — `actions.requested`,
 * `subagent.called`, `input.requested`, `action.result` — and the same idempotent writers the hook called do the rest:
 *
 *   · ONE TRACKER PER STREAM READ, and within it delegations keyed by turn as well as call id. Call ids are
 *     per-turn counters (`call_…02` in every recorded stream), and a replay of the parent's history from index 0
 *     reads an OLD turn while a live tab reads the current one: with one process-wide tracker the two overwrote
 *     each other, so an old failure was filed against the live child — dated in the past, pre-empting the child's
 *     own row through ON CONFLICT DO NOTHING — and the live child's own outcome was lost. A read sees its turns in
 *     order, so its own tracker is exact. Several readers of one live turn each settle it; the writers are
 *     idempotent (`onConflictDoNothing` on the unique `run_key`, UPDATE … WHERE status = 'running').
 *   · The cost: a read that starts after a delegation's `subagent.called` (a reconnect from a cursor) cannot settle
 *     it — the reader that saw the call, or a later replay, does.
 *   · a replay from index 0 re-reads old results: a failed one re-files the same row (a no-op), an answered one
 *     clears a park mark that must already be clear.
 *
 * What it cannot see: a turn nobody streamed at all. The live chat, the workflow delegate and the queue drain all
 * stream the turns they start, so that is a parent nobody is watching; its child's own hooks still record the child's
 * run, and only a child that died before its first turn goes unrecorded — the gap this module closes whenever anyone
 * is reading.
 *
 * Awaited, not fire-and-forget: the failed-delegation write races the child's own `openWorkflowRun` for one run_key,
 * and the unique index settles that race correctly only if each write completes. Never throws.
 */
import {
  createDelegationTracker,
  type ActionResultData,
  type ActionsRequestedData,
  type InputRequestedData,
  type SubagentCalledData,
} from "./delegation-failures.ts";
import { clearDelegationPark, markDelegationParked, recordFailedDelegation } from "./workflow-usage.ts";

/** The database writes a settled or parked delegation turns into (agent/lib/workflow-usage.ts). */
export interface DelegationRunWriters {
  recordFailedDelegation(name: string, childSessionId: string, message?: string, at?: Date): Promise<void>;
  markDelegationParked(name: string, childSessionId: string): Promise<void>;
  clearDelegationPark(name: string, childSessionId: string): Promise<void>;
}

const writers: DelegationRunWriters = { recordFailedDelegation, markDelegationParked, clearDelegationPark };

/** The event types this recorder acts on — everything else is passed over without parsing. */
export const DELEGATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "actions.requested",
  "subagent.called",
  "input.requested",
  "action.result",
]);

type StreamEvent = { readonly type?: unknown; readonly data?: unknown; readonly meta?: unknown };

/** The time eve stamped on an event (`meta.at`), if it is a real one. */
function stampOf(event: StreamEvent): Date | undefined {
  const at = (event.meta as { at?: unknown } | undefined)?.at;
  if (typeof at !== "string") return undefined;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * The recorder for one read of `parentSessionId`'s stream. The id is the one the guard serves — the path's — never a
 * field of the event. Feed it every parsed event; it ignores what it does not need.
 */
export function delegationRunRecorder(
  parentSessionId: string,
  write: DelegationRunWriters = writers,
): (event: StreamEvent) => Promise<void> {
  // This read's own tracker (see the header). Delegations are keyed by (parent, turn, call); `parked` matches on the
  // parent prefix, so a question still finds every delegation this read has outstanding.
  const tracker = createDelegationTracker();
  const inTurn = (data: Record<string, unknown>) =>
    `${parentSessionId}\u0000${typeof data.turnId === "string" ? data.turnId : ""}`;
  return async (event) => {
    const type = typeof event?.type === "string" ? event.type : "";
    if (!parentSessionId || !DELEGATION_EVENT_TYPES.has(type)) return;
    const data = (event.data ?? {}) as Record<string, unknown>;
    try {
      if (type === "actions.requested") tracker.declared(parentSessionId, data as ActionsRequestedData);
      else if (type === "subagent.called") tracker.called(inTurn(data), data as SubagentCalledData);
      else if (type === "input.requested") {
        for (const parked of tracker.parked(parentSessionId, data as InputRequestedData)) {
          await write.markDelegationParked(parked.name, parked.childSessionId);
        }
      } else if (type === "action.result") {
        const settled = tracker.settled(inTurn(data), data as ActionResultData);
        if (!settled) return;
        if (settled.failed) {
          // Filed at eve's own time for it: a replay of an old conversation must not date an old failure today.
          await write.recordFailedDelegation(settled.name, settled.childSessionId, settled.message, stampOf(event));
        }
        else await write.clearDelegationPark(settled.name, settled.childSessionId);
      }
    } catch (error) {
      console.error("[delegation-runs] could not record a delegation from the parent's stream", {
        parentSessionId,
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
