import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { workflowRunJournal, workflowRuns } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/workflow-runs — the most recent workflow runs, newest activity
 * first. Optional ?status= filters to one lifecycle state; ?limit= caps the
 * page (1..50, default 10). Per-run detail (journal, previews) lives at
 * /api/ops/workflow-runs/[runId].
 */
const querySchema = z.object({
  status: z.enum(["running", "completed", "failed", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export async function GET(request: NextRequest) {
  const org = await orgContextForRequest(request);
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
    status: searchParams.get("status") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query parameters" }, { status: 400 });
  }
  const { status, limit } = parsed.data;

  try {
    const rows = await withOrgRls(org.orgId, (tx) =>
      tx
      .select()
      .from(workflowRuns)
      .where(
        status
          ? and(eq(workflowRuns.orgId, org.orgId), eq(workflowRuns.status, status))
          : eq(workflowRuns.orgId, org.orgId),
      )
      .orderBy(desc(workflowRuns.updatedAt))
      .limit(limit),
    );

    // Which of these runs have at least one step with a recorded eve session?
    // Only those can be opened as a chat — the rest predate session capture.
    const runIds = rows.map((r) => r.runId);
    const withSession = runIds.length
      ? await withOrgRls(org.orgId, (tx) =>
          tx
          .select({ runId: workflowRunJournal.runId })
          .from(workflowRunJournal)
          .where(
            and(
              eq(workflowRunJournal.orgId, org.orgId),
              inArray(workflowRunJournal.runId, runIds),
              isNotNull(workflowRunJournal.sessionId),
            ),
          ),
        )
      : [];
    const sessionSet = new Set(withSession.map((r) => r.runId));

    const runs = rows.map((row) => ({
      runId: row.runId,
      workflowId: row.workflowId,
      workflowName: row.workflowName,
      status: row.status as "running" | "completed" | "failed" | "cancelled",
      attempts: row.attempts,
      workerId: row.workerId,
      leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
      lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
      cancellationStatus: row.cancelledAt
        ? "cancelled"
        : row.cancelRequestedAt
          ? "requested"
          : "none",
      cancelReason: row.cancelReason,
      error: row.error,
      createdBy: row.createdBy,
      hasSession: sessionSet.has(row.runId),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));

    return NextResponse.json({ runs });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
