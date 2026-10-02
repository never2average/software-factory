import { NextRequest, NextResponse } from "next/server";
import { orgContextForRequest } from "@/lib/org-context";
import { proxyTaskWorkflow } from "@/lib/task-workflow-service";

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
  return proxyTaskWorkflow(request, ctx, `/api/v1/tasks/${encodeURIComponent(id)}`);
}

export const PATCH = forward;
export const DELETE = forward;
