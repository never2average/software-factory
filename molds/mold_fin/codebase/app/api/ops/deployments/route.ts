import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { customers, deployments } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { isForeignKeyViolation, isUniqueViolation } from "@/lib/pg-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/ops/deployments — hand-create a deployment record. The identity
 *  fields are required (they're NOT NULL); health/release default to sane
 *  values the operator refines in the detail panel. */
const createSchema = z.object({
  customerId: z.string().min(1, "Pick a customer."),
  deploymentId: z.string().min(1, "A deployment id is required."),
  environment: z.string().min(1, "An environment is required."),
  region: z.string().min(1, "A region is required."),
  deployedVersion: z.string().min(1, "A version is required."),
  releaseStatus: z.string().min(1).default("deployed"),
  healthStatus: z.string().min(1).default("healthy"),
  deployOwnerEmail: z.string().trim().optional().nullable(),
  displayName: z.string().trim().optional().nullable(),
});

export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  try {
    const [row] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .insert(deployments)
        .values({
          ...parsed.data,
          // Stamp the tenant. Without it the row is written with a NULL org_id,
          // which the org_isolation policy matches for no workspace at all — the
          // create succeeds and the record is invisible to everyone.
          orgId: ctx.orgId,
          deployOwnerEmail: parsed.data.deployOwnerEmail || null,
          displayName: parsed.data.displayName || null,
        })
        .returning(),
    );
    return NextResponse.json({ item: { id: row.deploymentId } }, { status: 201 });
  } catch (e) {
    const msg = String(e);
    // Same trap as implementations: the FK to `customers` surfaced as an opaque
    // driver dump. Say the fixable thing instead.
    if (isForeignKeyViolation(e)) {
      return NextResponse.json(
        {
          error:
            `No customer with that id exists yet, so this deployment has nothing to attach to. ` +
            `Create the customer first (POST /api/ops/customers, or customer_create from the CLI).`,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** GET /api/ops/deployments — deployment cards + container-picker rows. */
export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ items: [] });
  try {
  // Workspace-scoped. These tables had no org_id until the tenancy migration,
  // so this route returned every workspace's rows to any signed-in caller.
    const [rows, custs] = await withOrgRls(ctx.orgId, (tx) =>
      Promise.all([
        tx.select().from(deployments).where(eq(deployments.orgId, ctx.orgId))
          .orderBy(asc(deployments.customerId), asc(deployments.deploymentId)).limit(300),
        tx.select({ id: customers.customerId, name: customers.customerName }).from(customers)
          .where(eq(customers.orgId, ctx.orgId)),
      ]));
    const customerName = (id: string | null | undefined) =>
      (id ? custs.find((c) => c.id === id)?.name : null) ?? id ?? null;
    const items = rows.map((d) => ({
      id: d.deploymentId,
      label:
        d.displayName?.trim() ||
        [d.customerId, d.environment, d.deployedVersion].filter(Boolean).join(" · ") ||
        d.deploymentId,
      displayName: d.displayName ?? null,
      // Extras for the "My deployments" TODO view (pickers ignore these).
      owner: d.deployOwnerEmail ?? null,
      status: d.releaseStatus,
      health: d.healthStatus,
      env: d.environment,
      version: d.deployedVersion,
      customer: d.customerId,
      customerLabel: customerName(d.customerId),
      uptime: d.uptime30dPct ?? null,
      errorRate: d.errorRate30dPct ?? null,
      lastDeployAt: d.lastDeployAt ?? null,
    }));
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
