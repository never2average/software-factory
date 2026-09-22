/**
 * What state is the current turn in, judged only from the event stream?
 *
 * Pure functions over a plain array, in `lib/` with NO `server-only` import, so
 * a test can drive the REAL code rather than a hand-copied twin. That is not
 * incidental: the workflow-runtime test copies its subject and has drifted so
 * far that it now greenlights an implementation that was deleted for crashing.
 * Every assertion about chat behaviour was a regex over source text. These two
 * functions decide when a user is told their reply is dead, so they are the
 * ones worth executing in a test.
 */

/** Only the shape we read. Events carry much more. */
export interface TurnEvent {
  type?: string;
}

/** Events that END a turn. Anything after one of these is a new turn. */
const TERMINAL = new Set([
  "turn.completed",
  "session.completed",
  "session.waiting",
  "turn.failed",
  "turn.cancelled",
  "session.failed",
]);

/**
 * Did a turn start and never finish?
 *
 * Scans backwards: the first terminal event means finished, a `turn.started`
 * before any terminal means still going. An empty tail means nothing is running.
 */
export function turnUnfinished(events: readonly TurnEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]?.type;
    if (type && TERMINAL.has(type)) return false;
    if (type === "turn.started") return true;
  }
  return false;
}

/**
 * Is the turn stuck in eve's retry loop — i.e. dead, not slow?
 *
 * When a step throws, eve replays the durable workflow from the beginning, so
 * the stream shows `session.started → turn.started → message.received` AGAIN.
 * A turn that is merely slow does that ONCE and then emits `step.started` and
 * keeps going; a turn whose step cannot run repeats the prologue and never
 * reaches a step at all.
 *
 * Measured against a real stuck run (2026-08-08, a sandbox template missing
 * after a bad deploy): four prologues, zero `step.started`, frozen at eleven
 * events for over six minutes, and eve's own log said "turnStep — 4 attempts ·
 * 3 max retries". The user saw an empty screen, because no `turn.failed` ever
 * reached the stream.
 *
 * The discriminator is the REPEAT, not elapsed time. A legitimate turn can take
 * minutes — one measured here ran 63 seconds across 443 events and 14 tools —
 * so any timeout-based guess would eventually call a working turn dead.
 *
 * Threshold of 3 prologues: two can occur benignly around a reconnect replay,
 * and eve allows 3 retries, so 3 means it is genuinely looping rather than
 * having had one bad attempt.
 */
export function retryStormDetected(events: readonly TurnEvent[], minPrologues = 3): boolean {
  let prologues = 0;
  let sawStep = false;
  // Only consider the tail since the last completed turn.
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]?.type;
    if (type && TERMINAL.has(type)) {
      start = i + 1;
      break;
    }
  }
  for (let i = start; i < events.length; i++) {
    const type = events[i]?.type;
    if (type === "message.received") prologues++;
    // A step that actually started means the turn is executing, not looping.
    if (type === "step.started" || type === "step.completed") sawStep = true;
  }
  return prologues >= minPrologues && !sawStep;
}

/**
 * May the composer deliver a new user message right now?
 *
 * The transcript is projected from events keyed by TURN id: eve's reducer
 * updates "the assistant message of turn N" in place, wherever it sits in the
 * list. So any event that arrives for turn N after a newer user bubble has been
 * appended renders ABOVE that bubble — the reported "the answer keeps streaming
 * above my prompt". And eve's send-path reader stops at the first session
 * boundary it meets, which is then the OLD turn's: the store goes `ready` with
 * the new turn unread.
 *
 * eve's own contract (docs/concepts/execution-model-and-durability, "Message
 * delivery and queueing") is: no server-side FIFO, send one turn at a time,
 * wait for `session.waiting`, and "keep your own per-session queue in the app
 * layer". The chat already has that queue, but it only engaged while the STORE
 * was busy — and the store is busy only while a `send()` is being read. A turn
 * can be alive with the store idle:
 *
 *  - detached: the stream was dropped (Stop, a network error, the reconnect
 *    budget, a slept tab) or the thread was reopened mid-turn. The turn is still
 *    running server-side; nothing local is listening.
 *  - awaiting-input: the turn parked on an approval or a question. eve holds
 *    unrelated follow-up text until that is answered and resumes the OLD turn
 *    first (docs/tools/human-in-the-loop).
 *
 * In all three states a new message is HELD in the queue, never delivered.
 */
export type HoldReason = "streaming" | "detached" | "awaiting-input";

export interface SendGateInput {
  /** The eve store is reading a turn (`submitted` | `streaming`). */
  readonly storeBusy: boolean;
  /** Raw stream events of this transcript. */
  readonly events: readonly TurnEvent[];
  /** Approvals/questions still open (not answered, dismissed or expired). */
  readonly pendingInputs: number;
  /**
   * The server said the unfinished turn is NOT running (cancel route answered
   * `no_active_turn`). It will never emit a terminal, so holding on it would
   * hold forever.
   */
  readonly abandoned?: boolean;
  /**
   * A turn was delivered AROUND the store (a direct POST to the session, used
   * when the store's cursor has no resume token). The server is running it and
   * no local stream is attached, so the events cannot show it yet.
   */
  readonly remoteTurn?: boolean;
}

