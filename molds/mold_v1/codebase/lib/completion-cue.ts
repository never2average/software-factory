/**
 * "IT IS DONE" AT A GLANCE (mold_v1-287) — the rules, kept out of React so scripts/test-chat-cues.mjs runs them.
 *
 * Three places say a piece of work finished:
 *   - the chat itself: when the main agent's turn ends WITH AN ANSWER while the chat is on screen, a short completed
 *     mark beside the composer and a polite announcement for a screen reader (`turnOutcome` says which ending it was:
 *     a failed or stopped turn says so in its own words, and a turn parked on a question is waiting, not done);
 *   - a specialist: its delegation card and Control Panel row settle with a completed mark (app/_components/
 *     completion-cue.tsx `useJustSettled`, a brief highlight that only a transition DURING this visit earns);
 *   - elsewhere: a chat that finished while the person was in another chat gets a marker in the chat list
 *     (`BackgroundWatch`), and the tab's title gets one while the page is hidden.
 *
 * Pure: plain arrays and numbers.
 */

/** Only what is read of an event. */
export interface CueEvent {
  readonly type?: string;
  readonly data?: { readonly finishReason?: string; readonly message?: string } | null;
}

export type TurnOutcome = "completed" | "failed" | "stopped" | "waiting" | "running" | "none";

/**
 * How did the LAST turn of this transcript end? Scans back to its terminal event:
 *   - `turn.completed` with no question asked after its start, and a `session.waiting` / `session.completed` or
 *     nothing after it: `completed`;
 *   - `turn.failed` / `session.failed`: `failed`; `turn.cancelled` or the page's own Stop marker: `stopped`;
 *   - a question or approval asked in the turn and the session parked on it: `waiting`;
 *   - a `turn.started` with no end yet: `running`; no turn at all: `none`.
 */
export function turnOutcome(events: readonly CueEvent[]): TurnOutcome {
  let asked = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]?.type;
    if (!t) continue;
    if (t === "client.turn.stopped" || t === "turn.cancelled") return "stopped";
    if (t === "turn.failed" || t === "session.failed") return "failed";
    if (t === "turn.completed") {
      // Did this turn park on the person? Look back to its start.
      for (let j = i - 1; j >= 0; j--) {
        const u = events[j]?.type;
        if (u === "turn.started") break;
        if (u === "input.requested") asked = true;
      }
      return asked ? "waiting" : "completed";
    }
    if (t === "input.requested") asked = true;
    if (t === "turn.started") return asked ? "waiting" : "running";
  }
  return "none";
}

/**
 * Should the chat on screen say "completed" now? Only for a turn that was seen RUNNING during this visit and has now
 * ended with an answer: the transcript a chat opens with is history, and a turn that is merely waiting on the person
 * already says so with its question.
 */
export function completionDue(input: { readonly wasRunning: boolean; readonly outcome: TurnOutcome }): boolean {
  return input.wasRunning && input.outcome === "completed";
}

/** The tab title with the done mark in front, never twice. */
export function markedTitle(title: string, mark: string): string {
  const prefix = `${mark} `;
  return title.startsWith(prefix) ? title : `${prefix}${title}`;
}

/** The tab title without the done mark. */
export function unmarkedTitle(title: string, mark: string): string {
  const prefix = `${mark} `;
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
}

/** Is the session at rest, judged from the one tail event `startIndex=-1` returns? */
export function tailAtRest(tail: CueEvent | null | undefined): boolean {
  const t = tail?.type;
  return (
    t === "session.waiting" ||
    t === "session.completed" ||
    t === "session.failed" ||
    t === "turn.completed" ||
    t === "turn.failed"
  );
}

/** How a chat left running ended, as the chat list says it. */
export type BackgroundEnd = "done" | "needs-you" | "failed";

/**
 * THE CHATS LEFT RUNNING. A chat the person leaves while its turn runs is watched (its last events read every few
 * seconds) until it comes to rest; then it carries what happened until the person opens it: `done` (an answer),
 * `needs-you` (it stopped on a question or an approval) or `failed`. A stopped turn carries nothing. Bounded: a handful
 * of chats at once, each for at most `WATCH_MAX_MS`, so a forgotten tab does not read for ever.
 */
export interface BackgroundWatch {
  /** chat id → { session id, when watching began }. */
  readonly watching: ReadonlyMap<string, { readonly sessionId: string; readonly since: number }>;
  /** Chats that came to rest while the person was elsewhere, not yet opened, and how. */
  readonly ended: ReadonlyMap<string, BackgroundEnd>;
}

export const WATCH_MAX = 6;
export const WATCH_MAX_MS = 30 * 60_000;
/** How many of a session's last events are read to tell how its turn ended. */
export const WATCH_TAIL_EVENTS = 40;
export const EMPTY_WATCH: BackgroundWatch = { watching: new Map(), ended: new Map() };

/** The person left `chatId` while its turn ran: watch it (the oldest watch makes room past `WATCH_MAX`). */
export function startWatch(w: BackgroundWatch, chatId: string, sessionId: string, now: number): BackgroundWatch {
  const watching = new Map(w.watching);
  watching.delete(chatId);
  watching.set(chatId, { sessionId, since: now });
  while (watching.size > WATCH_MAX) watching.delete(watching.keys().next().value as string);
  const ended = new Map(w.ended);
  ended.delete(chatId);
  return { watching, ended };
}

/** The person opened `chatId`: nothing to tell them about it any more, and nothing to watch. */
export function seen(w: BackgroundWatch, chatId: string): BackgroundWatch {
  if (!w.watching.has(chatId) && !w.ended.has(chatId)) return w;
  const watching = new Map(w.watching);
  watching.delete(chatId);
  const ended = new Map(w.ended);
  ended.delete(chatId);
  return { watching, ended };
}

/**
 * The session's last events were read for `chatId` (null: they could not be). At rest, how its turn ended decides the
 * marker: an answer is `done`, a question or approval is `needs-you`, a failure is `failed`, a stop is nothing. A watch
 * past its time is dropped.
 */
export function afterTail(
  w: BackgroundWatch,
  chatId: string,
  tail: readonly CueEvent[] | null,
  now: number,
): BackgroundWatch {
  const entry = w.watching.get(chatId);
  if (!entry) return w;
  const atRest = Boolean(tail?.length) && tailAtRest(tail?.[tail.length - 1]);
  if (atRest && tail) {
    const outcome = turnOutcome(tail);
    const watching = new Map(w.watching);
    watching.delete(chatId);
    const ended = new Map(w.ended);
    const end: BackgroundEnd | null =
      outcome === "completed" ? "done" : outcome === "waiting" ? "needs-you" : outcome === "failed" ? "failed" : null;
    if (end) ended.set(chatId, end);
    return { watching, ended };
  }
  if (now - entry.since > WATCH_MAX_MS) {
    const watching = new Map(w.watching);
    watching.delete(chatId);
    return { watching, ended: w.ended };
  }
  return w;
}
