/**
 * A SPECIALIST THAT IS STOPPED HANDS BACK — it never leaves the main thread waiting in silence.
 *
 * WHAT WAS MEASURED (eve 0.25.1, a live self-hosted deployment, 2026-10-05). The main agent delegated to one
 * specialist and the specialist's own session was cancelled (the Control Panel's Stop on a specialist does exactly
 * this: `POST /eve/v1/session/<child>/cancel`). The child wrote `turn.cancelled → session.waiting` and stopped. The
 * parent wrote NOTHING, then or ever: its turn stayed open on `subagent.called`, the chat said a specialist was
 * working, and every message typed at it was accepted (`200 {"ok":true}`) and held behind a delegation that could
 * no longer end.
 *
 * WHY. A parent's turn waits for its whole batch of delegations (`waitForRuntimeActionResults`,
 * eve/dist/src/execution/turn-workflow.js): it continues when EVERY one has delivered a `runtime-action-result` to
 * the turn's inbox. A child delivers that from exactly two places — when it finishes and when it fails
 * (`notifyDelegatedParentStep`, execution/workflow-entry.js). A cancelled child does neither: it settles as a park
 * and waits for a next message, on a continuation token no channel can address (`subagent:<parent>:<callId>` —
 * the HTTP channel namespaces every token it sends as `eve:…`, channel/send.js; a message "to the child" starts a
 * new, unrelated session instead). eve's own rule is that cancellation belongs to the PARENT turn ("the cancelled
 * parent does not synthesize tool results", docs/subagents.mdx), so a child stopped on its own is a state eve has
 * no exit from.
 *
 * WHAT THIS DOES, with eve's public operations only (cancel a turn, send a message):
 *
 *   - Stopping a specialist ENDS THE TURN THAT IS WAITING FOR IT and tells the main agent, in one message
 *     (lib/handback-text.ts), what happened to every delegation of that turn: the stopped one returned nothing, and
 *     any that had already FINISHED hand over their result — eve was holding those until the whole batch came
 *     back, and ending the turn would otherwise discard them. The main agent's next turn starts on that message.
 *   - If another specialist of the same turn is STILL WORKING or waiting on the person, the lone stop is REFUSED
 *     (409, with the reason): ending the turn would kill that work, and not ending it is the silence above.
 *   - A specialist with no turn running (finished, or waiting on a question) is not touched.
 *
 * THE ORDER, AND WHY EACH STEP IS WHERE IT IS (`handBackStopped`):
 *
 *   1. eve stops the specialist. Not accepted → nothing was running; nothing more happens (except a hand-back an
 *      earlier request wrote down and could not deliver, which is tried again).
 *   2. CLAIM, in the database: one row per (parent session, stopped child, parent turn), inserted under the
 *      workspace's row-level scope. Two Stops — in two processes, on two serverless instances — both reach here;
 *      the unique key lets one through. The other answers as a plain cancel.
 *   3. Wait for the specialist to come to rest. If it FINISHED or FAILED after all (the stop raced its last step),
 *      eve is delivering that result itself: the claim is released and nothing is sent — never both.
 *   4. WRITE THE MESSAGE DOWN in the claimed row, held results included, BEFORE the waiting turn is touched. From
 *      here on a failure loses nothing: the text is on record and a later Stop delivers it.
 *   5. Look at the parent AGAIN. If it no longer waits on this specialist in the turn that called it (the person
 *      stopped the main thread, or started something new), stand down: that turn is theirs.
 *   6. End the waiting turn, BY ITS ID — a turn the person started in the meantime is never the one cancelled — and
 *      require eve to accept that.
 *   7. Wait until the main thread is at rest, then send. A main thread that never comes to rest is not sent to.
 *   8. CONFIRM on the main thread's own stream that the message arrived. Only then is the outcome "told".
 *
 * Every outcome is reported as what happened (`HandbackOutcome`); the Control Panel shows it.
 *
 * Pure over an injected world (no eve import, no database): scripts/test-specialist-handback.mjs drives it with the
 * streams recorded from the real runtime, and the session guard (agent/lib/session-guard.ts) supplies the real one.
 */
