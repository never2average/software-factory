import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { orgs } from "@/agent/lib/db/schema";
import { PERIOD_LENGTH, WORK_PERIODS, daysPhrase, effectivePeriodLength, periodLengthRefusal } from "@/agent/lib/work-periods";
import { errorText } from "@/lib/ops-errors";
import { recordOpsAudit } from "@/lib/ops-audit";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { getOpsDb } from "@/lib/ops-db";
import { canAccessOrg, isOrgAdmin, orgContextForRequest } from "@/lib/org-context";
import { periodsNotFound } from "@/lib/work-periods-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/orgs/{id}/period-length — how long a new work period of this workspace runs: the workspace's own
 *                                         choice, the deployment's default and the range. Any member may read it.
 * PUT /api/ops/orgs/{id}/period-length — { lengthDays: number | null } (null = back to the deployment's default).
 *                                         A workspace admin (owner or admin) only, and only when the deployment
 *                                         profile lets a workspace choose (work_periods.workspace_can_set_length).
 *
 * The profile's `work_periods.length_days` is the default and `length_days_range` bounds the choice. The value is
 * the workspace's own (`orgs.period_length_days`, read and written by the workspace's primary key: one workspace's
 * choice is never another's). It applies to the periods the workspace opens from then on (by hand, by the model's
 * tools, by auto rollover); a period that exists keeps its dates. A change is recorded in the workspace's audit trail.
 * The agent reads it (agent/lib/work-period-store.ts) and has no way to change it.
 *
 * Under work_periods.mode "off" this route does not exist (404), like every other period route.
 */

function answer(stored: number | null, role: Parameters<typeof isOrgAdmin>[0]) {
  return {
    lengthDays: PERIOD_LENGTH.workspaceCanSet ? stored : null,
    effectiveDays: effectivePeriodLength(stored),
    defaultDays: WORK_PERIODS.lengthDays,
    min: PERIOD_LENGTH.min,
    max: PERIOD_LENGTH.max,
    /** The deployment lets a workspace choose. */
    workspaceCanSet: PERIOD_LENGTH.workspaceCanSet,
    /** …and this caller may: a workspace admin. */
    canEdit: PERIOD_LENGTH.workspaceCanSet && isOrgAdmin(role),
  };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const off = periodsNotFound();
  if (off) return off;
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!canAccessOrg(ctx, id)) return NextResponse.json({ error: "Not your workspace." }, { status: 403 });
  const db = getOpsDb();
  if (!db) return NextResponse.json(answer(null, ctx.role));
  try {
    // `orgs` is the workspaces' own table (no row-level security; identity resolution reads across it): this reads
    // exactly one row, the caller's workspace, by its primary key.
    const [row] = await db.select({ days: orgs.periodLengthDays }).from(orgs).where(eq(orgs.orgId, id)).limit(1);
    if (!row) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
    return NextResponse.json(answer(row.days, ctx.role));
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const off = periodsNotFound();
  if (off) return off;
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!canAccessOrg(ctx, id)) return NextResponse.json({ error: "Not your workspace." }, { status: 403 });
  if (!isOrgAdmin(ctx.role)) return NextResponse.json({ error: "Only a workspace admin or owner can change this." }, { status: 403 });
  if (!PERIOD_LENGTH.workspaceCanSet) return NextResponse.json({ error: periodLengthRefusal(null) }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { lengthDays?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body) || !("lengthDays" in body) || Object.keys(body).length !== 1) {
    return NextResponse.json({ error: "Send { lengthDays: a whole number of days, or null for the default }." }, { status: 400 });
  }
  const refused = periodLengthRefusal(body.lengthDays);
  if (refused) return NextResponse.json({ error: refused }, { status: 400 });
  const next = body.lengthDays as number | null;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  try {
    const [before] = await db.select({ days: orgs.periodLengthDays }).from(orgs).where(eq(orgs.orgId, id)).limit(1);
    if (!before) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
    const [row] = await db
      .update(orgs)
      .set({ periodLengthDays: next, updatedAt: new Date() })
      .where(eq(orgs.orgId, id))
      .returning({ days: orgs.periodLengthDays });
    if (!row) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
    if (before.days !== next) {
      const word = WORK_PERIODS.label.singular;
      const phrase = (days: number | null) => (days === null ? `${daysPhrase(WORK_PERIODS.lengthDays)} (the default)` : daysPhrase(days));
      await recordOpsAudit(db, {
        automationType: "org",
        automationId: id,
        actor: (await verifyOpsAuth(request.headers.get("authorization")))?.email ?? "web",
        event: `Changed the ${word} length from ${phrase(before.days)} to ${phrase(next)}; new ${WORK_PERIODS.label.plural} use it, existing ones keep their dates`,
        orgId: id,
      });
    }
    return NextResponse.json(answer(row.days, ctx.role));
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
