/**
 * Desktop notifications for chat turns: a reply is ready, the agent needs the person's answer, a turn failed.
 *
 * The decisions are in agent/lib/turn-notifier.ts (which moments notify) and agent/lib/push-notify.ts (what is
 * said, to whom); the recipients and their devices in agent/lib/push-recipients.ts. This file is the wiring.
 *
 * Off unless the three VAPID variables are set (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT): with none, no
 * database is touched. Root hooks never fire for a specialist's own turns, so a delegated specialist notifies once,
 * through the reply it feeds.
 *
 * Observe-only and never throws (eve escalates a thrown hook to `turn.failed`). The sending is OFF the turn's
 * critical path: handed to a small bounded queue and not awaited, so a slow push service never holds up a turn.
 */
import { defineHook } from "eve/hooks";
import { callerFromCtx, orgForSession, type SessionCtxLike } from "#lib/org-context.js";
import { createNotifyQueue, notify, sendNotification, vapidFromEnv } from "#lib/push-notify.js";
import { forgetSubscription, recipientsFor } from "#lib/push-recipients.js";
import { createTurnNotifier } from "#lib/turn-notifier.js";

const enabled = () => vapidFromEnv() !== null;

/** Who the turn ran for, and in which workspace — resolved exactly as the agent's tools resolve it. */
async function ownerOf(ctx: SessionCtxLike): Promise<{ orgId: string; email: string } | null> {
  const { email } = callerFromCtx(ctx);
  if (!email) return null;
  try {
    return { orgId: await orgForSession(ctx), email };
  } catch {
    return null;
  }
}

const sends = createNotifyQueue();
const turns = createTurnNotifier({
  async emit(ev, ctx) {
    if (!enabled()) return;
    sends.run(async () => {
      const owner = await ownerOf(ctx as SessionCtxLike);
      await notify(
        { vapid: vapidFromEnv, recipients: recipientsFor, send: sendNotification, forget: forgetSubscription },
        ev,
        owner,
      );
    });
  },
});

export default defineHook({
  events: {
    "turn.started"(event, ctx) {
      if (enabled()) turns.turnStarted(ctx.session.id, event.data.turnId);
    },
    "message.completed"(event, ctx) {
      if (enabled()) turns.messageCompleted(ctx.session.id, event.data as { turnId?: string; message?: unknown; finishReason?: unknown });
    },
    async "input.requested"(event, ctx) {
      if (enabled()) await turns.inputRequested(ctx.session.id, event.data as never, ctx);
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
