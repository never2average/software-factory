/**
 * Desktop notifications for chat turns: a reply is ready, the agent needs the person's answer, a turn failed.
 *
 * The decisions are in agent/lib/turn-notifier.ts (which moments notify) and agent/lib/push-notify.ts (what is
 * said, to whom); the recipients and their devices in agent/lib/push-recipients.ts. This file is the wiring.
 *
 * Off unless the three VAPID variables are set (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT): with none, no
 * database is touched. Root hooks never fire for a specialist's own turns, so a delegated specialist notifies once,
 * through the reply it feeds — and its QUESTIONS and APPROVALS, which eve proxies onto the root's stream without
 * running any hook, are reported by the channel's event handler instead (agent/channels/eve.ts). The one notifier
 * both feed lives in agent/lib/turn-notify.ts.
 *
 * Observe-only and never throws (eve escalates a thrown hook to `turn.failed`). The sending is OFF the turn's
 * critical path: handed to a small bounded queue and not awaited, so a slow push service never holds up a turn.
 */
import { defineHook } from "eve/hooks";
import { notificationsEnabled as enabled, notifyInputRequested, turnNotifier as turns } from "#lib/turn-notify.js";

export default defineHook({
  events: {
    "turn.started"(event, ctx) {
      if (enabled()) turns.turnStarted(ctx.session.id, event.data.turnId);
    },
    "message.completed"(event, ctx) {
      if (enabled()) turns.messageCompleted(ctx.session.id, event.data as { turnId?: string; message?: unknown; finishReason?: unknown });
    },
    async "input.requested"(event, ctx) {
      // The root's own question. A delegated specialist's never reaches a hook: agent/channels/eve.ts reports those
      // (and these too — each request notifies once, agent/lib/turn-notifier.ts).
      await notifyInputRequested(ctx.session.id, event.data, ctx);
    },
    async "turn.completed"(event, ctx) {
      if (enabled()) await turns.turnCompleted(ctx.session.id, event.data.turnId, ctx);
    },
    async "turn.failed"(event, ctx) {
      if (enabled()) await turns.turnFailed(ctx.session.id, event.data.turnId, ctx);
    },
    "turn.cancelled"(event, ctx) {
      if (enabled()) turns.turnCancelled(ctx.session.id, event.data.turnId);
    },
  },
});