import { buildHandbackMessage, handbackNonce, isHandbackMessage, type HandbackEntry } from "../../lib/handback-text.ts";

export { HANDBACK_HEADING } from "../../lib/handback-text.ts";

export interface StreamEvent {
  type?: string;
  data?: Record<string, unknown> | null;
}

/** One delegation of the parent's current turn. */
export interface Delegation {
  readonly callId: string;
  readonly name: string;
  readonly childSessionId: string;
}

/** Where a delegated child stands, read off its own stream. */
export type ChildState =
  | { readonly kind: "finished"; readonly result: string }
  | { readonly kind: "stopped"; readonly lastWords: string }
  | { readonly kind: "failed"; readonly message: string }
  /** Waiting on the person: it asked a question or needs an approval. Live — the parent legitimately waits. */
  | { readonly kind: "asking" }
  /** Mid-turn. Live. */
  | { readonly kind: "live" };

const isLive = (state: ChildState): boolean => state.kind === "live" || state.kind === "asking";
const settledTypes = (events: readonly StreamEvent[]) => events.map((e) => e?.type).filter((t): t is string => Boolean(t) && !(t as string).endsWith(".appended"));
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** The parent's turn that is open now: the id of its latest `turn.started`. */
export function currentTurnId(parentEvents: readonly StreamEvent[]): string | null {
  for (let i = parentEvents.length - 1; i >= 0; i--) {
    if (parentEvents[i]?.type === "turn.started") return text(parentEvents[i]?.data?.turnId) || null;
  }
  return null;
}

/** The delegations the parent's CURRENT turn has out: called since the last `turn.started`, not yet handed back. */
export function outstandingDelegations(parentEvents: readonly StreamEvent[]): Delegation[] {
  const out = new Map<string, Delegation>();
  for (const e of parentEvents) {
    const data = e?.data ?? {};
    // A new turn starts only once the last one settled; a cancelled or failed turn waits for nothing. (`turn.completed`
    // is NOT here: with a specialist out it is eve parking on that specialist's question, and the wait goes on.)
    if (e?.type === "turn.started" || e?.type === "turn.cancelled" || e?.type === "turn.failed") out.clear();
    else if (e?.type === "subagent.called" && typeof data.callId === "string" && typeof data.childSessionId === "string") {
      out.set(data.callId, { callId: data.callId, name: typeof data.name === "string" && data.name ? data.name : "specialist", childSessionId: data.childSessionId });
    } else if (e?.type === "action.result") {
      const callId = (data.result as { callId?: unknown } | undefined)?.callId;
      if (typeof callId === "string") out.delete(callId);
    }
  }
  return [...out.values()];
}

/** The parent's current continuation token: the latest `session.waiting` that carries one. */
export function continuationTokenOf(events: readonly StreamEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const token = events[i]?.type === "session.waiting" ? events[i]?.data?.continuationToken : undefined;
    if (typeof token === "string" && token) return token;
  }
  return null;
}

/** Is the session at rest — its latest event (text deltas aside) the `session.waiting` boundary? */
export const atRest = (events: readonly StreamEvent[]): boolean => settledTypes(events).pop() === "session.waiting";

/** Where a child stands. `events` is its own stream from the start. */
export function childState(events: readonly StreamEvent[]): ChildState {
  let said = "";
  let answer = "";
  for (const e of events) {
    if (e?.type !== "message.completed") continue;
    const message = text(e.data?.message);
    if (!message) continue;
    said = message;
    if (e.data?.finishReason !== "tool-calls") answer = message;
  }
  const types = settledTypes(events);
  if (types.includes("session.completed")) return { kind: "finished", result: answer || said };
  if (types.includes("session.failed")) {
    const failed = events.find((e) => e?.type === "session.failed");
    return { kind: "failed", message: text(failed?.data?.message) || "the specialist's session failed" };
  }
  const last = types[types.length - 1];
  // At rest after a cancel: `turn.cancelled` then the boundary, with nothing since.
  if (last === "session.waiting" && types[types.length - 2] === "turn.cancelled") return { kind: "stopped", lastWords: said };
  // Its own request is the last thing it wrote: it is waiting on the person.
  if (last === "input.requested") return { kind: "asking" };
  return { kind: "live" };
}

