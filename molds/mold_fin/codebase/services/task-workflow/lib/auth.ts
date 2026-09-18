import { timingSafeEqual } from "node:crypto";
import type { ServiceContext } from "@/lib/types";

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authenticateServiceRequest(request: Request): ServiceContext | Response {
  const expected = process.env.TASK_WORKFLOW_SERVICE_TOKEN;
  if (!expected) {
    console.error("TASK_WORKFLOW_SERVICE_TOKEN is not configured");
    return Response.json({ error: "Service authentication is not configured" }, { status: 503 });
  }
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!supplied || !equalSecret(supplied, expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const orgId = request.headers.get("x-org-id")?.trim();
  const actor = request.headers.get("x-actor-email")?.trim().toLowerCase();
  const rawRole = request.headers.get("x-actor-role")?.trim();
  if (!orgId || !actor) return Response.json({ error: "Missing service context" }, { status: 400 });
  const role = rawRole === "owner" || rawRole === "admin" || rawRole === "engineer" ? rawRole : "member";
  return { orgId, actor, role };
}

export function isServiceContext(value: ServiceContext | Response): value is ServiceContext {
  return !(value instanceof Response);
}
