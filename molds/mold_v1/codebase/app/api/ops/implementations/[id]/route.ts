import { NextRequest, NextResponse } from "next/server";
import { errorText, zodMessage } from "@/lib/ops-errors";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { implementation } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { recordFieldChanges } from "@/lib/ops-activity";
import { customerInOrg, orgContextForRequest } from "@/lib/org-context";
import { customBodySchema, customFieldChanges, customForWrite, profileFieldLabel, profileFieldSchemas } from "@/lib/ops-domain-fields";
import { W } from "@/lib/ui-words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/ops/implementations/:id — edit the editable key fields (owner /
 * stage / risk) from the details card. The implementation table is one row per
 * customer, so it's keyed by customerId (passed in the body). Writes the SoR.
 */
const patchSchema = z.strictObject({
  customerId: z.string().min(1),
  implementationOwnerEmail: z.string().min(1).optional(),
  implementationStage: z.string().min(1).optional(),
  implementationRiskLevel: z.string().min(1).optional(),
  // Empty string clears it → the label falls back to the composed identity.
  displayName: z.string().optional(),
  actor: z.string().min(1).optional(),
  implementationProgressPct: z.coerce.number().min(0).max(100).optional(),
  blockerOwner: z.enum(["Provider", "Customer", "Third-Party Vendor", "None"]).optional(),
  // Any other single-value column, for a deployment profile that puts it on the detail card (`domains`).
  ...profileFieldSchemas("implementations", ["implementationOwnerEmail", "implementationStage", "implementationRiskLevel"]),
  // The profile's OWN fields (`custom_fields`): a PARTIAL change, merged onto what is stored; null clears a key.
  custom: customBodySchema,
});

const stringOrNull = (v: unknown): string | null => (v == null ? null : String(v));


export async function PATCH(request: NextRequest, context: RouteContext) {
  const octx = await orgContextForRequest(request);
  if (!octx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  const { customerId, actor = "web", custom: customInput, ...set } = parsed.data as { customerId: string; actor?: string; custom?: unknown } & Record<string, unknown>;
  if (customInput != null) set.custom = customInput;
  if (Object.keys(set).length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  if (!(await customerInOrg(octx.orgId, customerId))) {
    return NextResponse.json({ error: `Not your workspace's ${W.account}.` }, { status: 403 });
  }
  try {
    const [before] = await withOrgRls(octx.orgId, (tx) =>
      tx.select().from(implementation).where(eq(implementation.customerId, customerId)),
    );
    if (before && "custom" in set) {
      const checked = customForWrite("implementations", set.custom, before);
      if (checked.error) return NextResponse.json({ error: checked.error }, { status: 400 });
      set.custom = checked.custom;
    }
    const [item] = await withOrgRls(octx.orgId, (tx) =>
      tx
        .update(implementation)
        .set(set)
        .where(eq(implementation.customerId, customerId))
        .returning(),
    );
    if (!item) return NextResponse.json({ error: `${W.Implementation} not found` }, { status: 404 });
    if (before) {
      void recordFieldChanges(
        db,
        { entityType: "implementation", entityId: id, actor, orgId: octx.orgId },
        [
          { label: profileFieldLabel("implementations", "implementationOwnerEmail", "Owner"), before: before.implementationOwnerEmail, after: item.implementationOwnerEmail },
          { label: profileFieldLabel("implementations", "implementationStage", "Stage"), before: before.implementationStage, after: item.implementationStage },
          { label: profileFieldLabel("implementations", "implementationRiskLevel", "Risk"), before: before.implementationRiskLevel, after: item.implementationRiskLevel },
          ...Object.keys(set)
            .filter((k) => !["implementationOwnerEmail", "implementationStage", "implementationRiskLevel", "displayName", "custom"].includes(k))
            .map((k) => ({ label: profileFieldLabel("implementations", k, k), before: stringOrNull((before as Record<string, unknown>)[k]), after: stringOrNull((item as Record<string, unknown>)[k]) })),
          ...("custom" in set ? customFieldChanges("implementations", before.custom, item.custom) : []),
        ],
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

/** DELETE /api/ops/implementations/:id?customerId=… — remove a rollout record.
 *  Keyed by customerId (the table's primary key). */
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const octx = await orgContextForRequest(request);
  if (!octx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const url = new URL(request.url);
  const { id } = await ctx.params;
  // customerId is the PK; fall back to the route id (which is rolloutId ?? customerId).
  const customerId = url.searchParams.get("customerId") ?? id;
  if (!(await customerInOrg(octx.orgId, customerId))) {
    return NextResponse.json({ error: `Not your workspace's ${W.account}.` }, { status: 403 });
  }
  try {
    const [item] = await withOrgRls(octx.orgId, (tx) =>
      tx
        .delete(implementation)
        .where(eq(implementation.customerId, customerId))
        .returning(),
    );
    if (!item) return NextResponse.json({ error: `${W.Implementation} not found` }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
