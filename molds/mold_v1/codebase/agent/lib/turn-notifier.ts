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
 *
 * A SPECIALIST'S QUESTION REACHES THIS TWICE OR NOT AT ALL, depending on who asked. The root's own `input.requested`
 * is emitted by its turn step, which runs both the channel's event handler and the authored hooks. A delegated
 * specialist's is PROXIED onto the root's stream by eve's `runProxySubagentEventStep`, which runs the channel's
 * handler and NO hook (eve 0.25.1, execution/subagent-event-proxy-step.js) — so with the hook alone, a specialist
 * that needed an approval while the tab was closed told nobody, and the main thread sat parked for days (measured on
 * a live deployment, 2026-09-25 → 28). Both callers are wired (agent/hooks/notifications.ts, agent/channels/eve.ts);
 * each request notifies ONCE, keyed by its `requestId`.
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
  /** The clock, for tests. */
  now?(): number;
}

const MAX_TURNS = 2_000;
const MAX_REQUESTS = 4_000;
/** The hook's and the channel's report of one emission are milliseconds apart; a step retried by eve, seconds. */
const REPEAT_MS = 60_000;

export function createTurnNotifier(deps: TurnNotifierDeps) {
  const turns = new Map<string, TurnSeen>();
  /**
   * `session:requestId` → when it was notified. The hook and the channel report the SAME emission, moments apart, so
   * a repeat inside REPEAT_MS is that; a later one is a new question that happens to carry the same id — ids are not
   * unique (agent/lib/unique-tool-call-ids.ts: some models count, and every delegated child starts counting again).
   */
  const asked = new Map<string, number>();
  const now = deps.now ?? Date.now;
  const firstAsk = (sessionId: string, requestIds: readonly string[]): boolean => {
    // A batch with no ids cannot be told apart from its own repeat: let it through (the old behaviour).
    if (requestIds.length === 0) return true;
    const at = now();
    const fresh = requestIds.filter((id) => at - (asked.get(`${sessionId}:${id}`) ?? -Infinity) >= REPEAT_MS);
    for (const id of fresh) {
      const k = `${sessionId}:${id}`;
      asked.delete(k); // re-insert at the end: the oldest entry is the one evicted
      if (asked.size >= MAX_REQUESTS) asked.delete(asked.keys().next().value as string);
      asked.set(k, at);
    }
    return fresh.length > 0;
  };
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
        requests?: ReadonlyArray<{
          requestId?: unknown;
          prompt?: unknown;
          display?: unknown;
          action?: { kind?: unknown; toolName?: unknown } | null;
        }>;
      },
      ctx: unknown,
    ) {
      const t = seen(key(sessionId, data.turnId));
      t.started = true;
      t.parked = true;
      const ids = (data.requests ?? []).map((r) => r?.requestId).filter((id): id is string => typeof id === "string" && id !== "");
      if (!firstAsk(sessionId, ids)) return;
      const first = data.requests?.[0];
      // `ask_question` is eve's own tool for a QUESTION: it is answered, not approved, and its prompt is the text.
      const tool =
        first?.action?.kind === "tool-call" && typeof first.action.toolName === "string" && first.action.toolName !== "ask_question"
          ? first.action.toolName
          : undefined;
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
