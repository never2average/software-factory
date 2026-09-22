import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { automationAudit } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import {
  canAccessOrg,
  isOrgAdmin,
  orgContextForRequest,
  tenancyEnabled,
} from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/orgs/{id}/audit — the workspace's append-only audit feed
 * (automation_audit filtered by org): membership/settings changes, connector
 * edits, schedule edits. Most recent first.
 *
 * WHAT THIS ROUTE WAS ACTUALLY DOING, MEASURED
 *
 * Nothing. It sits under `app/api/ops/orgs/`, which `scripts/check-tenancy.mjs`
 * exempts as tenancy CONTROL PLANE, and it queried `automation_audit` on the
 * bare `getOpsDb()` handle. But `automation_audit` is not control plane — it
 * carries an org_id and an `org_isolation` policy (.migrate-org-rls.mjs names
 * it), and that policy fails closed in production. Reproduced on a throwaway
 * Postgres carrying the production policy shape: the bare-handle read returned
 * 0 rows where the scoped read returned the workspace's. The feed has been
 * empty for everyone, which is why nobody noticed it was the wrong shape too.
 *
 * It is scoped now, like every other route that reads tenant rows — and that is
 * what makes the rest of this comment matter, because the moment it returns
 * rows it starts handing something out.
 *
 * TWO GUARDS, because scoping it turns an empty list into real content:
 *
 * 1. ADMINS ONLY. An audit trail names who changed what, and it is reached
 *    through the workspace-administration panel; it was open to every member.
 *    Nobody loses a feed that worked — today it returns nothing to anybody.
 *
 * 2. The chat telemetry that writes here no longer stores a usable session id
 *    (app/api/ops/chat-telemetry/route.ts hashes it). This feed was the supply
 *    of ids the other holes in the chat area needed, and the last 100 things
 *    that went wrong is a poor place to keep capabilities.
 *
 * Fail-safe: pre-migration org_id is unpopulated, so the filter would match
 * nothing — the recent platform-wide feed is returned instead, as before.
 *
 * tenancy-ok: the tenant read runs inside `withOrgRls(id, …)`, for the
 * workspace this caller has just been proved an administrator of. The route's
 * PATH looks like control plane; the table it reads is not.
 */

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!canAccessOrg(ctx, id)) return NextResponse.json({ error: "Not your workspace." }, { status: 403 });
  if (!isOrgAdmin(ctx.role)) {
    return NextResponse.json(
      { error: "The audit trail is available to workspace admins." },
      { status: 403 },
    );
  }
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const live = await tenancyEnabled(db);
  try {
    const rows = await withOrgRls(id, (tx) => {
      const base = tx
        .select({
          id: automationAudit.id,
          automationType: automationAudit.automationType,
          automationId: automationAudit.automationId,
          actor: automationAudit.actor,
          event: automationAudit.event,
          createdAt: automationAudit.createdAt,
        })
        .from(automationAudit)
        .orderBy(desc(automationAudit.createdAt))
        .limit(100);
      return live ? base.where(eq(automationAudit.orgId, id)) : base;
    });
    return NextResponse.json({ items: rows });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
