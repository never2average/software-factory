import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { orgMembers, orgs } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";
import { emailSignInConfigured, mintSessionToken, SESSION_TTL_SECONDS } from "@/lib/auth-session";
import { verifiedGoogleAddress } from "@/lib/ops-auth";
import { guestInviteFor, guestRefusal, markGuestArrived } from "@/lib/guest-invite";
import { guestLinkOf } from "@/lib/guest-invite-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/guest/google — a GUEST of one shared chat signs in with Google.
 *
 * Someone outside a chat's workspace, invited to read that one chat, opens its link and chooses "Continue with Google".
 * The browser sends the Google ID token it got, with the link's workspace and chat. This route accepts it ONLY when:
 *   - Google signed it, for one of our sign-in clients (the same checks as every other Google sign-in, lib/ops-auth.ts),
 *   - Google says the address is VERIFIED, and
 *   - that address — compared without regard to capital letters — holds a live invite to THIS chat
 *     (lib/guest-invite.ts: not withdrawn, not expired, the chat not un-shared).
 * It then answers with our own email-session token for that address — the same token the emailed code gives — so the
 * two doors land the guest in the same place with the same (lack of) rights. Any Google account can come through this
 * door, Workspace or not, because what admits it is the invite, not the account type.
 *
 * What it does NOT do: make the guest a member of anything, create a workspace, or grant access to anything but the
 * chat. The token proves an address; each request re-reads the invite (lib/chat-threads.ts, lib/session-gate.ts).
 *
 * A MEMBER of the link's workspace (its owner, a colleague) opening the link signed out is not a guest: for a Google
 * Workspace account that belongs to that workspace the answer is `reason: "member"`, and the page signs them in with
 * their own Google sign-in, exactly as before. Nobody else is admitted on a Google account that is not the invited one.
 *
 * The refusal says why, plainly. That is safe here, unlike on the code door: the caller has just proved to Google that
 * the address is theirs, so telling them about their own invite leaks nothing about anyone else.
 */
const schema = z.object({
  credential: z.string().min(20).max(8192),
  org: z.string().max(200),
  chat: z.string().max(200),
});

export async function POST(request: NextRequest) {
  if (!emailSignInConfigured()) {
    return NextResponse.json(
      { error: "Guest sign-in is not set up here yet. Ask the person who shared the chat to contact support.", reason: "not-configured" },
      { status: 503 },
    );
  }
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured", reason: "not-configured" }, { status: 503 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  const link = parsed.success ? guestLinkOf(parsed.data) : null;
  if (!parsed.success || !link) {
    return NextResponse.json({ error: "This link is incomplete. Open the link from your invite email again.", reason: "bad-link" }, { status: 400 });
  }
  const google = await verifiedGoogleAddress(parsed.data.credential);
  if (!google) {
    return NextResponse.json(
      {
        error: "Google could not confirm the email address of that account. Try again, or use “Email me a code” instead.",
        reason: "unverified",
      },
      { status: 401 },
    );
  }
  try {
    const invite = await guestInviteFor(link, google.email);
    if (invite.state !== "live") {
      // Their own workspace's chat: the ordinary sign-in, which a Workspace account already has. `org_members` and
      // `orgs` are the control plane (no RLS), read for the link's ONE workspace and this proven address only.
      if (google.hostedDomain) {
        const [member] = await db
          .select({ orgId: orgMembers.orgId })
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, link.org), eq(orgMembers.email, google.email)))
          .limit(1);
        const [byDomain] = member
          ? []
          : await db
              .select({ orgId: orgs.orgId })
              .from(orgs)
              .where(and(eq(orgs.orgId, link.org), eq(orgs.googleHostedDomain, google.hostedDomain.toLowerCase()), ne(orgs.status, "suspended")))
              .limit(1);
        if (member || byDomain) return NextResponse.json({ reason: "member" }, { status: 409 });
      }
      return NextResponse.json({ error: guestRefusal(invite.state), reason: invite.state, email: google.email }, { status: 403 });
    }
    await markGuestArrived(invite.orgId, invite.threadId, google.email);
    const token = await mintSessionToken(google.email);
    return NextResponse.json({ token, email: google.email, expiresIn: SESSION_TTL_SECONDS });
  } catch (e) {
    console.error("guest Google sign-in failed", e);
    return NextResponse.json({ error: "Could not sign you in right now. Try again in a moment." }, { status: 500 });
  }
}
