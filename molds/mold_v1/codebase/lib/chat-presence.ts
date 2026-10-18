/**
 * WHO ELSE IS IN A SHARED CHAT, AND WHO IS TYPING (mold_v1-288) — the rules both halves read.
 *
 * The page beats `/api/ops/threads/:id/presence` while a shared chat is open, and sends a TYPING beat at most once a
 * second while the person types (`typingBeatDue`); the server keeps a typing window of `TYPING_WINDOW_MS` from the
 * last one, so the line others see goes away about four seconds after the typing stops. A plain heartbeat never
 * closes the window; sending the message does.
 *
 * Typing is information, never a lock: nothing here holds a composer or refuses a message (mold_v1-290).
 *
 * Pure: no React, no network, safe on the server and in node tests (scripts/test-chat-cues.mjs).
 */
import { CHAT_CUES } from "./ui-words.ts";

/** How long one typing beat keeps the person "typing" on everyone else's screen. */
export const TYPING_WINDOW_MS = 4_000;
/** The fewest milliseconds between two typing beats from one page (about one a second). */
export const TYPING_BEAT_MS = 1_000;
/** How often an open shared chat asks who is here while the tab is visible, and while it is hidden. */
export const PRESENCE_POLL_MS = 2_000;
export const PRESENCE_POLL_HIDDEN_MS = 9_000;

/** One person the server says is in the chat now (never the caller themself). */
export interface OnlinePerson {
  /** Absent for a guest: the server never names one. */
  readonly email?: string;
  readonly name: string | null;
  readonly guest: boolean;
  readonly typing: boolean;
}

/** One message in the chat's shared queue, as the server lists it (oldest first). */
export interface SharedQueueItem {
  readonly id: string;
  readonly author: string;
  readonly mine: boolean;
  readonly text: string;
  readonly state: "queued" | "sending" | "failed";
  readonly error?: string | null;
}

/** Should a keystroke now send a typing beat? Not more than once per `TYPING_BEAT_MS`. */
export function typingBeatDue(lastBeatAt: number | null, now: number): boolean {
  return lastBeatAt === null || now - lastBeatAt >= TYPING_BEAT_MS;
}

/** How a person is shown: their roster name, the address's local part, or — for a guest — the guest label. */
export function personLabel(p: OnlinePerson): string {
  if (p.guest) return CHAT_CUES.guest;
  return p.name?.trim() || p.email?.split("@")[0] || CHAT_CUES.guest;
}

/**
 * The line beside the composer, or null when nobody else types. `me` is dropped if the server ever lists the caller
 * (it does not): your own typing is never shown to you.
 */
export function typingLine(online: readonly OnlinePerson[], me?: string | null): string | null {
  const mine = me?.toLowerCase();
  const names = online
    .filter((p) => p.typing && !p.guest && (!mine || p.email?.toLowerCase() !== mine))
    .map(personLabel);
  return names.length ? CHAT_CUES.typing(names) : null;
}

/** The people to read from a presence answer, defensively: anything malformed is dropped. */
export function onlineFrom(raw: unknown): OnlinePerson[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const o = r as Partial<OnlinePerson> | null;
    if (!o || typeof o !== "object") return [];
    return [
      {
        ...(typeof o.email === "string" ? { email: o.email } : {}),
        name: typeof o.name === "string" ? o.name : null,
        guest: o.guest === true,
        typing: o.typing === true,
      },
    ];
  });
}

/** The queue to read from a presence answer. */
export function queueFrom(raw: unknown): SharedQueueItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const q = r as Partial<SharedQueueItem> | null;
    if (!q || typeof q.id !== "string" || typeof q.text !== "string") return [];
    const state = q.state === "sending" || q.state === "failed" ? q.state : "queued";
    return [{ id: q.id, author: String(q.author ?? ""), mine: q.mine === true, text: q.text, state, error: q.error ?? null }];
  });
}
