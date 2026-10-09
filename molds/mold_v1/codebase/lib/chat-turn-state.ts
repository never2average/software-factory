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
import { isDetachedResult } from "./detached-delegation.ts";

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
 *  - delivering: eve still HOLDS a message of ours that it has not started.
 *    See `outstandingDeliveries` — eve answers 200 to a message sent while a
 *    turn is running or a specialist is parked, buffers it silently, and runs
 *    it as a turn of its own AFTER the next `session.waiting`. Sending more
 *    into that buffer is how "unanswered messages" stacked up where nothing
 *    could remove them.
 *
 * In every one of these states a new message is HELD in the queue, never
 * delivered — and the queue is the one place a message can still be removed.
 */
export type HoldReason = "streaming" | "detached" | "awaiting-input" | "delivering";

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
  /**
   * Messages this chat DELIVERED that the transcript has not yet seen arrive
   * (`outstandingDeliveries(...).length`). While any exist eve is holding input
   * of ours, so the session is not at rest even when the transcript's tail is a
   * `session.waiting`.
   */
  readonly outstanding?: number;
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
  if ((input.outstanding ?? 0) > 0) return { hold: true, reason: "delivering" };
  return { hold: false, reason: null };
}

/**
 * IS THE ANSWER OVER? — the one question behind every end-of-answer affordance.
 *
 * THE DEFECT. "When waiting for a tool call the agent pretends like things are
 * done and it shows the feedback, copy, and retry buttons normally seen at the
 * end of answers." Measured on a turn that read a 21-page pdf: one sentence,
 * four tool calls, then the rest of the reply — and the copy/vote/retry row sat
 * under the sentence for the whole of the middle.
 *
 * TWO SOURCES OF THE LIE, and this function removes both.
 *
 * 1. eve's own reducer. `upsertPart` (node_modules/eve/dist/src/client/
 *    message-reducer.js) writes `metadata.status = "complete"` whenever the
 *    part it just wrote is a TEXT part in state `done`, and `streaming`
 *    otherwise. eve closes the text part at every step boundary — a step that
 *    ends in tool calls emits `message.completed` with `finishReason:
 *    "tool-calls"`, which the reducer does not look at — so a turn that writes a
 *    sentence and then calls a tool passes through `complete` once per step.
 *    `turn.completed` sets the SAME field to the SAME value, so nothing
 *    downstream can tell a paragraph from a turn. (And `turn.failed` /
 *    `session.failed` are `return e` in that reducer: a turn that died leaves
 *    the message on `streaming` for ever, so the field is wrong in both
 *    directions.) Nothing in this repo may key "finished" off it.
 *
 * 2. THE STORE'S STATUS IS NOT THE TURN'S STATUS. `agent.status` is
 *    `submitted | streaming` only while eve's store is inside a `send()`
 *    (eve-agent-store.js: it is set `ready` the moment that `for await` ends).
 *    A turn is alive with the store idle on every path the reattach exists for
 *    — a thread reopened mid-turn, a resync remount, a severed stream past the
 *    budget, Stop, a turn POSTed around the store — and those are exactly the
 *    long turns, i.e. the ones with tool calls in them. `turnActive={isBusy}`
 *    therefore said "finished" for the whole detached half of a reply.
 *
 * The turn is over, not the paragraph, and `sendGate` already knows when: it is
 * the same question ("is this session at rest?") asked for the composer. Reuse
 * it rather than growing a second notion that can disagree with the first — a
 * screen that offers Retry while the composer holds the next message on "Still
 * working" is telling the person two different things at once.
 *
 * Deliberately TRUE for the two dead-turn verdicts `sendGate` releases on:
 * `abandoned` (the cancel route answered `no_active_turn`, or Stop's grace ran
 * out) and a retry storm. Nothing more is coming, and Retry is precisely what
 * the person needs. `turn.failed`, `turn.cancelled` and a transcript mounted
 * from the cached snapshot all land here through `turnUnfinished`'s TERMINAL
 * set, which reads history, so "finished" never depends on having watched the
 * turn end.
 */
export function turnFinished(input: SendGateInput): boolean {
  return !sendGate(input).hold;
}

/** Only the shape we read off a message part. Parts carry much more. */
export interface PartState {
  readonly type?: string;
  readonly state?: string;
}

/**
 * Is this part a line the model is STILL WRITING?
 *
 * The block caret and the "Working…" strip both asked "is the last part a text
 * part?", which is true right through the tool-call gap: eve closes the text
 * part (`state: "done"`) at the step boundary BEFORE the tool runs, and the
 * hosted relay flushes the tool part only at the NEXT step boundary, so for the
 * whole of a long call the transcript's tail is a finished paragraph. The
 * caret therefore blinked under text nobody was writing, and the strip whose
 * entire job is that gap hid itself in it.
 *
 * `=== "streaming"` and not `!== "done"`: a part with no state at all (the
 * optimistic user bubble, `client.message.submitted`) is not being written by
 * the model either.
 */
export function partStillWriting(part: PartState | undefined): boolean {
  return part?.type === "text" && part.state === "streaming";
}

/** Is the tail of this message a line still being written? */
export function tailStillWriting(parts: readonly PartState[]): boolean {
  return partStillWriting(parts[parts.length - 1]);
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
  /** An answer whose response went missing is being checked against the stream. */
  checkingAnswer = false,
): string {
  // Whether the answer landed — and so whether anything is running because of
  // it — is exactly what is not known yet. "A specialist is running" said a
  // thing nobody knew (review of #59).
  if (checkingAnswer && !signedOut) return `Queued — sends once your answer is confirmed. ${ANSWER_CHECKING_LINE}`;
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
    case "delivering":
      return "Queued — your earlier message is still waiting its turn on the server. Queued messages send after its reply.";
    default:
      return "Queued — sending after the current reply";
  }
}

/** Said while an answer whose response went missing is checked against the stream (`answerNeedsCheck`). */
export const ANSWER_CHECKING_LINE =
  "Checking whether your answer reached the server — if it did not, the question comes back above.";

/** What posting an answer came to. `notSent`: no POST was made at all (no session, or no resume token). */
export interface AnswerPostOutcome {
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
  readonly notSent?: "no-session" | "no-token";
}

/**
 * SHOULD A FAILED ANSWER BE CHECKED AGAINST THE STREAM before the question comes
 * back? Only when it may have LANDED: a 5xx, or a request whose response went
 * missing (status 0 from a fetch that threw). Not when nothing was posted —
 * status 0 meant that too ("no session", "no resume token"), and those waited
 * the whole minute for an answer that was never sent (review of #59). Not a
 * 4xx either: that is the server's answer.
 */
