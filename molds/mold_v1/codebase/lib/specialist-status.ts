/**
 * WHERE A SPECIALIST STANDS, AS ONE STATE AND ONE ICON (mold_v1-297).
 *
 * A delegation card said where its specialist stood in a sentence under it ("Working in the Control Panel — the main
 * agent continues once it hands back.", "Still working in the Control Panel. Its result comes back to the main agent
 * by itself when it finishes."), a coloured pill beside it ("Running", "Needs approval", "Working — reports later"),
 * and a generic tool glyph; the Control Panel's rail said it a third way (a check mark for done, nothing otherwise). A
 * specialist that had written nothing for twenty minutes read exactly like one that was busy.
 *
 * Now there is one set of states, derived here from the same facts on both surfaces, and each has its own icon, the
 * only visible mark, with its word as the icon's accessible name and tooltip (app/_components/specialist-status.tsx):
 *
 *   running   working, and it has written something within the bound
 *   waiting   it asked the person a question or an approval that is still open
 *   stuck     working, and nothing written (no event, no progress) for longer than the bound: derived, not reported
 *   ready     it has finished in its own session and its result has not reached the main agent yet (held with a
 *             sibling, or on its way as a "reports later" result): ready to report back
 *   done      its result reached the main agent
 *   failed    it ended with an error
 *   stopped   stopped: by the person, by the main agent (mold_v1-294), or by the sweep
 *
 * THE BOUND for "stuck" is NEXT_PUBLIC_SPECIALIST_STUCK_MIN (minutes; read at build), default 10: long enough for a
 * slow model call or a long sandbox command, well under the sweep's 30 minutes after which a frozen specialist is
 * stopped (agent/lib/specialist-sweep-settings.ts). Never under 2. "Stuck" says only that it has gone quiet; nothing is
 * stopped because of it.
 *
 * Pure; no React. The words are neutral (no profile word): a person reads them as they are.
 */

export type SpecialistState = "running" | "waiting" | "stuck" | "ready" | "done" | "failed" | "stopped";

/** Every state, in the order a legend shows them. */
export const SPECIALIST_STATES: readonly SpecialistState[] = ["running", "waiting", "stuck", "ready", "done", "failed", "stopped"];

export const STUCK_DEFAULT_MIN = 10;
export const STUCK_FLOOR_MIN = 2;

/** The bound, in ms: NEXT_PUBLIC_SPECIALIST_STUCK_MIN, else the default; a value that is not a number is the default. */
export function stuckAfterMs(raw: string | undefined = process.env.NEXT_PUBLIC_SPECIALIST_STUCK_MIN): number {
  const n = Number((raw ?? "").trim());
  const min = raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n > 0 ? Math.max(STUCK_FLOOR_MIN, n) : STUCK_DEFAULT_MIN;
  return min * 60_000;
}

/**
 * The state's word: the icon's accessible name and its tooltip. It is never shown as text beside the icon: the icon is
 * the only visible mark on a card and a rail row (one mark per state, not a glyph and a word saying the same).
 */
export const STATE_WORD: Readonly<Record<SpecialistState, string>> = {
  running: "Running",
  waiting: "Waiting on you",
  stuck: "Stuck",
  ready: "Ready to report back",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

/**
 * The icon's accessible name and tooltip: the state's word, and for a stuck specialist how long it has been quiet
 * ("Stuck: no progress for 25 minutes").
 */
export function stateLabel(state: SpecialistState, quietMs?: number): string {
  if (state !== "stuck" || quietMs === undefined) return STATE_WORD[state];
  const minutes = Math.max(1, Math.round(quietMs / 60_000));
  return `${STATE_WORD.stuck}: no progress for ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** The facts a state is derived from. Every field is optional: a surface passes what it knows. */
export interface StateFacts {
  /** The main thread has its settled result: finished, failed, or stopped. */
  readonly settled?: "done" | "failed" | "stopped";
  /** A Stop (the person's, the chat's own record) discarded it. */
  readonly stoppedHere?: boolean;
  /** A question or an approval it asked is open. */
  readonly waiting?: boolean;
  /** Its own session finished (`session.completed`). */
  readonly childFinished?: boolean;
  /** Its own session's last turn was cancelled. */
  readonly childStopped?: boolean;
  /** When it last wrote anything (ms since the epoch), when known. */
  readonly lastProgressAt?: number;
}

/** The state from the facts, at `now`, with the bound `stuckMs`. */
export function specialistState(facts: StateFacts, now: number, stuckMs: number = stuckAfterMs()): SpecialistState {
  if (facts.settled) return facts.settled;
  if (facts.stoppedHere || facts.childStopped) return "stopped";
  if (facts.waiting) return "waiting";
  if (facts.childFinished) return "ready";
  if (facts.lastProgressAt !== undefined && Number.isFinite(facts.lastProgressAt) && now - facts.lastProgressAt > stuckMs) return "stuck";
  return "running";
}

/** When a running specialist becomes stuck if nothing more is written (ms since the epoch), or null. */
export function stuckAt(facts: StateFacts, stuckMs: number = stuckAfterMs()): number | null {
  if (facts.settled || facts.stoppedHere || facts.childStopped || facts.waiting || facts.childFinished) return null;
  if (facts.lastProgressAt === undefined || !Number.isFinite(facts.lastProgressAt)) return null;
  return facts.lastProgressAt + stuckMs;
}

/** A state that is still in progress (its icon may move; a reduced-motion setting stops it). */
export const stateIsLive = (s: SpecialistState): boolean => s === "running" || s === "waiting" || s === "stuck" || s === "ready";

/** What the chat knows of a delegation beyond its own part, by call id (agent-chat builds it; the card reads it). */
export interface SpecialistCardFacts {
  /** Its own session finished (the Control Panel's feed of it). */
  readonly childFinished?: boolean;
  /** Its own session's last turn was cancelled. */
  readonly childStopped?: boolean;
  /** When its own stream last carried anything (ms). */
  readonly lastProgressAt?: number;
  /** A question or an approval it asked is open (in the stack beside the composer). */
  readonly waiting?: boolean;
  /** The main agent stopped it (mold_v1-294), with this reason ("" when it gave none). */
  readonly stopReason?: string;
  /** The person's Stop discarded it (the chat's own record; eve writes nothing for it). */
  readonly stoppedHere?: boolean;
}

/** What a specialist's own stream says, as the Control Panel follows it (reported to the chat by call id). */
export interface ChildActivity {
  readonly childFinished?: boolean;
  readonly childStopped?: boolean;
  readonly lastProgressAt?: number;
}

/**
 * The activity as one string that changes only when a card's state could: finished, stopped, and the last progress
 * to the half-minute (the stuck bound is minutes; a busy stream must not re-render the chat on every event).
 */
export function activitySignature(activity: ReadonlyMap<string, ChildActivity>): string {
  return [...activity]
    .map(([id, a]) => `${id}:${a.childFinished ? 1 : 0}${a.childStopped ? 1 : 0}:${a.lastProgressAt === undefined ? "" : Math.floor(a.lastProgressAt / 30_000)}`)
    .sort()
    .join("|");
}
