import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { orgMembers } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";
import { isOrgAdmin, orgContextForRequest, tenancyEnabled, canAccessOrg } from "@/lib/org-context";
import { recordOpsAudit } from "@/lib/ops-audit";
import { verifyOpsAuth } from "@/lib/ops-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 *  GET  /api/ops/orgs/{id}/members  — the workspace roster of members + roles.
 *  POST /api/ops/orgs/{id}/members  — add a member directly (admin/owner only).
 *                                     (Invites, for not-yet-members, are a
 *                                     separate route with a token.)
 */

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!canAccessOrg(ctx, id)) return NextResponse.json({ error: "Not your workspace." }, { status: 403 });
  const db = getOpsDb();
  if (!db || !(await tenancyEnabled(db))) return NextResponse.json({ items: [] });
  try {
    const rows = await db.select().from(orgMembers).where(eq(orgMembers.orgId, id)).orderBy(asc(orgMembers.email));
    return NextResponse.json({ items: rows, role: ctx.role });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

const addSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["owner", "admin", "engineer", "member"]).default("member"),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!canAccessOrg(ctx, id)) return NextResponse.json({ error: "Not your workspace." }, { status: 403 });
  if (!isOrgAdmin(ctx.role)) return NextResponse.json({ error: "Admin or owner only." }, { status: 403 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const parsed = addSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  // Only an owner can grant the owner role.
  if (parsed.data.role === "owner" && ctx.role !== "owner") {
    return NextResponse.json({ error: "Only an owner can add another owner." }, { status: 403 });
  }
  try {
    const [row] = await db
      .insert(orgMembers)
      .values({ orgId: id, email: parsed.data.email, role: parsed.data.role, invitedBy: ctx.orgId, acceptedAt: new Date() })
      .onConflictDoUpdate({ target: [orgMembers.orgId, orgMembers.email], set: { role: parsed.data.role } })
      .returning();
    void recordOpsAudit(db, {
      automationType: "org",
      automationId: id,
      actor: (await verifyOpsAuth(request.headers.get("authorization")))?.email ?? "web",
      event: `Added ${parsed.data.email} as ${parsed.data.role}`,
      orgId: ctx.orgId,
    });
    return NextResponse.json({ item: row }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
