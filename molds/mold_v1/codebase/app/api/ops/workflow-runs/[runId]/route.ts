import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { workflowRunJournal, workflowRuns } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/workflow-runs/[runId] — the durable state of one workflow run:
 * the run row plus its agent()-call journal, ordered by call index.
 *
 * Returns { run: null, journal: [] } with a 200 for an unknown runId — the
 * client polls before the row exists, so "not yet" is not an error. Previews
 * are truncated server-side; full prompts/results never leave the DB here.
 */
const runIdSchema = z.string().regex(/^wfr_[A-Za-z0-9-]{8,64}$/);

type RouteContext = { params: Promise<{ runId: string }> };

function preview(text: string | null, max: number): string | null {
  if (text == null) return null;
  return text.length > max ? text.slice(0, max) : text;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const org = await orgContextForRequest(request);
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  const { runId } = await context.params;
  if (!runIdSchema.safeParse(runId).success) {
    return NextResponse.json({ error: "Invalid run id" }, { status: 400 });
  }

  try {
    const [runRow] = await withOrgRls(org.orgId, (tx) =>
      tx
        .select()
        .from(workflowRuns)
        .where(and(eq(workflowRuns.orgId, org.orgId), eq(workflowRuns.runId, runId)))
        .limit(1),
    );

    if (!runRow) return NextResponse.json({ run: null, journal: [] });

    const journalRows = await withOrgRls(org.orgId, (tx) =>
      tx
        .select()
        .from(workflowRunJournal)
        .where(
          and(eq(workflowRunJournal.orgId, org.orgId), eq(workflowRunJournal.runId, runId)),
        )
        .orderBy(asc(workflowRunJournal.callIndex), asc(workflowRunJournal.attempt)),
    );

    const run = {
      runId: runRow.runId,
      workflowId: runRow.workflowId,
      workflowName: runRow.workflowName,
      status: runRow.status as "running" | "completed" | "failed" | "cancelled",
      attempts: runRow.attempts,
      workerId: runRow.workerId,
      leaseExpiresAt: runRow.leaseExpiresAt?.toISOString() ?? null,
      lastHeartbeatAt: runRow.lastHeartbeatAt?.toISOString() ?? null,
      cancellationStatus: runRow.cancelledAt
        ? "cancelled"
        : runRow.cancelRequestedAt
          ? "requested"
          : "none",
      cancelRequestedAt: runRow.cancelRequestedAt?.toISOString() ?? null,
      cancelRequestedBy: runRow.cancelRequestedBy,
      cancelReason: runRow.cancelReason,
      cancelledAt: runRow.cancelledAt?.toISOString() ?? null,
      error: runRow.error,
      createdAt: runRow.createdAt.toISOString(),
      updatedAt: runRow.updatedAt.toISOString(),
    };

    const journal = journalRows.map((row) => ({
      callIndex: row.callIndex,
      attempt: row.attempt,
      subagent: row.subagent,
      // Enough to read each step as a transcript (a workflow run is a chain of
      // subagent turns) — still bounded so full text stays in the DB.
      promptPreview: preview(row.prompt, 4000) ?? "",
      status: row.status as "running" | "completed" | "failed",
      error: row.error,
      resultPreview: preview(row.result, 8000),
      // The step's steer target — its session and the subagent child under it.
      sessionId: row.sessionId ?? null,
      childSessionId: row.childSessionId ?? null,
      createdAt: row.createdAt.toISOString(),
    }));

    return NextResponse.json({ run, journal });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