/**
 * The durable record of one hand-back: who may send it, and its text once written. Implemented over
 * `specialist_handbacks` (agent/lib/handback-ledger.ts), inside the workspace's row-level scope.
 */
export interface HandbackLedger {
  /**
   * Claim the hand-back for (parent, child, turn). `won`: this request sends it. `held`: another request holds it
   * (or already delivered it). The claim is one INSERT against a unique key.
   */
  claim(key: HandbackKey): Promise<"won" | "held">;
  /** The text, written before the waiting turn is ended. */
  write(key: HandbackKey, message: string): Promise<void>;
  /** How it ended: `delivered`, or `undelivered` (the text stays, and `retry` may take it). */
  settle(key: HandbackKey, status: "delivered" | "undelivered"): Promise<void>;
  /** Give the claim up without a trace: nothing needed sending (the specialist finished after all). */
  release(key: HandbackKey): Promise<void>;
  /**
   * Take over, atomically, a hand-back of this child that is UNDELIVERED or whose claimer went quiet: its key and its
   * text (null when the claimer never got to write it), or null when nothing is owed.
   */
  retry(parentSessionId: string, childSessionId: string): Promise<{ key: HandbackKey; message: string | null } | null>;
}

export interface HandbackKey {
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly turnId: string;
}

/** What the handler needs from eve. The guard supplies it; the test supplies recorded streams. */
export interface HandbackWorld {
  /** A session's COMPLETE history as of now, or undefined when it cannot be read whole. */
  history(sessionId: string): Promise<readonly StreamEvent[] | undefined>;
  /** eve's cancel of one turn: "accepted" when that turn was running. */
  cancel(sessionId: string, turnId?: string): Promise<string>;
  /** Deliver a message on a continuation token. Resolves to the session that took it. */
  send(message: string, continuationToken: string): Promise<{ readonly id: string; cancel(): Promise<unknown> }>;
  sleep(ms: number): Promise<void>;
  readonly ledger: HandbackLedger;
  /** A fresh random value for one message's quote delimiters. */
  nonce(): string;
  now?(): number;
}

export type StopPlan =
  /** Not a delegation of its root's current turn: cancel it the way eve always has. */
  | { readonly kind: "plain" }
  /** Another specialist of the turn is still at work, or waiting on the person: refuse the lone stop. */
  | { readonly kind: "refuse"; readonly name: string; readonly working: readonly string[]; readonly asking: readonly string[] }
  /** Stop it, end the waiting turn, and tell the main agent. */
  | { readonly kind: "hand-back"; readonly stopped: Delegation; readonly turnId: string; readonly others: ReadonlyArray<{ delegation: Delegation; state: ChildState }> };

/** Decide what stopping `childSessionId` means, before anything is cancelled. */
export async function planStop(world: Pick<HandbackWorld, "history">, parentSessionId: string, childSessionId: string): Promise<StopPlan> {
  const parent = await world.history(parentSessionId);
  if (!parent) return { kind: "plain" };
  const out = outstandingDelegations(parent);
  const stopped = out.find((d) => d.childSessionId === childSessionId);
  const turnId = currentTurnId(parent);
  if (!stopped || !turnId) return { kind: "plain" };
  // A specialist that is already at rest for good (finished and held, already stopped, failed) has nothing to stop:
  // eve answers `no_active_turn`. One waiting on a question falls through: eve says the same of it, and step 1 of
  // the hand-back then ends there.
  const own = await world.history(childSessionId);
  if (own && !isLive(childState(own))) return { kind: "plain" };
  const others: Array<{ delegation: Delegation; state: ChildState }> = [];
  for (const delegation of out) {
    if (delegation === stopped) continue;
    const events = await world.history(delegation.childSessionId);
    // A sibling that cannot be read is treated as working: never end a turn over work that may be live.
    others.push({ delegation, state: events ? childState(events) : { kind: "live" } });
  }
  const working = others.filter((o) => o.state.kind === "live").map((o) => o.delegation.name);
  const asking = others.filter((o) => o.state.kind === "asking").map((o) => o.delegation.name);
  if (working.length + asking.length > 0) return { kind: "refuse", name: stopped.name, working, asking };
  return { kind: "hand-back", stopped, turnId, others };
}

