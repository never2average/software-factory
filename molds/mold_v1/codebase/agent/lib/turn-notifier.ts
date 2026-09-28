/**
 * The notification hook's bookkeeping (agent/hooks/notifications.ts): which moments of a root turn notify, and with
 * what text. Pure over injected dependencies so scripts/test-web-push.mjs drives it with recorded events.
 *
 * A reply's text arrives on `message.completed` (the last one that is not tool-call narration), the turn's end on
 * `turn.completed` — two events, possibly two invocations. What this instance saw of a turn is kept per
 * `session:turn` (bounded, like the delegation tracker), and:
 *
 *   - `input.requested` notifies at once ("Needs your approval: …" / "Needs your answer: …"); the `turn.completed`
 *     that follows a park is NOT a reply and does not notify again;
 *   - `turn.completed` notifies a reply with the text it saw; a turn this instance saw start but that produced no
 *     answer (a turn that only ran tools) says nothing; a turn it saw nothing of (the text landed on another
 *     instance) still says the reply is ready, without a preview;
 *   - `turn.failed` notifies a failure; `turn.cancelled` never notifies (the person pressed Stop).
 */
import type { NotifyEvent } from "./notification-text.ts";

interface TurnSeen {
  started: boolean;
  text?: string;
  parked: boolean;
}

export interface TurnNotifierDeps {
  /** Send `ev` for the session this hook context belongs to. Never throws. */
  emit(ev: NotifyEvent, ctx: unknown): Promise<void>;
}

const MAX_TURNS = 2_000;

export function createTurnNotifier(deps: TurnNotifierDeps) {
  const turns = new Map<string, TurnSeen>();
  const key = (sessionId: string, turnId: string | undefined) => `${sessionId}:${turnId ?? "-"}`;
  const seen = (k: string): TurnSeen => {
    let t = turns.get(k);
    if (!t) {
      if (turns.size >= MAX_TURNS) turns.delete(turns.keys().next().value as string);
      t = { started: false, parked: false };
      turns.set(k, t);
    }
    return t;
  };
  return {
    turnStarted(sessionId: string, turnId: string | undefined) {
      seen(key(sessionId, turnId)).started = true;
    },
    messageCompleted(sessionId: string, data: { turnId?: string; message?: unknown; finishReason?: unknown }) {
      if (typeof data.message !== "string" || !data.message.trim()) return;
      // Narration before a tool call is not the answer.
      if (data.finishReason === "tool-calls") return;
      const t = seen(key(sessionId, data.turnId));
      t.started = true;
      t.text = data.message;
    },
    async inputRequested(
      sessionId: string,
      data: {
        turnId?: string;
        requests?: ReadonlyArray<{ prompt?: unknown; display?: unknown; action?: { kind?: unknown; toolName?: unknown } | null }>;
      },
      ctx: unknown,
    ) {
      const t = seen(key(sessionId, data.turnId));
      t.started = true;
      t.parked = true;
      const first = data.requests?.[0];
      const tool = first?.action?.kind === "tool-call" && typeof first.action.toolName === "string" ? first.action.toolName : undefined;
      await deps.emit(
        {
          kind: "input",
          sessionId,
          turnId: data.turnId,
          tool,
          text: tool ? undefined : typeof first?.prompt === "string" ? first.prompt : undefined,
        },
        ctx,
      );
    },
    async turnCompleted(sessionId: string, turnId: string | undefined, ctx: unknown) {
      const k = key(sessionId, turnId);
      const t = turns.get(k);
      turns.delete(k);
      if (t?.parked) return;
      if (t && t.started && !t.text) return;
      await deps.emit({ kind: "reply", sessionId, turnId, text: t?.text }, ctx);
    },
    async turnFailed(sessionId: string, turnId: string | undefined, ctx: unknown) {
      turns.delete(key(sessionId, turnId));
      await deps.emit({ kind: "failed", sessionId, turnId }, ctx);
    },
    turnCancelled(sessionId: string, turnId: string | undefined) {
      turns.delete(key(sessionId, turnId));
    },
    /** For tests. */
    size: () => turns.size,
  };
}
