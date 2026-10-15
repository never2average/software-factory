/**
 * WHICH COPY OF A CHAT AN OPEN MAY USE: this browser's, or the server's; and which may overwrite which.
 *
 * Two decisions `openChat` (app/_components/chat-shell.tsx) makes, held here as pure functions so they are executed by
 * a test (scripts/test-chat-open-route.mjs) rather than read off the component.
 *
 * No React, no DOM: node runs it.
 */
import { turnUnfinished, type TurnEvent } from "./chat-turn-state.ts";

/**
 * How recently a stored chat with a turn still running must have been written for this browser's copy to be trusted
 * as a turn that is STILL running.
 *
 * The persist path writes a running chat every 2 s while its reply streams (agent-chat's `persistTick`), so a chat
 * left mid-reply a moment ago has a row from a moment ago. A row older than this whose last turn never finished is
 * more likely a run that died mid-turn: mounted as running, its live reader would wait on a stream that never sends,
 * so that chat still goes to the server, which replays what the run actually left.
 */
export const RUNNING_REOPEN_WINDOW_MS = 5 * 60_000;

export type OpenRoute = "local" | "network";

/**
 * Where does an open of this stored chat read its transcript from?
 *
 *   - `local`: mount what this browser holds, with no request. A chat with no session (never sent) is local; so is
 *     one with its events and a resume token (a parked chat).
 *   - `network`: the events are not here (pruned for the storage quota, another device), or there is no resume token
 *     and nothing says a turn is running right now.
 *
 * A RUNNING chat this browser holds is now local too: events whose last turn has not finished, written in the last
 * {@link RUNNING_REOPEN_WINDOW_MS}, with or without a token. It used to go to the server because it has no token (a
 * first turn has none until it parks), where the replay loop read the turn until it fell silent: 4.5 s at the least,
 * up to 60-75 s under the loading shimmer while the reply kept streaming. Mounted from this browser's copy, the chat's
 * own live reader (agent-chat `attachDecision`: "live-turn") continues from the absolute index the copy ends at,
 * exactly as it already did for a running chat on its second turn.
 */
export function openRoute(input: {
  readonly sessionId?: string | null;
  readonly token: boolean;
  readonly events: readonly unknown[] | undefined;
  readonly updatedAt?: number;
  readonly now: number;
}): OpenRoute {
  if (!input.sessionId) return "local";
  if (!input.events?.length) return "network";
  if (input.token) return "local";
  if (runningRecently(input.events, input.updatedAt, input.now)) return "local";
  return "network";
}

/** The stored events end inside a turn, and the row was written within {@link RUNNING_REOPEN_WINDOW_MS}. */
export function runningRecently(events: readonly unknown[], updatedAt: number | undefined, now: number): boolean {
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return false;
  const age = now - updatedAt;
  // A row "from the future" (another device's clock) is not evidence of anything recent.
  if (age < 0 || age > RUNNING_REOPEN_WINDOW_MS) return false;
  return turnUnfinished(events as readonly TurnEvent[]);
}

/**
 * The replay stops that mean the read reached the end of what the stream had: a drained marker, a terminal event,
 * or a park followed by silence. Anything else (`timeout`, `segment-cap`, `error`, `cancelled`, `eof`, `live`) is a
 * read that stopped for its own reasons, and its transcript may be a prefix of the conversation.
 */
const COMPLETE_STOPS = new Set(["marker", "terminal", "park-quiet"]);

export function replayComplete(stop: string | undefined): boolean {
  return stop !== undefined && COMPLETE_STOPS.has(stop);
}

/**
 * May this replay be stored (in this browser, and as the saved copy) over the copy we already hold?
 *
 * A stream only grows, so a COMPLETE replay is never shorter than a genuine copy of the same session; when it is,
 * the copy is the wrong one (a restored database, a re-minted session) and the replay wins. A replay that stopped
 * early (its deadline, its segment cap, an error) proves nothing of the kind: storing it over a longer copy is how a
 * transcript cut short becomes the one every later open mounts. So it is stored only when it reaches at least as far
 * as the longest copy known (`longer`: this browser's stream index, the saved copy's index), or nothing is known.
 */
export function replayMayReplace(
  replay: { readonly stop?: string; readonly index?: number },
  longer: number | undefined,
): boolean {
  if (replayComplete(replay.stop)) return true;
  if (longer === undefined || !Number.isFinite(longer) || longer <= 0) return true;
  return typeof replay.index === "number" && replay.index >= longer;
}
