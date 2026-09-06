import { authenticateServiceRequest, isServiceContext } from "@/lib/auth";
import { withOrgTransaction } from "@/lib/db";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = authenticateServiceRequest(request);
  if (!isServiceContext(ctx)) return ctx;
  try {
    const { id } = await params;
    const items = await withOrgTransaction(ctx.orgId, (sql) => sql`
      select id, task_id as "taskId", workflow_id as "workflowId",
             workflow_version_id as "workflowVersionId", from_stage_id as "fromStageId",
             to_stage_id as "toStageId", trigger, actor, reason,
             idempotency_key as "idempotencyKey", created_at as "createdAt"
        from task_workflow_transition_events
       where org_id = ${ctx.orgId} and task_id = ${id}
       order by created_at asc`);
    return Response.json({ items });
  } catch (error) {
    return errorResponse(error);
  }
}
