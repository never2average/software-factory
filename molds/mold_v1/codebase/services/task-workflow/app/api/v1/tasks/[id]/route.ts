import { authenticateServiceRequest, isServiceContext } from "@/lib/auth";
import { enqueueStageAutomation } from "@/lib/automation";
import { withOrgTransaction } from "@/lib/db";
import { deleteTask, updateTask } from "@/lib/engine";
import { errorResponse, issueMessage } from "@/lib/http";
import { taskPatchSchema } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const ctx = authenticateServiceRequest(request);
  if (!isServiceContext(ctx)) return ctx;
  const parsed = taskPatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: issueMessage(parsed.error) }, { status: 400 });
  try {
    const { id } = await context.params;
    const result = await withOrgTransaction(ctx.orgId, (sql) => updateTask(sql, ctx, id, parsed.data));
    const automationRunId = await enqueueStageAutomation(result.automation);
    return Response.json({ item: result.item, automationRunId, idempotent: result.idempotent ?? false });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const ctx = authenticateServiceRequest(request);
  if (!isServiceContext(ctx)) return ctx;
  try {
    const { id } = await context.params;
    await withOrgTransaction(ctx.orgId, (sql) => deleteTask(sql, ctx, id));
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
