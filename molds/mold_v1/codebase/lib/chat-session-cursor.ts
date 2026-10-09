/**
 * The session cursor a chat is mounted on, repaired from the stream — and NOT
 * repaired when the session it points at is dead.
 *
 * A session parked on user input carries its resume token on the latest
 * `session.waiting` EVENT, while the store's `session` cursor only advances at a
 * clean turn boundary, so a hand-off can arrive WITHOUT the token. Resuming from
 * such a cursor sends an empty continuationToken, which eve rejects ("Missing or
 * empty 'continuationToken' field") and the next message is lost. Backfilling it
 * from the stream is what this function is for.
 *
 * WHY IT WALKS TO THE LAST BOUNDARY INSTEAD OF THE LAST `session.waiting`
 *
 * It used to scan backwards for the newest `session.waiting` carrying a token
 * and stop there. After a turn ends on `session.failed` that scan sails straight
 * past the failure and finds the token from an EARLIER park of the session that
 * has just died — so a cursor that was deliberately emptied gets its dead token
 * put back, the next message posts to a finished session with a spent token, and
 * the reader is told "The connection to the agent dropped."
 *
 * eve already owns this rule. `advanceSession`
 * (node_modules/eve/dist/src/client/session-utils.js) takes the LAST
 * `isCurrentTurnBoundaryEvent` — `session.waiting`, `session.completed` or
 * `session.failed` — and returns `createInitialSessionState()` (no id, no token)
 * for anything but a park. Two places deciding "is this session still
 * resumable" by two different rules is how the repair came to undo the reset;
 * this applies eve's own answer, so there is one rule.
 *
 * Dependency-free on purpose: it is mounted from a client component but the rule
 * is executed in scripts/test-thread-snapshot.mjs, and a rule that can only be
 * grepped is the kind that drifted here in the first place.
 */

/** The events eve treats as the end of the current turn, in its own order. */
const BOUNDARY = new Set(["session.waiting", "session.completed", "session.failed"]);

type BoundaryEvent = { type?: string; data?: { continuationToken?: string } };

/**
 * The last turn boundary in the stream, or undefined if the turn is still
 * running. eve's `findBoundaryEvent`, with the same backwards walk: synthesized
 * `client.*` markers and ordinary deltas are not boundaries, so they are walked
 * past rather than treated as evidence either way.
 */
export function lastBoundaryEvent(events: readonly unknown[]): BoundaryEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as BoundaryEvent;
    if (event?.type && BOUNDARY.has(event.type)) return event;
  }
  return undefined;
}

/**
 * The cursor with its resume token repaired — ONLY when the stream's last word
 * is a park that carries one.
 *
 * A cursor that already holds a token is returned untouched: this repairs a
 * missing token, it does not adjudicate one the store still believes in.
 */
export function withFreshestToken<T extends { continuationToken?: string }>(
  session: T,
  events: readonly unknown[],
): T {
  if (session.continuationToken) return session;
  const boundary = lastBoundaryEvent(events);
  // `session.completed` / `session.failed`: the session is over. There IS a
  // token further back in the stream and it is exactly the one not to hand out.
  if (boundary?.type !== "session.waiting") return session;
  const token = boundary.data?.continuationToken;
  if (typeof token !== "string" || !token) return session;
  return { ...session, continuationToken: token };
}
