import { NextRequest, NextResponse } from "next/server";
import { errorMessage, errorText, zodMessage } from "@/lib/ops-errors";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apps } from "@/agent/lib/db/schema";
import { cronMatches } from "@/agent/lib/cron-match";
import { describePatch, recordOpsAudit } from "@/lib/ops-audit";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * PATCH  /api/ops/apps/:id — edit the app. Content/provenance columns are
 * refresh-owned and deliberately NOT patchable; strictObject rejects them.
 * DELETE /api/ops/apps/:id — soft delete (the row survives for its history).
 */
const patchAppSchema = z.strictObject({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  sourceKind: z.enum(["workflow", "prompt"]).optional(),
  workflow: z.string().nullable().optional(),
  prompt: z.string().nullable().optional(),
  subagent: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  refreshCron: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  // Who is making the change (audit-trail only; not a column).
  actor: z.string().min(1).optional(),
});

const deleteBodySchema = z.strictObject({ actor: z.string().min(1).optional() });


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: NextRequest, context: RouteContext) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid app id" }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = patchAppSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  const { actor = "web", ...patch } = parsed.data;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }
  // Empty string clears the override — store NULL, same as an explicit null.
  if (patch.refreshCron !== undefined) {
    patch.refreshCron = patch.refreshCron?.trim() || null;
    if (patch.refreshCron) {
      try {
        cronMatches(patch.refreshCron, new Date());
      } catch (e) {
        return NextResponse.json(
          { error: errorMessage(e) },
          { status: 400 },
        );
      }
    }
  }

  try {
    const [before] = await withOrgRls(ctx.orgId, (tx) =>
      tx.select().from(apps).where(and(eq(apps.id, id), eq(apps.orgId, ctx.orgId))).limit(1),
    );
    if (!before) return NextResponse.json({ error: "App not found" }, { status: 404 });
    const [item] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .update(apps)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(apps.id, id), eq(apps.orgId, ctx.orgId)))
        .returning(),
    );
    // Best-effort audit trail — a failed audit write never fails the patch.
    await recordOpsAudit(db, {
      automationType: "workflow",
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
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid app id" }, { status: 400 });

  let actor = "web";
  try {
    const parsed = deleteBodySchema.safeParse(await request.json());
    if (parsed.success && parsed.data.actor) actor = parsed.data.actor;
  } catch {
    /* a body is optional on DELETE */
  }

  try {
    const [item] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .update(apps)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(apps.id, id), eq(apps.orgId, ctx.orgId)))
        .returning(),
    );
    if (!item) return NextResponse.json({ error: "App not found" }, { status: 404 });
    await recordOpsAudit(db, {
      automationType: "workflow",
      automationId: id,
      actor,
      event: `Deleted app "${item.name}"`,
      orgId: ctx.orgId,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