export function answerNeedsCheck(outcome: AnswerPostOutcome): boolean {
  if (outcome.ok || outcome.notSent) return false;
  return outcome.status === 0 || outcome.status >= 500;
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
  | "open-failed"
  /**
   * The turn on the tail is over, but eve still holds a message we delivered
   * (see `outstandingDeliveries`): its turn starts AFTER this boundary, and
   * nothing else will read it.
   */
  | "buffered";

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
  /** Delivered messages not yet seen arriving — see `outstandingDeliveries`. */
  readonly outstanding?: number;
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
  // "Abandoned" is a verdict about the UNFINISHED turn (the cancel route said it
  // is not running). It says nothing about a message delivered after it — a Stop
  // releases the queue into exactly that state, and that reply must be read.
  const buffered =
    input.events !== undefined && (input.outstanding ?? 0) > 0 && !turnUnfinished(input.events);
  if (input.abandoned && !buffered) return { attach: false, reason: "abandoned" };
  if (input.failures !== undefined && input.failures >= (input.maxFailures ?? 4)) {
    return { attach: false, reason: "open-failed" };
  }
  // Identity-only question (see the note above): everything turn-shaped passes.
  if (input.events === undefined) return { attach: true, reason: "live-turn" };
  if (!turnUnfinished(input.events)) {
    // A boundary is the end of THIS turn, not of everything the session owes us.
    // One delivery can produce several boundaries (a message eve buffered runs as
    // its own turn after this one), and both readers stop at the first — eve's
    // send-path reader and `readLiveTail` alike. Without this, the reply to a
    // buffered message surfaced only when the NEXT send opened a stream at the
    // stale cursor, read it, and stopped at ITS boundary: one reply behind, for
    // the rest of the session.
    if ((input.outstanding ?? 0) > 0) return { attach: true, reason: "buffered" };
    return { attach: false, reason: "terminal" };
  }
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
 * through untouched, so ordinary transcripts are byte-identical to before. It
 * also applies `withResumedSteps` (below): a turn that resumes after a
 * specialist returns keeps its later parts below the specialist's card.
 */
export interface EventReducer<TData, TEvent> {
  initial(): TData;
  reduce(data: TData, event: TEvent): TData;
}

const EPOCH = "~epoch";
type WithEpoch = { [EPOCH]?: { epoch: number; ended: boolean } };

/**
 * A shallow copy that KEEPS non-enumerable properties. A spread drops them, and
 * the wrappers below each keep their state in one — so a spread in the outer
 * wrapper would silently reset the inner wrapper's state.
 */
function copyWithState<T extends object>(data: T): T {
  return Object.defineProperties({}, Object.getOwnPropertyDescriptors(data)) as T;
}

/**
 * EVERY PART OF A TURN IN THE ORDER IT HAPPENED — steps after a delegation.
 *
 * THE DEFECT. "The thinking stream continues above the subagent segment even
 * though it should be below the subagent section." When the orchestrator hands
 * work to a specialist, eve suspends the turn's durable workflow and resumes it
 * when the specialist's result arrives — and the resumed half starts counting
 * steps from 0 AGAIN (its emission state is rebuilt with `stepIndex: 0`;
 * recorded in scripts/fixtures/subagent-delivery/child-completes.ndjson and
 * scripts/fixtures/event-order/). eve's reducer keys a turn's reasoning and
 * text parts by step alone (`reasoning:<stepIndex>` / `text:<stepIndex>`,
 * `partKey` in node_modules/eve/dist/src/client/message-reducer.js) and
 * `upsertPart` replaces a part WHERE IT ALREADY IS. So the thinking after the
 * delegation was written into the thinking block BEFORE it — above the
 * specialist's card — and a sentence the orchestrator wrote before delegating
 * was overwritten by its answer after. Live and on reopen alike: both are the
 * same fold over the same events.
 *
 * THE RULE. A step can only start once. A `step.started` for a step index this
 * turn has already COMPLETED is the resumed half, so it and every later event
 * of that turn are renumbered past the last completed step — the reducer then
 * opens new parts below the card instead of rewriting old ones. Nothing else is
 * renumbered: a step that throws never completes, so eve's retry of it keeps its
 * index and still upserts in place, and `turn.started` (a new turn, or eve
 * replaying the whole turn after a throw) starts the count again. A transcript
 * with no delegation passes through untouched.
 */
const STEPS = "~steps";
type StepState = Readonly<Record<string, { readonly completed: number; readonly offset: number }>>;
type WithSteps = { [STEPS]?: StepState };

export function withResumedSteps<TData extends object, TEvent extends TurnEvent>(
  base: EventReducer<TData, TEvent>,
): EventReducer<TData, TEvent> {
  return {
    initial: () => base.initial(),
    reduce(data, event) {
      const state: StepState = (data as WithSteps)[STEPS] ?? {};
      const payload = (event as { data?: { turnId?: unknown; stepIndex?: unknown } }).data;
      const turnId = typeof payload?.turnId === "string" ? payload.turnId : undefined;
      let next = state;
      let scoped = event;
      if (turnId !== undefined && event?.type === "turn.started") {
        if (state[turnId]) {
          const { [turnId]: _dropped, ...rest } = state;
          next = rest;
        }
      } else if (turnId !== undefined && typeof payload?.stepIndex === "number") {
        const step = payload.stepIndex;
        let turn = state[turnId] ?? { completed: -1, offset: 0 };
        if (event.type === "step.started" && step + turn.offset <= turn.completed) {
          turn = { ...turn, offset: turn.completed + 1 - step };
        }
        const index = step + turn.offset;
        if (event.type === "step.completed" && index > turn.completed) turn = { ...turn, completed: index };
        if (turn !== state[turnId]) next = { ...state, [turnId]: turn };
        if (turn.offset !== 0) scoped = { ...event, data: { ...payload, stepIndex: index } };
      }
      const reduced = base.reduce(data, scoped);
      if (next === state) {
        // Carry the state onto a new projection that the base built without it.
        if (reduced !== data && (reduced as WithSteps)[STEPS] !== state && Object.keys(state).length) {
          Object.defineProperty(reduced, STEPS, { value: state, enumerable: false, configurable: true });
        }
        return reduced;
      }
      const out = reduced === data ? copyWithState(data) : reduced;
      Object.defineProperty(out, STEPS, { value: next, enumerable: false, configurable: true });
      return out;
    },
  };
}

/**
 * A PARKED SPECIALIST'S HAND-BACK GETS ITS OWN TURN.
 *
 * When a delegation parks (the specialist asked the person something) the
 * parent's turn ends at `session.waiting`. The answer resumes the specialist,
 * and when it hands back eve runs the parent's reply as a continuation that
 * has NO `turn.started` and arrives with `turnId: ""` — the same emission-state
 * reset as the step renumbering above; recorded in
 * scripts/fixtures/subagent-delivery/child-parks-then-answered.ndjson and
 * scripts/fixtures/event-order/two-parked-handbacks.ndjson. eve's reducer keys
 * the assistant message by turn id (`${turnId}:assistant`), so EVERY such
 * hand-back in a thread folded into ONE message — the first one's, wherever
 * it sits: the second specialist's answer appeared above every message sent
 * since, inside the first specialist's reply.
 *
 * The continuation still carries its `sequence`, which is the number eve gives
 * every turn (`turn_<sequence>`: the recordings show `turn_0`, the hand-back at
 * sequence 1, then `turn_2` — the id eve skipped). So a `""` turn id becomes
 * `turn_<sequence>`: its own message, in stream order, under the id eve would
 * have sent. An event without a sequence is left as it is.
 */
export function continuationTurnId(turnId: unknown, sequence: unknown): unknown {
  return turnId === "" && typeof sequence === "number" && Number.isInteger(sequence) && sequence >= 0
    ? `turn_${sequence}`
    : turnId;
}

/**
 * A SPECIALIST'S QUESTION GOES TO THE TURN THAT DELEGATED.
 *
 * A question a parked specialist asks is proxied onto the parent's stream with
 * the CHILD's own ids (`turnId: "turn_0"`, `sequence: 0` — recorded in
 * scripts/fixtures/event-order/two-parked-handbacks.ndjson). For the first
 * delegation that happens to be right. For a later one it names a turn that
 * ended long ago, and eve's reducer put the card — answered, it stays in the
 * transcript — into THAT turn's reply, above every message since.
 *
 * A turn that has completed cannot ask anything, so an `input.requested` for a
 * completed turn is re-addressed to the turn running now (the latest to
 * start). A question for a turn still open is left exactly where it is.
 */
const QUESTIONS = "~questions";
type QuestionState = { readonly completed: readonly string[]; readonly latest?: string };
type WithQuestions = { [QUESTIONS]?: QuestionState };

export function withDelegatedQuestions<TData extends object, TEvent extends TurnEvent>(
  base: EventReducer<TData, TEvent>,
): EventReducer<TData, TEvent> {
  return {
    initial: () => base.initial(),
    reduce(data, event) {
      const state: QuestionState = (data as WithQuestions)[QUESTIONS] ?? { completed: [] };
      const payload = (event as { data?: { turnId?: unknown } }).data;
      const turnId = typeof payload?.turnId === "string" ? payload.turnId : undefined;
      let next = state;
      let scoped = event;
      if (turnId !== undefined) {
        if (event.type === "turn.completed") {
          if (!state.completed.includes(turnId)) next = { ...state, completed: [...state.completed, turnId] };
        } else if (event.type === "input.requested") {
          if (state.latest && state.latest !== turnId && state.completed.includes(turnId)) {
            scoped = { ...event, data: { ...payload, turnId: state.latest } } as TEvent;
          }
        } else if (turnId !== state.latest && !state.completed.includes(turnId)) {
          // The first sign of a turn — `turn.started`, or a hand-back's first step.
          next = { ...state, latest: turnId };
        }
      }
      const reduced = base.reduce(data, scoped);
      if (next === state) {
        if (reduced !== data && (reduced as WithQuestions)[QUESTIONS] !== state && (state.latest || state.completed.length)) {
          Object.defineProperty(reduced, QUESTIONS, { value: state, enumerable: false, configurable: true });
        }
        return reduced;
      }
      const out = reduced === data ? copyWithState(data) : reduced;
      Object.defineProperty(out, QUESTIONS, { value: next, enumerable: false, configurable: true });
      return out;
    },
  };
}

export function withSessionEpochs<TData extends object, TEvent extends TurnEvent>(
  reducer: EventReducer<TData, TEvent>,
): EventReducer<TData, TEvent> {
  // Every transcript reducer also gets `withResumedSteps` (and
  // `withDelegatedQuestions` around it), INSIDE the epoch scoping: their state
  // is keyed by the scoped turn id, so a new session's `turn_0` never inherits
  // the old one's.
  const base = withDelegatedQuestions(withResumedSteps(reducer));
  return {
    initial: () => base.initial(),
    reduce(data, raw) {
      let event = raw;
      const sent = (raw as { data?: { turnId?: unknown; sequence?: unknown } }).data;
      if (sent?.turnId === "") {
        const named = continuationTurnId(sent.turnId, sent.sequence);
        if (named !== "") event = { ...raw, data: { ...sent, turnId: named } } as TEvent;
      }
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
      const out = next === data ? copyWithState(data) : next;
      Object.defineProperty(out, EPOCH, { value: { epoch, ended }, enumerable: false, configurable: true });
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
 *    (`turn.failed` / `turn.cancelled` for its `turnId`, its turn completing
 *    AFTER the park, a LATER turn running a step, or the session ended).
 *    Nothing can answer it any more.
 *
 * `session.waiting` is the PARK signal, not an end (see the table in
 * docs/concepts/sessions-runs-and-streaming): it must never kill a request, or
 * every approval would be dead the instant it was asked.
 *
 * Nor does the parked turn's own `turn.completed` BEFORE that park. eve ends a
 * parked turn with its epilogue — the recorded order is `input.requested` →
 * `turn.completed` (same turn) → `session.waiting` — so treating it as the end
 * of the run marked every approval the parent raised "expired" the instant it
 * appeared (live, 2026-09-23; scripts/fixtures/approval-park/). Likewise a
 * later `turn.started` alone proves nothing: a follow-up message that does not
 * answer a pending approval is DEFERRED by eve (harness resolvePendingInput →
 * `deferredMessage`) as a turn with a preamble and an epilogue and NO step, and
 * the approval is still parked. Only a later turn that runs a step shows the
 * batch was resolved — eve clears it before any `step.started`.
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
interface ActionShape {
  readonly kind?: unknown;
  readonly callId?: unknown;
}
interface RequestEventData {
  readonly turnId?: unknown;
  readonly requests?: readonly OpenRequestShape[];
  readonly actions?: readonly ActionShape[];
  readonly result?: { readonly callId?: unknown; readonly kind?: unknown };
}

/**
 * IS THIS REQUEST THE PARENT'S OWN, OR PROXIED UP FROM A DELEGATED CHILD?
 *
 * Every call the PARENT makes is announced as an `actions.requested` carrying
 * that call's id. A delegated child's approval or question is not: eve forwards
 * it onto the parent's stream as a bare `input.requested` whose `action.callId`
 * belongs to the CHILD's tool call, with no `actions.requested` of its own
 * (eve/dist/src/execution/subagent-adapter.js forwards the child's event verbatim
 * through `forwardSubagentInputRequestStep`). So "its call id was never declared
 * here" is the only signal on this stream that distinguishes the two, and it is
 * exact — measured on a recorded delegation stream, where the child's
 * `ask_question` call id appears in `input.requested` and nowhere else
 * (scripts/fixtures/subagent-delivery/child-parks-then-answered.ndjson).
 *
 * This matters because the two are answered through DIFFERENT eve paths. The
 * parent's own request resolves from plain follow-up text server-side; a proxied
 * one does not — eve routes only structured `inputResponses`, keyed by
 * `requestId`, to the child (`routeDeliverPayload` in
 * eve/dist/src/execution/subagent-hitl-proxy.js splits the payload on that field
 * alone and everything else goes to the parent). Text typed at a parked child is
 * therefore not an answer: it is buffered behind the very delegation it was
 * meant to release, and never reaches anybody. Measured 2026-09-23 against the
 * real runtime: after the parent's `input.requested`, a follow-up `message`
 * produced no `message.received`, no new turn, and no result — it vanished with
 * `{"ok":true}` (scripts/fixtures/subagent-delivery/child-parks-never-answered.ndjson).
 *
 * "Not declared here" is only trusted once a `subagent.called` has been seen, so
 * the rule stays dormant in a plain conversation. That guard is not cosmetic: a
 * transcript can legitimately begin AFTER the `actions.requested` that declared
 * a call — a replay from a later index, a compacted cache — and without a child
 * in the picture the parent's own approval would then be misread as proxied and
 * outlive its turn, which is the stale-approval defect running backwards.
 */
export function proxiedChildRequestIds(events: readonly TurnEvent[]): ReadonlySet<string> {
  const declared = new Set<string>();
  const proxied = new Set<string>();
  let sawDelegation = false;
  for (const raw of events) {
    const data = (raw as { data?: RequestEventData }).data;
    if (raw?.type === "subagent.called") {
      sawDelegation = true;
      continue;
    }
    if (raw?.type === "actions.requested") {
      for (const a of data?.actions ?? []) {
        if (typeof a?.callId === "string") declared.add(a.callId);
      }
      continue;
    }
    if (raw?.type !== "input.requested") continue;
    for (const req of data?.requests ?? []) {
      const requestId = typeof req?.requestId === "string" ? req.requestId : undefined;
      if (!requestId) continue;
      const callId = typeof req?.action?.callId === "string" ? req.action.callId : undefined;
      // No call id at all is the parent's own session-limit prompt, not a child's.
      if (sawDelegation && callId !== undefined && !declared.has(callId)) proxied.add(requestId);
    }
  }
  return proxied.size === 0 ? NO_REQUEST_IDS : proxied;
}

export function deadInputRequestIds(events: readonly TurnEvent[]): ReadonlySet<string> {
  /** requestId → the call and turn it belongs to, while it is still answerable. */
  const open = new Map<
    string,
    {
      turnId?: string;
      callId?: string;
      proxied?: boolean;
      /** A `session.waiting` has been seen since it was asked: the turn's epilogue is behind it. */
      parked?: boolean;
      /** A later turn has started since: its first `step.started` means the batch was resolved. */
      superseded?: boolean;
    }
  >();
  const dead = new Set<string>();
  /** Call ids the PARENT declared — see proxiedChildRequestIds for why this is the test. */
  const declared = new Set<string>();
  /** Delegations dispatched minus delegations settled. */
  let liveDelegations = 0;
  /** No child has been started, so nothing on this stream can be proxied from one. */
  let sawDelegation = false;
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
      case "actions.requested": {
        for (const a of data?.actions ?? []) {
          if (typeof a?.callId === "string") declared.add(a.callId);
          if (a?.kind === "subagent-call" || a?.kind === "remote-agent-call") liveDelegations++;
        }
        break;
      }
      case "subagent.called": {
        sawDelegation = true;
        break;
      }
      case "input.requested": {
        for (const req of data?.requests ?? []) {
          const requestId = typeof req?.requestId === "string" ? req.requestId : undefined;
          if (!requestId) continue;
          // A RE-PARK restates the same request (eve mints a fresh token and asks
          // again after a failed answer). It is alive again, whatever happened
          // before — otherwise one bad click would bury a live approval.
          dead.delete(requestId);
          const callId = typeof req?.action?.callId === "string" ? req.action.callId : undefined;
          open.set(requestId, {
            turnId,
            callId,
            proxied: sawDelegation && callId !== undefined && !declared.has(callId),
          });
        }
        break;
      }
      case "action.result": {
        const callId = typeof data?.result?.callId === "string" ? data.result.callId : undefined;
        // A DELEGATION settling retires every question that child still had open.
        // It has to: a proxied request carries the CHILD's turn id and the CHILD's
        // call id, so neither of the two rules below can ever reach it — the
        // parent's `turn.completed` names a different turn, and the delegation's
        // own `action.result` names a different call. Without this, a child that
        // died or was answered elsewhere left a question that looked live for
        // ever, and (since these now hold the send gate) the composer with it.
        // A "reports later" stand-in (lib/detached-delegation.ts) settles nothing: that specialist still works, and
        // its question — proxied here, answered between turns — must stay answerable until its real result comes.
        if (data?.result?.kind === "subagent-result" && !isDetachedResult(data.result)) {
          liveDelegations = Math.max(0, liveDelegations - 1);
          if (liveDelegations === 0) {
            for (const [requestId, req] of [...open]) if (req.proxied) kill(requestId);
          }
        }
        // The gated call RAN (or was denied): its approval was consumed, whether
        // or not this client is the one that answered it.
        if (!callId) break;
        for (const [requestId, req] of [...open]) if (req.callId === callId) kill(requestId);
        break;
      }
      case "turn.completed":
      case "turn.failed":
      case "turn.cancelled": {
        // The turn that was suspended on the request is over. Nothing will pick
        // the answer up. A PROXIED request is exempt: the parent emits this
        // epilogue while the child is still parked (eve's emitProxiedInputRequest
        // calls emitTurnEpilogue so the channel can render the prompt), so the
        // parent's turn ending says nothing about the child's. Killing it here is
        // what made the question unanswerable the instant it was asked.
        //
        // The parent's OWN park has the same epilogue: eve emits `turn.completed`
        // for the parked turn right after `input.requested` and before
        // `session.waiting`. That one is the park, not an end, so a completion
        // only counts once the request has parked. (A failure or cancellation is
        // an end whenever it comes.)
        for (const [requestId, req] of [...open]) {
          if (req.proxied) continue;
          if (type === "turn.completed" && !req.parked) continue;
          if (req.turnId === undefined || turnId === undefined || req.turnId === turnId) {
            kill(requestId);
          }
        }
        break;
      }
      case "turn.started": {
        // A LATER turn started. That alone does not end the park: a message
        // that does not answer a pending approval is DEFERRED behind it (eve's
        // resolvePendingInput → `deferredMessage`) and arrives as a turn with a
        // preamble, an epilogue and no step, the approval still parked. The
        // turn's first `step.started` is the proof (below).
        // eve re-emits `turn.started` for the SAME turn when it replays a turn
        // after a step throws (see retryStormDetected) — same id, still alive.
        // Proxied requests are exempt: they carry a CHILD turn id, so every
        // parent turn looks "later" than them. Only the delegation settling (or
        // the session ending) retires one.
        for (const req of open.values()) {
          if (req.proxied) continue;
          if (req.turnId !== undefined && turnId !== undefined && req.turnId !== turnId) {
            req.superseded = true;
          }
        }
        break;
      }
      case "step.started": {
        // A later turn is RUNNING THE MODEL, so the parked batch is gone: eve
        // resolves (and clears) pending input before any step starts, and a turn
        // it cannot resolve emits no step at all. Covers the answer whose
        // `action.result` never made it into the persisted stream.
        for (const [requestId, req] of [...open]) {
          if (req.proxied) continue;
          const later =
            req.superseded ||
            (req.turnId !== undefined && turnId !== undefined && req.turnId !== turnId);
          if (later) kill(requestId);
        }
        break;
      }
      case "session.waiting": {
        // The PARK. It never kills anything; it only marks that the parked
        // turn's epilogue is behind every request open now.
        for (const req of open.values()) req.parked = true;
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
        break;
    }
  }
  // One shared empty set, so a transcript with no dead requests keeps the same
  // reference on every projection (see withRequestIds for why that matters).
  return dead.size === 0 ? NO_REQUEST_IDS : dead;
}

/** The shape of a message part this projection reads; deliberately structural. */
export interface InputRequestPart {
  readonly type?: string;
  readonly toolName?: string;
  readonly state?: string;
  readonly toolCallId?: string;
  readonly toolMetadata?: {
    readonly eve?: { readonly inputRequest?: unknown; readonly inputResponse?: unknown };
  };
}

/**
 * WHICH REQUESTS BELONG AT THE TAIL OF THE CONVERSATION, ANSWERABLE.
 *
 * Extracted from agent-chat so the decision can be RUN over a recorded stream
 * rather than read. It is the whole of the subagent hand-back defect: the chat
 * used to `continue` here on any proxied child request ("Subagent-proxied
 * approvals live in the rail, never in this thread"), and everything downstream
 * is derived from this list — the answer cards, and `openInputRequests`, which
 * is what `sendGate` counts and what `composerRoute` resolves typed text
 * against. Dropping them here therefore did three things at once:
 *
 *   1. no card, so the only way to answer was to open the Control Panel, find
 *      the run, and wait for its child stream to attach;
 *   2. `sendGate` saw zero pending inputs, so the composer re-opened as if the
 *      chat were idle;
 *   3. `composerRoute` could only return "send", so the operator's typed answer
 *      left as a plain `message` — which eve does NOT route to a parked child
 *      (see proxiedChildRequestIds). It was swallowed in silence.
 *
 * Measured 2026-09-23 against the live deployment: across six sessions, not one
 * declared specialist ever returned a result, while the built-in `agent` tool —
 * which the model calls without ever parking — returned fine. The operator's
 * workaround was to paste the specialist's output into the chat by hand as a
 * 21 KB message.
 *
 * A proxied request is hoisted to the TAIL, not rendered in place, because it
 * carries the child's turn id and eve's reducer therefore attaches it to an
 * earlier assistant message — in place it renders above newer text. That is
 * what this collection was built for; it just refused its own occupants.
 */
export function pendingInputRequestParts(input: {
  readonly messages: readonly { readonly parts?: readonly unknown[] }[];
  readonly dismissed: ReadonlySet<string>;
  readonly responded: ReadonlySet<string>;
  readonly expired: ReadonlySet<string>;
}): InputRequestPart[] {
  const out: InputRequestPart[] = [];
  for (const m of input.messages) {
    for (const p of m.parts ?? []) {
      const part = p as InputRequestPart;
      if (part.type !== "dynamic-tool") continue;
      // The DELEGATION card itself is not a request — it is the running child.
      if (part.toolName?.startsWith("eve:subagent:")) continue;
      // A tool that has already RUN (terminal) is never awaiting approval —
      // even when its inputRequest metadata lingers and no inputResponse was
      // recorded on the part (a write approved via the parent proxy). Without
      // this guard a completed approval-gated write is hoisted to the tail as a
      // DUPLICATE (empty) approval card.
      const terminal =
        part.state === "output-available" ||
        part.state === "output-error" ||
        part.state === "output-denied";
      const pending =
        !terminal &&
        (part.state === "approval-requested" ||
          (Boolean(part.toolMetadata?.eve?.inputRequest) && !part.toolMetadata?.eve?.inputResponse));
      if (!pending) continue;
      const requestId = (part.toolMetadata?.eve?.inputRequest as { requestId?: string } | undefined)
        ?.requestId;
      // Waved away by the operator — never re-hoist it.
      if (requestId && input.dismissed.has(requestId)) continue;
      // Answered cards drop out — UNLESS the answer failed and expired them:
      // an expired card stays, re-rendered as a muted "run has stopped" note.
      // A DEAD request (its run ended on the stream) is kept for the same
      // reason and rendered the same way: the operator sees what was asked and
      // that nothing is waiting on them, rather than a Yes/No that can only
      // fail. It no longer counts towards the send gate — see openInputRequests.
      if (requestId && input.responded.has(requestId) && !input.expired.has(requestId)) continue;
      out.push(part);
    }
  }
  return out;
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

/**
 * The `render-loop` report's detail, inside its 300 characters: WHO was rendering
 * (the census, lib/render-census.ts), WHAT was on screen (the scene), then as much
 * of the error text as fits — "Minified React error #185" says nothing else.
 */
export function renderLoopDetail(message: string, scene: string, census: string): string {
  const head = `renders ${census || "none counted"} — ${scene}`;
  return `${head} — ${message}`.slice(0, 300);
}

/**
 * A MESSAGE THIS CHAT DELIVERED, and where the stream stood when it did.
 *
 * `at` is the ABSOLUTE stream index at the moment of delivery (see
 * `serverEventCount` / `absoluteIndexBase`): the `message.received` that proves
 * the delivery can only appear at or after it.
 */
export interface Delivery {
  /** The text that was POSTed (the `message` eve echoes back in `message.received`). */
  readonly text: string;
  readonly at: number;
  /** `Date.now()` at delivery — only for the escape hatch in `outstandingDeliveries`. */
  readonly sentAt: number;
  /** The eve session it went to. The caller drops deliveries of another session: no ack can come. */
  readonly sessionId?: string | null;
  /**
   * "message" (default): acked by a `message.received` with its text.
   * "answer": an input response — acked once the stream has moved past it
   * (another tab answering a question this tab is showing is learned this way).
   */
  readonly kind?: "message" | "answer";
  /** The queue item this delivery sent (lib/chat-queue) — never sent again by any tab. */
  readonly itemId?: string;
}

/**
 * How long a delivery may stay unseen before it stops holding anything.
 *
 * Only an escape hatch: a message eve buffered behind a specialist that is
 * parked on a question can legitimately wait until the question is answered,
 * but a gate that holds for ever because one `message.received` was never seen
 * is the very "stuck" this exists to end. Stop clears deliveries at once.
 */
export const DELIVERY_MAX_AGE_MS = 15 * 60_000;

const normalizeMessageText = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The texts a `message.received` can be matched on: eve's `data.message` (which
 * for multi-part content is a SUMMARY with `[file: …]` lines, see eve's
 * `summarizeUserContent`) and the plain join of its text parts.
 */
function receivedTexts(event: TurnEvent): readonly string[] {
  const data = (event as { data?: { message?: unknown; parts?: readonly { type?: string; text?: string }[] } })
    .data;
  const out: string[] = [];
  if (typeof data?.message === "string") out.push(normalizeMessageText(data.message));
  const parts = Array.isArray(data?.parts) ? data.parts : [];
  const joined = parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
  if (joined) out.push(normalizeMessageText(joined));
  return out;
}

/**
 * HAS THIS MESSAGE ALREADY ARRIVED? — for a message the SERVER sent from the chat's queue
 * (lib/chat-queue-drain.ts). A tab learns such a delivery after the fact (a refresh of the queue), possibly after it
 * has already read the turn it started; recording it as owed then would hold the chat on "delivering" for fifteen
 * minutes waiting for a `message.received` that is already on screen. Only receipts at or after `sinceMs` (eve's
 * own event stamp, with a minute's slack) count, so an identical earlier message is not mistaken for this one.
 */
export function receivedSince(events: readonly TurnEvent[], text: string, sinceMs: number): boolean {
  const want = normalizeMessageText(text);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as TurnEvent & { meta?: { at?: string } };
    if (e?.type !== "message.received") continue;
    const at = Date.parse(e.meta?.at ?? "");
    if (Number.isFinite(at) && at < sinceMs - 60_000) return false;
    if (receivedTexts(e).includes(want)) return true;
  }
  return false;
}

/**
 * WHICH OF OUR MESSAGES HAS EVE NOT STARTED YET?
 *
 * THE DEFECT. "When I send a second message, only then does it load the second
 * message" — and, when something is stuck, "the messages keep getting stacked
 * and unanswered messages cannot be deleted". Both reproduced against the real
 * eve runtime (scripts/fixtures/buffered-turns):
 *
 *  - eve answers `200 {ok:true}` to a message sent while a turn is RUNNING, or
 *    while a delegated specialist is PARKED on a question, and emits NOTHING for
 *    it. It is buffered, and runs as a turn of its own after the next
 *    `session.waiting` — so ONE delivery (the answer that un-parks the
 *    specialist, or the message that was running) produces TWO boundaries.
 *  - both readers stop at the FIRST boundary: eve's send-path reader
 *    (`ClientSession` in node_modules/eve/dist/src/client/session.js breaks on
 *    `isCurrentTurnBoundaryEvent`) and this app's `readLiveTail`. And
 *    `attachDecision` / `sendGate` read a `session.waiting` tail as "at rest".
 *    So nothing read the buffered turn. The next send opened a stream at the
 *    stale cursor, read THAT reply, and stopped at its boundary — one reply
 *    behind for the rest of the session.
 *
 * The transcript alone cannot tell "at rest" from "a buffered turn is about to
 * start": the boundary looks the same. What can tell them apart is what this
 * chat SENT. A delivery is outstanding until a `message.received` carrying its
 * text appears at or after the index it was sent at; matched in order, one
 * `message.received` per delivery, so two identical messages need two.
 *
 * Deliveries older than `maxAgeMs` are dropped rather than held for ever.
 */
export function outstandingDeliveries(input: {
  readonly deliveries: readonly Delivery[];
  /** Server events of the transcript (client.* markers are skipped, as for the index). */
  readonly events: readonly TurnEvent[];
  /** The mount's absolute-index deficit — see `absoluteIndexBase`. */
  readonly indexBase?: number;
  readonly now?: number;
  readonly maxAgeMs?: number;
}): readonly Delivery[] {
  if (input.deliveries.length === 0) return input.deliveries;
  const base = input.indexBase ?? 0;
  const received: { index: number; texts: readonly string[] }[] = [];
  /** Where the session ENDED for good: nothing delivered before it will ever be acked. */
  const ended: number[] = [];
  /** Every session boundary — an answer is owed until the reply it resumed reaches one. */
  const boundaries: number[] = [];
  let index = base;
  for (const event of input.events) {
    if (event?.type?.startsWith("client.")) continue;
    if (event?.type === "message.received") received.push({ index, texts: receivedTexts(event) });
    if (event?.type === "session.completed" || event?.type === "session.failed") ended.push(index);
    if (isSessionBoundary(event)) boundaries.push(index);
    index += 1;
  }
  const used = new Set<number>();
  const now = input.now ?? Date.now();
  const maxAge = input.maxAgeMs ?? DELIVERY_MAX_AGE_MS;
  const out: Delivery[] = [];
  for (const d of [...input.deliveries].sort((a, b) => a.at - b.at)) {
    // The session this was delivered to is over: eve will never run it.
    if (ended.some((e) => e >= d.at)) continue;
    if (d.kind === "answer") {
      // Settled once the reply it RESUMED has reached a boundary. Not at the
      // first event past it: a resumed reply has no `turn.started`, so the
      // transcript reads "at rest" all the way through it, and dropping the
      // reader at its first event left the rest to a replay after the end —
      // no live text, and no Stop while it ran (review, `stopresumed`).
      if (boundaries.some((b) => b >= d.at)) continue;
      if (now - d.sentAt > maxAge) continue;
      out.push(d);
      continue;
    }
    const want = normalizeMessageText(d.text);
    const hit = received.findIndex(
      (r, i) => !used.has(i) && r.index >= d.at && (want === "" || r.texts.includes(want)),
    );
    if (hit >= 0) {
      used.add(hit);
      continue;
    }
    if (now - d.sentAt > maxAge) continue;
    out.push(d);
  }
  return out.length === input.deliveries.length ? input.deliveries : out;
}

/**
 * THE READER DOES NOT GIVE UP ON A TURN THAT IS STILL RUNNING.
 *
 * Live telemetry (example_app, since 2026-09-20): "Chat stream ended mid-turn
 * and stopped resuming" ×10 (last event message.appended ×5, reasoning.appended
 * ×3, actions.requested ×2) against four reattaches, one of which carried a turn
 * from index 1742 to 2114. A reader that fails `ATTACH_BUDGET` times used to be
 * the END: `attachDecision` then answered "open-failed" for the rest of the
 * turn, the poll's own resync budget ran out behind it, and the reply appeared
 * only when the next send opened a stream — i.e. "only after I send another
 * message".
 *
 * So a spent budget is a PAUSE, not a verdict: the component re-arms a fresh
 * round after this delay for as long as the turn is unfinished (or a delivery is
 * outstanding). Every open still costs an ownership-gated database read, so the
 * rounds back off — 5s, 10s, 20s, 40s, then once a minute — which bounds a dead
 * connection at one open a minute instead of zero reads for ever.
 */
export function attachRetryDelayMs(round: number): number {
  const r = Math.max(0, Math.floor(round));
  return Math.min(5_000 * 2 ** r, 60_000);
}

/**
 * A LIVE SPECIALIST'S QUESTION CANNOT BE WAVED AWAY.
 *
 * "Dismiss — the run has moved past this" exists for a request whose run is
 * over. A proxied request from a specialist that is still delegated is the
 * opposite: eve buffers EVERY message behind that delegation until the question
 * is answered (it emits nothing for them), so dismissing it opened the send gate
 * onto a session that could only swallow what was typed. Reproduced in the real
 * UI: dismiss, type, and each message sat under "Working…" with no reply and no
 * way to remove it.
 *
 * Returns the dismissals that may count: every one, minus the live proxied
 * requests (a proxied request retires on its own when the delegation settles —
 * see `deadInputRequestIds`).
 */
export function effectiveDismissals(
  dismissed: ReadonlySet<string>,
  events: readonly TurnEvent[],
): ReadonlySet<string> {
  if (dismissed.size === 0) return dismissed;
  const proxied = proxiedChildRequestIds(events);
  if (proxied.size === 0) return dismissed;
  const dead = deadInputRequestIds(events);
  const live = [...proxied].filter((id) => !dead.has(id));
  return withoutRequestIds(dismissed, live);
}

/**
 * IS THERE A WAY OUT OF THIS HOLD?
 *
 * The composer shows Stop only while the eve STORE is reading, but most of the
 * holds that feel stuck have the store idle: a detached turn, a turn parked on a
 * question nobody means to answer, a message eve is still holding. Each of them
 * gets a visible Stop that cancels server-side (eve's cancel is cooperative:
 * `turn.cancelled` → `session.waiting`, or — for a parked specialist — the
 * delegation is simply dropped and any buffered message then runs) and releases
 * the queue.
 *
 * `awaiting-input` only when something is actually waiting behind it (a queued
 * message): an ordinary question with an empty composer is not stuck.
 */
export function stopAvailable(input: {
  readonly gate: SendGate;
  readonly storeBusy: boolean;
  readonly readOnly?: boolean;
  readonly queued?: number;
  /**
   * The question on screen is a delegated SPECIALIST's. Its delegation may never
   * settle (a dead child), and it cannot be dismissed — so Stop is the way out.
   */
  readonly specialistWaiting?: boolean;
}): boolean {
  if (input.readOnly || input.storeBusy || !input.gate.hold) return false;
  if (input.gate.reason === "awaiting-input") return (input.queued ?? 0) > 0 || Boolean(input.specialistWaiting);
  return input.gate.reason === "detached" || input.gate.reason === "delivering";
}

/**
 * WHICH TURN A STOP IS AIMED AT — the one THIS TAB is showing, never "whatever
 * is running", and never a guess.
 *
 * eve's cancel route takes a `turnId` and ignores a cancel for any other turn
 * (measured against the real runtime: a mismatched id answers 202 and changes
 * nothing; the matching one ends the turn, or drops a parked delegation). An
 * untargeted cancel is session-wide, which is how a Stop pressed in a second tab
 * — showing an old park — cancelled the newer turn the first tab had started.
 *
 *  - an unfinished turn on the tail: that turn;
 *  - a reply that RESUMED after an answered question (events after the park's
 *    `session.waiting`, no new `turn.started`): the parked turn — `resumed`,
 *    because eve then emits no `turn.cancelled`;
 *  - a park (a question just before the boundary): the parked turn;
 *  - at rest: NOTHING. Real turn ids are not `last + 1` (a deferred message, a
 *    resumed delegation and a retried step all break that), so a Stop at rest
 *    only releases what this tab is holding and cancels nothing.
 */
export function stopTarget(events: readonly TurnEvent[]): {
  readonly turnId?: string;
  readonly resumed?: boolean;
  readonly parked?: boolean;
  /**
   * A resumed reply's OWN turn, as the transcript names it — where its "Stopped."
   * goes. The cancel still aims at `turnId` (the parked turn, what eve's cancel
   * route matches), but the reply a parked specialist hands back arrives with
   * `turnId: ""` and is projected as `turn_<sequence>` (`continuationTurnId`), so
   * a note keyed to the parked turn was said ABOVE the reply that was stopped.
   */
  readonly replyTurnId?: string;
} {
  let turnId: string | undefined;
  let started = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; data?: { turnId?: unknown } };
    if (e?.type !== "turn.started") continue;
    started = i;
    turnId = typeof e.data?.turnId === "string" ? e.data.turnId : undefined;
    break;
  }
  if (started < 0 || !turnId) return {};
  if (turnUnfinished(events)) return { turnId };
  let boundary = -1;
  for (let i = events.length - 1; i > started; i--) {
    if (isSessionBoundary(events[i])) {
      boundary = i;
      break;
    }
  }
  if (boundary < 0) return {};
  const after = events.slice(boundary + 1).filter((e) => !e?.type?.startsWith("client."));
  if (after.length > 0 && !after.some((e) => e?.type === "turn.started")) {
    let replyTurnId: string | undefined;
    for (const e of after) {
      const d = (e as { data?: { turnId?: unknown; sequence?: unknown } }).data;
      const named = continuationTurnId(d?.turnId, d?.sequence);
      if (typeof named === "string" && named && named !== turnId && typeof d?.turnId === "string") {
        replyTurnId = named;
        break;
      }
    }
    return { turnId, resumed: true, ...(replyTurnId ? { replyTurnId } : {}) };
  }
  const beforeBoundary = events.slice(Math.max(started, boundary - 4), boundary).map((e) => e?.type);
  if (beforeBoundary.includes("input.requested")) return { turnId, parked: true };
  return {};
}

