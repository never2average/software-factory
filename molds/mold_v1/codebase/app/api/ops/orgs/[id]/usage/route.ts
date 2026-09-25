import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, eq, gte, sql } from "drizzle-orm";
import { automationRuns, orgs } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";
import { orgContextForRequest, tenancyEnabled, canAccessOrg } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/orgs/{id}/usage — this workspace's run volume, tokens and cost
 * over the trailing 30 days, plus its configured caps (orgs.limits). The
 * dispatcher checks these caps before firing (§7 Usage & limits).
 *
 * Fail-safe: pre-migration, org_id is unpopulated, so we report platform-wide
 * totals rather than an empty slice.
 */

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!canAccessOrg(ctx, id)) return NextResponse.json({ error: "Not your workspace." }, { status: 403 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const live = await tenancyEnabled(db);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  try {
    const scope = live
      ? and(eq(automationRuns.orgId, id), gte(automationRuns.startedAt, since))
      : gte(automationRuns.startedAt, since);
    const [agg] = await db
      .select({
        runs: sql<number>`count(*)`,
        inputTokens: sql<number>`coalesce(sum(${automationRuns.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${automationRuns.outputTokens}), 0)`,
        costUsd: sql<number>`coalesce(sum(${automationRuns.costUsd}), 0)`,
      })
      .from(automationRuns)
      .where(scope);
    const [org] = live ? await db.select().from(orgs).where(eq(orgs.orgId, id)).limit(1) : [];
    return NextResponse.json({
      window: "30d",
      scope: live ? "workspace" : "platform (tenancy pending)",
      runs: Number(agg?.runs ?? 0),
      inputTokens: Number(agg?.inputTokens ?? 0),
      outputTokens: Number(agg?.outputTokens ?? 0),
      costUsd: Number(agg?.costUsd ?? 0),
      limits: org?.limits ?? null,
    });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
