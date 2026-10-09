/**
 * DESKTOP NOTIFICATIONS for chat turns — what is said, to whom, and how it is sent.
 *
 * agent/hooks/notifications.ts calls this on three moments of a ROOT turn (root hooks never fire for a specialist's
 * own turns, so a delegation notifies once, when the reply it feeds comes back):
 *
 *   reply   — the turn completed with an answer: the chat title, and the first ~120 characters of the answer;
 *   input   — the turn parked on the person: "Needs your approval: <tool>" or "Needs your answer: <question>";
 *   failed  — the turn failed.
 *
 * TO WHOM. The person the turn ran for, and — on a shared thread — its participants who turned notifications on
 * (a subscription row IS that choice). Only for a session that is a CHAT (a row in the owner's chat list, or a
 * shared thread): a workflow step's session belongs to a run, not a conversation, and never pings anyone.
 *
 * WHAT. Only the chat title and a short preview, never a tool's input or anything read from the data room. A device
 * whose person turned "Show message preview in notifications" off gets the title alone. Pushes are encrypted end to
 * end (RFC 8291), but the smallest payload is still the safest one.
 *
 * DEDUPLICATED. Every notification of one event carries one `tag` (session:turn:kind). The service worker
 * (public/sw.js) and the page's own notifier (for a hidden tab) show it under that tag, so a push and an open tab
 * never alert twice, and the push service collapses re-sends by `Topic`.
 *
 * Never throws: eve escalates a thrown hook to `turn.failed`.
 */
import {
  notificationFor,
  type NotificationPayload,
  type NotifyEvent,
} from "./notification-text.ts";
import { sendWebPush, topicFor, vapidFromEnv, type PushTarget, type SendResult, type VapidKeys } from "./web-push.ts";

export { notificationFor, notificationTag, plainToolName, previewLine, PREVIEW_CHARS } from "./notification-text.ts";
export type { NotificationPayload, NotifyEvent, NotifyKind } from "./notification-text.ts";

export interface Recipient extends PushTarget {
  readonly id: string;
  readonly orgId: string;
  readonly email: string;
  readonly preview: boolean;
  /** The chat's title as THIS person's list shows it (their own chat, or the shared thread). */
  readonly title: string | null;
}

export interface NotifyDeps {
  vapid(): VapidKeys | null;
  /** Everyone to notify about this session, one row per device, with their title for it. */
  recipients(sessionId: string, owner: { readonly orgId: string; readonly email: string }): Promise<Recipient[]>;
  send(target: Recipient, payload: NotificationPayload, vapid: VapidKeys): Promise<SendResult>;
  /** The push service said the browser dropped this subscription (404/410). */
  forget(target: Recipient): Promise<void>;
}

/** Notify every device that should hear about `ev`. Returns how many were sent (for tests and logs). Never throws. */
export async function notify(
  deps: NotifyDeps,
  ev: NotifyEvent,
  owner: { readonly orgId: string; readonly email: string } | null,
): Promise<{ sent: number; removed: number }> {
  const out = { sent: 0, removed: 0 };
  try {
    const vapid = deps.vapid();
    if (!vapid || !owner?.email || !owner.orgId) return out;
    const targets = await deps.recipients(ev.sessionId, owner);
    await Promise.all(
      targets.map(async (t) => {
        const res = await deps.send(t, notificationFor(ev, t.title, t.preview, owner.orgId), vapid);
        if (res.gone) {
          out.removed += 1;
          await deps.forget(t).catch(() => undefined);
        } else if (res.status >= 200 && res.status < 300) out.sent += 1;
      }),
    );
  } catch (error) {
    console.error("[notifications] could not notify:", error instanceof Error ? error.message : error);
  }
  return out;
}

/** The production sender. */
export function sendNotification(target: Recipient, payload: NotificationPayload, vapid: VapidKeys): Promise<SendResult> {
  return sendWebPush(target, payload, vapid, {
    topic: topicFor(payload.tag),
    urgency: payload.kind === "input" ? "high" : "normal",
    ttlSeconds: 24 * 60 * 60,
  });
}

export { vapidFromEnv };

/**
 * KEEPING THE FUNCTION ALIVE FOR A PUSH. A hook does not await its sends (below), and on serverless a function that
 * returns can be frozen with a push still in flight — the last notification of a turn would be the one dropped.
 * Vercel exposes `waitUntil` on the request context it installs (`Symbol.for("@vercel/request-context")` — exactly
 * what `@vercel/functions`' `waitUntil` reads; read here directly rather than adding that package to both bundles).
 * Each send is registered there, bounded so no promise outlives `maxMs`. Off Vercel there is no such context and
 * nothing to do: a long-lived process keeps running.
 */
export function platformWaitUntil(promise: Promise<unknown>, maxMs: number): boolean {
  const ctx = (globalThis as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined } | undefined>)[
    Symbol.for("@vercel/request-context")
  ]?.get?.();
  if (typeof ctx?.waitUntil !== "function") return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxMs);
    }),
  ]).finally(() => clearTimeout(timer));
  ctx.waitUntil(bounded);
  return true;
}

/**
 * OFF THE TURN'S CRITICAL PATH. A hook awaits nothing it does not have to: a push service that is slow (or an
 * endpoint that times out) must never hold up a turn's `turn.completed`. `run` starts the work and returns at once;
 * at most `maxConcurrent` sends run together, up to `maxPending` wait their turn, and anything beyond that is
 * dropped (a notification is a courtesy, never worth a backlog). Every accepted job is registered with the
 * platform's `waitUntil` (`keepAlive`), bounded by `keepAliveMs`, so a frozen function does not drop it.
 */
export function createNotifyQueue(
  maxConcurrent = 4,
  maxPending = 200,
  opts: { readonly keepAlive?: (p: Promise<unknown>, maxMs: number) => unknown; readonly keepAliveMs?: number } = {},
) {
  const keepAlive = opts.keepAlive ?? platformWaitUntil;
  const keepAliveMs = opts.keepAliveMs ?? 15_000;
  let active = 0;
  const waiting: Array<() => Promise<unknown>> = [];
  const pump = () => {
    while (active < maxConcurrent && waiting.length > 0) {
      const job = waiting.shift() as () => Promise<unknown>;
      active += 1;
      void job()
        .catch(() => undefined)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };
  return {
    run(job: () => Promise<unknown>): boolean {
      if (waiting.length >= maxPending) return false;
      let settle!: () => void;
      const done = new Promise<void>((resolve) => {
        settle = resolve;
      });
      waiting.push(() => job().finally(settle));
      keepAlive(done, keepAliveMs);
      pump();
      return true;
    },
    stats: () => ({ active, waiting: waiting.length }),
  };
}
