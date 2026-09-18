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
