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
  | { readonly act: "read" }
  | { readonly act: "post"; readonly item: string; readonly claim: string; readonly seq: number };

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
