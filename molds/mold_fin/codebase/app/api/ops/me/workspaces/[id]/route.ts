import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { orgMembers } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";
import { tenancyEnabled } from "@/lib/org-context";
import { recordOpsAudit } from "@/lib/ops-audit";
import { verifyOpsAuth } from "@/lib/ops-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/ops/me/workspaces/{id} — leave a workspace.
 *
 * Removing a member already existed, but only an admin could do it
 * (`orgs/{id}/members/{email}` gates on isOrgAdmin), so the one thing a person
 * could not do was walk out of a room they had been added to. Being invited
 * into the wrong workspace was therefore permanent unless someone else acted.
 *
 * Self-service and no role check — leaving is not an administrative act on
 * other people, it is a decision about your own membership. The one refusal is
 * the last owner: a workspace with no owner cannot be administered or recovered
 * by anyone, so that has to be resolved (hand ownership over, or delete the
 * workspace) before its last owner can go.
 *
 * Nothing else is touched. Their authored rows stay put — attributing work to
 * an author who has left is correct, and deleting it would be a data loss the
 * word "leave" does not promise.
 */

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db || !(await tenancyEnabled(db))) {
    return NextResponse.json({ error: "Tenancy is not enabled yet." }, { status: 409 });
  }
  const { id } = await params;
  const email = identity.email.toLowerCase();
  try {
    const [me] = await db
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, id), eq(orgMembers.email, email)))
      .limit(1);
    if (!me) return NextResponse.json({ error: "You are not a member of that workspace." }, { status: 404 });

    if (me.role === "owner") {
      const owners = await db
        .select({ email: orgMembers.email })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, id), eq(orgMembers.role, "owner")));
      if (owners.length <= 1) {
        return NextResponse.json(
          {
            error:
              "You are the only owner of this workspace. Make someone else an owner first, or delete the workspace.",
            reason: "last-owner",
          },
          { status: 409 },
        );
      }
    }

    await db.delete(orgMembers).where(and(eq(orgMembers.orgId, id), eq(orgMembers.email, email)));
    void recordOpsAudit(db, {
      automationType: "org",
      automationId: id,
      actor: email,
      event: `${email} left the workspace`,
      orgId: id,
    });
    return NextResponse.json({ ok: true, left: id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
