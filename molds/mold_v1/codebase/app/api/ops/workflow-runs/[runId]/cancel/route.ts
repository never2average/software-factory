import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { orgContextForRequest } from "@/lib/org-context";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { requestWorkflowRunCancellation } from "@/lib/workflow-journal";
import { SERVICE_SCOPE_HEADER } from "@/agent/lib/service-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const runIdSchema = z.string().regex(/^wfr_[A-Za-z0-9-]{8,64}$/);
const bodySchema = z.strictObject({ reason: z.string().trim().max(500).optional() });
type RouteContext = { params: Promise<{ runId: string }> };

/**
 * Durably request cancellation, then fan the signal into every currently known
 * Eve parent/child session. The lease holder records the final `cancelled`
 * state after its heartbeat observes the request; Eve's replayable stream keeps
 * the authoritative `turn.cancelled` -> `session.waiting` boundary.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const [org, identity] = await Promise.all([
    orgContextForRequest(request),
    verifyOpsAuth(request.headers.get("authorization")),
  ]);
  if (!org || !identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (org instanceof Response) return org;
  const { runId } = await context.params;
  if (!runIdSchema.safeParse(runId).success) {
    return NextResponse.json({ error: "Invalid run id" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const cancellation = await requestWorkflowRunCancellation({
    orgId: org.orgId,
    runId,
    requestedBy: identity.email,
    reason: parsed.data.reason ?? null,
  });
  if (cancellation.status === "not_found") {
    return NextResponse.json({ error: "Workflow run not found" }, { status: 404 });
  }
  if (cancellation.status === "not_running") {
    return NextResponse.json({ runId, status: "not_running", signalledSessions: [] });
  }

  /**
   * WHO SIGNALS THE SESSIONS. A run is the workspace's, and any member may cancel it (checked above, where the durable
   * request is recorded). But the agent lets only a step's INITIATOR act on its session; a colleague reads it and no
   * more (lib/chat-gate.ts). So the fan-out goes out as the front-end's own service identity, scoped to this run's
   * workspace — the agent admits it only on sessions in that workspace — and falls back to the caller's token only
   * where there is no service token (local development). Either way, the durable request above is what stops the run.
   */
  const serviceToken = request.headers.get("x-vercel-oidc-token") ?? process.env.VERCEL_OIDC_TOKEN ?? null;
  const bearer = serviceToken ? `Bearer ${serviceToken}` : request.headers.get("authorization");
  const agentUrl = process.env.NEXT_PUBLIC_EVE_API_URL ?? "";
  const signalledSessions: Array<{ sessionId: string; status: string }> = [];
  if (agentUrl && bearer) {
    await Promise.all(
      cancellation.sessionIds.map(async (sessionId) => {
        try {
          const response = await fetch(
            `${agentUrl}/eve/v1/session/${encodeURIComponent(sessionId)}/cancel`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: bearer,
                ...(serviceToken ? { [SERVICE_SCOPE_HEADER]: org.orgId } : {}),
              },
              body: "{}",
              signal: AbortSignal.timeout(10_000),
            },
          );
          const body = (await response.json().catch(() => ({}))) as { status?: string };
          signalledSessions.push({
            sessionId,
            status: response.ok ? body.status ?? "accepted" : `http_${response.status}`,
          });
        } catch {
          signalledSessions.push({ sessionId, status: "unreachable" });
        }
      }),
    );
  }

  return NextResponse.json({
    runId,
    status: cancellation.status,
    cancellationStatus: cancellation.status === "cancelled" ? "cancelled" : "requested",
    reason: cancellation.reason,
    signalledSessions,
  });
}
