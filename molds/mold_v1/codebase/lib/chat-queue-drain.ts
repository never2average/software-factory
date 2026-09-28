/**
 * SENDING A QUEUED MESSAGE — when, as whom, and exactly once.
 *
 * eve keeps no queue of its own ("keep your own per-session queue in the channel or app layer, then deliver the next
 * message after the session parks again" — eve docs, execution model). This is that delivery. It runs on the web
 * server for three callers, all of which only ever ask "is there something to send now?":
 *
 *   - the agent's hook (agent/hooks/chat-queue.ts), the moment a session reaches `session.waiting` — with no tab open;
 *   - a tab of the owner, when it sees the chat come to rest (so a hook that could not reach this server changes
 *     nothing while a tab is open);
 *   - the cron sweep (/api/cron/deliver-queued), once a minute, for anything both of the above missed.
 *
 * WHEN. Only at REST, judged from eve's own stream tail, never from the caller: the last event is `session.waiting`,
 * the turn did not park on a question or approval (or the owner stopped the one it parked on), and the previous item
 * has been answered — the tail is a DIFFERENT `session.waiting` from the one that item was delivered against. So the
 * nudge carries no authority: a caller can make a due delivery happen sooner, never one that is not due.
 *
 * AS WHOM. As the CHAT'S OWNER, who is the only person who can have queued into it (`sessionOwner`, enforced at
 * enqueue): the drain serves that owner, claims only their items, and sends each as the CLAIMED ROW's owner — never
 * as whoever happens to be asking. The agent's tools read the caller's identity on every turn, so a service
 * identity would run the turn as nobody. A tab of the owner passes its own sign-in (a tab of anyone else is
 * refused); with no tab, the server signs a queue-delivery token (lib/auth-session.ts `mintQueueDeliveryToken`):
 * two minutes, bound to this one eve session, accepted only by the agent's session routes and never by the web
 * app. And only while the owner can still act in the workspace (`canActIn`): a removed member's queue is not sent.
 * A deployment without AUTH_JWT_PRIVATE_KEY cannot sign: its queue is then sent by the owner's open tab only.
 *
 * EXACTLY ONCE. `claimNextQueued` (lib/chat-queue-server.ts) is the only way out of `queued`. A POST eve refused
 * puts the item back. A POST whose answer was lost (a 5xx, a dropped socket) is checked against the tail before
 * anything else happens, by THIS item's own receipt (a `message.received` carrying its text after the rest it was
 * sent against — another sender's turn moving the session proves nothing): received → sent; the session still
 * resting where it was → back in line; anything else → the claim is kept, and a claim nothing can settle ends after
 * `CLAIM_HARD_TIMEOUT_MS` (database clock) as "Didn't send — Send again". It is never simply retried.
 *
 * Pure over injected dependencies, so scripts/test-chat-queue-db.mjs drives it against a real Postgres and a fake eve.
 */
import { deliveryReference, type DeliveryScope } from "./queue-delivery-token.ts";
import {
  CLAIM_HARD_TIMEOUT_MS,
  SENDING_STALE_MS,
  canActIn,
  claimNextQueued,
  failClaim,
  markSent,
  releaseClaim,
  sessionOwner,
  sessionQueueState,
  type QueueRow,
  type RunIn,
} from "./chat-queue-server.ts";

/** One event of eve's NDJSON stream, as much of it as this needs. */
export interface TailEvent {
  readonly type?: string;
  readonly data?: {
    readonly continuationToken?: string;
    readonly requests?: ReadonlyArray<{ readonly requestId?: string }>;
    readonly [k: string]: unknown;
  };
  readonly meta?: { readonly at?: string };
}

export interface RestVerdict {
  /** Nothing is running and nothing is waiting on the person. */
  readonly rest: boolean;
  readonly reason: "rest" | "busy" | "parked" | "ended" | "unknown";
  /** The continuation token of the `session.waiting` the session rests on. */
  readonly token?: string;
  /** Identity of that `session.waiting` (eve's timestamp + token): a new turn and a new rest make a new mark. */
  readonly mark?: string;
  /** The requests it parked on, when parked. */
  readonly parkedOn?: readonly string[];
}

const TURN_END = new Set(["turn.completed", "turn.failed", "turn.cancelled"]);

/**
 * Is the session at rest? From the last few events of its stream (a tail read, `startIndex=-N`).
 *
 * A turn that PARKS emits `input.requested`, then `turn.completed`, then `session.waiting` (recorded:
 * scripts/fixtures/approval-park). Walking back from the waiting over the turn's end, an `input.requested` before
 * any other event means the session is waiting for the PERSON, and a queued message must not be sent into it (it
 * would answer or clear their question). Unless the person STOPPED that question: eve drops a parked delegation on
 * cancel and emits nothing, so the only record is the chat's own Stop marker (`stopped`).
 */
