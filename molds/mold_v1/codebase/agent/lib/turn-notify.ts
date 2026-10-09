/**
 * The ONE turn notifier of this agent process, and what it sends through.
 *
 * Two callers feed it: the authored hook (agent/hooks/notifications.ts — every event of the root's own turn steps)
 * and the HTTP channel's event handlers (agent/channels/eve.ts — the one event no hook ever receives: a delegated
 * specialist's question or approval, proxied onto the root's stream). They must share one instance or a request both
 * of them see would notify twice; agent/lib/turn-notifier.ts has the rule.
 *
 * Off unless the three VAPID variables are set: with none, no database is touched. Never throws, and the sending is
 * off the turn's critical path (a small bounded queue, not awaited).
 */
import { callerFromCtx, orgForSession, type SessionCtxLike } from "./org-context.ts";
import { createNotifyQueue, notify, sendNotification, vapidFromEnv } from "./push-notify.ts";
import { forgetSubscription, recipientsFor } from "./push-recipients.ts";
import { createTurnNotifier } from "./turn-notifier.ts";

export const notificationsEnabled = () => vapidFromEnv() !== null;

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

export const turnNotifier = createTurnNotifier({
  async emit(ev, ctx) {
    if (!notificationsEnabled()) return;
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

/**
 * A question or an approval is waiting for the person — theirs to answer whether the root asked or a specialist did.
 * Safe to call from both the hook and the channel for the same event. Never throws.
 */
export async function notifyInputRequested(sessionId: string, data: unknown, ctx: unknown): Promise<void> {
  if (!notificationsEnabled()) return;
  try {
    await turnNotifier.inputRequested(sessionId, data as never, ctx);
  } catch {
    /* a notification is never worth a turn */
  }
}