/** Why a lone stop was refused, in words that say what each other specialist is doing. */
export function refusalMessage(name: string, working: readonly string[], asking: readonly string[] = []): string {
  const list = (names: readonly string[]) => names.map((n) => `"${n}"`).join(", ");
  const parts: string[] = [];
  if (working.length) parts.push(`${list(working)} ${working.length === 1 ? "is" : "are"} still working`);
  if (asking.length) parts.push(`${list(asking)} ${asking.length === 1 ? "is" : "are"} waiting for your answer`);
  const next =
    working.length === 0
      ? `Answer ${asking.length === 1 ? "it" : "them"} first, or stop the main thread instead (that stops every specialist it started).`
      : `Stop the main thread instead (that stops every specialist it started), or wait for the ${working.length + asking.length === 1 ? "other one" : "others"} to finish.`;
  return `The "${name}" specialist was not stopped: ${parts.join(" and ")} in the same turn, and stopping one specialist alone would leave the main thread waiting for it forever. ${next}`;
}

export type HandbackOutcome =
  /** The message is on the main thread's own stream. */
  | "told"
  /** eve had no turn of the specialist's to stop, and nothing was owed: nothing was sent. */
  | "nothing-to-stop"
  /** Another request holds this hand-back (or already delivered it): this one sent nothing. */
  | "held-elsewhere"
  /** The specialist finished or failed after all; eve delivers that result itself. Nothing was sent. */
  | "finished-anyway"
  /** The main thread no longer waits on this specialist (it was stopped or moved on). Nothing was sent. */
  | "main-thread-moved-on"
  /** The specialist is stopped and the main thread was NOT told. The text is on record; stopping it again retries. */
  | "not-delivered";

const entriesOf = (stopped: Delegation, state: ChildState, others: ReadonlyArray<{ delegation: Delegation; state: ChildState }>): HandbackEntry[] =>
  [{ delegation: stopped, state }, ...others].map(({ delegation, state: s }): HandbackEntry => ({
    name: delegation.name,
    state: s.kind === "finished" || s.kind === "failed" ? s : { kind: "stopped", lastWords: s.kind === "stopped" ? s.lastWords : "" },
  }));

/** Has the main thread received this very message? Told by the message's own random value. */
const received = (parent: readonly StreamEvent[], message: string): boolean => {
  const nonce = handbackNonce(message);
  return parent.some((e) => e?.type === "message.received" && isHandbackMessage(e.data?.message) && (nonce ? String(e.data?.message).includes(nonce) : String(e.data?.message) === message));
};

/** Send `message` to a main thread that is at rest, and confirm it arrived. Never throws. */
async function deliver(world: HandbackWorld, parentSessionId: string, message: string, deadline: number): Promise<boolean> {
  const now = world.now ?? Date.now;
  let token: string | null = null;
  for (;;) {
    const parent = await world.history(parentSessionId).catch(() => undefined);
    if (parent) {
      if (received(parent, message)) return true; // an earlier attempt's send did land
      if (atRest(parent)) {
        token = continuationTokenOf(parent);
        break;
      }
    }
    if (now() >= deadline) return false; // never at rest: nothing is sent to a thread that is still moving
    await world.sleep(250);
  }
  if (!token) return false;
  const session = await world.send(message, token);
  if (session.id !== parentSessionId) {
    // eve starts a NEW session when a token is no longer live. That is not the main thread: stop it at once.
    await session.cancel().catch(() => undefined);
    console.error("[specialist-handback] the hand-back did not reach the main thread (eve opened another session); it was cancelled", { parentSessionId, opened: session.id });
    return false;
  }
  for (;;) {
    const parent = await world.history(parentSessionId).catch(() => undefined);
    if (parent && received(parent, message)) return true;
    if (now() >= deadline) return false;
    await world.sleep(250);
  }
}

