import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { loginCodes } from "@/agent/lib/db/schema";
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
 */

const schema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: z.string().trim().regex(/^\d{6}$/, "The code is six digits."),
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
    const token = await mintSessionToken(email);
    return NextResponse.json({ token, email, expiresIn: SESSION_TTL_SECONDS });
  } catch (e) {
    console.error("login code verify failed", e);
    return NextResponse.json({ error: "Could not verify that code right now." }, { status: 500 });
  }
}
