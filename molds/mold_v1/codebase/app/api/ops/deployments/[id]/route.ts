import { NextRequest, NextResponse } from "next/server";
import { errorText, zodMessage } from "@/lib/ops-errors";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { deployments } from "@/agent/lib/db/schema";
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

/** Drawn from its definition (records.areas.deployments): a change goes through lib/record-area-routes.ts. */
const DECLARED = isDeclared("deployments");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/ops/deployments/:id — edit the editable key fields (owner / health
 * / release status) from the details card. Keyed by (customerId, deploymentId);
 * customerId comes in the body. Writes the system-of-record.
 */
const patchSchema = z.strictObject({
  customerId: z.string().min(1),
  deployOwnerEmail: z.string().min(1).optional(),
  // One of the stored values (the schema's enum), or a 400 that lists them.
  healthStatus: choiceSchema("deployments", "healthStatus").optional(),
  releaseStatus: choiceSchema("deployments", "releaseStatus").optional(),
  // Empty string clears it → the label falls back to the composed identity.
  displayName: z.string().optional(),
  actor: z.string().min(1).optional(),
  // Two companies may each have a report "Q2FY26-results": the list then keys the row (and its activity feed)
  // on customer + id, and says so here. Absent, the activity is filed under the route id as before.
  entityId: z.string().min(1).optional(),
  // Any other single-value column, for a deployment profile that puts it on the detail card (`domains`).
  ...profileFieldSchemas("deployments", ["deployOwnerEmail", "healthStatus", "releaseStatus"]),
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
      return await declaredPatch("deployments", octx, db, and(eq(deployments.orgId, octx.orgId), eq(deployments.deploymentId, id), eq(deployments.customerId, customerId))!, b, typeof b.entityId === "string" && b.entityId ? b.entityId : id, (await callerEmail(request)) ?? "");
    } catch (e) {
      return NextResponse.json({ error: errorText(e) }, { status: 500 });
    }
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  const { customerId, actor = "web", entityId, custom: customInput, ...set } = parsed.data as { customerId: string; actor?: string; entityId?: string; custom?: unknown } & Record<string, unknown>;
  if (customInput != null) set.custom = customInput;
  if (Object.keys(set).length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  if (!(await customerInOrg(octx.orgId, customerId))) {
    return NextResponse.json({ error: `Not your workspace's ${W.account}.` }, { status: 403 });
  }
  try {
    const where = and(eq(deployments.orgId, octx.orgId), eq(deployments.deploymentId, id), eq(deployments.customerId, customerId));
    const [before] = await withOrgRls(octx.orgId, (tx) =>
      tx.select().from(deployments).where(where),
    );
    // The one validator every write to the area goes through (agent/lib/record-area-write.ts): only its refusal is used here.
    const refusal = checkOnly("deployments", "update", { ...set }, { actor, role: octx.role, before: (before as Record<string, unknown> | undefined) ?? null });
    if (refusal.length) return refused(refusal);
    if (before && "custom" in set) {
      const checked = customForWrite("deployments", set.custom, before);
      if (checked.error) return NextResponse.json({ error: checked.error }, { status: 400 });
      // Only the keys the body names, merged in SQL onto what is stored at write time: the value checked above was
      // read before this statement, and writing it back whole lost an own value saved in between.
      const delta = customDelta(set.custom, checked.custom ?? {});
      if (delta) set.custom = customMergeSql(deployments.custom, delta, { empty: "object" });
      else delete set.custom;
    }
    const [item] = await withOrgRls(octx.orgId, (tx) =>
      tx.update(deployments).set(set).where(where).returning(),
    );
    if (!item) return NextResponse.json({ error: `${W.Deployment} not found` }, { status: 404 });
    if (before) {
      void recordFieldChanges(
        db,
        { entityType: "deployment", entityId: entityId ?? id, actor, orgId: octx.orgId },
        [
          { label: profileFieldLabel("deployments", "deployOwnerEmail", "Owner"), before: before.deployOwnerEmail, after: item.deployOwnerEmail },
          { label: profileFieldLabel("deployments", "healthStatus", "Health"), before: before.healthStatus, after: item.healthStatus },
          { label: profileFieldLabel("deployments", "releaseStatus", "Release status"), before: before.releaseStatus, after: item.releaseStatus },
          ...Object.keys(set)
            .filter((k) => !["deployOwnerEmail", "healthStatus", "releaseStatus", "displayName", "custom"].includes(k))
            .map((k) => ({ label: profileFieldLabel("deployments", k, k), before: stringOrNull((before as Record<string, unknown>)[k]), after: stringOrNull((item as Record<string, unknown>)[k]) })),
          ...("custom" in set ? customFieldChanges("deployments", before.custom, item.custom) : []),
        ],
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

/** DELETE /api/ops/deployments/:id?customerId=… — remove a deployment record.
 *  Keyed by (customerId, deploymentId). */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const octx = await orgContextForRequest(request);
  if (!octx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (octx instanceof Response) return octx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await ctx.params;
  const customerId = new URL(request.url).searchParams.get("customerId");
  if (!customerId) return NextResponse.json({ error: "customerId is required" }, { status: 400 });
  if (!(await customerInOrg(octx.orgId, customerId))) {
    return NextResponse.json({ error: `Not your workspace's ${W.account}.` }, { status: 403 });
  }
  try {
    // Who may delete it (records.areas.deployments.permissions): a 403 with the sentence. Nothing is read when none are declared.
    const forbidden = await deleteForbidden("deployments", octx, and(eq(deployments.orgId, octx.orgId), eq(deployments.deploymentId, id), eq(deployments.customerId, customerId))!, () => callerEmail(request));
    if (forbidden) return forbidden;
    const [item] = await withOrgRls(octx.orgId, (tx) =>
      tx
        .delete(deployments)
        .where(and(eq(deployments.orgId, octx.orgId), eq(deployments.deploymentId, id), eq(deployments.customerId, customerId)))
        .returning(),
    );
    if (!item) return NextResponse.json({ error: `${W.Deployment} not found` }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
