import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { orgMembers } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";
import { isOrgAdmin, orgContextForRequest, canAccessOrg } from "@/lib/org-context";
import { recordOpsAudit } from "@/lib/ops-audit";
import { verifyOpsAuth } from "@/lib/ops-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 *  PATCH  /api/ops/orgs/{id}/members/{email}  — change a member's role.
 *  DELETE /api/ops/orgs/{id}/members/{email}  — remove a member.
 *  Admin/owner only; role changes are audited. Guards against removing the last
 *  owner (a workspace must always have one).
 */

const patchSchema = z.object({ role: z.enum(["owner", "admin", "engineer", "member"]) });

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; email: string }> },
) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, email: raw } = await params;
  const email = decodeURIComponent(raw).toLowerCase();
  if (!canAccessOrg(ctx, id)) return NextResponse.json({ error: "Not your workspace." }, { status: 403 });
  if (!isOrgAdmin(ctx.role)) return NextResponse.json({ error: "Admin or owner only." }, { status: 403 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  try {
    // Only an owner can grant OR revoke the owner role.
    if (parsed.data.role === "owner" && ctx.role !== "owner") {
      return NextResponse.json({ error: "Only an owner can grant the owner role." }, { status: 403 });
    }
    const [target] = await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, id), eq(orgMembers.email, email)));
    if (target?.role === "owner" && parsed.data.role !== "owner" && ctx.role !== "owner") {
      return NextResponse.json({ error: "Only an owner can change another owner's role." }, { status: 403 });
    }
    // Don't demote the last owner.
    if (parsed.data.role !== "owner") {
      const owners = await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, id), eq(orgMembers.role, "owner")));
      if (owners.length === 1 && owners[0].email === email) {
        return NextResponse.json({ error: "A workspace must keep at least one owner." }, { status: 409 });
      }
    }
    const [row] = await db
      .update(orgMembers)
      .set({ role: parsed.data.role })
      .where(and(eq(orgMembers.orgId, id), eq(orgMembers.email, email)))
      .returning();
    if (!row) return NextResponse.json({ error: "Member not found." }, { status: 404 });
    void recordOpsAudit(db, {
      automationType: "org",
      automationId: id,
      actor: (await verifyOpsAuth(request.headers.get("authorization")))?.email ?? "web",
      event: `Changed ${email}'s role to ${parsed.data.role}`,
      orgId: ctx.orgId,
    });
    return NextResponse.json({ item: row });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; email: string }> },
) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, email: raw } = await params;
  const email = decodeURIComponent(raw).toLowerCase();
  if (!canAccessOrg(ctx, id)) return NextResponse.json({ error: "Not your workspace." }, { status: 403 });
  if (!isOrgAdmin(ctx.role)) return NextResponse.json({ error: "Admin or owner only." }, { status: 403 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  try {
    const owners = await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, id), eq(orgMembers.role, "owner")));
    if (owners.length === 1 && owners[0].email === email) {
      return NextResponse.json({ error: "Can't remove the last owner." }, { status: 409 });
    }
    // Only an owner can remove another owner.
    if (owners.some((o) => o.email === email) && ctx.role !== "owner") {
      return NextResponse.json({ error: "Only an owner can remove another owner." }, { status: 403 });
    }
    await db.delete(orgMembers).where(and(eq(orgMembers.orgId, id), eq(orgMembers.email, email)));
    void recordOpsAudit(db, {
      automationType: "org",
      automationId: id,
      actor: (await verifyOpsAuth(request.headers.get("authorization")))?.email ?? "web",
      event: `Removed ${email} from the workspace`,
      orgId: ctx.orgId,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
