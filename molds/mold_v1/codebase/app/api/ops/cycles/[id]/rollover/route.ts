import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { cycles, todos } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { recordActivity } from "@/lib/ops-activity";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/ops/cycles/:id/rollover — move every unfinished (non-done,
 * non-cancelled) task out of this cycle into `target` (another cycle id, or
 * null = backlog). Used when closing a sprint.
 */
const bodySchema = z.strictObject({
  target: z.string().uuid().nullable().optional(),
  actor: z.string().min(1).optional(),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid cycle id" }, { status: 400 });
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const { target = null, actor = "web" } = parsed.data;
  try {
    const moved = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .update(todos)
        .set({ cycleId: target, updatedAt: new Date() })
        .where(and(eq(todos.orgId, ctx.orgId), eq(todos.cycleId, id), isNull(todos.archivedAt), ne(todos.done, true)))
        .returning({ id: todos.id }),
    );
    let targetName: string | null = null;
    if (target) {
      const [c] = await withOrgRls(ctx.orgId, (tx) =>
        tx.select({ name: cycles.name }).from(cycles).where(and(eq(cycles.id, target), eq(cycles.orgId, ctx.orgId))),
      );
      targetName = c?.name ?? null;
    }
    void recordActivity(db, {
      entityType: "cycle",
      entityId: id,
      actor,
      orgId: ctx.orgId,
      event: `Rolled over ${moved.length} unfinished task${moved.length === 1 ? "" : "s"} to ${targetName ?? "Backlog"}`,
    });
    return NextResponse.json({ ok: true, moved: moved.length });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
