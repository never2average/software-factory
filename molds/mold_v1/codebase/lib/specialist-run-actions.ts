/**
 * WHAT A PERSON MAY DO WITH ONE SPECIALIST'S RUN, AND WHAT THEY ARE TOLD INSTEAD — shared by the Control Panel
 * (app/_components/cockpit.tsx) and the agent's session guard (agent/lib/session-guard.ts), so both say the same.
 *
 * WHY THERE IS NO "RESUME" FOR A DELEGATED SPECIALIST (measured on the real eve 0.25.1 runtime,
 * scripts/test-specialist-batch.mjs). A specialist's own session is parked on a continuation token eve mints for the
 * delegation, `<parent session>:<call id>`. eve's HTTP channel prefixes every token it is given with its own name
 * (eve/dist/src/channel/send.js), so a message posted to the specialist's session with that token reaches no session:
 * eve answers 200 and starts a NEW, unrelated conversation with the text as its first message. The specialist, and the
 * main thread that called it, receive nothing. That is what the Control Panel's "Resume" did.
 *
 * Nor could a working route help. A specialist hands back exactly one way: when it finishes or fails, into the inbox of
 * the main thread's turn that called it (`notifyDelegatedParentStep`, eve/dist/src/execution/workflow-entry.js). A
 * stopped specialist's turn is gone by the time anyone could press Resume: the hand-back ended it and told the main
 * agent "stopped, no result" (agent/lib/specialist-handback.ts), or the person stopped the main thread, and eve's
 * settle of a cancelled turn clears its pending delegations (settle-cancelled-turn-step.js). A result produced after
 * that would have nowhere to go, and would contradict what the main agent was already told. In eve's own model,
 * cancellation belongs to the parent turn (docs/subagents.mdx). So the correct offer is the one that works: ask the
 * main agent to run it again, as a new delegation in a turn that is waiting for it.
 *
 * A workflow step's OWN session is not a delegation: it was started over HTTP, its token is the channel's own, and a
 * message to it continues it. Resume stays for those, and only when the agent has said the session is not a
 * delegation (a step's row often opens the specialist the step called, which is one).
 */

/** What the Control Panel shows for a stopped specialist, in place of Resume. */
export const STOPPED_SPECIALIST_NOTE =
  "Stopped. A specialist cannot be resumed on its own: the main thread's turn that called it has ended, so anything it did now would reach nobody. To have it done, ask the main agent in the chat to run it again.";

/** What the agent answers (409) to a message posted to a delegated specialist's own session. */
export const SPECIALIST_MESSAGE_REFUSAL =
  "A specialist cannot take a message on its own session: the message would start a new, unrelated conversation and the specialist would never see it. To answer its question, answer it in the chat. To have a stopped specialist's work done, ask the main agent in the chat to run it again.";

/** The machine-readable reason beside {@link SPECIALIST_MESSAGE_REFUSAL}. */
export const SPECIALIST_MESSAGE_REFUSAL_CODE = "specialist-session-not-addressable";

/**
 * WHETHER A SESSION IS A DELEGATION, as the agent's session guard knows it: the session's owner record names a parent
 * (`ownership.source === "lineage"`), the same fact the guard refuses a message on. The guard states it on every
 * stream it serves, `1` for a delegated specialist's session and `0` for any other, and the web app's /eve proxy
 * passes it through. A panel decides from it whether a message to the session can work: a workflow step opens its
 * specialist's session as often as its own, and the journal alone does not say which one a row points at.
 */
export const SESSION_DELEGATION_HEADER = "x-eve-session-delegation";

/** The header's value: true (a delegation), false (not one), or undefined when the agent did not say. */
export function delegationFromHeader(value: string | null | undefined): boolean | undefined {
  return value === "1" ? true : value === "0" ? false : undefined;
}

/**
 * Can a message posted to this session reach it? Only when the agent said it is NOT a delegation. Unknown is no: a
 * control that may only ever answer 409 is not offered.
 */
export const canMessageSession = (delegated: boolean | undefined): boolean => delegated === false;

/**
 * What to show when a message to a session was refused: the agent's own `error` text, never a bare status code.
 * `fallback` is used only when the answer carried no text at all.
 */
export async function refusalText(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" && body.error.trim() ? body.error : fallback;
}

export interface RunControlInput {
  /**
   * The run is a delegation (a specialist the main agent called, or one a workflow step called), from
   * {@link SESSION_DELEGATION_HEADER}; undefined until the agent has said.
   */
  readonly delegated: boolean | undefined;
  /** The parent still counts the delegation as out. */
  readonly running: boolean;
  /** The run's own feed: false once its turn ended, undefined before anything was read. */
  readonly turnActive?: boolean;
  /** The run's latest continuation token, if its stream carried one. */
  readonly continuationToken?: string;
  /** Its last turn ended in `turn.cancelled`. */
  readonly stopped?: boolean;
}

export interface RunControl {
  /**
   * The header button. `stop`: Stop (the guard turns it into a hand-back for a delegation, and pressing it again on a
   * stopped specialist retries a hand-back that was not delivered). `resume`: a message on the run's own token
   * continues this very session, which is true of a workflow step and never of a delegation.
   */
  readonly button: "stop" | "resume" | null;
  /** What to tell the person beside it, when there is something to do instead. */
  readonly note: string | null;
}

/** The header control for the run open in the Control Panel. */
export function runControl(run: RunControlInput): RunControl {
  const button = run.running && run.turnActive !== false ? "stop" : canMessageSession(run.delegated) && run.continuationToken ? "resume" : null;
  return { button, note: run.delegated === true && run.stopped ? STOPPED_SPECIALIST_NOTE : null };
}
