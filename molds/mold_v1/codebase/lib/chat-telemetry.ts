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