export interface SendGate {
  readonly hold: boolean;
  readonly reason: HoldReason | null;
}

export function sendGate(input: SendGateInput): SendGate {
  if (input.storeBusy) return { hold: true, reason: "streaming" };
  if (input.remoteTurn) return { hold: true, reason: "detached" };
  if (
    !input.abandoned &&
    turnUnfinished(input.events) &&
    // A retry storm is a DEAD turn, already reported as such ("send it again").
    !retryStormDetected(input.events)
  ) {
    return { hold: true, reason: "detached" };
  }
  if (input.pendingInputs > 0) return { hold: true, reason: "awaiting-input" };
  return { hold: false, reason: null };
}

/** How many turns this transcript has started — a remount-stable turn ordinal. */
export function turnsStarted(events: readonly TurnEvent[]): number {
  let n = 0;
  for (const e of events) if (e?.type === "turn.started") n++;
  return n;
}

/** Is this (tail) event a session boundary, i.e. is the session at rest? */
export function isSessionBoundary(event: TurnEvent | undefined): boolean {
  const type = event?.type;
  return type === "session.waiting" || type === "session.completed" || type === "session.failed";
}

/**
 * What the queue header says. Honest about WHY the message has not gone.
 *
 * `attached` is the difference between "we are holding this behind something we
 * cannot hear" and "the rest of it is coming in right now". The hold itself is
 * unchanged — a message is still HELD while a turn is running, because eve has
 * no server-side FIFO and anything delivered mid-turn renders above the bubble
 * that asked for it — but a reader on the live stream is the one case where the
 * wait has a visible end, and saying so is the difference between watching a
 * dead screen and watching a reply.
 */
export function holdLabel(
  reason: HoldReason | null,
  specialistRunning = false,
  attached = false,
  signedOut = false,
): string {
  switch (reason) {
    case "detached":
      // A 401 is not a slow turn: the hour-long session token expired under it
      // (auth-gate drops it 60s before `exp`), so the reader cannot read and the
      // poll cannot poll. "Still working" would be a lie that hides the one
      // action that fixes it.
      if (signedOut) {
        return "Your sign-in expired while this reply was running. Sign in again to pick it up — nothing is lost.";
      }
      return specialistRunning
        ? "Still working — a specialist is running. Queued messages send when it finishes."
        : attached
          ? "Still working — the rest of the earlier reply is arriving now. Queued messages send when it finishes."
          : "Still working — the earlier reply is continuing on the server. Queued messages send when it finishes.";
    case "awaiting-input":
      return "Queued — sends after you answer the request above";
    default:
      return "Queued — sending after the current reply";
  }
}

/**
 * ONE DETACH IS ONE INCIDENT, however many times it is rendered.
 *
 * A detached turn is HELD and watched, not shown as an error, but it is still
 * counted so it stays queryable. The count was per MOUNT, and a resync remounts
 * the chat — so one session filed three byte-identical "Chat stream ended
 * mid-turn and stopped resuming · last event: message.appended" records inside
 * 63 seconds on 2026-09-21. That reads as three failures; it was one, seen three
 * times.
 *
 * File the first detach of a turn, and file one more when the watcher has spent
 * its whole resync budget on that same turn — because a turn that never comes
 * back is the thing worth knowing about, and going silent about it would trade
 * one bad signal for none.
 */
export function shouldReportDetach(input: {
  /** Reports already filed for this turn (module scope — survives the remount). */
  readonly reported: number;
  readonly resyncsSpent: number;
  readonly resyncBudget: number;
}): boolean {
  const exhausted = input.resyncsSpent >= input.resyncBudget;
  return input.reported < (exhausted ? 2 : 1);
}

/**
 * May the watcher spend a resync on this detached turn right now?
 *
 * A resync is a full replay AND a remount, and the replay deliberately returns
 * as soon as a live turn goes quiet (chat-shell's `replaySession`: a 1.5s gap
 * mid-turn, or its own deadline). So replaying a turn that is still running
 * mounts it MID-TURN, and the fresh mount is detached again — detach → resync →
 * detach, which is the cycle the telemetry recorded. The resync budget bounded
 * the spin at four, it did not stop it.
 *
 * Two gates, then:
 *
 *  - a real session boundary on the tail (`startIndex=-1`, eve docs "Reconnect
 *    and rewind") means the session is genuinely at rest and the replay will
 *    come back whole. Always worth a resync.
 *  - otherwise, only the BLIND fallback is left (the tail probe answered nothing
 *    three times running), and that is allowed exactly once per genuine step
 *    forward: if this mount holds no more server events than the last resync was
 *    asked with, the last one did not hold and another would fetch the same
 *    transcript again.
 */
