// agent-workspace patch to eve 0.25.1 (mold_v1-196): what the application's specialist sweep may do to a main thread and its
// delegations, from outside any turn. Not part of eve. Added by patches/eve+0.25.1.patch; the readable source of every
// change is scripts/eve-patch/. Exported as `delegationSweep` from `eve/channels` (public/channels/index.js).
//
// The sweep (agent/lib/specialist-sweep.ts) finds delegations of a main thread that went quiet: frozen, finished with
// their result never handed back, stopped or crashed without a report. It decides from the sessions' own streams and
// acts through exactly four operations, each one an existing route home that eve already deduplicates:
//
//   events     read a session's durable stream (what `getSession(id).getEventStream()` reads in a route handler; a
//              schedule has no `getSession`)
//   cancel     eve's own cancel of a session's turn (`requestWorkflowTurnCancellation`, which also stops a detachable
//              delegation parked on the person), and `terminate`: end a run that a cancel did not reach
//   handOver   resume a waiting batch's sweep hook (`<session>:delegation-sweep:<first call id>`, created by the
//              detaching wait under a driver that announces `delegationSweep`) with `{ kind: "sweep-detach" }`: the
//              batch is handed over as it would be at its bound, every delegation still out as "reports later"
//   deliverLateResult
//              resume the main thread's delivery hook with `{ kind: "deliver", payloads: [{ delegationResults: [r] }] }`,
//              the same payload a detachable delegation sends home itself (execution/parent-session-delivery.js). The
//              session driver keeps it only while that call is recorded as detached, and the turn that delivers it
//              removes the record (harness/detached-delegations.js `filterDelegationDelivery`,
//              `takeDelegationResults`), so a result the sweep sends and the one the specialist sends reach the main
//              agent exactly once between them, whichever lands first.
//
// No route exposes any of this: only server code that imports it can call it, and the application gates each call by
// the session's workspace and owner. eve's unauthenticated callback routes (closed in the application by
// agent/lib/callback-guard.ts) can resume a hook by token only with `runtime-action-result` or `deliver` payloads,
// which the sweep hook ignores.
import { getHookByToken, getRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";

const SWEEP_DETACH_KIND = `sweep-detach`;

/** The token of a waiting batch's sweep hook: its main thread's session and the batch's first delegation's call id. */
function sweepHookToken(sessionId, callId) {
  return `${sessionId}:delegation-sweep:${callId}`;
}

/**
 * Fails at once, plainly, where no workflow world is configured (a plain script, a unit test): without it the core's
 * reads hang and reject out of band instead.
 */
async function ensureWorld() {
  await getWorld();
}

const isMissing = (error) => HookNotFoundError.is(error) || (error instanceof Error && /not found|no hook/i.test(error.message));

/** A session's durable event stream from `startIndex` (negative: from the tail), as parsed events. */
async function events(sessionId, startIndex = 0) {
  await ensureWorld();
  return parseNdjsonStream(() => getRun(sessionId).getReadable({ startIndex }));
}

/** eve's cancel of the session's running turn (or of a detachable delegation parked on the person). */
async function cancel(sessionId, turnId) {
  await ensureWorld();
  return await requestWorkflowTurnCancellation(turnId === undefined ? { sessionId } : { sessionId, turnId });
}

/** End a session's whole run (a frozen specialist that a cancel did not reach). False when there is no such run. */
async function terminate(sessionId, reason) {
  await ensureWorld();
  try {
    await getRun(sessionId).cancel({ cancelReason: String(reason ?? ``).slice(0, 500) });
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/**
 * Hand over the batch that waits on one of `callIds` (its first delegation's): true when a waiting batch took it.
 * False when none waits (it already went on, or it was started under a driver without `delegationSweep`).
 */
async function handOver(sessionId, callIds) {
  await ensureWorld();
  for (const callId of callIds ?? []) {
    if (typeof callId !== `string` || !callId) continue;
    try {
      await resumeHook(sweepHookToken(sessionId, callId), { kind: SWEEP_DETACH_KIND });
      return true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return false;
}

/**
 * Deliver one delegation's result to its main thread as a late result. `continuationTokens` are the tokens the main
 * thread may take deliveries on (its latest `session.waiting` token, as a channel names it and namespaced); only one
 * whose hook belongs to `sessionId` is used. True when the delivery was taken by the session (whether it is still owed
 * is the session's own decision, once).
 */
async function deliverLateResult(input) {
  const r = input?.result;
  if (!r || typeof r !== `object` || typeof r.callId !== `string` || r.kind !== `subagent-result` || typeof r.subagentName !== `string`) {
    throw new Error(`delegationSweep.deliverLateResult: a subagent-result with a call id and a specialist name is required.`);
  }
  await ensureWorld();
  for (const token of input.continuationTokens ?? []) {
    if (typeof token !== `string` || !token) continue;
    let hook;
    try {
      hook = await getHookByToken(token);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (hook?.runId !== input.sessionId) continue;
    await resumeHook(token, { kind: `deliver`, payloads: [{ delegationResults: [r] }] });
    return true;
  }
  return false;
}

const delegationSweep = Object.freeze({ cancel, deliverLateResult, events, handOver, sweepHookToken, terminate });

export { delegationSweep };
