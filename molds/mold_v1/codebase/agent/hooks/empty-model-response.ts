/**
 * The server side of the chat log: an empty model response reaches
 * `automation_audit` whether the turn survived it or not.
 *
 * Every kind in `lib/chat-telemetry.ts` before this one is emitted by the
 * BROWSER. So when the live deployment's chat died on 2026-09-23 with
 * `MODEL_CALL_FAILED "Empty model response"` — every attempt, both sessions, at
 * the same depth, after the pdf had already been read — the recorded history of
 * chat incidents stayed at five rows and a person had to notice before any
 * instrument did.
 *
 * THIS MUST BE A HOOK AND NOT THE MODEL MIDDLEWARE, and it must fire on the
 * SUCCESS events too. `agent/lib/empty-model-response.ts` now recovers most
 * empties below eve — retry, then the text-only fallback — so eve sees a normal
 * step and `step.failed` never fires. A recorder hanging off the failure events
 * alone would therefore go quiet exactly as the fix started working, and the
 * next person would read that silence as "it stopped happening".
 *
 * eve discovers every file under `agent/hooks/` as a hook of the ROOT agent, so
 * this covers the main chat — which is where the defect was measured and where a
 * person is waiting. A specialist's own empties are stashed on the child
 * session's step and are not drained by this file; see
 * agent/lib/empty-model-response-log.ts.
 *
 * Observe-only and never throws: eve escalates a thrown hook to `turn.failed`,
 * and a recorder that fails the turn it just rescued would be a joke. The flush
 * swallows its own errors and is awaited so two terminal events for one step
 * cannot interleave their writes.
 */
import { defineHook } from "eve/hooks";
import { flushEmptyResponses } from "#lib/empty-model-response-log.js";

export default defineHook({
  events: {
    // The recovered case: the step finished because the retry or the fallback
    // worked. This is the event that will carry almost every row once the fix is
    // live, and the one an operator counts to see whether it is still happening.
    async "step.completed"(_event, ctx) {
      await flushEmptyResponses(ctx);
    },
    // The unrecovered case: eve gave up on top of the ladder giving up.
    async "step.failed"(_event, ctx) {
      await flushEmptyResponses(ctx);
    },
    // Belt and braces for a turn that ends without a terminal step event (a
    // cancel mid-stream, a turn parked on a limit). A drained slot makes each of
    // these a cheap no-op, and the record id set makes a double drain harmless.
    async "turn.completed"(_event, ctx) {
      await flushEmptyResponses(ctx);
    },
    async "turn.failed"(_event, ctx) {
      await flushEmptyResponses(ctx);
    },
    async "turn.cancelled"(_event, ctx) {
      await flushEmptyResponses(ctx);
    },
  },
});