export function sessionRest(tail: readonly TailEvent[] | null | undefined, stopped: ReadonlySet<string> = new Set()): RestVerdict {
  if (!tail || tail.length === 0) return { rest: false, reason: "unknown" };
  const last = tail[tail.length - 1];
  if (last?.type === "session.completed" || last?.type === "session.failed") return { rest: false, reason: "ended" };
  if (last?.type !== "session.waiting") return { rest: false, reason: "busy" };
  const token = typeof last.data?.continuationToken === "string" ? last.data.continuationToken : undefined;
  if (!token) return { rest: false, reason: "unknown" };
  const mark = `${last.meta?.at ?? ""}|${token}`;
  const parkedOn: string[] = [];
  for (let i = tail.length - 2; i >= 0; i--) {
    const e = tail[i];
    if (TURN_END.has(e?.type ?? "")) continue;
    if (e?.type === "input.requested") {
      for (const r of e.data?.requests ?? []) if (typeof r?.requestId === "string") parkedOn.push(r.requestId);
      if (parkedOn.length === 0) parkedOn.push("?");
      continue;
    }
    break;
  }
  if (parkedOn.length > 0 && !parkedOn.every((id) => stopped.has(id))) {
    return { rest: false, reason: "parked", token, mark, parkedOn };
  }
  return { rest: true, reason: "rest", token, mark };
}

export interface DrainDeps {
  readonly runIn: RunIn;
  /** The last `count` events of the session's stream, read as `bearer`; null when it could not be read. */
  readTail(sessionId: string, bearer: string, count?: number): Promise<TailEvent[] | null>;
  /** POST a follow-up into the session as `bearer`. `status` 0 = no answer (network). */
  post(sessionId: string, bearer: string, body: Record<string, unknown>): Promise<{ readonly status: number; readonly text?: string }>;
  /**
   * A queue-delivery token for `email` in `orgId`, for `sessionId` only and one `scope` (read its stream, or post
   * ONE claimed item); null when this server cannot sign.
   */
  mint(email: string, orgId: string, sessionId: string, scope: DeliveryScope): Promise<string | null>;
  /** Request ids of the questions the owner STOPPED in this chat (its `client.turn.stopped` markers). */
  stoppedRequests(orgId: string, email: string, sessionId: string): Promise<ReadonlySet<string>>;
  /** The completion-gate schema a Goal / Loop turn is sent with. */
  readonly goalSchema?: object;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newClaimId?: () => string;
}

/** How long an item that eve accepted may go unanswered before the next one is sent anyway (#59's escape). */
export const SETTLE_MAX_MS = 15 * 60_000;

/** Enough of the stream to find an item's own receipt after the rest it was sent against. */
export const SETTLE_TAIL_EVENTS = 200;

export type DrainResult =
  | { readonly delivered: QueueRow; readonly reason: "sent" | "received" }
  | {
      readonly delivered?: undefined;
      readonly reason:
        | "empty"
        | "shared"
        | "not-member"
        | "failed"
        | "not-owner"
        | "no-credential"
        | "busy"
        | "parked"
        | "ended"
        | "unknown"
        | "delivering"
        | "claimed-elsewhere"
        | "refused"
        | "not-received";
      readonly detail?: string;
    };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const PARK_RETRIES = 5;
/** eve's answer when the session has not parked on its token yet: nothing was taken. */
export function parkNotVisible(res: { readonly status: number; readonly text?: string }): boolean {
  return (res.status === 404 || res.status >= 500) && /target session was not found|session .*not found/i.test(res.text ?? "");
}

const normalize = (t: string) => t.replace(/\s+/g, " ").trim();
const markOf = (e: TailEvent | undefined): string | null =>
  e?.type === "session.waiting" && typeof e.data?.continuationToken === "string"
    ? `${e.meta?.at ?? ""}|${e.data.continuationToken}`
    : null;
function receivedText(e: TailEvent): string[] {
  const d = e.data as { message?: unknown; parts?: ReadonlyArray<{ type?: string; text?: string }> } | undefined;
  const out: string[] = [];
  if (typeof d?.message === "string") out.push(normalize(d.message));
  const joined = (d?.parts ?? []).filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
  if (joined) out.push(normalize(joined));
  return out;
}

/**
 * DID THIS DELIVERY ARRIVE? Only its own receipt counts: a `message.received` carrying THIS claim's delivery
 * reference (lib/queue-delivery-token.ts — unique per claim, so the same words sent any other way prove nothing),
 * after the `session.waiting` it was sent against (`restMark`). "received"; "not-received" only when the session
 * still rests on that very waiting (nothing at all happened); anything else — another turn ran, the mark scrolled
 * out of the window, the tail could not be read — is "unknown", and nothing is resent on an unknown.
 */
