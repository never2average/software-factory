import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { orgs } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";
import { canAccessOrg, DEFAULT_DOMAIN, DEFAULT_ORG, isOrgAdmin, orgContextForRequest, tenancyEnabled } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 *  GET   /api/ops/orgs/{id}       — workspace settings (members of it, or admins).
 *  PATCH /api/ops/orgs/{id}       — branding / domain / region / limits / status.
 *                                   Admin/owner only. Suspend/activate lives here.
 */

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!canAccessOrg(ctx, id)) return NextResponse.json({ error: "Not your workspace." }, { status: 403 });
  const db = getOpsDb();
  if (!db || !(await tenancyEnabled(db))) {
    // See the note in ../route.ts: no orgs row exists to name, and hardcoding
    // one company's name here showed it to every other tenant.
    return NextResponse.json({ item: { orgId: id, name: "Workspace", status: "active" } });
  }
  try {
    const [row] = await db.select().from(orgs).where(eq(orgs.orgId, id)).limit(1);
    if (!row) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
    return NextResponse.json({ item: row, role: ctx.role });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  googleHostedDomain: z.string().trim().toLowerCase().nullable().optional(),
  branding: z.object({ logoUrl: z.string().optional(), displayName: z.string().optional() }).nullable().optional(),
  plan: z.string().nullable().optional(),
  limits: z
    .object({
      monthlyTokenCap: z.number().optional(),
      monthlyCostUsdCap: z.number().optional(),
      workflowRunCap: z.number().optional(),
    })
    .nullable()
    .optional(),
  status: z.enum(["provisioning", "active", "suspended"]).optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!canAccessOrg(ctx, id)) return NextResponse.json({ error: "Not your workspace." }, { status: 403 });
  if (!isOrgAdmin(ctx.role)) return NextResponse.json({ error: "Admin or owner only." }, { status: 403 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  // Org #1 is the fail-safe home every unresolved identity lands on — suspending
  // it would 403 everyone. Never allow it.
  if (parsed.data.status === "suspended" && id === DEFAULT_ORG) {
    return NextResponse.json({ error: "The primary workspace can't be suspended." }, { status: 409 });
  }
  // Domain-claim safety on update: can't grab a domain another active workspace
  // already owns (a claimed domain auto-joins everyone from it), and the
  // reserved onfinance.in domain stays with org #1.
  if (parsed.data.googleHostedDomain) {
    const domain = parsed.data.googleHostedDomain;
    // Reserved for org #1 only while org #1 exists — see the POST route. A
    // reservation held on behalf of a deleted workspace blocks the domain's
    // real owner and protects nothing.
    if (domain === DEFAULT_DOMAIN && id !== DEFAULT_ORG) {
      const [primary] = await db
        .select({ orgId: orgs.orgId })
        .from(orgs)
        .where(eq(orgs.orgId, DEFAULT_ORG))
        .limit(1);
      if (primary) {
        return NextResponse.json({ error: "That domain is reserved." }, { status: 409 });
      }
    }
    const [claimed] = await db
      .select({ orgId: orgs.orgId, name: orgs.name })
      .from(orgs)
      .where(eq(orgs.googleHostedDomain, domain))
      .limit(1);
    // ownership-guard-ok: `orgs` carries no row-level security, so this read sees every workspace's row.
    if (claimed && claimed.orgId !== id) {
      return NextResponse.json({ error: `Domain '${domain}' already belongs to '${claimed.name}'.` }, { status: 409 });
    }
  }
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(parsed.data)) set[k] = v;
  try {
    const [row] = await db.update(orgs).set(set).where(eq(orgs.orgId, id)).returning();
    if (!row) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
    return NextResponse.json({ item: row });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
