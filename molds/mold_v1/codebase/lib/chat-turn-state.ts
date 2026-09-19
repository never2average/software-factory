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

/** What the queue header says. Honest about WHY the message has not gone. */
export function holdLabel(reason: HoldReason | null, specialistRunning = false): string {
  switch (reason) {
    case "detached":
      return specialistRunning
        ? "Still working — a specialist is running. Queued messages send when it finishes."
        : "Still working — the earlier reply is continuing on the server. Queued messages send when it finishes.";
    case "awaiting-input":
      return "Queued — sends after you answer the request above";
    default:
      return "Queued — sending after the current reply";
  }
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
