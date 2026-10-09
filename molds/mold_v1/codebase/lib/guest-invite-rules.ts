/**
 * WHEN A GUEST'S INVITE TO ONE CHAT IS STILL GOOD — one rule, for sign-in and for every guest read.
 *
 * A chat shared with someone outside its workspace makes them a read-only GUEST of that one chat: a
 * `chat_thread_members` row in the chat's workspace, opened through the chat's link (lib/chat-threads.ts accessFor,
 * lib/session-gate.ts guestSessionDecision). That row is also what lets them SIGN IN from the link, with an emailed code
 * or with Google (app/api/auth/email/request, app/api/auth/guest/google).
 *
 * The invite is good while:
 *   - it is not withdrawn (`status` 'revoked'), and
 *   - it has been opened (`status` 'accepted'), or its `expires_at` has not passed, or it has none.
 *
 * An invite sent from now on that nobody opens within {@link GUEST_INVITE_TTL_DAYS} expires, as a workspace invite
 * does (org_invites, 14 days): the members route stamps `expires_at` when it shares the chat, and again when it shares
 * it again. Opening it — through any route that reads the chat (lib/chat-threads.ts, lib/session-gate.ts
 * markMembershipOpened, the sign-in doors) — makes it "accepted", which does not expire.
 *
 * INVITES SENT BEFORE MIGRATION 0027 HAVE NO `expires_at`, AND STAND. The operator decided to let the pending invites
 * stand; a clock started from `invited_at` would have cut off, on deploy, every one already older than two weeks.
 *
 * Pure and dependency-free (relative imports only): the web app, the agent and plain-node tests all load it.
 */

/** An unopened chat invite sent from now on is good for this many days after it was (last) sent. */
export const GUEST_INVITE_TTL_DAYS = 14;
export const GUEST_INVITE_TTL_MS = GUEST_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Why a guest's invite is not good, in words a person can act on. */
export type GuestInviteState = "live" | "revoked" | "expired";

export interface GuestInviteRow {
  readonly status: string | null | undefined;
  /** When an unopened invite lapses. Null for an invite sent before migration 0027: it does not lapse. */
  readonly expiresAt: Date | string | null | undefined;
}

/** The state of one member row, for a guest. */
export function guestInviteState(row: GuestInviteRow, now: number = Date.now()): GuestInviteState {
  if (row.status === "revoked") return "revoked";
  if (row.status === "accepted") return "live";
  if (row.expiresAt === null || row.expiresAt === undefined || row.expiresAt === "") return "live";
  const ends = row.expiresAt instanceof Date ? row.expiresAt.getTime() : Date.parse(row.expiresAt);
  if (!Number.isFinite(ends)) return "expired";
  return now < ends ? "live" : "expired";
}

/** When an invite shared now lapses if nobody opens it. */
export function guestInviteExpiry(now: number = Date.now()): Date {
  return new Date(now + GUEST_INVITE_TTL_MS);
}

export function guestInviteLive(row: GuestInviteRow, now: number = Date.now()): boolean {
  return guestInviteState(row, now) === "live";
}

/** An email address as every guest comparison reads it: trimmed, lower-case. */
export function normalEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** The link's `org` and `chatSession` parameters, when they are plausible (the same alphabet the routes accept). */
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
/** An eve session id: one opaque token, no whitespace or URL separators. */
const SESSION_ID = /^[^\s/?#&]{1,200}$/;

export interface GuestLink {
  readonly org: string;
  readonly chat: string;
}

/** A chat link's workspace and chat, or null when either is missing or malformed. */
export function guestLinkOf(input: { org?: unknown; chat?: unknown } | null | undefined): GuestLink | null {
  const org = typeof input?.org === "string" ? input.org.trim() : "";
  const chat = typeof input?.chat === "string" ? input.chat.trim() : "";
  return WORKSPACE_ID.test(org) && SESSION_ID.test(chat) ? { org, chat } : null;
}
