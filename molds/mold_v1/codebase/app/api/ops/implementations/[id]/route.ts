import { NextRequest, NextResponse } from "next/server";
import { errorText, zodMessage } from "@/lib/ops-errors";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { implementation } from "@/agent/lib/db/schema";
import { implementationSchema } from "@/agent/lib/customer-schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { recordFieldChanges } from "@/lib/ops-activity";
import { customerInOrg, orgContextForRequest } from "@/lib/org-context";
import { choiceSchema, customBodySchema, customFieldChanges, customForWrite, profileFieldLabel, profileFieldSchemas } from "@/lib/ops-domain-fields";
import { customDelta } from "@/agent/lib/custom-fields";
import { customMergeSql } from "@/agent/lib/custom-merge-sql";
import { W } from "@/lib/ui-words";
import { isDeclared } from "@/agent/lib/record-area-records";
import { checkOnly } from "@/agent/lib/record-area-write";
import { declaredPatch, deleteForbidden, refused } from "@/lib/record-area-routes";
import { callerEmail } from "@/lib/work-periods-server";

/** Drawn from its definition (records.areas.implementations): a change goes through lib/record-area-routes.ts. */
const DECLARED = isDeclared("implementations");

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
  // One of the stored values (the schema's enum), or a 400 that lists them.
  implementationStage: choiceSchema("implementations", "implementationStage").optional(),
  implementationRiskLevel: choiceSchema("implementations", "implementationRiskLevel").optional(),
  // Empty string clears it → the label falls back to the composed identity.
  displayName: z.string().optional(),
  actor: z.string().min(1).optional(),
  implementationProgressPct: z.coerce.number().min(0).max(100).optional(),
  // The stored values, from the one schema that lists them (agent/lib/customer-schema.ts).
  blockerOwner: implementationSchema.shape.blockerOwner.optional(),
  // Any other single-value column, for a deployment profile that puts it on the detail card (`domains`).
  ...profileFieldSchemas("implementations", ["implementationOwnerEmail", "implementationStage", "implementationRiskLevel"]),
  // The profile's OWN fields (`custom_fields`): a PARTIAL change, merged onto what is stored; null clears a key.
  custom: customBodySchema,
});

const stringOrNull = (v: unknown): string | null => (v == null ? null : String(v));


export async function PATCH(request: NextRequest, context: RouteContext) {
  const octx = await orgContextForRequest(request);
  if (!octx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (octx instanceof Response) return octx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (DECLARED) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return refused(["The body must be a JSON object."]);
    const b = body as Record<string, unknown>;
    const customerId = typeof b.customerId === "string" ? b.customerId : "";
    if (!customerId) return refused([`Name the ${W.account} this belongs to.`]);
    if (!(await customerInOrg(octx.orgId, customerId))) {
      return NextResponse.json({ error: `Not your workspace's ${W.account}.` }, { status: 403 });
    }
    try {
      return await declaredPatch("implementations", octx, db, and(eq(implementation.orgId, octx.orgId), eq(implementation.customerId, customerId))!, b, id, (await callerEmail(request)) ?? "");
    } catch (e) {
      return NextResponse.json({ error: errorText(e) }, { status: 500 });
    }
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
      tx.select().from(implementation).where(and(eq(implementation.orgId, octx.orgId), eq(implementation.customerId, customerId))),
    );
    // The one validator every write to the area goes through (agent/lib/record-area-write.ts): only its refusal is used here.
    const refusal = checkOnly("implementations", "update", { ...set }, { actor, role: octx.role, before: (before as Record<string, unknown> | undefined) ?? null });
    if (refusal.length) return refused(refusal);
    if (before && "custom" in set) {
      const checked = customForWrite("implementations", set.custom, before);
      if (checked.error) return NextResponse.json({ error: checked.error }, { status: 400 });
      // Only the keys the body names, merged in SQL onto what is stored at write time: the value checked above was
      // read before this statement, and writing it back whole lost an own value saved in between.
      const delta = customDelta(set.custom, checked.custom ?? {});
      if (delta) set.custom = customMergeSql(implementation.custom, delta, { empty: "object" });
      else delete set.custom;
    }
    const [item] = await withOrgRls(octx.orgId, (tx) =>
      tx
        .update(implementation)
        .set(set)
        .where(and(eq(implementation.orgId, octx.orgId), eq(implementation.customerId, customerId)))
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
 *  Keyed by (customerId, the caller's workspace): the table's primary key. */
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const octx = await orgContextForRequest(request);
  if (!octx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (octx instanceof Response) return octx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const url = new URL(request.url);
  const { id } = await ctx.params;
  // customerId (with the workspace) is the PK; fall back to the route id (which is rolloutId ?? customerId).
  const customerId = url.searchParams.get("customerId") ?? id;
  if (!(await customerInOrg(octx.orgId, customerId))) {
    return NextResponse.json({ error: `Not your workspace's ${W.account}.` }, { status: 403 });
  }
  try {
    // Who may delete it (records.areas.implementations.permissions): a 403 with the sentence. Nothing is read when none are declared.
    const forbidden = await deleteForbidden("implementations", octx, and(eq(implementation.orgId, octx.orgId), eq(implementation.customerId, customerId))!, () => callerEmail(request));
    if (forbidden) return forbidden;
    const [item] = await withOrgRls(octx.orgId, (tx) =>
      tx
        .delete(implementation)
        .where(and(eq(implementation.orgId, octx.orgId), eq(implementation.customerId, customerId)))
        .returning(),
    );
    if (!item) return NextResponse.json({ error: `${W.Implementation} not found` }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
