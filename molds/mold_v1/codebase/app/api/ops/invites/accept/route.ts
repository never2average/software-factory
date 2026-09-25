import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { orgInvites, orgMembers } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";
import { tenancyEnabled } from "@/lib/org-context";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { recordOpsAudit } from "@/lib/ops-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ops/invites/accept — a signed-in invitee redeems their one-time
 * token: we hash it, match a live invite, and write the org_members row. The
 * invite is single-use (marked accepted) and must not be expired. The token is
 * matched against the CALLER's own email so a leaked token can't be redeemed by
 * someone else.
 *
 * NOTE: a consumer-domain invitee can only reach this route once OPS_MULTI_TENANT
 * admits their token at the gate (§10.9) — otherwise proxy.ts 401s them first.
 * Workspace-domain and @onfinance.in invitees work today.
 */

const schema = z.object({ token: z.string().min(8) });

export async function POST(request: NextRequest) {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db || !(await tenancyEnabled(db))) {
    return NextResponse.json({ error: "Tenancy is not enabled yet." }, { status: 409 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A token is required." }, { status: 400 });

  const hash = createHash("sha256").update(parsed.data.token).digest("hex");
  const email = identity.email.toLowerCase();
  try {
    const [invite] = await db
      .select()
      .from(orgInvites)
      .where(and(eq(orgInvites.tokenHash, hash), isNull(orgInvites.acceptedAt)))
      .limit(1);
    if (!invite) return NextResponse.json({ error: "This invite is invalid or already used." }, { status: 404 });
    if (invite.expiresAt.getTime() < Date.now()) {
      return NextResponse.json({ error: "This invite has expired." }, { status: 410 });
    }
    if (invite.email.toLowerCase() !== email) {
      return NextResponse.json({ error: "This invite was issued to a different address." }, { status: 403 });
    }
    await db
      .insert(orgMembers)
      .values({ orgId: invite.orgId, email, role: invite.role, invitedBy: invite.invitedBy, acceptedAt: new Date() })
      .onConflictDoUpdate({ target: [orgMembers.orgId, orgMembers.email], set: { role: invite.role, acceptedAt: new Date() } });
    await db.update(orgInvites).set({ acceptedAt: new Date() }).where(eq(orgInvites.id, invite.id));
    void recordOpsAudit(db, {
      orgId: invite.orgId,
      automationType: "org",
      automationId: invite.orgId,
      actor: email,
      event: `Accepted invite as ${invite.role}`,
    });
    return NextResponse.json({ orgId: invite.orgId, role: invite.role });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
