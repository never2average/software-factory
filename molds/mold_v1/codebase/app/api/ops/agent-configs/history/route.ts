import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { z } from "zod";
import { getOpsDb } from "@/lib/ops-db";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { isOrgAdmin, orgContextForRequest } from "@/lib/org-context";
import { listPromptVersions, restorePromptVersion } from "@/lib/agent-prompt-versions";
import { recordOpsAudit } from "@/lib/ops-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One agent's prompt history.
 *
 *   GET  ?agentKey=research              every state, newest first, each with
 *                                        the text it replaced
 *   POST {agentKey, versionId}           put that version back
 *
 * Reading is open to any workspace member — knowing what an agent was told is
 * not privileged. Restoring changes the agent's behaviour, so it is admin/owner
 * only, matching the PUT that writes the prompt in the first place.
 *
 * tenancy-ok: every database access goes through lib/agent-prompt-versions.ts,
 * which now enters the workspace's RLS scope for each statement and already
 * took the workspace as an argument.
 */

export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const agentKey = new URL(request.url).searchParams.get("agentKey");
  if (!agentKey) return NextResponse.json({ error: "agentKey is required." }, { status: 400 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ items: [] });
  try {
    return NextResponse.json({
      items: await listPromptVersions(db, ctx.orgId, agentKey),
      canRestore: isOrgAdmin(ctx.role),
    });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

const postSchema = z.object({ agentKey: z.string().min(1).max(80), versionId: z.uuid() });

export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!ctx || !identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isOrgAdmin(ctx.role)) return NextResponse.json({ error: "Admin or owner only." }, { status: 403 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  const actor = identity.email.toLowerCase();
  try {
    const result = await restorePromptVersion(
      db,
      ctx.orgId,
      parsed.data.agentKey,
      parsed.data.versionId,
      actor,
    );
    if (!result) {
      return NextResponse.json({ error: "That version no longer exists." }, { status: 404 });
    }
    void recordOpsAudit(db, {
      automationType: "agent",
      automationId: parsed.data.agentKey,
      actor,
      orgId: ctx.orgId,
      event: `Restored an earlier prompt for the ${parsed.data.agentKey} agent`,
    });
    return NextResponse.json({ ok: true, instructions: result.instructions });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