export function resyncDecision(input: {
  /** The one event the tail probe returned, if any. */
  readonly tail: TurnEvent | undefined;
  /** Consecutive tail reads that answered nothing, including this one. */
  readonly silentReads: number;
  /** Server events this mount holds. */
  readonly knownEvents: number;
  /** Server events the LAST resync of this turn was asked with, if any. */
  readonly lastResyncEvents?: number;
  readonly spent: number;
  readonly budget: number;
  readonly blindAfter?: number;
}): { readonly resync: boolean; readonly reason: "boundary" | "blind" | null } {
  if (input.spent >= input.budget) return { resync: false, reason: null };
  if (isSessionBoundary(input.tail)) return { resync: true, reason: "boundary" };
  const stalled =
    input.lastResyncEvents !== undefined && input.knownEvents <= input.lastResyncEvents;
  if (!input.tail && !stalled && input.silentReads >= (input.blindAfter ?? 3)) {
    return { resync: true, reason: "blind" };
  }
  return { resync: false, reason: null };
}

/* ===========================================================================
 * REATTACH: read the live stream instead of polling it
 * ========================================================================= */

/**
 * SHOULD A LIVE READER BE ON THIS TRANSCRIPT RIGHT NOW?
 *
 * The defect this answers, in one line: the stream is severed on a hard ~120s
 * boundary regardless of health, and the ONLY thing in this app that reopens at
 * the advanced index is eve's send-path reader — which runs only while a
 * `send()` is being consumed. `EveAgentStore`'s public surface is
 * `snapshot / setCallbacks / subscribe / send / stop / reset`: there is no
 * attach. So the moment a turn is detached (Stop, a segment the store's own
 * budget did not recover, a reopened thread, a slept tab) NOTHING is reading the
 * live stream, and the rest of a reply that the server finishes perfectly well
 * never reaches the browser.
 *
 * What the app did instead was POLL: read the session tail, and on a boundary do
 * a full bounded REPLAY and remount (`resyncDecision` below). A running turn's
 * replay returns mid-turn by design, so every remount detached again — measured
 * on 2026-09-21 as three byte-identical "Chat stream ended mid-turn and stopped
 * resuming · last event: message.appended" records on ONE session inside 63
 * seconds. PR #34 stopped the cycling by requiring progress before another
 * resync, which removed the spin and left the fault: on 2026-09-22T15:32:45 the
 * same session filed exactly ONE such record and the half-written answer simply
 * never continued.
 *
 * eve exposes the missing piece and the app never used it: `ClientSession
 * .stream({ startIndex, signal })`. This function decides when to use it.
 *
 * `events` is OPTIONAL. Omit it to ask only the identity questions — is there a
 * session, is it still the one we attached to, is the store reading — which is
 * what the reader itself asks on every incoming event, where re-deciding the
 * turn's state from a half-applied tail would be both wrong and expensive.
 */
export type AttachVerdict =
  /** Attach: a turn is running and nothing is listening to it. */
  | "live-turn"
  /** Nothing to attach to yet (no message has been sent). */
  | "no-session"
  /** The store owns the stream. NEVER two readers over one session. */
  | "store-busy"
  /** The transcript moved to another session under a reader that is still open. */
  | "session-changed"
  /** The turn reached a terminal. The reply is complete; stop reading. */
  | "terminal"
  /** The cancel route said `no_active_turn`: it will never emit a terminal. */
  | "abandoned"
  /** eve is replaying a turn that cannot run (see retryStormDetected). Dead, not slow. */
  | "retry-storm"
  /** The stream would not open often enough that the poll is the better bet. */
  | "open-failed";

export interface AttachInput {
  /** The session (or shared-thread) the reader would open. */
  readonly sessionId?: string | null;
  /** The one a reader is ALREADY open on, when asking whether to keep going. */
  readonly attachedTo?: string | null;
  /** The eve store is reading a turn (`submitted` | `streaming`). */
  readonly storeBusy: boolean;
  /** The transcript's events — store events MERGED with whatever the tail brought. */
  readonly events?: readonly TurnEvent[];
  /** The server said this turn is not running (cancel answered `no_active_turn`). */
  readonly abandoned?: boolean;
  /** Consecutive failures to open or read a stream for this turn. */
  readonly failures?: number;
  readonly maxFailures?: number;
}

export function attachDecision(input: AttachInput): {
  readonly attach: boolean;
  readonly reason: AttachVerdict;
} {
  if (!input.sessionId) return { attach: false, reason: "no-session" };
  // Checked before anything else about the turn: an event from the session we
  // USED to be on must never land in the transcript of the one we are on now.
  if (input.attachedTo && input.attachedTo !== input.sessionId) {
    return { attach: false, reason: "session-changed" };
  }
  // Two readers over one session is the one thing that must never happen: the
  // store's reader advances its own cursor, and a second reader consuming the
  // same indices would double-apply every event it wins the race for.
  if (input.storeBusy) return { attach: false, reason: "store-busy" };
  if (input.abandoned) return { attach: false, reason: "abandoned" };
  if (input.failures !== undefined && input.failures >= (input.maxFailures ?? 4)) {
    return { attach: false, reason: "open-failed" };
  }
  // Identity-only question (see the note above): everything turn-shaped passes.
  if (input.events === undefined) return { attach: true, reason: "live-turn" };
  if (!turnUnfinished(input.events)) return { attach: false, reason: "terminal" };
  // A stormed turn is DEAD and is already reported as such ("send it again").
  // Holding a stream open on it costs an ownership-gated database read per
  // reconnect and can never produce an event.
  if (retryStormDetected(input.events)) return { attach: false, reason: "retry-storm" };
  return { attach: true, reason: "live-turn" };
}

