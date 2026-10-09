import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, desc, eq, gt, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { orgInvites, orgMembers } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";
import { tenancyEnabled } from "@/lib/org-context";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { recordOpsAudit } from "@/lib/ops-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ops/invites/claim — accept an invite you can SEE, without its token.
 *
 * The token flow (`/invites/accept`) exists to prove you own the address the
 * invite was sent to. Once you are signed in as that address, it has already
 * been proven — the token would be re-establishing a fact the bearer token
 * already establishes. So this accepts on the strength of the verified email
 * alone, matched against a live, unexpired, unaccepted invite for that exact
 * address.
 *
 * That is what makes an invite recoverable. Previously the emailed link was the
 * only copy: lose the mail, or receive it at an address that could not sign in,
 * and the invite was unusable while still looking pending to whoever sent it.
 *
 * The same single-use bookkeeping as the token path — the invite is marked
 * accepted, so it stops appearing as outstanding to the workspace admin.
 */

const schema = z.object({ orgId: z.string().min(1).max(200) });

export async function POST(request: NextRequest) {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db || !(await tenancyEnabled(db))) {
    return NextResponse.json({ error: "Tenancy is not enabled yet." }, { status: 409 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A workspace id is required." }, { status: 400 });
  const email = identity.email.toLowerCase();

  try {
    const [invite] = await db
      .select()
      .from(orgInvites)
      .where(
        and(
          eq(orgInvites.orgId, parsed.data.orgId),
          eq(orgInvites.email, email),
          isNull(orgInvites.acceptedAt),
          gt(orgInvites.expiresAt, new Date()),
          // A chat share's invite is never a membership: its guest reads that one chat through its link.
          ne(orgInvites.origin, "chat_share"),
        ),
      )
      .orderBy(desc(orgInvites.createdAt))
      .limit(1);
    if (!invite) {
      return NextResponse.json(
        { error: "There's no live invite to that workspace for your address." },
        { status: 404 },
      );
    }

    await db
      .insert(orgMembers)
      .values({
        orgId: invite.orgId,
        email,
        role: invite.role,
        invitedBy: invite.invitedBy,
        acceptedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [orgMembers.orgId, orgMembers.email],
        set: { role: invite.role, acceptedAt: new Date() },
      });
    await db.update(orgInvites).set({ acceptedAt: new Date() }).where(eq(orgInvites.id, invite.id));
    void recordOpsAudit(db, {
      automationType: "org",
      automationId: invite.orgId,
      actor: email,
      event: `Accepted invite as ${invite.role}`,
      orgId: invite.orgId,
    });
    return NextResponse.json({ orgId: invite.orgId, role: invite.role });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