export function receiptAfter(
  tail: readonly TailEvent[] | null | undefined,
  restMark: string | null,
  claimId: string | null,
): "received" | "not-received" | "unknown" {
  if (!tail || tail.length === 0 || !restMark || !claimId) return "unknown";
  let at = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (markOf(tail[i]) === restMark) {
      at = i;
      break;
    }
  }
  if (at < 0) return "unknown";
  const ref = normalize(deliveryReference(claimId));
  for (let i = at + 1; i < tail.length; i++) {
    if (tail[i]?.type === "message.received" && receivedText(tail[i]).some((t) => t.includes(ref))) return "received";
  }
  return at === tail.length - 1 ? "not-received" : "unknown";
}

/** Settle a claim whose sender is gone, from the item's own receipt. */
async function settleStale(
  deps: DrainDeps,
  input: { readonly orgId: string; readonly sessionId: string; readonly by: "server" | "tab" },
  s: QueueRow,
  bearer: string,
): Promise<DrainResult> {
  const receipt = receiptAfter(await deps.readTail(input.sessionId, bearer, SETTLE_TAIL_EVENTS), s.restMark, s.claimId);
  if (receipt === "received") {
    await markSent(deps.runIn, { orgId: input.orgId, id: s.id, claimId: s.claimId ?? "", by: input.by, sentMessage: s.message + deliveryReference(s.claimId ?? "") });
    return { delivered: { ...s, message: s.message + deliveryReference(s.claimId ?? "") }, reason: "received" };
  }
  if (receipt === "not-received") {
    await releaseClaim(deps.runIn, { orgId: input.orgId, id: s.id, claimId: s.claimId ?? "", error: "not received" });
    return { reason: "not-received" };
  }
  if ((s.claimAgeMs ?? 0) >= CLAIM_HARD_TIMEOUT_MS) {
    await failClaim(deps.runIn, { orgId: input.orgId, id: s.id, claimId: s.claimId ?? "", note: "Didn't send — it could not be confirmed." });
    return { reason: "failed" };
  }
  return { reason: "unknown" };
}

/**
 * Send the session's next queued item if — and only if — it is due. At most ONE item per call: the next waits for
 * the rest that follows this one's reply (the hook fires again then).
 */