/**
 * Delegations dispatched and not settled: `subagent.called` with no subagent-result for its call. A delegation handed
 * over as "reports later" (lib/detached-delegation.ts) is still live, marked `detached`: it works on while the main
 * thread goes on, and reports by itself.
 */
export function liveDelegations(events: readonly TurnEvent[]): { callId: string; name: string; detached?: true }[] {
  const live = new Map<string, { name: string; detached?: true }>();
  for (const raw of events) {
    const e = raw as { type?: string; data?: { callId?: unknown; name?: unknown; result?: { callId?: unknown; kind?: unknown } } };
    if (e?.type === "subagent.called" && typeof e.data?.callId === "string") {
      live.set(e.data.callId, { name: typeof e.data.name === "string" ? e.data.name : "specialist" });
    } else if (e?.type === "action.result" && typeof e.data?.result?.callId === "string") {
      const callId = e.data.result.callId;
      const held = live.get(callId);
      if (isDetachedResult(e.data.result)) {
        if (held) live.set(callId, { name: held.name, detached: true });
      } else live.delete(callId);
    }
  }
  return [...live].map(([callId, d]) => ({ callId, name: d.name, ...(d.detached ? { detached: true as const } : {}) }));
}

/**
 * WHICH SPECIALISTS IS THE PARENT WAITING ON, with nothing asked of the person?
 *
 * After a delegated specialist's question is answered, the parent's stream is
 * SILENT until the child hands back: the child resumes on its own session, and
 * the parent says nothing until `subagent.completed` → `action.result`
 * (`subagent-result`) → the orchestrator's next step (recorded:
 * scripts/fixtures/subagent-delivery/child-parks-then-answered.ndjson). The
 * same is true before the first question, while the child simply works.
 *
 * That silence is the EXPECTED state, and two things need to know it: the live
 * reader, which must not take a quiet seam for a failure (`readLiveTail`'s
 * `quietExpected`), and the status line, which should say who is working
 * rather than read as a stall. Empty while a question is open — then the
 * person, not a specialist, is what the turn is waiting on.
 */
