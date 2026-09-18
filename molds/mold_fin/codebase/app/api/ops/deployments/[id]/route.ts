import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { deployments } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { recordFieldChanges } from "@/lib/ops-activity";
import { customerInOrg, orgContextForRequest } from "@/lib/org-context";

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
  healthStatus: z.string().min(1).optional(),
  releaseStatus: z.string().min(1).optional(),
  // Empty string clears it → the label falls back to the composed identity.
  displayName: z.string().optional(),
  actor: z.string().min(1).optional(),
});

function zodMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

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
  const { customerId, actor = "web", ...set } = parsed.data;
  if (Object.keys(set).length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  if (!(await customerInOrg(octx.orgId, customerId))) {
    return NextResponse.json({ error: "Not your workspace's customer." }, { status: 403 });
  }
  try {
    const where = and(eq(deployments.deploymentId, id), eq(deployments.customerId, customerId));
    const [before] = await withOrgRls(octx.orgId, (tx) =>
      tx.select().from(deployments).where(where),
    );
    const [item] = await withOrgRls(octx.orgId, (tx) =>
      tx.update(deployments).set(set).where(where).returning(),
    );
    if (!item) return NextResponse.json({ error: "Deployment not found" }, { status: 404 });
    if (before) {
      void recordFieldChanges(
        db,
        { entityType: "deployment", entityId: id, actor, orgId: octx.orgId },
        [
          { label: "Owner", before: before.deployOwnerEmail, after: item.deployOwnerEmail },
          { label: "Health", before: before.healthStatus, after: item.healthStatus },
          { label: "Release status", before: before.releaseStatus, after: item.releaseStatus },
        ],
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** DELETE /api/ops/deployments/:id?customerId=… — remove a deployment record.
 *  Keyed by (customerId, deploymentId). */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const octx = await orgContextForRequest(request);
  if (!octx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await ctx.params;
  const customerId = new URL(request.url).searchParams.get("customerId");
  if (!customerId) return NextResponse.json({ error: "customerId is required" }, { status: 400 });
  if (!(await customerInOrg(octx.orgId, customerId))) {
    return NextResponse.json({ error: "Not your workspace's customer." }, { status: 403 });
  }
  try {
    const [item] = await withOrgRls(octx.orgId, (tx) =>
      tx
        .delete(deployments)
        .where(and(eq(deployments.deploymentId, id), eq(deployments.customerId, customerId)))
        .returning(),
    );
    if (!item) return NextResponse.json({ error: "Deployment not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
