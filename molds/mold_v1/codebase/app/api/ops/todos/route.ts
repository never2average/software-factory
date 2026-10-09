import { NextRequest, NextResponse } from "next/server";
import { orgContextForRequest } from "@/lib/org-context";
import { proxyTaskWorkflow } from "@/lib/task-workflow-service";
import { guardTaskRequest } from "@/lib/work-periods-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function forward(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const guarded = await guardTaskRequest(request, ctx.orgId, null);
  if ("response" in guarded) return guarded.response;
  return proxyTaskWorkflow(request, ctx, "/api/v1/tasks", guarded.body);
}

export const GET = forward;
export const POST = forward;