export async function drainSession(
  deps: DrainDeps,
  input: {
    readonly orgId: string;
    readonly sessionId: string;
    readonly by: "server" | "tab";
    /** A tab of the owner: its own sign-in. Refused when it is not the owner's. */
    readonly caller?: { readonly email: string; readonly bearer: string };
  },
): Promise<DrainResult> {
  const chat = await sessionOwner(deps.runIn, { orgId: input.orgId, sessionId: input.sessionId });
  if (chat.shared) return { reason: "shared" };
  const owner = chat.owner;
  if (!owner) return { reason: "empty" };
  // A tab only ever drains its own person's queue.
  if (input.caller && input.caller.email.toLowerCase() !== owner) return { reason: "not-owner" };
  const state = await sessionQueueState(deps.runIn, { orgId: input.orgId, sessionId: input.sessionId, owner });
  if (state.queued === 0 && !state.sending) return { reason: "empty" };
  // Nothing goes out as someone who can no longer act here. A claim left in flight for them (its sender died)
  // is ended as failed first, so the session's one-in-flight slot is not held for ever.
  if (!(await canActIn(deps.runIn, { orgId: input.orgId, email: owner }))) {
    const s = state.sending;
    if (s && (s.claimAgeMs ?? 0) >= SENDING_STALE_MS) {
      await failClaim(deps.runIn, { orgId: input.orgId, id: s.id, claimId: s.claimId ?? "", note: "Not sent — no longer a member of this workspace." });
    }
    return { reason: "not-member" };
  }
  const bearer = input.caller?.bearer ?? (await deps.mint(owner, input.orgId, input.sessionId, { act: "read" }));
  if (!bearer) return { reason: "no-credential" };

  // A claim a dead sender left behind: settled from ITS OWN receipt, never by sending again.
  if (state.sending) {
    if ((state.sending.claimAgeMs ?? 0) < SENDING_STALE_MS) return { reason: "delivering" };
    return settleStale(deps, input, state.sending, bearer);
  }

  const tail = await deps.readTail(input.sessionId, bearer);
  const stopped = await deps.stoppedRequests(input.orgId, owner, input.sessionId).catch(() => new Set<string>());
  const verdict = sessionRest(tail, stopped);
  if (!verdict.rest) return { reason: verdict.reason === "rest" ? "busy" : verdict.reason };
  // The previous item's reply has not come to rest yet: this is still the waiting it was sent against.
  const last = state.lastSent;
  // (After SETTLE_MAX_MS — database clock — a reply that never started is not waited on for ever: #59's escape.)
  if (last && last.restMark && last.restMark === verdict.mark && (last.sentAgeMs ?? 0) < SETTLE_MAX_MS) {
    return { reason: "delivering" };
  }

  const claimId = deps.newClaimId?.() ?? `${input.by}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const item = await claimNextQueued(deps.runIn, {
    orgId: input.orgId,
    sessionId: input.sessionId,
    owner,
    claimId,
    restMark: verdict.mark ?? "",
  });
  if (!item) return { reason: "claimed-elsewhere" };
  // Sent as the CLAIMED ROW's owner and nobody else: their tab's own sign-in, or — for each attempt — a single-use
  // post token signed for them, bound to this item, this claim and this exact body.
  const rowOwner = item.ownerEmail.toLowerCase();
  if (input.caller && input.caller.email.toLowerCase() !== rowOwner) {
    await releaseClaim(deps.runIn, { orgId: input.orgId, id: item.id, claimId, error: null });
    return { reason: "not-owner" };
  }
  const posted = item.message + deliveryReference(claimId);
  const bearerFor = async (seq: number): Promise<string | null> =>
    input.caller
      ? input.caller.bearer
      : deps.mint(rowOwner, input.orgId, input.sessionId, { act: "post", item: item.id, claim: claimId, seq });

  const body: Record<string, unknown> = { continuationToken: verdict.token, message: posted };
  if (item.goal && deps.goalSchema) body.outputSchema = deps.goalSchema;
  const sleep = deps.sleep ?? defaultSleep;
  let res: { readonly status: number; readonly text?: string } = { status: 0 };
  for (let attempt = 0; ; attempt++) {
    const sendBearer = await bearerFor(attempt + 1);
    if (!sendBearer) {
      await releaseClaim(deps.runIn, { orgId: input.orgId, id: item.id, claimId, error: null });
      return { reason: "no-credential" };
    }
    res = await deps.post(input.sessionId, sendBearer, body).catch(() => ({ status: 0 }));
    // The hook fires the instant `session.waiting` is durable, which can be a moment before eve has parked the
    // session on its token: eve then answers "target session was not found" and has taken NOTHING, so trying
    // again (with a fresh single-use token) is safe — the same case #59 retries for an answer.
    if (!parkNotVisible(res) || attempt >= PARK_RETRIES) break;
    await sleep(500 * 2 ** attempt);
  }
  if (res.status >= 200 && res.status < 300) {
    await markSent(deps.runIn, { orgId: input.orgId, id: item.id, claimId, by: input.by, sentMessage: posted });
    return { delivered: { ...item, state: "sent", message: posted }, reason: "sent" };
  }
  if (res.status >= 400 && res.status < 500) {
    // Refused (a stale token, a gate): not delivered. Back in line; the next rest tries again.
    await releaseClaim(deps.runIn, { orgId: input.orgId, id: item.id, claimId, error: `refused (${res.status})` });
    return { reason: "refused", detail: String(res.status) };
  }
  if (parkNotVisible(res)) {
    await releaseClaim(deps.runIn, { orgId: input.orgId, id: item.id, claimId, error: "the session was not ready" });
    return { reason: "not-received", detail: "park not visible" };
  }
  // No answer, or a 5xx: eve may have taken it. Look for THIS delivery's receipt before doing anything else.
  for (let i = 0; i < 3; i++) {
    await sleep(1_000 * (i + 1));
    const receipt = receiptAfter(await deps.readTail(input.sessionId, bearer, SETTLE_TAIL_EVENTS), verdict.mark ?? null, claimId);
    if (receipt === "received") {
      await markSent(deps.runIn, { orgId: input.orgId, id: item.id, claimId, by: input.by, sentMessage: posted });
      return { delivered: { ...item, state: "sent", message: posted }, reason: "received" };
    }
    if (receipt === "not-received") {
      await releaseClaim(deps.runIn, { orgId: input.orgId, id: item.id, claimId, error: `no answer (${res.status})` });
      return { reason: "not-received" };
    }
  }
  // Still cannot tell: the claim stays; the sweep settles it from its receipt, or ends it as "Didn't send".
  return { reason: "unknown", detail: "ambiguous" };
}

/** Request ids a chat's Stop markers retired (`client.turn.stopped`), from `chat_sessions.client_markers`. */
export function stoppedRequestIds(markers: readonly unknown[] | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const m of markers ?? []) {
    const e = m as { type?: string; data?: { requestIds?: unknown } };
    if (e?.type !== "client.turn.stopped") continue;
    for (const id of Array.isArray(e.data?.requestIds) ? e.data.requestIds : []) if (typeof id === "string") out.add(id);
  }
  return out;
}