/**
 * The next ABSOLUTE stream index this transcript needs.
 *
 * `EveAgentStore.snapshot.events` is the raw SERVER log (`#c` in
 * eve-agent-store.js) seeded with `initialEvents` — but this app's
 * `initialEvents` also carry browser-only `client.*` markers, appended at the
 * end (lib/chat-snapshot.ts `mountFromSnapshot`, and the persist path in
 * agent-chat). Those markers have no index on the server, so a positional
 * `events.length` overshoots by exactly the number of questions the reader has
 * answered — and the reattach would then open past events it does not have and
 * project a transcript with a hole in it.
 *
 * Counting the non-client events is the same number `mountFromSnapshot` puts in
 * `streamIndex`, which is the value eve itself takes as `startIndex`. Deriving
 * it rather than reading `session.streamIndex` matters because the store RESETS
 * that cursor (sessionId and all) whenever a stream ends without a session
 * boundary — which is precisely the detached case this whole path is for.
 */
export function serverEventCount(events: readonly TurnEvent[]): number {
  let n = 0;
  for (const e of events) if (!e?.type?.startsWith("client.")) n += 1;
  return n;
}

/**
 * How far the ABSOLUTE stream index runs ahead of the events actually held.
 *
 * `serverEventCount` counts what is in the transcript, and for a transcript read
 * straight off the stream that IS the absolute index. It is not, for one mounted
 * from a cached transcript: `compactTranscript` (lib/chat-snapshot.ts) drops
 * superseded `*.appended` deltas on purpose, so the stored events are FEWER than
 * the index they cover — `mountFromSnapshot` returns both, and says so.
 *
 * Counting such a transcript and calling the result an absolute index understates
 * it by every delta compaction removed. A reader resuming there would be handed
 * events the transcript already contains, and re-applying an older
 * `message.appended` rewinds the reply on screen (the reducer replaces a part by
 * key, it does not append). The two changes that meet here shipped the same day,
 * built in parallel, and their offline tests each passed alone.
 *
 * The deficit is fixed for the life of a mount — events are only ever appended
 * after it — so it is measured once, from the cursor and the transcript the mount
 * was given, and added to every count taken from then on.
 */
export function absoluteIndexBase(
  mountedStreamIndex: number | undefined,
  mountedEvents: readonly TurnEvent[] | undefined,
): number {
  if (typeof mountedStreamIndex !== "number" || !Number.isFinite(mountedStreamIndex)) return 0;
  // Never negative: a cursor BEHIND the transcript would push a reader backwards,
  // which is the very failure this exists to stop.
  return Math.max(0, Math.floor(mountedStreamIndex) - serverEventCount(mountedEvents ?? []));
}

/**
 * WHAT CURSOR MAY BE HANDED BACK WHEN A READER REACHES A BOUNDARY.
 *
 * The hand-off used to return `{ sessionId, continuationToken: freshestToken(),
 * streamIndex }` unconditionally — and `isSessionBoundary` counts
 * `session.failed` and `session.completed` as terminals, so it did that for a
 * session that is OVER. `freshestToken()` scans back to the last
 * `session.waiting`, which after a failure is the token from an earlier park of
 * the now-dead session. The next message then posted to a dead session with a
 * spent token and surfaced as "The connection to the agent dropped."
 *
 * eve says this itself, in `advanceSession` (client/session-utils.js): on any
 * boundary that is not `session.waiting` it returns
 * `createInitialSessionState()` — `{ streamIndex: 0 }`, no session id, no token.
 * That EMPTY state is how a new session gets opened, and `withSessionEpochs`
 * below is written assuming exactly that (it renumbers `turn_0` of the next
 * session so it cannot overwrite this transcript's first exchange). Overriding
 * it put the app back in the state the epochs exist to survive.
 *
 * So: `session.waiting` is a park and the cursor is carried; `session.failed`
 * and `session.completed` end the session and the cursor is dropped, exactly as
 * eve would have dropped it.
 */
export function handBackSession(input: {
  /** The boundary the reader stopped on. */
  readonly boundary: TurnEvent | undefined;
  readonly sessionId: string;
  readonly continuationToken: string | undefined;
  readonly streamIndex: number;
}): { sessionId?: string; continuationToken?: string; streamIndex: number } {
  const type = input.boundary?.type;
  if (type === "session.completed" || type === "session.failed") {
    // Identical to eve's own `createInitialSessionState()`.
    return { streamIndex: 0 };
  }
  return {
    sessionId: input.sessionId,
    continuationToken: input.continuationToken,
    streamIndex: input.streamIndex,
  };
}

