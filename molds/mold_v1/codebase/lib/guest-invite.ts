import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { chatThreadMembers, chatThreads } from "@/agent/lib/db/schema";
import { withOrgRls } from "./ops-db";
import { guestInviteState, normalEmail, type GuestInviteState, type GuestLink } from "./guest-invite-rules";

/**
 * IS THIS ADDRESS INVITED TO THIS ONE CHAT? — asked by the two guest sign-in doors, before anyone is signed in.
 *
 * A guest arrives through the chat's link (`/?chatSession=<session>&org=<workspace>`), which names ONE workspace and ONE
 * chat. That is the only workspace read here, inside its own RLS scope, by that chat's session id: nothing lists or
 * searches workspaces, so an address's invites elsewhere are neither found nor inferred.
 *
 * The answer is used two ways, and neither grants anything by itself:
 *   - the code door (app/api/auth/email/request) sends a code only when this says "live", and answers the SAME whatever
 *     it says, so the door cannot be used to learn who is invited where;
 *   - the Google door (app/api/auth/guest/google) accepts a Google sign-in only when the Google account's VERIFIED
 *     address is the invited one, and then says plainly why not (the person has proved that address is theirs).
 *
 * What a signed-in guest may then read is decided again on every request, from the same row (lib/chat-threads.ts,
 * lib/session-gate.ts): a sign-in token proves an address, never access.
 *
 * tenancy-ok: the one tenant read runs inside `withOrgRls(link.org, …)` — the workspace the link names.
 */
export type GuestInviteLookup =
  | { readonly state: "live"; readonly orgId: string; readonly threadId: string; readonly status: string }
  | { readonly state: Exclude<GuestInviteState, "live"> | "none" };

export async function guestInviteFor(link: GuestLink, address: string, now: number = Date.now()): Promise<GuestInviteLookup> {
  const email = normalEmail(address);
  if (!email) return { state: "none" };
  const rows = await withOrgRls(link.org, (tx) =>
    tx
      .select({
        threadId: chatThreads.id,
        ownerEmail: chatThreads.ownerEmail,
        status: chatThreadMembers.status,
        expiresAt: chatThreadMembers.expiresAt,
      })
      .from(chatThreadMembers)
      .innerJoin(chatThreads, eq(chatThreads.id, chatThreadMembers.threadId))
      .where(
        and(
          eq(chatThreads.orgId, link.org),
          eq(chatThreadMembers.orgId, link.org),
          eq(chatThreads.eveSessionId, link.chat),
          // Un-shared (archived) is un-shared for every guest.
          isNull(chatThreads.archivedAt),
          sql`lower(${chatThreadMembers.email}) = ${email}`,
        ),
      ),
  );
  // The owner is never a guest of their own chat.
  const mine = rows.filter((r) => normalEmail(r.ownerEmail) !== email);
  if (mine.length === 0) return { state: "none" };
  const live = mine.find((r) => guestInviteState(r, now) === "live");
  if (live) return { state: "live", orgId: link.org, threadId: live.threadId, status: live.status };
  return { state: mine.some((r) => guestInviteState(r, now) === "expired") ? "expired" : "revoked" };
}

/**
 * Signing in from the link IS opening the chat, so the invite counts as accepted from here on (and no longer expires).
 * The same bookkeeping lib/chat-threads.ts does when a member first opens a thread. Best-effort: a failed write never
 * costs the guest their sign-in.
 */
export async function markGuestArrived(orgId: string, threadId: string, address: string): Promise<void> {
  const email = normalEmail(address);
  await withOrgRls(orgId, (tx) =>
    tx
      .update(chatThreadMembers)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(
        and(
          eq(chatThreadMembers.threadId, threadId),
          sql`lower(${chatThreadMembers.email}) = ${email}`,
          eq(chatThreadMembers.status, "invited"),
        ),
      ),
  ).catch(() => undefined);
}

/** What the page says when a guest's own verified address has no good invite to the chat. */
export function guestRefusal(state: Exclude<GuestInviteLookup["state"], "live">): string {
  switch (state) {
    case "expired":
      return "This invite has expired. Ask the person who shared the chat with you to share it again.";
    case "revoked":
      return "This chat is no longer shared with you. Ask the person who shared it if you still need it.";
    case "none":
      return "This chat was not shared with that email address. Sign in with the address the invite was sent to.";
  }
}
