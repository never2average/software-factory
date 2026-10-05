/**
 * WHEN IS A DELEGATED STEP OVER? — read off the step's own event stream, for a caller that is a PROGRAM.
 *
 * A workflow step, an app refresh and a cron step all reach a specialist the same way (lib/workflow-delegate.ts): a
 * message to the root agent that names the specialist, and the step's value is the root's reply once the specialist
 * has handed back. The reader used to end at the first `turn.completed`. That is not the end of the step when a
 * specialist is still out:
 *
 *   subagent.called → input.requested → turn.completed → session.waiting
 *
 * is eve PARKING the root because the specialist asked the person something (a question, or an approval for a
 * write — `emitProxiedInputRequest` writes the request and then the turn's epilogue; recorded in
 * scripts/fixtures/subagent-delivery/child-parks-then-answered.ndjson, indices 8–10). The specialist has not handed
 * back, and after the answer the SAME stream carries `subagent.completed` → `action.result` → the root's reply →
 * the real `turn.completed`. Ending at the park returned the root's narration ("I'll hand this to …") as the step's
 * value: an app refreshed from a specialist stored that sentence as its document.
 *
 * So a turn that ends on an OPEN REQUEST with its specialist still out is not the end of the step. Then:
 *
 *   - somebody may answer (a person started the step and can open it from the run timeline): keep reading;
 *   - nobody can (the step runs on the platform's own identity — a scheduled refresh, a cron): fail at once, with
 *     the specialist's name and what it asked for, so the app says why instead of waiting out its budget.
 *
 * Pure: no fetch, no clock. scripts/test-specialist-handback.mjs feeds it the recorded streams.
 */

interface StepEvent {
  type?: string;
  data?: Record<string, unknown> | null;
}

/** What a specialist (or the root) is waiting on the person for. */
export interface StepAsk {
  /** The specialist that asked, when exactly one delegation is outstanding; otherwise undefined. */
  readonly specialist?: string;
  /** The tool awaiting approval, for an approval. */
  readonly tool?: string;
  /** The question's text, for a question. */
  readonly prompt?: string;
}

export type StepVerdict =
  /** Not over: keep reading. */
  | { readonly kind: "open" }
  /** Over: the last turn ended with nothing outstanding. */
  | { readonly kind: "done" }
  /** Parked on the person with a specialist still out. Not over — and never will be unless somebody answers. */
  | { readonly kind: "waiting-on-person"; readonly ask: StepAsk };

export function createStepWatch() {
  const out = new Map<string, string>(); // callId → specialist
  let ask: StepAsk | null = null;
  return {
    /** Specialists called and not handed back. */
    outstanding: (): string[] => [...out.values()],
    /** The open request, if the step is parked on one. */
    asked: (): StepAsk | null => ask,
    see(event: StepEvent): StepVerdict {
      const data = event.data ?? {};
      switch (event.type) {
        case "subagent.called":
          if (typeof data.callId === "string") out.set(data.callId, typeof data.name === "string" && data.name ? data.name : "specialist");
          return { kind: "open" };
        case "action.result": {
          const result = data.result as { callId?: unknown } | undefined;
          if (typeof result?.callId === "string" && out.delete(result.callId) && out.size === 0) ask = null;
          return { kind: "open" };
        }
        case "input.requested": {
          const first = (data.requests as ReadonlyArray<{ prompt?: unknown; action?: { kind?: unknown; toolName?: unknown } | null }> | undefined)?.[0];
          const tool = first?.action?.kind === "tool-call" && typeof first.action.toolName === "string" && first.action.toolName !== "ask_question" ? first.action.toolName : undefined;
          ask = {
            ...(out.size === 1 ? { specialist: [...out.values()][0] } : {}),
            ...(tool ? { tool } : {}),
            ...(!tool && typeof first?.prompt === "string" && first.prompt ? { prompt: first.prompt } : {}),
          };
          return { kind: "open" };
        }
        case "session.completed":
          return { kind: "done" };
        case "turn.completed":
          // Only the PARK is not the end: a request is open and the specialist that made it has not handed back.
          // Any other completed turn ends the step, as it always has.
          return ask && out.size > 0 ? { kind: "waiting-on-person", ask } : { kind: "done" };
        default:
          return { kind: "open" };
      }
    },
  };
}

/** One sentence for whoever reads the failed step: who is waiting, for what, and what to do about it. */
export function waitingOnPersonMessage(ask: StepAsk, opts: { readonly unattended: boolean }): string {
  const who = ask.specialist ? `The "${ask.specialist}" specialist` : "A specialist";
  const what = ask.tool
    ? `needs a person to approve \`${ask.tool}\``
    : ask.prompt
      ? `asked a question ("${ask.prompt.length > 160 ? `${ask.prompt.slice(0, 157)}…` : ask.prompt}")`
      : "is waiting for a person's answer";
  return opts.unattended
    ? `${who} ${what}, and this step runs with nobody to answer it, so it was stopped and produced nothing. Run it from a chat, where the request can be answered, or change the brief so it needs no approval.`
    : `${who} ${what} and nobody answered in time, so this step produced nothing. Open the step from the run's timeline to answer it, then run it again.`;
}
