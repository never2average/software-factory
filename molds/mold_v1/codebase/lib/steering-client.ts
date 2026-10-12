/**
 * NOTES TO A RUNNING SPECIALIST — what the chat, the Control Panel and the agent's route share (mold_v1-235).
 *
 * A person may send a delegated specialist a note while it works ("focus on FY24 only"). The note is kept in the
 * delegation's inbox and the specialist reads it at its next step, without restarting and without losing its work
 * (agent/lib/steering.ts; the eve patch's harness/steering-notes.js). It goes through ONE route, on the MAIN THREAD's
 * session, gated like a message to that thread:
 *
 *   POST /eve/v1/session/<main thread>/steer   { callId, text }      write a note (the owner, or a participant)
 *   GET  /eve/v1/session/<main thread>/steer                         the thread's notes and whether each was read
 *
 * A message posted to the specialist's own session is still refused (lib/specialist-run-actions.ts): eve cannot take
 * one there. Pure; no server import.
 */

/** The route segment after the session id. */
export const STEER_SEGMENT = "steer";

/** Longest note accepted, in characters. A note is a steer, not a document. */
export const STEER_NOTE_MAX_CHARS = 2_000;

/** One note as the route answers it. */
export interface SteeringNote {
  readonly id: string;
  /** The delegation's call id on the main thread. */
  readonly callId: string;
  readonly text: string;
  /** "pending": written, not yet read; "delivered": read into one of the specialist's steps. */
  readonly status: "pending" | "delivered";
  readonly createdAt: string | null;
  readonly deliveredAt: string | null;
}

/** The machine-readable reasons a note is refused, beside a plain `error`. */
export const STEER_REFUSAL = {
  /** The delegation has finished, failed or been stopped: nothing is left to read the note. */
  notRunning: "specialist-not-running",
  /** No such delegation on this main thread. */
  unknown: "specialist-not-found",
  /** Empty, or longer than {@link STEER_NOTE_MAX_CHARS}. */
  invalid: "steer-note-invalid",
  /** The session is itself a delegation: notes go through its main thread. */
  notMainThread: "steer-not-main-thread",
} as const;

/** What the person is told when the specialist has already finished. */
export function notRunningMessage(name: string): string {
  return `${name} has already finished, so it can no longer take a note. Ask the main agent in the chat instead.`;
}

/** The note as the specialist reads it, appended to its next step's messages. */
export function noteForModel(author: string | null | undefined, text: string): string {
  const who = typeof author === "string" && author.trim() ? author.trim() : "the person you are working for";
  return `Note from ${who} while you were working: ${text}`;
}

/** Is this text a note the route accepts? */
export function validNote(text: unknown): text is string {
  return typeof text === "string" && text.trim().length > 0 && text.length <= STEER_NOTE_MAX_CHARS;
}

/** The route for a main thread, as the browser calls it (through the web app's /eve proxy). */
export const steerPath = (mainThreadSessionId: string): string =>
  `/eve/v1/session/${encodeURIComponent(mainThreadSessionId)}/${STEER_SEGMENT}`;
