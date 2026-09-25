import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { customers, deployments } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { isForeignKeyViolation, isUniqueViolation } from "@/lib/pg-error";
import { customBodySchema, customForWrite, pickProfileFields, profileFieldSchemas } from "@/lib/ops-domain-fields";
import { asCustomValues } from "@/agent/lib/custom-fields";
import { DEPLOYMENT_PROFILE } from "@/lib/deployment-profile.generated";
import { an, upperFirst, W } from "@/lib/ui-words";

const ENV_HIDDEN = DEPLOYMENT_PROFILE.domains.deployments.fields.environment?.hidden === true;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/ops/deployments — hand-create a deployment record. The identity
 *  fields are required (they're NOT NULL); health/release default to sane
 *  values the operator refines in the detail panel. */
const createSchema = z.object({
  customerId: z.string().min(1, `Pick ${an(W.account)} ${W.account}.`),
  deploymentId: z.string().min(1, `${upperFirst(an(W.deployment))} ${W.deployment} id is required.`),
  environment: z.string().min(1, "An environment is required."),
  region: z.string().min(1, "A region is required."),
  deployedVersion: z.string().min(1, "A version is required."),
  releaseStatus: z.string().min(1).default("deployed"),
  healthStatus: z.string().min(1).default("healthy"),
  deployOwnerEmail: z.string().trim().optional().nullable(),
  displayName: z.string().trim().optional().nullable(),
  // Any other single-value column, for a deployment profile that puts it on the "New …" form (`domains`).
  ...profileFieldSchemas("deployments", ["deployOwnerEmail"]),
  // The profile's OWN fields (`custom_fields`), by key. Checked below by the shared validator, not by zod.
  custom: customBodySchema,
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
  // A create: the required custom fields must be there, an undeclared key is refused.
  const { custom: customInput, ...data } = parsed.data;
  const checked = customForWrite("deployments", customInput, null);
  if (checked.error) return NextResponse.json({ error: checked.error }, { status: 400 });
  try {
    const [row] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .insert(deployments)
        .values({
          ...data,
          ...(checked.custom ? { custom: checked.custom } : {}),
          // Stamp the tenant. Without it the row is written with a NULL org_id,
          // which the org_isolation policy matches for no workspace at all — the
          // create succeeds and the record is invisible to everyone.
          orgId: ctx.orgId,
          deployOwnerEmail: data.deployOwnerEmail || null,
          displayName: data.displayName || null,
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
            `No ${W.account} with that id exists yet, so this ${W.deployment} has nothing to attach to. ` +
            `Create the ${W.account} first (POST /api/ops/customers, or customer_create from the CLI).`,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: errorText(msg) }, { status: 500 });
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
        // A profile that does not use environments hides the field; its fixed value is not something to read.
        [d.customerId, ENV_HIDDEN ? d.deploymentId : d.environment, d.deployedVersion].filter(Boolean).join(" · ") ||
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
      // The columns this deployment's profile shows or edits beyond the defaults ({} for the default profile).
      fields: pickProfileFields("deployments", d),
      // The values of the profile's own fields (`custom_fields`), by key.
      custom: asCustomValues(d.custom),
    }));
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
