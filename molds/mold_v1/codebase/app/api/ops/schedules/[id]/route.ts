import { NextRequest, NextResponse } from "next/server";
import { errorText, zodMessage } from "@/lib/ops-errors";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { scheduleRules } from "@/agent/lib/db/schema";
import { describePatch, recordOpsAudit } from "@/lib/ops-audit";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lease/bookkeeping columns (lockedAt, leaseToken, lastRunAt, nextRunAt) are
// dispatcher-owned and deliberately NOT patchable; strictObject rejects them.
const patchScheduleSchema = z.strictObject({
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  cron: z.string().nullable().optional(),
  everyMinutes: z.number().int().positive().nullable().optional(),
  kind: z.string().min(1).optional(),
  // WHICH workflow (workflows.name) this rule's fire runs; null clears routing.
  workflow: z.string().nullable().optional(),
  channelId: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  // Who to notify when the rule decides to alert — handed to the agent at
  // dispatch time (see agent/schedules/dynamic.ts).
  notifyEmail: z.string().nullable().optional(),
  // The recipient LIST (supersedes the deprecated single notifyEmail above).
  notifyEmails: z.array(z.email()).nullable().optional(),
  enabled: z.boolean().optional(),
  // Who is making the change (audit-trail only; not a column).
  actor: z.string().min(1).optional(),
});

// DELETE may carry an optional JSON body naming the actor for the audit trail.
const deleteBodySchema = z.strictObject({ actor: z.string().min(1).optional() });


const uuidSchema = z.uuid();

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, context: RouteContext) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid schedule id" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = patchScheduleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  const { actor = "web", ...patch } = parsed.data;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }
  try {
    // Read the old row first so the audit entry can describe the actual diff.
    const [before] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(scheduleRules)
        .where(and(eq(scheduleRules.id, id), eq(scheduleRules.orgId, ctx.orgId)))
        .limit(1),
    );
    if (!before) {
      return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
    }
    const [item] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .update(scheduleRules)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(scheduleRules.id, id), eq(scheduleRules.orgId, ctx.orgId)))
        .returning(),
    );
    if (!item) {
      return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
    }
    // Best-effort audit trail — a failed audit write never fails the patch.
    await recordOpsAudit(db, {
      automationType: "schedule",
      automationId: id,
      actor,
      event: describePatch(before, patch),
      orgId: ctx.orgId,
    });
    return NextResponse.json({ item });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid schedule id" }, { status: 400 });
  }
  // Optional body: { actor } for the audit trail; no/invalid body means "web".
  const body = await request.json().catch(() => null);
  const actor = deleteBodySchema.safeParse(body).data?.actor ?? "web";
  try {
    const deleted = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .delete(scheduleRules)
        .where(and(eq(scheduleRules.id, id), eq(scheduleRules.orgId, ctx.orgId)))
        .returning({ id: scheduleRules.id, name: scheduleRules.name }),
    );
    if (deleted.length === 0) {
      return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
    }
    // Best-effort audit trail — a failed audit write never fails the delete.
    await recordOpsAudit(db, {
      automationType: "schedule",
      automationId: id,
      actor,
      event: `Deleted schedule "${deleted[0].name}"`,
      orgId: ctx.orgId,
    });
    return NextResponse.json({ deleted: true });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
