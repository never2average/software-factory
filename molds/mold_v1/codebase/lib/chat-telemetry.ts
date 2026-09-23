/**
 * THE KINDS OF CHAT INCIDENT, AND THE SENTENCE EACH ONE READS AS.
 *
 * One map, exported, with no `server-only` import — so a test can execute the
 * real thing and the route cannot drift from the component.
 *
 * WHY THIS FILE EXISTS. `/api/ops/chat-telemetry` validates `kind` against a zod
 * enum and answers **202 on a parse failure** (the route is fire-and-forget by
 * contract: chat must never get worse because its telemetry is unhappy). The
 * cost of that contract is that a kind which is emitted but not listed is
 * accepted, dropped, and looks exactly like a kind that never fired.
 *
 * That is not hypothetical. Auditing the callers on 2026-09-22 found TWO kinds
 * the chat has been emitting into the void:
 *
 *   - `resync`  — every replay+remount the detached-turn watcher spends
 *   - `stop`    — every press of Stop
 *
 * Neither was in the enum, so neither has ever reached `automation_audit`. The
 * whole recorded history of chat incidents is five rows, against an operator who
 * says "streaming has many many problems" — the log was not measuring the
 * problem, it was measuring the six kinds somebody remembered to list.
 *
 * So: the enum is DERIVED from this map. A kind with no sentence cannot be
 * accepted, and a kind with a sentence is accepted automatically. The trap is
 * closed structurally rather than by remembering.
 */

/**
 * kind → the sentence a human reads at 2am in `automation_audit`.
 *
 * The numbers (attempt, elapsed, detail) are appended by the route; these are
 * only the opening clause.
 */
export const CHAT_TELEMETRY_SENTENCES = {
  "stream-error": "Chat stream errored",
  "stream-gave-up": "Chat stream ended mid-turn and stopped resuming",
  "save-failed": "Chat list failed to save",
  resume: "Chat stream resumed",
  "gate-denied": "Session access denied",
  // A React render loop that reached the eve store. Its own sentence, because
  // falling through to "resumed" would file the one error nobody can see from
  // the outside under the one word that means everything is fine.
  "render-loop": "Chat render loop (turn kept running)",
  // Emitted since the detached-turn watcher shipped; silently dropped until now.
  resync: "Chat replayed a detached turn",
  stop: "Chat turn stopped by the user",

  /* ---- the live reattach (this change) ---------------------------------- */

  // The app opened a reader on a turn that was running with nothing attached.
  // Counted because the interesting comparison is attach-started vs
  // attach-complete: the gap is how often a live tail cannot finish the job.
  "attach-started": "Chat reattached to a running turn",
  // The reader saw the turn through to its terminal. This is the success line
  // for the defect recorded at 2026-09-22T15:32:45 — where the reply stopped on
  // screen while the server finished it perfectly well.
  "attach-complete": "Chat reattach carried the turn to its end",
  // The stream would not open, or kept ending empty, or the share was revoked.
  // The resync/replay watcher is still behind this; a run of these means the
  // live tail is not the mechanism it is supposed to be.
  "attach-failed": "Chat reattach could not read the live stream",

  /* ---- what the old telemetry could not see ------------------------------ */

  /**
   * A turn that is unfinished and has gone quiet.
   *
   * `stream-gave-up` only fires when `agent.status === "ready"` AND a backwards
   * scan finds an unfinished turn — so a death that leaves the store in any
   * other state (`submitted`, `streaming`, `error`) records NOTHING. That is the
   * most likely reason the log has five rows against "many many problems".
   * This one is judged from the transcript alone: unfinished turn, no new event
   * for a while, once per turn, whatever the store thinks it is doing.
   */
  stall: "Chat turn stalled with no new events",

  /* ---- what NOTHING could see: the server side (this change) ------------- */

  /**
   * The model answered a step with nothing at all — no text, no tool call.
   *
   * Measured on the live deployment on 2026-09-23. A person uploaded a pdf and
   * asked for KPIs; the sandbox fetched it and `pdfplumber` returned real page
   * text; about three bash calls later every attempt died the same way —
   * `step.failed`/`turn.failed`, `MODEL_CALL_FAILED`, `"Empty model response"`,
   * with `[eve:harness.tool-loop] empty model response; reissuing the model call
   * once` twice in the server log before the turn ended. Every attempt, the same
   * depth, two separate sessions.
   *
   * NOTHING RECORDED IT. Every kind above is emitted by the browser, so a
   * server-side death left the chat log exactly as it was and a person had to
   * notice before any instrument did. That is the whole reason this kind exists.
   *
   * The row carries only SHAPE — finish reason, prompt/completion tokens,
   * whether any tool call came back, how many messages and tool definitions went
   * up, the request's approximate byte size, the model id, and whether an output
   * cap was in force AND WHAT IT WAS. Never prompt text, document content or
   * tool arguments. `agent/lib/empty-model-response.ts` formats it; the cap
   * field is there because the one reproduction anybody has (`max_tokens: 256`
   * → `finish_reason: "length"`, empty content, 256 completion tokens burned by
   * a reasoning model) can only be confirmed or killed from the live call.
   */
  "model-empty": "Model returned an empty response",
  /**
   * Every attempt came back empty — the retries AND the text-only fallback — so
   * the person was handed a sentence instead of a chat that simply stops. One of
   * these is a real defect with a real person behind it; a run of them means the
   * fallback is not the escape hatch it was built to be.
   */
  "model-empty-gave-up": "Model returned only empty responses; the person was told rather than left waiting",
} as const satisfies Record<string, string>;

