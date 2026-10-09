import { NextRequest, NextResponse } from "next/server";
import { and, eq, desc, gt, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { loginCodes, orgInvites, orgMembers } from "@/agent/lib/db/schema";
import { guestInviteFor, guestRefusal, markGuestArrived } from "@/lib/guest-invite";
import { guestLinkOf } from "@/lib/guest-invite-rules";
import { getOpsDb } from "@/lib/ops-db";
import { emailSignInConfigured, mintSessionToken, SESSION_TTL_SECONDS } from "@/lib/auth-session";
import { loginCodeMatches } from "@/lib/login-code";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/email/verify — trade a one-time code for a session token.
 *
 * The three guards that make a six-digit code safe all live here: the code
 * expires in ten minutes, survives only five wrong guesses, and is consumed on
 * first success. Miss any one of them and a million-space code is brute
 * forceable at leisure.
 *
 * The token this returns proves an EMAIL ADDRESS and nothing more. It grants no
 * workspace: membership is read from the database on every request, so an
 * invitee still has to redeem their invite, and someone who leaves a workspace
 * loses access immediately even though their token is still valid.
 *
 * FROM A CHAT'S LINK (`org`, `chat` in the body), the invite is checked again here, after the code: it may have been
 * withdrawn or have expired in the ten minutes since the code was sent. A guest whose invite is still good is signed in
 * and the invite counts as opened (lib/guest-invite.ts markGuestArrived); one whose invite is not is told why and gets
 * no token. Someone who already belongs to a workspace, or holds a workspace invite, signs in as before.
 */

const schema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: z.string().trim().regex(/^\d{6}$/, "The code is six digits."),
  /** The chat link's workspace and chat, when a guest signs in from it. */
  org: z.string().max(200).optional(),
  chat: z.string().max(200).optional(),
});

/** Wrong code, expired code, no code — all one message. Which of the three it
 *  was is information an attacker wants and the real user does not need. */
const REFUSED = "That code is wrong or has expired. Request a new one.";
const MAX_ATTEMPTS = 5;

export async function POST(request: NextRequest) {
  if (!emailSignInConfigured()) {
    return NextResponse.json({ error: "Email sign-in is not configured." }, { status: 503 });
  }
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  const { email, code } = parsed.data;

  try {
    const [row] = await db
      .select()
      .from(loginCodes)
      .where(and(eq(loginCodes.email, email), isNull(loginCodes.consumedAt)))
      .orderBy(desc(loginCodes.createdAt))
      .limit(1);
    if (!row) return NextResponse.json({ error: REFUSED }, { status: 401 });
    if (row.expiresAt.getTime() < Date.now()) {
      return NextResponse.json({ error: REFUSED }, { status: 401 });
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      return NextResponse.json(
        { error: "Too many wrong attempts on that code. Request a new one." },
        { status: 429 },
      );
    }

    if (!loginCodeMatches(email, code, row.codeHash)) {
      // Count the miss BEFORE returning, or the cap never bites.
      await db
        .update(loginCodes)
        .set({ attempts: row.attempts + 1 })
        .where(eq(loginCodes.id, row.id));
      return NextResponse.json({ error: REFUSED }, { status: 401 });
    }

    // Single use. Consume FIRST: if minting somehow fails afterwards the code is
    // spent and they request another, which is the safe direction to fail in.
    await db.update(loginCodes).set({ consumedAt: new Date() }).where(eq(loginCodes.id, row.id));
    const link = guestLinkOf(parsed.data);
    if (link) {
      const guest = await guestInviteFor(link, email);
      if (guest.state === "live") {
        await markGuestArrived(guest.orgId, guest.threadId, email);
      } else {
        const [member] = await db.select({ orgId: orgMembers.orgId }).from(orgMembers).where(eq(orgMembers.email, email)).limit(1);
        const [invite] = member
          ? []
          : await db
              .select({ orgId: orgInvites.orgId })
              .from(orgInvites)
              .where(
                and(
                  eq(orgInvites.email, email),
                  isNull(orgInvites.acceptedAt),
                  gt(orgInvites.expiresAt, new Date()),
                  ne(orgInvites.origin, "chat_share"),
                ),
              )
              .limit(1);
        // Not a guest of this chat any more, and nothing else to sign in to: say why, and hand out nothing.
        if (!member && !invite) return NextResponse.json({ error: guestRefusal(guest.state) }, { status: 403 });
      }
    }
    const token = await mintSessionToken(email);
    return NextResponse.json({ token, email, expiresIn: SESSION_TTL_SECONDS });
  } catch (e) {
    console.error("login code verify failed", e);
    return NextResponse.json({ error: "Could not verify that code right now." }, { status: 500 });
  }
}
