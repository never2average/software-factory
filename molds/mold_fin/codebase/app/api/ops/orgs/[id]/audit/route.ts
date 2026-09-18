import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { automationAudit } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";
import { orgContextForRequest, tenancyEnabled, canAccessOrg } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/orgs/{id}/audit — the workspace's append-only audit feed
 * (automation_audit filtered by org): membership/settings changes, connector
 * edits, schedule edits. Most recent first.
 *
 * Fail-safe: pre-migration, org_id is unpopulated → return the recent
 * platform-wide feed rather than an empty list.
 */

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!canAccessOrg(ctx, id)) return NextResponse.json({ error: "Not your workspace." }, { status: 403 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const live = await tenancyEnabled(db);
  try {
    const base = db
      .select({
        id: automationAudit.id,
        automationType: automationAudit.automationType,
        automationId: automationAudit.automationId,
        actor: automationAudit.actor,
        event: automationAudit.event,
        createdAt: automationAudit.createdAt,
      })
      .from(automationAudit)
      .orderBy(desc(automationAudit.createdAt))
      .limit(100);
    const rows = live ? await base.where(eq(automationAudit.orgId, id)) : await base;
    return NextResponse.json({ items: rows });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
