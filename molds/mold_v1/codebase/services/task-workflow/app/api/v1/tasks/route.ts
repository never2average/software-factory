import { authenticateServiceRequest, isServiceContext } from "@/lib/auth";
import { enqueueStageAutomation } from "@/lib/automation";
import { withOrgTransaction } from "@/lib/db";
import { createTask, listTasks } from "@/lib/engine";
import { errorResponse, issueMessage } from "@/lib/http";
import { taskCreateSchema } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const ctx = authenticateServiceRequest(request);
  if (!isServiceContext(ctx)) return ctx;
  try {
    const items = await withOrgTransaction(ctx.orgId, (sql) => listTasks(sql, ctx.orgId));
    return Response.json({ items });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const ctx = authenticateServiceRequest(request);
  if (!isServiceContext(ctx)) return ctx;
  const parsed = taskCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: issueMessage(parsed.error) }, { status: 400 });
  try {
    const result = await withOrgTransaction(ctx.orgId, (sql) => createTask(sql, ctx, parsed.data));
    const automationRunId = await enqueueStageAutomation(result.automation);
    return Response.json({ item: result.item, automationRunId }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