/** One event of the attached tail, with the absolute index it arrived at. */
export interface IndexedEvent<T = TurnEvent> {
  readonly index: number;
  readonly event: T;
}

/**
 * The store's events plus the attached tail, DEDUPLICATED BY ABSOLUTE INDEX.
 *
 * Three rules, each one a way the screen could otherwise lie:
 *
 *  - An index the store already holds is DROPPED, never applied. The store is
 *    always the newer copy of an index it has (it is the one that can also
 *    fold the client-side markers), and letting a replayed tail event overwrite
 *    it is how the same reply gets written twice.
 *  - The tail is applied in index order, and stops at the FIRST GAP. An event
 *    whose predecessor is missing cannot be placed: eve's reducer updates "the
 *    assistant message of turn N" in place, so applying 104 without 103 does not
 *    leave a hole, it writes the wrong text.
 *
 *    THIS FILE USED TO CLAIM "the gap closes itself on the next reconnect,
 *    which reopens at the missing index". It did not, and the claim was the
 *    whole defect: `readLiveTail` reopens at ITS OWN counter, never at the index
 *    the transcript needs, and the component's append guard compared a new entry
 *    only against the LAST one it held — so a restarted reader that re-delivered
 *    100..159 over a tail already holding 103..149 had 100, 101 and 102 silently
 *    dropped, and `mergedEvents` was then frozen for the rest of the session.
 *    `turnUnfinished` stayed true, `attachDecision` kept answering "live turn",
 *    and the composer sat on "Still working…" with the queue never flushing —
 *    unrecoverable on a shared thread, where the poll returns early on
 *    `relayThreadId` and the hand-off is skipped on `attachVia`.
 *
 *    A gap now closes because `appendTailEvent` below places an entry by INDEX
 *    rather than appending it, and because a restarted reader is started at
 *    exactly the index the merged transcript is missing.
 *  - Nothing to add returns the SAME ARRAY REFERENCE, so every memo keyed on
 *    the event list keeps its identity on an ordinary, unattached transcript.
 *    (Same reason `deadInputRequestIds` shares one empty set.)
 */
export function mergeAttachedEvents<T extends TurnEvent>(
  storeEvents: readonly T[],
  tail: readonly IndexedEvent<T>[],
  nextIndex: number = serverEventCount(storeEvents),
): readonly T[] {
  if (tail.length === 0) return storeEvents;
  const byIndex = new Map<number, T>();
  for (const entry of tail) {
    if (!entry || entry.index < nextIndex) continue;
    // First delivery wins: a reconnect that re-sends an index we already took
    // must not replace it, or a streaming text part rewinds on screen.
    if (!byIndex.has(entry.index)) byIndex.set(entry.index, entry.event);
  }
  const extra: T[] = [];
  for (let i = nextIndex; byIndex.has(i); i++) extra.push(byIndex.get(i) as T);
  return extra.length === 0 ? storeEvents : [...storeEvents, ...extra];
}

/**
 * Place one delivered event in the tail BY ITS INDEX, not at the end.
 *
 * The guard this replaces was `prev[prev.length - 1].index >= entry.index ? prev
 * : [...prev, entry]` — a comparison against the LAST entry only. It is correct
 * for one reader, whose indices are strictly increasing, and wrong the moment a
 * reader RESTARTS mid-turn, which three ordinary things cause: a reader failure
 * bumping the attach epoch, the tab becoming visible again, and eve re-emitting
 * `turn.started` when it replays a turn after a step throws (see
 * `retryStormDetected`). The restarted reader reopens at the index the
 * transcript is missing, so its first deliveries are BELOW the tail's last
 * index — and every one of them was dropped, which made the hole permanent.
 *
 * Proved: a tail holding 103..149 met a reader delivering 100..159 and kept
 * 103..159; 100, 101 and 102 were gone for good and `mergeAttachedEvents`
 * returned the store's array unchanged from then on.
 *
 * Rules, in the order they matter:
 *  - an index already held is kept as it was (FIRST DELIVERY WINS — a re-sent
 *    `message.appended` would otherwise rewind the reply on screen, because the
 *    reducer replaces a part by key rather than appending to it);
 *  - the common case, an index past the end, is still a plain append with no
 *    copying beyond the spread;
 *  - anything else is inserted at its place, so the list stays index-ordered
 *    and `mergeAttachedEvents` can walk it from `nextIndex` without a gap;
 *  - nothing added returns the SAME ARRAY REFERENCE, so the memos keyed on the
 *    tail do not churn on a duplicate delivery.
 */
export function appendTailEvent<T extends TurnEvent>(
  prev: readonly IndexedEvent<T>[],
  entry: IndexedEvent<T>,
): readonly IndexedEvent<T>[] {
  if (!entry || !Number.isFinite(entry.index)) return prev;
  const last = prev[prev.length - 1];
  if (last === undefined || entry.index > last.index) return [...prev, entry];
  // Backwards from the end: a restarted reader's deliveries land near the tail's
  // own range, not at its start.
  let at = prev.length - 1;
  while (at >= 0 && prev[at].index > entry.index) at--;
  if (at >= 0 && prev[at].index === entry.index) return prev;
  return [...prev.slice(0, at + 1), entry, ...prev.slice(at + 1)];
}

