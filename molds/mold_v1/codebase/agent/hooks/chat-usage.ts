/**
 * Token accounting for ordinary chat turns — the main agent's own model calls.
 *
 * eve discovers every file under `agent/hooks/` (recursively) as a hook of the
 * ROOT agent, the way each `agent/subagents/<id>/hooks/usage.ts` is a hook of
 * that subagent. Root hooks do not fire for subagent turns and subagent hooks
 * do not fire for root turns, so this and the workflow recorders never double
 * count: workflow usage lands in `automation_runs`, chat usage in
 * `chat_turn_usage`.
 *
 * Observe-only and fire-and-forget: the recorder never throws (eve escalates a
 * thrown hook to `turn.failed`) and nothing here awaits the database, so a
 * slow or absent database cannot slow or fail a turn. See
 * agent/lib/chat-usage.ts for what is recorded and how the workspace is found.
 */
import { defineHook } from "eve/hooks";
import { chatUsage } from "#lib/chat-usage.js";

export default defineHook({
  events: {
    "step.completed"(event, ctx) {
      void chatUsage.recordStep(ctx, event.data.turnId, event.data.usage);
    },
    "turn.completed"(event, ctx) {
      void chatUsage.finishTurn(ctx, event.data.turnId, "success");
    },
    "turn.failed"(event, ctx) {
      void chatUsage.finishTurn(ctx, event.data.turnId, "failed");
    },
    "turn.cancelled"(event, ctx) {
      void chatUsage.finishTurn(ctx, event.data.turnId, "cancelled");
    },
  },
});
