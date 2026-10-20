import { NextRequest, NextResponse } from "next/server";
import { orgContextForRequest } from "@/lib/org-context";
import { proxyTaskWorkflow } from "@/lib/task-workflow-service";
import { guardTaskRequest } from "@/lib/work-periods-server";
import { afterTaskWrite } from "@/lib/record-lifecycle-server";
import { forwardWorkflowTask, taskWorkflowWrite } from "@/lib/record-workflow-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function forward(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  // A lifecycle that runs a workflow: a new task's instance is attached with it (and a move goes through its step rules).
  if (taskWorkflowWrite(request.method)) return forwardWorkflowTask(request, ctx, null, "/api/v1/tasks");
  // The caller's role: what a lifecycle transition's `roles` reads (agent/lib/record-lifecycle.ts).
  const guarded = await guardTaskRequest(request, ctx.orgId, null, undefined, undefined, { role: ctx.role });
  if ("response" in guarded) return guarded.response;
  const response = await proxyTaskWorkflow(request, ctx, "/api/v1/tasks", guarded.body);
  // Once the service took it: an enforced lifecycle's move to the activity feed (and its warnings into the answer),
  // and a recurring task's next occurrence (lib/record-lifecycle-server.ts).
  return afterTaskWrite(response, ctx.orgId, null, guarded.lifecycle);
}

export const GET = forward;
export const POST = forward;
