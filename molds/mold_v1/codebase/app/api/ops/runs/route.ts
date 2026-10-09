import { NextRequest, NextResponse } from "next/server";
import { errorText, zodMessage as opsZodMessage } from "@/lib/ops-errors";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { automationRuns, workflowRunJournal } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/runs?type=<t>&id=<id>&limit=<n> — run history for one
 * automation, newest first. `type` is a closed set; `id` is the automation
 * row's uuid or the system cron's name.
 */
const querySchema = z.strictObject({
  type: z.enum(["schedule", "system_cron", "connector", "workflow"]),
  id: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

// The issue list in the profile's words (lib/ops-errors.ts); "query" names a bad query string.
const zodMessage = (error: z.ZodError): string => opsZodMessage(error, "query");

export async function GET(request: NextRequest) {
  // This route read tenant data with NO workspace resolved at all.
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ items: [] });
  const params = request.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    type: params.get("type") ?? undefined,
    id: params.get("id") ?? undefined,
    limit: params.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  const { type, id, limit } = parsed.data;
  try {
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(automationRuns)
        .where(and(eq(automationRuns.automationType, type), eq(automationRuns.automationId, id)))
        .orderBy(desc(automationRuns.startedAt))
        .limit(limit),
    );

    // A fire that ran a workflow is only openable as a chat if that run
    // captured a step session; flag it so the UI can skip dead links.
    const wfRunIds = rows.map((r) => r.workflowRunId).filter((x): x is string => Boolean(x));
    const withSession = wfRunIds.length
      ? await withOrgRls(ctx.orgId, (tx) =>
          tx
          .select({ runId: workflowRunJournal.runId })
          .from(workflowRunJournal)
          .where(
            and(inArray(workflowRunJournal.runId, wfRunIds), isNotNull(workflowRunJournal.sessionId)),
          ),
        )
      : [];
    const sessionSet = new Set(withSession.map((r) => r.runId));
    const items = rows.map((row) => ({
      ...row,
      hasSession: row.workflowRunId ? sessionSet.has(row.workflowRunId) : false,
    }));
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
