/**
 * The agent's door for a QUEUE-DELIVERY token (lib/auth-session.ts `mintQueueDeliveryToken`): what the web app
 * signs to send a person's queued chat message after their tab has closed (lib/chat-queue-drain.ts).
 *
 * Admitted only when ALL hold:
 *   - the ES256 signature verifies with AUTH_JWT_PUBLIC_KEY (only the web app holds the private half), the issuer is
 *     ours, the audience is the queue-delivery one and the `kind` says so — so an ordinary sign-in is never taken
 *     for one, nor one for a sign-in;
 *   - the route is THAT session's own (`sid`), and the method is what the token's `act` allows:
 *       read → `GET /eve/v1/session/:sid/stream` only;
 *       post → `POST /eve/v1/session/:sid` only — never `/stream`, `/cancel`, a new session or `/info`;
 *   - for post, the BODY is the claimed queued item and nothing else: only `message` / `continuationToken` /
 *     `outputSchema` (no `inputResponses` — it cannot answer a question), and `message` exactly equal to the item's
 *     text plus its claim's delivery reference;
 *   - for post, the claim is live (`state = 'sending'`, this `claim_id`, owner, workspace and session) and the
 *     token's `seq` has not been passed (`token_seq <= seq`).
 *
 * SINGLE USE is spent ONCE PER REQUEST by the session guard (agent/lib/session-guard.ts → `consumePost`), not here:
 * eve's own handler runs this auth list again after the guard, so a door that consumed would refuse its own
 * request's second pass. The guard runs first on every per-session route; its one atomic UPDATE (`token_seq < seq`,
 * raised to `seq`) refuses a replay or a second request racing the first.
 *
 * It carries the person's `email` and the workspace (`org`), exactly the attributes an email-session sign-in
 * carries, so the turn runs as them, in that workspace (membership still checked by agent/lib/org-context.ts).
 * Everything else falls through to the next door, which does not accept it either. No database: nothing admitted.
 */
import { sql } from "drizzle-orm";
import { jwtEcdsa } from "eve/channels/auth";
import {
  POST_BODY_KEYS,
  QUEUE_DELIVERY_AUDIENCE,
  QUEUE_DELIVERY_KIND,
  deliveryReference,
  sessionIdOfRoute,
} from "../../lib/queue-delivery-token.ts";
import { getDb, withOrgDb } from "./db/index.ts";

type AuthResult = Awaited<ReturnType<ReturnType<typeof jwtEcdsa>>>;
type AuthFn = (request: Request) => Promise<AuthResult>;

export interface PostClaim {
  readonly org: string;
  readonly sid: string;
  readonly email: string;
  readonly item: string;
  readonly claim: string;
  readonly seq: number;
  readonly message: string;
}

/** Is this post token's claim live, and its `seq` not yet passed? Read-only (see the note above). */
export type CheckPost = (c: PostClaim) => Promise<boolean>;

const rowsOf = (r: unknown): unknown[] => (Array.isArray(r) ? r : ((r as { rows?: unknown[] } | null)?.rows ?? []));

export const checkPostInDb: CheckPost = async (c) => {
  if (!getDb()) return false;
  try {
    return (
      rowsOf(
        await withOrgDb(c.org, (tx) =>
          tx.execute(sql`
            select id from chat_queue_items
            where id = ${c.item} and org_id = ${c.org} and eve_session_id = ${c.sid} and lower(owner_email) = ${c.email}
              and state = 'sending' and claim_id = ${c.claim} and token_seq <= ${c.seq}
              and ${c.message} = message || ${deliveryReference(c.claim)}`),
        ),
      ).length === 1
    );
  } catch {
    return false;
  }
};

/**
 * SPEND a post token — once. The session guard calls this for a session-bound caller's message POST, after deciding
 * the caller may write and before eve sees the request: one atomic UPDATE that only a higher `seq` passes.
 */
export const consumePostInDb: CheckPost = async (c) => {
  if (!getDb()) return false;
  try {
    return (
      rowsOf(
        await withOrgDb(c.org, (tx) =>
          tx.execute(sql`
            update chat_queue_items set token_seq = ${c.seq}, updated_at = now()
            where id = ${c.item} and org_id = ${c.org} and eve_session_id = ${c.sid} and lower(owner_email) = ${c.email}
              and state = 'sending' and claim_id = ${c.claim} and token_seq < ${c.seq}
              and ${c.message} = message || ${deliveryReference(c.claim)}
            returning id`),
        ),
      ).length === 1
    );
  } catch {
    return false;
  }
};

/** The post claim a verified session-bound token and its request body make, or null when they make none. */
export function postClaimOf(claims: Record<string, unknown> | null, sessionId: string, body: unknown): PostClaim | null {
  if (!claims || claims.kind !== QUEUE_DELIVERY_KIND || claims.act !== "post" || claims.sid !== sessionId) return null;
  const { email, org, item, claim, seq } = claims;
  if (typeof email !== "string" || typeof org !== "string" || typeof item !== "string" || typeof claim !== "string") return null;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !POST_BODY_KEYS.has(k))) return null;
  if (typeof b.message !== "string") return null;
  return { org, sid: sessionId, email: email.toLowerCase(), item, claim, seq, message: b.message };
}

/** The claims of the request's bearer token — read only AFTER it has been verified by a door. */
export function claimsOf(request: Request): Record<string, unknown> | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();
  const payload = bearer?.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function queueDeliveryAuth(publicKey: string, check: CheckPost = checkPostInDb): AuthFn {
  const verify = jwtEcdsa({
    algorithm: "ES256",
    publicKey,
    issuer: "delivered",
    audiences: [QUEUE_DELIVERY_AUDIENCE],
    claims: { kind: [QUEUE_DELIVERY_KIND] },
    clockSkewSeconds: 5,
  });
  return async (request) => {
    let path = "";
    try {
      path = new URL(request.url).pathname.replace(/\/$/, "");
    } catch {
      return null;
    }
    const route = sessionIdOfRoute(path);
    if (!route) return null;
    const isStream = path.endsWith("/stream");
    const method = request.method.toUpperCase();
    const auth = await verify(request);
    if (!auth) return null;
    // Verified above; only now are its claims read — for the checks this door exists to make.
    const claims = claimsOf(request);
    if (!claims || claims.kind !== QUEUE_DELIVERY_KIND || claims.sid !== route) return null;
    if (claims.act === "read") return method === "GET" && isStream ? auth : null;
    if (claims.act !== "post" || method !== "POST" || isStream) return null;
    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      return null;
    }
    const post = postClaimOf(claims, route, body);
    return post && (await check(post)) ? auth : null;
  };
}