/** What each specialist of the turn handed back, as of now. Null when one of them is live (nothing may be ended). */
async function entriesNow(
  world: HandbackWorld,
  stopped: Delegation,
  stoppedState: ChildState,
  others: ReadonlyArray<{ delegation: Delegation; state?: ChildState }>,
): Promise<HandbackEntry[] | null> {
  const read: Array<{ delegation: Delegation; state: ChildState }> = [];
  for (const other of others) {
    const events = await world.history(other.delegation.childSessionId).catch(() => undefined);
    const state = events ? childState(events) : (other.state ?? { kind: "live" as const });
    if (isLive(state)) return null;
    read.push({ delegation: other.delegation, state });
  }
  return entriesOf(stopped, stoppedState, read);
}

/**
 * Steps 5–8 for a claimed, WRITTEN hand-back: end the turn if it still waits on the specialist, deliver, confirm,
 * and record how it went. `fresh`: this is the request that stopped the specialist, so a main thread that no longer
 * waits has moved on by the person's own hand; on a retry it has usually been ended by the earlier attempt.
 */
async function endAndDeliver(world: HandbackWorld, key: HandbackKey, message: string, settleMs: number, fresh: boolean): Promise<HandbackOutcome> {
  const now = world.now ?? Date.now;
  const parent = await world.history(key.parentSessionId).catch(() => undefined);
  if (!parent) {
    await world.ledger.settle(key, "undelivered");
    return "not-delivered";
  }
  const waits = currentTurnId(parent) === key.turnId && outstandingDelegations(parent).some((d) => d.childSessionId === key.childSessionId);
  if (waits) {
    const ended = await world.cancel(key.parentSessionId, key.turnId).catch(() => "error");
    // `no_active_turn` with the thread at rest: the turn is already gone (an earlier attempt ended it; a turn parked
    // on a specialist's request ends without writing anything). Anything else unaccepted is a turn still there.
    if (ended !== "accepted" && !(ended === "no_active_turn" && atRest(parent))) {
      console.error("[specialist-handback] eve did not end the turn waiting for a stopped specialist", { ...key, status: ended });
      await world.ledger.settle(key, "undelivered");
      return "not-delivered";
    }
  } else if (fresh) {
    await world.ledger.release(key);
    return "main-thread-moved-on";
  }
  const ok = await deliver(world, key.parentSessionId, message, now() + settleMs);
  await world.ledger.settle(key, ok ? "delivered" : "undelivered");
  if (!ok) console.error("[specialist-handback] a stopped specialist's hand-back is written down but was not delivered; stopping it again retries", key);
  return ok ? "told" : "not-delivered";
}

/**
 * A hand-back an earlier request claimed and did not deliver (it failed, or its process died): take it over and
 * finish it. `nothing-to-stop` when none is owed. Never throws.
 */
