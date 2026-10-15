import { NextRequest, NextResponse } from "next/server";
import { orgContextForRequest } from "@/lib/org-context";
import { proxyTaskWorkflow } from "@/lib/task-workflow-service";
import { guardTaskRequest } from "@/lib/work-periods-server";
import { afterTaskWrite } from "@/lib/record-lifecycle-server";
import { taskDeleteForbidden } from "@/lib/record-permissions-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function forward(request: NextRequest, context: RouteContext) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const { id } = await context.params;
  // Who may delete it (records.areas.tasks.permissions): a 403 with the sentence; nothing read when undeclared.
  if (request.method === "DELETE") {
    const no = await taskDeleteForbidden(request, ctx, id);
    if (no) return no;
  }
  // The caller's role: what a lifecycle transition's `roles` reads (agent/lib/record-lifecycle.ts).
  const guarded = await guardTaskRequest(request, ctx.orgId, id, undefined, undefined, { role: ctx.role });
  if ("response" in guarded) return guarded.response;
  const response = await proxyTaskWorkflow(request, ctx, `/api/v1/tasks/${encodeURIComponent(id)}`, guarded.body);
  // Once the service took it: an enforced lifecycle's move to the activity feed (and its warnings into the answer),
  // and a recurring task's next occurrence (lib/record-lifecycle-server.ts).
  return afterTaskWrite(response, ctx.orgId, id, guarded.lifecycle);
}

export const PATCH = forward;
export const DELETE = forward;
