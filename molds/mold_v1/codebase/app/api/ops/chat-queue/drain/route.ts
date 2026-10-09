import { NextRequest, NextResponse } from "next/server";
import { getOpsDb } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { drain } from "@/lib/chat-queue-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/ops/chat-queue/drain { sessionId } — a tab of the owner saw its chat come to rest with messages queued:
 * send the next one if it is due (lib/chat-queue-drain.ts decides; this only says who is asking).
 *
 * With the tab's own sign-in, so it works even where the server cannot sign one (no AUTH_JWT_PRIVATE_KEY). The
 * answer names the item that went — or that the hook had already sent — so the tab can read its reply.
 *
 * tenancy-ok: the drain runs on `runInOrg` (withOrgRls) in the caller's workspace; the only bare handle is the
 * `getOpsDb()` null check.
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const email = (await verifyOpsAuth(auth))?.email?.toLowerCase();
  if (!email || !auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!getOpsDb()) return NextResponse.json({ error: "no database" }, { status: 503 });
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "workspace unavailable" }, { status: 503 });
  if (ctx instanceof Response) return ctx;
  const body = (await request.json().catch(() => null)) as { sessionId?: string } | null;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  try {
    const result = await drain({
      orgId: ctx.orgId,
      sessionId,
      by: "tab",
      caller: { email, bearer: auth.replace(/^Bearer\s+/i, "").trim() },
    });
    return NextResponse.json({
      reason: result.reason,
      delivered: result.delivered
        ? { id: result.delivered.id, message: result.delivered.message, sentAt: result.delivered.sentAt, goal: result.delivered.goal, text: result.delivered.text }
        : null,
    });
  } catch {
    return NextResponse.json({ error: "The queue could not be sent." }, { status: 503 });
  }
}