/**
 * Project the attached tail ON TOP of the store's own projection.
 *
 * The store has no public ingest, so the transcript's reducer is run over the
 * tail here — the same pattern `app/_components/cockpit.tsx` already uses to
 * reduce a child session's events outside the store.
 *
 * Folding onto `base` rather than re-reducing the whole stream is not just an
 * optimisation, it is what keeps `withSessionEpochs` correct: the epoch state
 * lives on the data object as a NON-ENUMERABLE property (see below), so
 * continuing from the store's own output continues its epoch, while a fresh
 * fold over a merged list that starts mid-session would restart at epoch 0 and
 * write a second session's `turn_0` over the first exchange.
 *
 * `reduce` is pure (cockpit shares one reducer instance for exactly this
 * reason), so the result is identical to reducing the full sequence once —
 * which is what scripts/test-chat-reattach.mjs asserts, event by event.
 */
export function projectAttached<TData, TEvent extends TurnEvent>(
  reducer: EventReducer<TData, TEvent>,
  base: TData,
  tail: readonly TEvent[],
): TData {
  let data = base;
  for (const event of tail) data = reducer.reduce(data, event);
  return data;
}

/**
 * Keep turn ids unique across eve SESSIONS inside one transcript.
 *
 * Turn ids are `turn_<n>` counted per session. When a session ends for good
 * (`session.failed`, `session.completed`) eve's client starts a NEW session on
 * the next send, whose first turn is `turn_0` again — and the reducer, keyed by
 * turn id, then writes the new prompt over the transcript's FIRST user bubble
 * and streams the new answer into the FIRST assistant message, at the top.
 *
 * A new session only ever follows a session-ending boundary. eve also re-emits `session.started` when it replays a turn after a
 * step throws (see retryStormDetected) — same session, same ids — and that must
 * keep upserting in place, so it does not count.
 *
 * Wraps any `{ initial, reduce }` reducer; events of the first session pass
 * through untouched, so ordinary transcripts are byte-identical to before.
 */
export interface EventReducer<TData, TEvent> {
  initial(): TData;
  reduce(data: TData, event: TEvent): TData;
}

const EPOCH = "~epoch";
type WithEpoch = { [EPOCH]?: { epoch: number; ended: boolean } };

export function withSessionEpochs<TData extends object, TEvent extends TurnEvent>(
  base: EventReducer<TData, TEvent>,
): EventReducer<TData, TEvent> {
  return {
    initial: () => base.initial(),
    reduce(data, event) {
      const state = (data as WithEpoch)[EPOCH] ?? { epoch: 0, ended: false };
      let { epoch, ended } = state;
      const type = event?.type;
      const payload = (event as { data?: { turnId?: unknown } }).data;
      if (type === "session.completed" || type === "session.failed") {
        ended = true;
      } else if (
        ended &&
        // Nothing more can arrive from a session that ended, so the first
        // turn-scoped thing after it IS the new session. Not only
        // `session.started`: eve's store swaps the optimistic bubble for
        // `message.received` IN PLACE, which puts the new turn's first event
        // ahead of its own `session.started` in the projection order.
        (type === "session.started" ||
          type === "client.message.submitted" ||
          typeof payload?.turnId === "string")
      ) {
        epoch += 1;
        ended = false;
      }
      let scoped = event;
      if (epoch > 0 && payload && typeof payload.turnId === "string") {
        scoped = { ...event, data: { ...payload, turnId: `${payload.turnId}~s${epoch}` } };
      }
      const next = base.reduce(data, scoped);
      if (next === data && epoch === state.epoch && ended === state.ended) return data;
      // Non-enumerable: invisible to JSON, spreads and every `data.messages` reader.
      const out = next === data ? ({ ...data } as TData) : next;
      Object.defineProperty(out, EPOCH, { value: { epoch, ended }, enumerable: false });
      return out;
    },
  };
}

