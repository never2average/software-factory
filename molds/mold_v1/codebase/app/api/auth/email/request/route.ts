import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt, isNull, ne, sql as raw } from "drizzle-orm";
import { z } from "zod";
import { loginCodes, orgInvites, orgMembers } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";
import { emailSignInConfigured } from "@/lib/auth-session";
import { hashLoginCode, mintLoginCode } from "@/lib/login-code";
import { sendLoginCode } from "@/lib/platform-notify";
import { W } from "@/lib/ui-words";
import { guestInviteFor } from "@/lib/guest-invite";
import { guestLinkOf } from "@/lib/guest-invite-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/email/request — email a one-time sign-in code.
 *
 * WHO MAY GET ONE: an address that already has a workspace membership, or a
 * live unaccepted invite. Nobody else, ever. This is not a public sign-up door
 * — self-serve onboarding is Google-only and stays that way. Email sign-in
 * exists to make an INVITE redeemable by someone Google cannot vouch for, so
 * the invite is the authorisation and this route only carries the code.
 *
 * A GUEST of one shared chat qualifies too, from that chat's link only. Sharing a chat with someone outside its
 * workspace makes them a guest of that one chat (a chat membership, never a workspace membership or invite), so the
 * two checks above never found them and no code was ever sent. The page they open from the link sends the link's
 * workspace and chat (`org`, `chat`); the code goes out only when that ONE chat, in that ONE workspace, holds a live
 * invite for exactly this address (lib/guest-invite.ts). Nothing else is searched.
 *
 * The response is deliberately identical whether or not the address qualifies.
 * Saying "no invite for that address" turns this endpoint into a membership
 * oracle: anyone could enumerate who works where by watching the reply. The
 * person who really was invited has the code in their inbox; the person
 * probing learns nothing.
 */

const schema = z.object({
  email: z.string().trim().toLowerCase().email(),
  /** The chat link's workspace and chat, when a guest asks from it. */
  org: z.string().max(200).optional(),
  chat: z.string().max(200).optional(),
});

/** Same body for every outcome — see the note above. */
const SAME_ANSWER = {
  ok: true,
  message: "If that address has an invite or an existing workspace, a sign-in code is on its way.",
};

/** Per address, per hour. Well above honest use, low enough to be useless as a mail cannon. */
const CODES_PER_HOUR = 5;

export async function POST(request: NextRequest) {
  if (!emailSignInConfigured()) {
    return NextResponse.json(
      { error: `Email sign-in is not configured on this ${W.install}.` },
      { status: 503 },
    );
  }
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid email address is required." }, { status: 400 });
  const email = parsed.data.email;
  const link = guestLinkOf(parsed.data);

  try {
    // Rate limit BEFORE the eligibility check, so the two paths cost the same
    // and the timing doesn't leak which one you're on.
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const [{ recent }] = await db
      .select({ recent: raw<number>`count(*)::int` })
      .from(loginCodes)
      .where(and(eq(loginCodes.email, email), gt(loginCodes.createdAt, since)));
    if (recent >= CODES_PER_HOUR) {
      return NextResponse.json(
        { error: "Too many codes requested for that address. Try again in an hour." },
        { status: 429 },
      );
    }

    const [member] = await db
      .select({ orgId: orgMembers.orgId })
      .from(orgMembers)
      .where(eq(orgMembers.email, email))
      .limit(1);
    const [invite] = await db
      .select({ orgId: orgInvites.orgId })
      .from(orgInvites)
      .where(
        and(
          eq(orgInvites.email, email),
          isNull(orgInvites.acceptedAt),
          gt(orgInvites.expiresAt, new Date()),
          // A chat share's invite (before #85) is never a membership: its guest signs in from the chat's link below.
          ne(orgInvites.origin, "chat_share"),
        ),
      )
      .orderBy(desc(orgInvites.createdAt))
      .limit(1);
    const guest = !member && !invite && link ? (await guestInviteFor(link, email)).state === "live" : false;
    if (!member && !invite && !guest) return NextResponse.json(SAME_ANSWER);

    const code = mintLoginCode();
    await db.insert(loginCodes).values({
      email,
      codeHash: hashLoginCode(email, code),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      requestedIp: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });
    const delivery = await sendLoginCode({ to: email, code });
    if (!delivery.delivered) {
      // A code nobody can receive is worse than a refusal: the person waits for
      // mail that is not coming. This is an operator-side failure (no mail
      // provider configured, provider down), not a fact about the address, so
      // reporting it leaks nothing.
      console.error("login code undeliverable", { email, reason: delivery.reason });
      return NextResponse.json(
        { error: `Could not send the code: ${delivery.reason}` },
        { status: 502 },
      );
    }
    return NextResponse.json(SAME_ANSWER);
  } catch (e) {
    console.error("login code request failed", e);
    return NextResponse.json({ error: "Could not send a code right now." }, { status: 500 });
  }
}
