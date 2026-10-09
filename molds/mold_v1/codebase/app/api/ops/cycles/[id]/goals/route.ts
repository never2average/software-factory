import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { z } from "zod";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { WORK_PERIODS } from "@/agent/lib/work-periods";
import { goalsFor, setMemberGoal } from "@/agent/lib/work-period-store";
import { callerEmail } from "@/lib/work-periods-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET/PUT /api/ops/cycles/:id/goals — each person's own goal and planned count for one period.
 *
 * Exists only under the profile's `work_periods.mode: "individual"` (agent/lib/work-periods.ts); under "team" a
 * period has one shared goal on its own row, and under "off" there are no periods, so both answer 404.
 * A PUT sets the caller's own goal, or (with `member`) that of a person who reports to them on the roster.
 */
const putSchema = z.strictObject({
  member: z.string().email().optional(),
  goal: z.string().max(2000).nullable().optional(),
  targetCount: z.number().int().min(0).max(1000).nullable().optional(),
});

const notHere = () => (WORK_PERIODS.individual ? null : NextResponse.json({ error: "Not found" }, { status: 404 }));

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const off = notHere();
  if (off) return off;
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  if (!getOpsDb()) return NextResponse.json({ items: [] });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid cycle id" }, { status: 400 });
  try {
    const items = await withOrgRls(ctx.orgId, (tx) => goalsFor(tx, ctx.orgId, id));
    return NextResponse.json({ items: items.map((g) => ({ member: g.member, goal: g.goal, targetCount: g.targetCount, updatedAt: g.updatedAt })) });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const off = notHere();
  if (off) return off;
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  if (!getOpsDb()) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid cycle id" }, { status: 400 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  const me = await callerEmail(request);
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await withOrgRls(ctx.orgId, (tx) =>
      setMemberGoal(tx, ctx.orgId, me, { cycleId: id, member: parsed.data.member ?? me, goal: parsed.data.goal, targetCount: parsed.data.targetCount }),
    );
    if ("refused" in result) return NextResponse.json({ error: result.refused }, { status: result.refused.startsWith("No ") ? 404 : 403 });
    return NextResponse.json({ item: { member: result.item.member, goal: result.item.goal, targetCount: result.item.targetCount } });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