/**
 * WHICH OPEN INPUT REQUESTS ARE STILL ANSWERABLE — read from the stream alone.
 *
 * A parked request survives a reload: that is the point of eve's human-in-the-
 * loop (docs/tools/human-in-the-loop — "parks at `session.waiting`, durably, for
 * as long as it takes — seconds or days"). So the card is rebuilt from the
 * message PART, whose `approval-requested` state / `inputRequest` metadata has
 * no expiry of its own.
 *
 * The three sets the chat kept alongside it (responded / dismissed / expired)
 * are in-memory, so they are EMPTY after a reload. Any request whose part never
 * reached a terminal state — its turn died, it was answered through a path that
 * never wrote `inputResponse` back onto the part, or its `action.result` was
 * simply not in the replay — was therefore hoisted again as a LIVE approval, and
 * `sendGate` then held the composer on `awaiting-input` forever. Reported as
 * "permission decisions resurface and block streaming for chats that are already
 * completed", and it is unrecoverable by the user: the card's Yes/No posts a
 * continuation token that is long gone.
 *
 * The stream can tell the two apart, and only the stream can:
 *
 *  - LIVE PARK — an `input.requested` and nothing after it that ends the call or
 *    the turn. Still answerable. Unchanged behaviour: hoist it, hold the
 *    composer, let a composer answer resolve it.
 *  - DEAD — the same `input.requested`, but the stream later shows the call
 *    resolved (`action.result` for its `callId`) or the run ended
 *    (`turn.completed` / `turn.failed` / `turn.cancelled` for its `turnId`, a
 *    LATER turn started, or the session ended). Nothing can answer it any more.
 *
 * `session.waiting` is the PARK signal, not an end (see the table in
 * docs/concepts/sessions-runs-and-streaming): it must never kill a request, or
 * every approval would be dead the instant it was asked.
 *
 * Returns the DEAD ids. Callers drop them from `pendingInputs` (so the chat is
 * sendable) and render them the way an expired card renders — a muted note that
 * the run has stopped — never as a live prompt.
 */
const NO_REQUEST_IDS: ReadonlySet<string> = new Set<string>();

interface OpenRequestShape {
  readonly requestId?: unknown;
  readonly action?: { readonly callId?: unknown };
}
interface RequestEventData {
  readonly turnId?: unknown;
  readonly requests?: readonly OpenRequestShape[];
  readonly result?: { readonly callId?: unknown };
}

export function deadInputRequestIds(events: readonly TurnEvent[]): ReadonlySet<string> {
  /** requestId → the call and turn it belongs to, while it is still answerable. */
  const open = new Map<string, { turnId?: string; callId?: string }>();
  const dead = new Set<string>();
  const kill = (requestId: string) => {
    open.delete(requestId);
    dead.add(requestId);
  };
  for (const raw of events) {
    const type = raw?.type;
    if (!type) continue;
    const data = (raw as { data?: RequestEventData }).data;
    const turnId = typeof data?.turnId === "string" ? data.turnId : undefined;
    switch (type) {
      case "input.requested": {
        for (const req of data?.requests ?? []) {
          const requestId = typeof req?.requestId === "string" ? req.requestId : undefined;
          if (!requestId) continue;
          // A RE-PARK restates the same request (eve mints a fresh token and asks
          // again after a failed answer). It is alive again, whatever happened
          // before — otherwise one bad click would bury a live approval.
          dead.delete(requestId);
          const callId = typeof req?.action?.callId === "string" ? req.action.callId : undefined;
          open.set(requestId, { turnId, callId });
        }
        break;
      }
      case "action.result": {
        // The gated call RAN (or was denied): its approval was consumed, whether
        // or not this client is the one that answered it.
        const callId = typeof data?.result?.callId === "string" ? data.result.callId : undefined;
        if (!callId) break;
        for (const [requestId, req] of [...open]) if (req.callId === callId) kill(requestId);
        break;
      }
      case "turn.completed":
      case "turn.failed":
      case "turn.cancelled": {
        // The turn that was suspended on the request is over. Nothing will pick
        // the answer up.
        for (const [requestId, req] of [...open]) {
          if (req.turnId === undefined || turnId === undefined || req.turnId === turnId) {
            kill(requestId);
          }
        }
        break;
      }
      case "turn.started": {
        // A LATER turn started, so the parked one cannot still be suspended.
        // eve re-emits `turn.started` for the SAME turn when it replays a turn
        // after a step throws (see retryStormDetected) — same id, still alive.
        for (const [requestId, req] of [...open]) {
          if (req.turnId !== undefined && turnId !== undefined && req.turnId !== turnId) {
            kill(requestId);
          }
        }
        break;
      }
      case "session.completed":
      case "session.failed": {
        // The session is over for good; a new send opens a new one (see
        // withSessionEpochs). Every request it held is unreachable.
        for (const requestId of [...open.keys()]) kill(requestId);
        break;
      }
      default:
        // `session.waiting` lands here ON PURPOSE. It is the park.
        break;
    }
  }
  // One shared empty set, so a transcript with no dead requests keeps the same
  // reference on every projection (see withRequestIds for why that matters).
  return dead.size === 0 ? NO_REQUEST_IDS : dead;
}

/**
 * Add ids to a set WITHOUT changing its identity when nothing is added.
 *
 * `setX(prev => new Set(prev).add(id))` always produces a new object, so the
 * memos keyed on that state recompute, the effects keyed on those memos re-run,
 * and an effect that calls the setter again never reaches a fixed point — the
 * shape that ends as "Maximum update depth exceeded" (React #185). Because the
 * chat's store re-renders synchronously while it reads a turn, that throw is
 * delivered to whichever `setState` comes next — usually eve's own store notify,
 * where it becomes `agent.error` and kills a turn that was streaming fine.
 *
 * Returning `prev` unchanged is the fixed point, so the same answer twice is one
 * render, not an escalating series of them.
 */
