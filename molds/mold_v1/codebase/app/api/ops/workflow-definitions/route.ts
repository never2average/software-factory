import { NextRequest, NextResponse } from "next/server";
import { orgContextForRequest } from "@/lib/org-context";
import { proxyTaskWorkflow } from "@/lib/task-workflow-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function forward(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return proxyTaskWorkflow(request, ctx, "/api/v1/workflow-definitions");
}

export const GET = forward;
export const POST = forward;