export async function retryOwed(world: HandbackWorld, parentSessionId: string, childSessionId: string, settleMs = 10_000): Promise<HandbackOutcome> {
  let owed: Awaited<ReturnType<HandbackLedger["retry"]>> = null;
  try {
    owed = await world.ledger.retry(parentSessionId, childSessionId);
    if (!owed) return "nothing-to-stop";
    let message = owed.message;
    if (!message) {
      // Claimed, never written: build it now from what the streams say.
      const parent = await world.history(parentSessionId);
      const out = parent ? outstandingDelegations(parent) : [];
      const stopped = out.find((d) => d.childSessionId === childSessionId);
      const own = await world.history(childSessionId);
      const state = own ? childState(own) : undefined;
      if (!parent || !stopped || currentTurnId(parent) !== owed.key.turnId || !state || state.kind !== "stopped") {
        await world.ledger.release(owed.key);
        return state && (state.kind === "finished" || state.kind === "failed") ? "finished-anyway" : "main-thread-moved-on";
      }
      const entries = await entriesNow(world, stopped, state, out.filter((d) => d !== stopped).map((delegation) => ({ delegation })));
      if (!entries) {
        await world.ledger.settle(owed.key, "undelivered");
        return "not-delivered";
      }
      message = buildHandbackMessage(stopped.name, entries, world.nonce());
      await world.ledger.write(owed.key, message);
    }
    return await endAndDeliver(world, owed.key, message, settleMs, false);
  } catch (error) {
    console.error("[specialist-handback] could not retry an undelivered hand-back", { parentSessionId, childSessionId, error: error instanceof Error ? error.message : String(error) });
    // The ledger itself could not be asked (its table is not there yet, the database is away): nothing is known to be
    // owed, so nothing is claimed about the main thread.
    if (!owed) return "nothing-to-stop";
    await world.ledger.settle(owed.key, "undelivered").catch(() => undefined);
    return "not-delivered";
  }
}

/**
 * Carry out a `hand-back` plan (the numbered steps in the header). Never throws. `cancelChild` is eve's own cancel
 * of the child, run by the caller (the guard forwards the person's request so eve's answer is the response); it
 * resolves to eve's status.
 */
export async function handBackStopped(
  world: HandbackWorld,
  input: {
    readonly parentSessionId: string;
    readonly plan: Extract<StopPlan, { kind: "hand-back" }>;
    readonly cancelChild: () => Promise<string>;
    /** How long each wait (the child coming to rest; the main thread settling and confirming) may take. */
    readonly settleMs?: number;
  },
): Promise<HandbackOutcome> {
  const { parentSessionId, plan } = input;
  const now = world.now ?? Date.now;
  const settleMs = input.settleMs ?? 10_000;
  const key: HandbackKey = { parentSessionId, childSessionId: plan.stopped.childSessionId, turnId: plan.turnId };
  let claimed = false;
  let written = false;
  try {
    // 1
    if ((await input.cancelChild()) !== "accepted") return await retryOwed(world, parentSessionId, key.childSessionId, settleMs);
    // 2
    if ((await world.ledger.claim(key)) !== "won") return "held-elsewhere";
    claimed = true;
    // 3
    let stopped: ChildState = { kind: "live" };
    for (const deadline = now() + settleMs; ; ) {
      const events = await world.history(key.childSessionId).catch(() => undefined);
      if (events) stopped = childState(events);
      if (!isLive(stopped) || now() >= deadline) break;
      await world.sleep(250);
    }
    if (stopped.kind === "finished" || stopped.kind === "failed") {
      await world.ledger.release(key);
      return "finished-anyway";
    }
    // 4 — siblings are read again now: a result is what its specialist's stream says at this moment.
    const entries = await entriesNow(world, plan.stopped, stopped, plan.others);
    if (!entries) {
      // A sibling came back to life (it was answered in the window). Its turn is not ours to end.
      await world.ledger.release(key);
      return "not-delivered";
    }
    const message = buildHandbackMessage(plan.stopped.name, entries, world.nonce());
    await world.ledger.write(key, message);
    written = true;
    // 5–8
    return await endAndDeliver(world, key, message, settleMs, true);
  } catch (error) {
    console.error("[specialist-handback] could not hand back a stopped specialist", { parentSessionId, child: key.childSessionId, error: error instanceof Error ? error.message : String(error) });
    if (claimed) await (written ? world.ledger.settle(key, "undelivered") : world.ledger.release(key)).catch(() => undefined);
    return "not-delivered";
  }
}