export function withRequestIds(
  prev: ReadonlySet<string>,
  ids: Iterable<string>,
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const id of ids) {
    if (!id || prev.has(id)) continue;
    next ??= new Set(prev);
    next.add(id);
  }
  return next ?? prev;
}

/**
 * Take request ids back out, on the same fixed-point discipline.
 *
 * Needed when a delivery FAILS after the card was optimistically marked
 * answered: a shared thread's answer goes to the relay, and a relay that refuses
 * it (409 someone else holds the turn, 502 a spent token) must leave the card
 * answerable. Marking it answered anyway is the quiet failure — the person sees
 * their Yes recorded and the agent never hears it.
 */
export function withoutRequestIds(
  prev: ReadonlySet<string>,
  ids: Iterable<string>,
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const id of ids) {
    if (!id || !prev.has(id)) continue;
    next ??= new Set(prev);
    next.delete(id);
  }
  return next ?? prev;
}

/**
 * Is this a RENDER loop rather than a stream failure?
 *
 * React reports an update-depth blow-up as #185 (minified) or "Maximum update
 * depth exceeded" (development). Measured once in production on 2026-09-21
 * 13:33:52 as `Chat stream errored · — Minified React error #185`: it arrived
 * through the eve store's `onError`, because the store notifies subscribers
 * synchronously inside its `for await` over the stream, so React's throw
 * unwinds into the store's own catch. There the turn is marked `error` and the
 * user is told the connection dropped — about a stream that never faltered.
 *
 * No ErrorBoundary can intercept that: the error is not thrown while rendering
 * the boundary's subtree, it is thrown at the next `setState` call site, which
 * is the store's. So the chat classifies it instead, and leaves a turn that is
 * still running to the detached-turn watcher.
 */
export function isRenderLoopError(message: string | null | undefined): boolean {
  if (!message) return false;
  return (
    /maximum update depth exceeded/i.test(message) ||
    /too many re-?renders/i.test(message) ||
    /minified react error #(185|301)\b/i.test(message) ||
    /react\.dev\/errors\/(185|301)\b/i.test(message)
  );
}

/**
 * Where does text typed into the composer go?
 *
 * A pending QUESTION has no text box of its own here — a freeform question can
 * only be answered from the composer — and eve resolves such text into the
 * answer server-side (`resolveTextToResponse`). Delivered as a MESSAGE it still
 * resumes the old turn, but also leaves a user bubble below an answer that is
 * being written above it. Delivered as the ANSWER it is recorded on the question
 * card and the transcript stays in order. Text that answers nothing (an approval
 * is pending, or the question only takes its listed options) is held.
 */
export function composerRoute(input: {
  readonly gate: SendGate;
  /** How many open requests this text resolves to an answer for. */
  readonly answers: number;
  readonly hasFiles: boolean;
}): "send" | "queue" | "answer" {
  if (!input.gate.hold) return "send";
  if (input.gate.reason === "awaiting-input" && input.answers > 0 && !input.hasFiles) return "answer";
  return "queue";
}

/**
 * What was on screen when a render loop threw.
 *
 * A production React "maximum update depth" error is minified to the bare string
 * "Minified React error #185" and carries no component stack — and no
 * ErrorBoundary ever sees it, because the store delivers it at its own setState
 * call site (see agent-chat's onError). The single occurrence recorded on
 * 2026-09-21 therefore named nothing that could be searched for, and an offline
 * repro of the streaming transcript (including a wide KPI table, the content
 * this product streams most) did not reproduce it.
 *
 * So record the SCENE instead of guessing: what the transcript held, what the
 * tail part was, and which of the renderers known to drive their own updates —
 * a streaming markdown table, a code block, a mermaid diagram, an open approval
 * card — were mounted. Pure, so a test drives the real thing; one short line,
 * because it travels inside a 300-character telemetry detail.
 */
export function renderLoopScene(
  messages: readonly { parts?: readonly unknown[] }[],
  events: readonly TurnEvent[],
  viewport?: { width: number; height: number },
): string {
  const last = messages[messages.length - 1];
  const parts = (last?.parts ?? []) as Array<{ type?: string; state?: string; text?: string }>;
  const tail = parts[parts.length - 1];
  const text = typeof tail?.text === "string" ? tail.text : "";
  const bits = [
    `msgs ${messages.length}`,
    `parts ${parts.length}`,
    `tail ${tail?.type ?? "none"}/${tail?.state ?? "-"}`,
    `event ${events[events.length - 1]?.type ?? "none"}`,
  ];
  // A table is the one that matters most here: half of what this product streams
  // is a KPI table, and a table is also the widest thing a transcript renders.
  if (/^\s*\|.*\|/m.test(text)) bits.push("table");
  if (text.includes("```mermaid")) bits.push("mermaid");
  else if (text.includes("```")) bits.push("code");
  if (parts.some((p) => p.state === "approval-requested")) bits.push("approval");
  if (viewport) bits.push(`${viewport.width}x${viewport.height}`);
  return bits.join(" · ");
}
