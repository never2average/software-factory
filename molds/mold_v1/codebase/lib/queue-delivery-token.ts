/**
 * The queue-delivery token's fixed names, shared by the web app that signs it (lib/auth-session.ts
 * `mintQueueDeliveryToken`) and the agent's channel that accepts it (agent/lib/queue-delivery-auth.ts). Pure.
 *
 * It is not a sign-in: its own audience and `kind` keep every web-app route (`verifySessionToken`, audience
 * `delivered-app`) from accepting it, and the channel admits it only on the routes of the one eve session it names.
 */
import { SESSION_BOUND_TOKEN_AUDIENCE, SESSION_BOUND_TOKEN_KIND } from "./session-token-kinds.ts";

/** One source: #66's lib/session-token-kinds.ts, which the agent's session guard reads too. */
export const QUEUE_DELIVERY_AUDIENCE = SESSION_BOUND_TOKEN_AUDIENCE;
export const QUEUE_DELIVERY_KIND = SESSION_BOUND_TOKEN_KIND;
/** One delivery and its check. */
export const QUEUE_DELIVERY_TTL_SECONDS = 120;

/**
 * What a delivery token may do:
 *   read  — `GET /eve/v1/session/:sid/stream` only (the drain reads the session's tail);
 *   post  — ONE `POST /eve/v1/session/:sid` whose body is exactly the claimed queued item: `message` equal to the
 *           item's text plus its delivery reference, no `inputResponses`, nothing else. Single-use: the claim's
 *           `token_seq` must be below the token's `seq`, and admitting it raises it (agent/lib/queue-delivery-auth.ts).
 */
export type DeliveryScope =
  | { readonly act: "read"; readonly queue?: DeliveryQueue }
  | {
      readonly act: "post";
      readonly item: string;
      readonly claim: string;
      readonly seq: number;
      /** Which queue the item is in: a person's own chat (`chat_queue_items`, the default) or a shared chat's. */
      readonly queue?: DeliveryQueue;
      /** For a shared chat's item: its thread. The agent admits the author only as a participant of THAT thread. */
      readonly thread?: string;
    };

/**
 * A SHARED CHAT'S queued message (`chat_thread_queue`, mold_v1-290) is sent AS ITS AUTHOR — the owner or a participant
 * of the thread — never as whoever's page ran the queue. Its token names that queue in this claim; the agent then
 * checks the item there, and admits the author as a participant of the thread as well as its owner (lib/chat-gate.ts).
 */
export type DeliveryQueue = "chat" | "thread";
export const DELIVERY_QUEUE_CLAIM = "q";
/** The thread a shared chat's queued item is in (its token's own thread). */
export const DELIVERY_THREAD_CLAIM = "thread";

/** The text a shared chat's queued message is sent as: its sender named, so the agent knows who is speaking. */
export const THREAD_FROM_OPEN = "[from: ";
export const THREAD_FROM_CLOSE = "]\n\n";
export function threadMessageText(author: string, text: string): string {
  return `${THREAD_FROM_OPEN}${author}${THREAD_FROM_CLOSE}${text}`;
}

/** Keys a queued message's POST body may carry — no `inputResponses` (an answer to a question), nothing else. */
export const POST_BODY_KEYS: ReadonlySet<string> = new Set(["message", "continuationToken", "outputSchema"]);

/**
 * THE DELIVERY REFERENCE appended to a queued message as it is sent: unique to the claim, so the stream's
 * `message.received` for THIS delivery can be told from the same words sent any other way (lib/chat-queue-drain.ts
 * `receiptAfter`). A directive block, so no reader ever sees it (lib/chat-attachments.ts strips every complete
 * directive pair from what is displayed); the model reads that the message was queued and sent automatically.
 */
export function deliveryReference(claimId: string): string {
  return `\n\n⁦directives⁩ (This message was queued earlier and sent automatically when you finished; ref ${claimId}.) ⁦/directives⁩`;
}

/** Was `message` (a session's `message.received`) sent under one of these claims? */
export function sentUnderClaim(message: string, claims: readonly string[]): boolean {
  return claims.some((c) => message.includes(deliveryReference(c)));
}

/** The eve session a request's route is about: `/eve/v1/session/:id` or `/eve/v1/session/:id/stream`; else null. */
export function sessionIdOfRoute(pathname: string): string | null {
  const m = /^\/eve\/v1\/session\/([^/]+)(\/stream)?\/?$/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}
