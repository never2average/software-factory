import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { cycles } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { WORK_PERIODS, followingWindow } from "@/agent/lib/work-periods";
import { listPeriods, rollOverEnded } from "@/agent/lib/work-period-store";
import { periodsNotFound } from "@/lib/work-periods-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET/POST /api/ops/cycles — the periods todos are grouped into. What a period is for this deployment (shared by the
 * team, held per person, or absent) is its profile's `work_periods` (agent/lib/work-periods.ts); under mode "off"
 * this route answers 404 like any path that does not exist.
 *
 * When the profile gives periods a length, a POST without dates opens the period that follows the latest one (or
 * starts today), and it may omit the name. With no length (the default profile) the request is what it always was.
 */
const createSchema = z.strictObject({
  name: WORK_PERIODS.lengthDays === null ? z.string().min(1) : z.string().min(1).optional(),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  createdBy: z.string().min(1).default("web"),
});

export async function GET(request: NextRequest) {
  const off = periodsNotFound();
  if (off) return off;
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  if (!getOpsDb()) return NextResponse.json({ items: [] });
  try {
    const items = await withOrgRls(ctx.orgId, async (tx) => {
      // work_periods.auto_rollover: an ended period is closed and its unfinished tasks carried on, here, inside
      // this workspace's own transaction. Nothing happens when the profile leaves it off (the default).
      await rollOverEnded(tx, ctx.orgId);
      return tx.select().from(cycles).where(and(eq(cycles.orgId, ctx.orgId), isNull(cycles.archivedAt))).orderBy(asc(cycles.startsAt));
    });
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const off = periodsNotFound();
  if (off) return off;
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  const { startsAt, endsAt, ...rest } = parsed.data;
  try {
    const [item] = await withOrgRls(ctx.orgId, async (tx) => {
      const length = WORK_PERIODS.lengthDays;
      if (length !== null && startsAt == null && endsAt == null) {
        const latest = (await listPeriods(tx, ctx.orgId)).filter((c) => c.endsAt).sort((a, b) => b.endsAt!.getTime() - a.endsAt!.getTime())[0] ?? null;
        const window = followingWindow(latest, length);
        return tx.insert(cycles).values({ ...rest, name: rest.name ?? window.name, orgId: ctx.orgId, startsAt: window.startsAt, endsAt: window.endsAt }).returning();
      }
      return tx
        .insert(cycles)
        .values({ ...rest, name: rest.name ?? "", orgId: ctx.orgId, startsAt: startsAt ? new Date(startsAt) : null, endsAt: endsAt ? new Date(endsAt) : null })
        .returning();
    });
    return NextResponse.json({ item }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