export type ChatTelemetryKind = keyof typeof CHAT_TELEMETRY_SENTENCES;

/**
 * Every accepted kind, as the tuple `z.enum` wants.
 *
 * Derived, never hand-written: that is the whole point of the file.
 */
export const CHAT_TELEMETRY_KINDS = Object.keys(CHAT_TELEMETRY_SENTENCES) as [
  ChatTelemetryKind,
  ...ChatTelemetryKind[],
];

/** Is this kind one the route will record rather than silently drop? */
export function isChatTelemetryKind(kind: unknown): kind is ChatTelemetryKind {
  return typeof kind === "string" && kind in CHAT_TELEMETRY_SENTENCES;
}

/** The opening clause for a kind. Unknown kinds never reach here (see the enum). */
export function chatTelemetrySentence(kind: ChatTelemetryKind): string {
  return CHAT_TELEMETRY_SENTENCES[kind];
}

/**
 * The session id, as something you can CORRELATE but not USE.
 *
 * Lived in `app/api/ops/chat-telemetry/route.ts` until the agent runtime needed
 * to write the same kind of row from the other side of the deployment boundary.
 * Two hashes of the same session id computed by two different files is exactly
 * how "this conversation has severed six times in twelve minutes" stops being
 * visible, so there is one function and both surfaces call it.
 *
 * WHY A HASH AT ALL. `automation_id` used to be the raw eve session id, and
 * `GET /api/ops/orgs/:id/audit` returns the last 100 rows of this table to
 * anyone in the workspace — so the telemetry written when a chat went wrong
 * published the ids of the chats it went wrong in. A session id is a capability
 * in this system's shape: it is what the eve gate decides on, what the
 * transcript cache is keyed by, and what the mirror row used to let a colleague
 * claim.
 *
 * A truncated SHA-256 keeps the only property the feed uses — two lines about
 * the same chat carry the same id — while the value in the row opens nothing.
 * 16 hex characters is 64 bits: far beyond collision range for a chat feed, and
 * short enough to read. NOT reversible by a reader, and not meant to be private
 * FROM us: the same hash of the same id is how an operator matches a row back to
 * a session they already legitimately hold.
 *
 * The hasher is a PARAMETER, not a `node:crypto` import, because this file is
 * the one module both deployments share and `app/_components/agent-chat.tsx`
 * takes its type — a top-level `node:crypto` here is one accidental value import
 * away from putting a node builtin in the browser bundle. Each caller passes the
 * SHA-256 hex it already has.
 */
export function chatSessionTag(sessionId: string, sha256Hex: (value: string) => string): string {
  return `chat_${sha256Hex(sessionId).slice(0, 16)}`;
}
