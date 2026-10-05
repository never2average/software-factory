import { NextRequest, NextResponse } from "next/server";
import { orgContextForRequest } from "@/lib/org-context";
import { proxyTaskWorkflow } from "@/lib/task-workflow-service";
import { guardTaskRequest } from "@/lib/work-periods-server";

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
  const guarded = await guardTaskRequest(request, ctx.orgId, id);
  if ("response" in guarded) return guarded.response;
  return proxyTaskWorkflow(request, ctx, `/api/v1/tasks/${encodeURIComponent(id)}`, guarded.body);
}

export const PATCH = forward;
export const DELETE = forward;
