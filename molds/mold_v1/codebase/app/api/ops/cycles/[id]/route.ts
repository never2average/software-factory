import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { cycles } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { recordFieldChanges } from "@/lib/ops-activity";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const patchSchema = z.strictObject({
  name: z.string().min(1).optional(),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  state: z.enum(["planning", "active", "closed"]).optional(),
  goal: z.string().nullable().optional(),
  capacity: z.number().int().nonnegative().nullable().optional(),
  lead: z.string().nullable().optional(),
  actor: z.string().min(1).optional(),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid cycle id" }, { status: 400 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  const { startsAt, endsAt, actor = "web", ...rest } = parsed.data;
  const set: Record<string, unknown> = { ...rest, updatedAt: new Date() };
  if (startsAt !== undefined) set.startsAt = startsAt ? new Date(startsAt) : null;
  if (endsAt !== undefined) set.endsAt = endsAt ? new Date(endsAt) : null;
  try {
    const [before] = await withOrgRls(ctx.orgId, (tx) =>
      tx.select().from(cycles).where(and(eq(cycles.id, id), eq(cycles.orgId, ctx.orgId))),
    );
    const [item] = await withOrgRls(ctx.orgId, (tx) =>
      tx.update(cycles).set(set).where(and(eq(cycles.id, id), eq(cycles.orgId, ctx.orgId))).returning(),
    );
    if (!item) return NextResponse.json({ error: "Cycle not found" }, { status: 404 });
    if (before) {
      void recordFieldChanges(
        db,
        { entityType: "cycle", entityId: id, actor, orgId: ctx.orgId },
        [
          { label: "State", before: before.state, after: item.state },
          { label: "Goal", before: before.goal, after: item.goal },
          { label: "Capacity", before: before.capacity, after: item.capacity },
          { label: "Lead", before: before.lead, after: item.lead },
        ],
      );
    }
    return NextResponse.json({ item });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid cycle id" }, { status: 400 });
  try {
    // Hard delete — the sprint row is removed. Its todos keep their (now
    // dangling) cycleId and simply fall out of any cycle grouping.
    const [item] = await withOrgRls(ctx.orgId, (tx) =>
      tx.delete(cycles).where(and(eq(cycles.id, id), eq(cycles.orgId, ctx.orgId))).returning({ id: cycles.id }),
    );
    if (!item) return NextResponse.json({ error: "Cycle not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