export function awaitingSpecialists(input: {
  readonly events: readonly TurnEvent[];
  /** Questions/approvals on screen that nobody has answered yet. */
  readonly openRequests: number;
}): { callId: string; name: string; detached?: true }[] {
  if (input.openRequests > 0) return [];
  return liveDelegations(input.events);
}

/** "investor-presentations" → "Investor Presentations": a specialist's tool name, said as a name. */
export function specialistDisplayName(name: string): string {
  const words = name.replace(/[-_]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return name;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * What the status line says while a specialist works and the main thread waits
 * for it — named, so a quiet stream reads as work in progress, not a stall.
 */
export function specialistWorkingLine(names: readonly string[], finished: readonly string[] = [], reportsLater: readonly string[] = []): string {
  // `liveDelegations` says "specialist" when the event carried no name.
  const unique = [...new Set(names.map((n) => n.trim()).filter((n) => n && n !== "specialist"))];
  const done = [...new Set(finished.map((n) => n.trim()).filter((n) => n && n !== "specialist"))];
  const later = [...new Set(reportsLater.map((n) => n.trim()).filter((n) => n && n !== "specialist"))];
  // Handed over as "reports later" (lib/detached-delegation.ts): the main thread is not waiting on these.
  if (later.length > 0 && unique.length === 0 && done.length === 0) {
    return `${later.map(specialistDisplayName).join(", ")} ${later.length === 1 ? "is" : "are"} still working — ${later.length === 1 ? "its result comes" : "their results come"} back to the main agent by itself.`;
  }
  if (done.length > 0 && unique.length > 0) {
    // Specialists called together hand back together (see `handbackStates`): say who is done and who is not, so
    // a finished specialist with nothing on the main thread reads as held, not lost.
    const still = unique.map(specialistDisplayName).join(", ");
    const ready = done.map(specialistDisplayName).join(", ");
    return `${ready} ${done.length === 1 ? "has" : "have"} finished; ${still} ${unique.length === 1 ? "is" : "are"} still working. Specialists called together hand back together — the main thread continues here by itself when ${unique.length === 1 ? "it does" : "they do"}.`;
  }
  if (unique.length === 0) return "Still working — a specialist is running. The rest of the reply will appear here when it finishes.";
  if (unique.length === 1) {
    return `The ${specialistDisplayName(unique[0])} specialist is working — the main thread continues here when it hands back.`;
  }
  return `${unique.length} specialists are working (${unique.map(specialistDisplayName).join(", ")}) — the main thread continues here when they hand back.`;
}

/** A delegation as the Control Panel knows it: the parent's view (`status`) and which child session it is. */
export interface DelegationView {
  readonly callId: string;
  readonly name: string;
  /** "running" until the parent's stream carries this delegation's result. */
  readonly status: string;
  readonly childSessionId?: string | null;
  /** Handed over as "reports later" (lib/detached-delegation.ts): its result comes back by itself, never held, never lost. */
  readonly detached?: boolean;
}

/** What a child's own stream says, as the Control Panel follows it. */
export interface ChildFeedView {
  /** The child's session ended (`session.completed`). */
  readonly completed?: boolean;
  /** The child's final assistant text. */
  readonly result?: string;
}

/**
 * A SPECIALIST THAT HAS FINISHED WHILE THE MAIN THREAD HAS NOT HEARD FROM IT: held, or lost?
 *
 * eve hands a parent the results of ONE STEP'S delegations TOGETHER: `resolvePendingRuntimeActions`
 * (eve/dist/src/harness/runtime-actions.js) emits `subagent.completed` / `action.result` only when every delegation
 * of the batch has returned ("eve runs the batch concurrently and returns every result", docs/subagents.mdx).
 * Measured on a live deployment, 2026-10-05: two specialists called together, one finished in 4 s, the other was still
 * working six minutes later — and the parent's stream had said nothing about the first. That is `held`: the result
 * is safe inside the waiting turn and arrives by itself with its siblings'.
 *
 * The chat used to call exactly that a hand-off that "didn't reach the chat" and offer **Bring result into chat**,
 * which CANCELS the waiting turn — and with it every sibling still working (39 minutes of a filing specialist's work,
 * 2026-10-04) — and makes the main agent start again from a pasted message. So:
 *
 *   held   finished, and at least one other delegation the parent still waits for is NOT finished. Nothing to do.
 *   lost   finished, and so is everything else the parent waits for, yet the parent has no result: eve's own
 *          hand-back did not land. Only this is offered the manual rescue.
 *
 * A delegation whose child cannot be seen (no feed yet) counts as not finished: never call a wait a loss.
 *
 * With the root's `subagents: { batch: "detach" }` (mold_v1-184) eve no longer holds a finished result behind a sibling
 * for long: it hands the batch over once one result is in and another waits on the person (or after 10 s), each one
 * still out as "reports later", and brings that one's result back as a turn of its own when it finishes. Such a
 * delegation (`detached`) is neither held nor lost: it is `reportsLater`, and never offered the rescue.
 */
export function handbackStates(
  delegations: readonly DelegationView[],
  feeds: Readonly<Record<string, ChildFeedView | undefined>>,
): {
  lost: { callId: string; name: string; result: string }[];
  held: { callId: string; name: string }[];
  /** Handed over as "reports later": eve brings the result back as a turn of its own. Never offered the rescue. */
  reportsLater: { callId: string; name: string }[];
} {
  const reportsLater = delegations.filter((d) => d.status === "running" && d.detached).map(({ callId, name }) => ({ callId, name }));
  const waiting = delegations.filter((d) => d.status === "running" && !d.detached);
  const finished: { callId: string; name: string; result: string }[] = [];
  let unfinished = 0;
  for (const d of waiting) {
    const feed = d.childSessionId ? feeds[d.childSessionId] : undefined;
    const result = feed?.completed ? (feed.result ?? "").trim() : "";
    if (feed?.completed && result) finished.push({ callId: d.callId, name: d.name, result });
    else unfinished += 1;
  }
  if (unfinished > 0) return { lost: [], held: finished.map(({ callId, name }) => ({ callId, name })), reportsLater };
  return { lost: finished, held: [], reportsLater };
}

/** The browser-only marker a Stop leaves in the transcript (persisted with it, like `client.input.responded`). */
export const STOPPED_MARKER = "client.turn.stopped";

/**
 * The browser-made markers a transcript must CARRY across every open — a full
 * replay and a shared-thread open included. The server stream has never heard
 * of them, so an open that keeps only one kind loses the other: a Stop's marker
 * dropped this way brought the specialist back as "Running" and the question
 * back as live, holding the composer.
 */
export function isPersistedMarker(event: unknown): boolean {
  const type = (event as { type?: unknown })?.type;
  return type === "client.input.responded" || type === STOPPED_MARKER;
}

export function stoppedMarker(input: {
  readonly requestIds: readonly string[];
  readonly delegations: readonly { callId: string; name: string }[];
  readonly at: number;
  /** The turn the Stop ended — its reply gets the "Stopped." note. */
  readonly turnId?: string;
}): TurnEvent & {
  data: { requestIds: string[]; delegations: { callId: string; name: string }[]; at: number; turnId?: string };
} {
  return {
    type: STOPPED_MARKER,
    data: {
      requestIds: [...input.requestIds],
      delegations: [...input.delegations],
      at: input.at,
      ...(input.turnId ? { turnId: input.turnId } : {}),
    },
  };
}

/**
 * WHICH REPLIES WERE STOPPED, and by whom — turn id → the note shown under
 * that reply. From eve's `turn.cancelled` and from this app's own Stop markers
 * (eve reports neither a stopped resumed reply nor a dropped delegation). The
 * note stays in the conversation's history; `mine` is the turns this tab
 * stopped, so the others read "from another tab or device".
 */
export function stoppedTurnNotes(
  events: readonly TurnEvent[],
  mine: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, string> {
  const notes = new Map<string, string>();
  for (const raw of events) {
    const e = raw as { type?: string; data?: { turnId?: unknown } };
    const turnId = typeof e?.data?.turnId === "string" ? e.data.turnId : undefined;
    if (!turnId) continue;
    if (e.type === STOPPED_MARKER) {
      // A Stop that discarded a specialist says so on that specialist's tile.
      const discarded = (e.data as { delegations?: unknown[] } | undefined)?.delegations?.length ?? 0;
      if (discarded === 0) notes.set(turnId, "Stopped.");
      continue;
    }
    else if (e.type === "turn.cancelled" && !notes.has(turnId)) {
      notes.set(turnId, mine.has(turnId) ? "Stopped." : "Stopped from another tab or device.");
    }
  }
  return notes;
}

/**
 * Did this turn put NOTHING of its own on screen — no text, no thinking, no
 * tool? Such a turn's Stop is recorded as a marker too (`stoppedMarker`), not
 * left to eve's `turn.cancelled` alone: the note is then carried with the
 * chat's persisted markers (client_markers), so every open and every device
 * says it, whatever the stream held when the transcript was cached.
 */
export function turnShowedNothing(events: readonly TurnEvent[], turnId: string): boolean {
  for (const raw of events) {
    const e = raw as {
      type?: string;
      data?: { turnId?: unknown; messageSoFar?: unknown; message?: unknown; reasoningSoFar?: unknown; reasoning?: unknown };
    };
    if (e?.data?.turnId !== turnId) continue;
    switch (e.type) {
      case "actions.requested":
      case "input.requested":
      case "authorization.required":
        return false;
      case "message.appended":
        if (typeof e.data.messageSoFar === "string" && e.data.messageSoFar.trim()) return false;
        break;
      case "message.completed":
        if (typeof e.data.message === "string" && e.data.message.trim()) return false;
        break;
      case "reasoning.appended":
        if (typeof e.data.reasoningSoFar === "string" && e.data.reasoningSoFar.trim()) return false;
        break;
      case "reasoning.completed":
        if (typeof e.data.reasoning === "string" && e.data.reasoning.trim()) return false;
        break;
    }
  }
  return true;
}

/**
 * WHERE EACH "Stopped." NOTE IS SAID — under the last thing its turn put on
 * screen, in the conversation's history.
 *
 * The note used to go only under the turn's ASSISTANT message. A turn stopped
 * before it streamed anything has an assistant message with nothing to show
 * (eve's reducer makes one from `step.started` / `turn.cancelled`, holding only
 * a `step-start`), and a message that renders nothing is dropped whole — note
 * and all. So the note was said above the composer instead, only until the
 * next turn, and a reopened chat had nowhere to say it at all (live check
 * 2026-09-25, mold_v1-125). The host is now the LAST message of the turn that
 * renders something: the reply if it has any content, else the person's own
 * message. `rendersContent` is the view's own test (AgentMessage's), so a
 * host is never a message that will not render.
 *
 * Returns message id → note. A turn none of whose messages is on screen (an
 * optimistic bubble eve has not numbered yet) has no host: the caller says it
 * above the composer, as before.
 */
export function stoppedNoteHosts<M extends { readonly id: string; readonly metadata?: { readonly turnId?: string } | undefined }>(
  messages: readonly M[],
  notes: ReadonlyMap<string, string>,
  rendersContent: (message: M) => boolean,
): ReadonlyMap<string, string> {
  const hosts = new Map<string, string>();
  if (notes.size === 0) return hosts;
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const turnId = m.metadata?.turnId;
    if (!turnId || seen.has(turnId)) continue;
    const note = notes.get(turnId);
    if (note === undefined || !rendersContent(m)) continue;
    seen.add(turnId);
    hosts.set(m.id, note);
  }
  return hosts;
}

/**
 * What Stop retired, read back from the transcript — so a reload still knows
 * the question is not waiting and the specialist's tile is not "Running".
 */
export function stoppedFromEvents(events: readonly TurnEvent[]): {
  readonly requestIds: ReadonlySet<string>;
  readonly delegations: ReadonlyMap<string, string>;
  /** requestId → the specialist(s) whose work the same Stop discarded, for the card's note. */
  readonly requestNames: ReadonlyMap<string, string>;
  /** The absolute stream index of the newest Stop (-1: none) — for the "Stopped." note. */
  readonly latestAt: number;
} {
  let latestAt = -1;
  const requestIds = new Set<string>();
  const delegations = new Map<string, string>();
  const requestNames = new Map<string, string>();
  for (const raw of events) {
    const e = raw as { type?: string; data?: { requestIds?: unknown; delegations?: unknown } };
    if (e?.type !== STOPPED_MARKER) continue;
    const at = (e.data as { at?: unknown } | undefined)?.at;
    if (typeof at === "number") latestAt = Math.max(latestAt, at);
    for (const id of Array.isArray(e.data?.requestIds) ? e.data.requestIds : []) if (typeof id === "string") requestIds.add(id);
    const names: string[] = [];
    for (const d of Array.isArray(e.data?.delegations) ? e.data.delegations : []) {
      const dd = d as { callId?: unknown; name?: unknown };
      if (typeof dd?.callId !== "string") continue;
      const name = typeof dd.name === "string" ? dd.name : "specialist";
      delegations.set(dd.callId, name);
      names.push(name);
    }
    for (const id of Array.isArray(e.data?.requestIds) ? e.data.requestIds : []) {
      if (typeof id === "string") requestNames.set(id, names.join(", ") || "specialist");
    }
  }
  return { requestIds: requestIds.size ? requestIds : NO_REQUEST_IDS, delegations, requestNames, latestAt };
}

/**
 * THE LIVE READER'S RE-ARMING HAS AN END.
 *
 * `attachRetryDelayMs` backs off to once a minute; without a ceiling a dead turn
 * kept every open tab reconnecting once a minute for ever. After this many
 * rounds (≈ ten minutes) the chat stops on its own and offers "Reconnect".
 */
export const ATTACH_MAX_ROUNDS = 13;
export function attachRearmAllowed(round: number, hidden: boolean, turnRunning = false): boolean {
  // A HIDDEN tab keeps reading a turn that is still RUNNING: that is the tab the person comes back to, and a
  // background tab that stopped reading met them with a stale reply. It is still capped (this function's rounds),
  // and an idle hidden tab — nothing running — is never re-armed, which is what #59 stopped.
  return round < ATTACH_MAX_ROUNDS && (!hidden || turnRunning);
}

/**
 * UN-ANSWER the requests whose answer the server REFUSED.
 *
 * eve's store records an answer in its own data the moment it is sent (the
 * reducer's `respondToInputRequest`: state `approval-responded`, an
 * `inputResponse`), and nothing takes it back when the POST is refused — so the
 * card read "answered" while nothing was. This restores those parts to exactly
 * what `input.requested` made them (`approval-requested`, no response), so the
 * question is live and answerable again.
 */
export function withoutResponses<M extends { parts?: readonly unknown[] }>(
  messages: readonly M[],
  requestIds: ReadonlySet<string>,
): readonly M[] {
  if (requestIds.size === 0) return messages;
  let changed = false;
  const out = messages.map((m) => {
    let touched = false;
    const parts = (m.parts ?? []).map((p) => {
      const part = p as {
        state?: string;
        approval?: unknown;
        toolMetadata?: { eve?: { inputRequest?: { requestId?: string }; inputResponse?: unknown } & Record<string, unknown> };
      };
      const rid = part.toolMetadata?.eve?.inputRequest?.requestId;
      if (!rid || !requestIds.has(rid) || !part.toolMetadata?.eve?.inputResponse) return p;
      touched = true;
      const { inputResponse: _gone, ...eve } = part.toolMetadata.eve;
      void _gone;
      return { ...part, state: "approval-requested", approval: { id: rid }, toolMetadata: { ...part.toolMetadata, eve } };
    });
    if (!touched) return m;
    changed = true;
    return { ...m, parts };
  });
  return changed ? out : messages;
}

/**
 * Fold the answers THIS CHAT gave into the view — the same change eve's reducer
 * makes for `client.input.responded` (state `approval-responded`, an
 * `inputResponse`). Answers are posted by the app itself (so a refusal can be
 * told from a later stream failure), which means the store never records them;
 * without this a typed answer would vanish from the thread until a reload.
 */
export function withResponses<M extends { parts?: readonly unknown[] }>(
  messages: readonly M[],
  answers: Readonly<Record<string, { readonly requestId: string; readonly optionId?: string; readonly text?: string }>>,
): readonly M[] {
  if (Object.keys(answers).length === 0) return messages;
  let changed = false;
  const out = messages.map((m) => {
    let touched = false;
    const parts = (m.parts ?? []).map((p) => {
      const part = p as {
        toolMetadata?: { eve?: { inputRequest?: { requestId?: string }; inputResponse?: unknown } & Record<string, unknown> };
      };
      const rid = part.toolMetadata?.eve?.inputRequest?.requestId;
      const answer = rid ? answers[rid] : undefined;
      if (!rid || !answer || part.toolMetadata?.eve?.inputResponse) return p;
      touched = true;
      return {
        ...part,
        state: "approval-responded",
        approval: { id: rid, ...(answer.text !== undefined ? { reason: answer.text } : {}) },
        toolMetadata: { ...part.toolMetadata, eve: { ...part.toolMetadata!.eve, inputResponse: answer } },
      };
    });
    if (!touched) return m;
    changed = true;
    return { ...m, parts };
  });
  return changed ? out : messages;
}

/**
 * May an answer POST be tried again? Only eve's own retryable case
 * (`isRetryableDeliveryFailure` in its client): a 500 "target session was not
 * found", which is what answering just as the question parks can meet.
 * Anything else is an answer — accepted, refused, or unknown — and is decided
 * once.
 */
export function answerPostRetryable(status: number, body: string): boolean {
  return status === 500 && /target session was not found/i.test(body);
}

/** What one chat's markers may weigh: sent by the browser, and accepted by the server. */
export const MARKERS_MAX_BYTES_CLIENT = 16_000;
export const MARKERS_MAX_BYTES_SERVER = 32_000;
const ANSWER_TEXT_MAX = 300;

/**
 * ONE CHAT'S MARKERS, CAPPED BY BYTES — never a reason to refuse anything.
 *
 * Only the persisted kinds (`isPersistedMarker`) are kept. Stops come first:
 * they are small and they are what keeps a stopped specialist "Stopped" on
 * another device. An answer marker's typed text is trimmed (the answer already
 * lives in eve's own transcript; the marker only has to say the question was
 * answered). Then the newest are kept until the cap, in their original order.
 * A single 33 KB answer used to get a whole chat-list sync rejected (400), and
 * with it every other chat's title and archive state.
 */
export function capMarkers(markers: readonly unknown[], maxBytes: number): unknown[] {
  const trimmed = markers.filter(isPersistedMarker).map((m) => {
    const e = m as { type?: string; data?: { responses?: unknown } };
    if (e.type !== "client.input.responded" || !Array.isArray(e.data?.responses)) return m;
    return {
      ...e,
      data: {
        ...e.data,
        responses: e.data.responses.map((r) => {
          const rr = r as { text?: unknown };
          return typeof rr?.text === "string" && rr.text.length > ANSWER_TEXT_MAX
            ? { ...rr, text: `${rr.text.slice(0, ANSWER_TEXT_MAX)}…` }
            : r;
        }),
      },
    };
  });
  const keep = new Set<number>();
  let bytes = 2;
  const take = (want: (m: unknown) => boolean) => {
    for (let i = trimmed.length - 1; i >= 0; i--) {
      if (keep.has(i) || !want(trimmed[i])) continue;
      const size = JSON.stringify(trimmed[i]).length + 1;
      if (bytes + size > maxBytes) continue;
      bytes += size;
      keep.add(i);
    }
  };
  take((m) => (m as { type?: string }).type === STOPPED_MARKER);
  take(() => true);
  return trimmed.filter((_, i) => keep.has(i));
}
