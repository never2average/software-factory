import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { verifyOpsAuth } from "@/lib/ops-auth";
import type { OrgContext } from "@/lib/org-context";

function serviceConfig(): { url: string; token: string } | null {
  const url = process.env.TASK_WORKFLOW_SERVICE_URL?.replace(/\/$/, "");
  const token = process.env.TASK_WORKFLOW_SERVICE_TOKEN;
  return url && token ? { url, token } : null;
}

/** Forward one authenticated Ops request into the workflow service. The
 * browser's Google token stops here; the internal service gets only resolved
 * tenant/actor context and its own bearer secret. */
export async function proxyTaskWorkflow(
  request: NextRequest,
  ctx: OrgContext,
  path: string,
): Promise<NextResponse> {
  const config = serviceConfig();
  if (!config) {
    return NextResponse.json({ error: "Task workflow service is not configured" }, { status: 503 });
  }
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  try {
    const upstream = await fetch(`${config.url}${path}`, {
      method: request.method,
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": request.headers.get("content-type") ?? "application/json",
        "x-org-id": ctx.orgId,
        "x-actor-email": identity.email.toLowerCase(),
        "x-actor-role": ctx.role,
      },
      body: hasBody ? await request.text() : undefined,
      cache: "no-store",
    });
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch (error) {
    console.error("Task workflow service request failed", { path, error });
    return NextResponse.json({ error: "Task workflow service is unavailable" }, { status: 503 });
  }
}
