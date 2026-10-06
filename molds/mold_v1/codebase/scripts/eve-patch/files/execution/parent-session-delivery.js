// fde-agent patch to eve 0.25.1 (mold_v1-184): a detached delegation's way home. Not part of eve.
// Added by patches/eve+0.25.1.patch; the readable source of every change is scripts/eve-patch/.
//
// A delegation started under `subagents: { batch: "detach" }` carries its parent SESSION's delivery token
// (`parentSessionContinuationToken` in the subagent adapter state) beside the turn's inbox token. What it sends home
// (its result, its question to the person) goes to the turn's inbox as before AND to the parent session's delivery
// hook, as a `deliver` whose payload carries only `delegationResults` / `delegationRequests`. The parent's session
// driver keeps such a payload only while that delegation is recorded as detached in the session's durable state
// (harness/detached-delegations.js `filterDelegationDelivery`), and the turn that delivers it removes the record, so
// it reaches the main agent exactly once whichever copy, retry or instance gets there first. No public channel can
// produce these fields: eve's HTTP channel builds every payload from `message`, `context`, `inputResponses` and
// `outputSchema` only (channel/send.js).
import { createLogger } from "#internal/logging.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

const log = createLogger(`execution.parent-session-delivery`);

/** resumeHook, answering false (instead of throwing) when no hook holds the token. */
async function resumeHookIfPresent(token, payload) {
  try {
    await resumeHook(token, payload);
    return true;
  } catch (error) {
    if (HookNotFoundError.is(error)) return false;
    throw error;
  }
}

/**
 * Deliver `payload` to the parent session's delivery hook, by the token recorded at dispatch (the session's
 * continuation token, which its driver keeps its delivery hook on). A parent session that takes no deliveries (it
 * ended, or its channel re-keyed it) takes nothing: logged, not retried — there is nobody to deliver to. (Its current
 * token cannot be looked up here: eve 0.25.1 keeps the session snapshot in the workflow's own state, not on a stream
 * another run can read.)
 */
async function deliverToParentSession(input) {
  if (await resumeHookIfPresent(input.token, { kind: `deliver`, payloads: [input.payload] })) return true;
  log.warn(`a delegation's parent session takes no deliveries on the token it was started with; nothing was sent`, { parentSessionId: input.parentSessionId });
  return false;
}

/**
 * Send one hook payload of a detachable delegation home. `always`: to the turn's inbox (if it is still there) AND to the
 * parent session; otherwise to the session only when the turn's inbox is gone.
 */
async function sendDelegationHome(input) {
  const atTurn = input.parentContinuationToken ? await resumeHookIfPresent(input.parentContinuationToken, input.hookPayload) : false;
  if (!input.always && atTurn) return;
  await deliverToParentSession({ parentSessionId: input.parentSessionId, payload: input.sessionPayload, token: input.parentSessionContinuationToken });
}

export { deliverToParentSession, resumeHookIfPresent, sendDelegationHome };
