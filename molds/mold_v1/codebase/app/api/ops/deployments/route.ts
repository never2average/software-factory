import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { customers, deployments } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { customerInOrg, orgContextForRequest } from "@/lib/org-context";
import { isForeignKeyViolation, isUniqueViolation } from "@/lib/pg-error";
import { customBodySchema, customForWrite, pickProfileFields, profileFieldSchemas } from "@/lib/ops-domain-fields";
import { asCustomValues, customDelta } from "@/agent/lib/custom-fields";
import { customMergeSql } from "@/agent/lib/custom-merge-sql";
import { DEPLOYMENT_PROFILE } from "@/lib/deployment-profile.generated";
import { an, upperFirst, W } from "@/lib/ui-words";

const ENV_HIDDEN = DEPLOYMENT_PROFILE.domains.deployments.fields.environment?.hidden === true;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/ops/deployments — create a deployment record, or UPDATE the one with this (customerId, deploymentId).
 *
 *  A create needs the identity fields (they're NOT NULL); health/release default to sane values the operator
 *  refines in the detail panel. An update changes ONLY the fields the body names ("" or null clears an optional
 *  one), and its `custom` only by the keys it names, merged in SQL onto what is stored at write time. It used to be
 *  insert-only, so the MCP tool `deployment_upsert` could create a record and never correct one: a second call for
 *  the same id was a unique-key error. */
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
/** An update: the same fields, none required and none defaulted, so a field the body leaves out keeps its value. */
const updateSchema = createSchema.partial().extend({
  customerId: createSchema.shape.customerId,
  deploymentId: createSchema.shape.deploymentId,
  environment: z.string().min(1, "An environment cannot be cleared.").optional(),
  region: z.string().min(1, "A region cannot be cleared.").optional(),
  deployedVersion: z.string().min(1, "A version cannot be cleared.").optional(),
  releaseStatus: z.string().min(1).optional(),
  healthStatus: z.string().min(1).optional(),
});

export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const body = await request.json().catch(() => null);
  const keyed = updateSchema.safeParse(body);
  if (!keyed.success) {
    return NextResponse.json({ error: keyed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  // The account must be this workspace's. The foreign key alone does not say so: it is checked past row-level
  // security, so a create naming another workspace's account id used to succeed, stamped with this workspace.
  // Absent and not-yours read the same, so neither answer confirms an id exists elsewhere.
  if (!(await customerInOrg(ctx.orgId, keyed.data.customerId))) return noSuchAccount();
  // The row's whole key: (org_id, customer_id, deployment_id). The same ids in another workspace are its own row.
  const where = and(eq(deployments.orgId, ctx.orgId), eq(deployments.customerId, keyed.data.customerId), eq(deployments.deploymentId, keyed.data.deploymentId));
  try {
    // The row is looked up inside the caller's scope: another workspace's row with this key is simply not there.
    const [existing] = await withOrgRls(ctx.orgId, (tx) => tx.select({ custom: deployments.custom }).from(deployments).where(where));
    if (existing) return await update(ctx.orgId, keyed.data, existing, where);
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
  const parsed = createSchema.safeParse(body);
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
        .onConflictDoNothing({ target: [deployments.orgId, deployments.customerId, deployments.deploymentId] })
        .returning(),
    );
    // Created by someone else since the lookup: this call is an update of it.
    if (!row) return await update(ctx.orgId, keyed.data, null, where);
    return NextResponse.json({ item: { id: row.deploymentId }, created: true }, { status: 201 });
  } catch (e) {
    const msg = String(e);
    // Same trap as implementations: the FK to `customers` surfaced as an opaque
    // driver dump. Say the fixable thing instead.
    if (isForeignKeyViolation(e)) return noSuchAccount();
    return NextResponse.json({ error: errorText(msg) }, { status: 500 });
  }
}

function noSuchAccount(): NextResponse {
  return NextResponse.json(
    {
      error:
        `No ${W.account} with that id exists yet, so this ${W.deployment} has nothing to attach to. ` +
        `Create the ${W.account} first (POST /api/ops/customers, or customer_create from the CLI).`,
    },
    { status: 409 },
  );
}

/** The update half of POST: the named fields SET, `custom` merged by the keys named, in SQL at write time. */
async function update(
  orgId: string,
  data: z.infer<typeof updateSchema>,
  existing: { custom: unknown } | null,
  where: ReturnType<typeof and>,
): Promise<NextResponse> {
  const { customerId: _c, deploymentId, custom: customInput, ...fields } = data;
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    set[k] = v === "" ? null : v;
  }
  if (customInput != null) {
    const [stored] = existing ? [existing] : await withOrgRls(orgId, (tx) => tx.select({ custom: deployments.custom }).from(deployments).where(where));
    const checked = customForWrite("deployments", customInput, stored ?? { custom: {} });
    if (checked.error) return NextResponse.json({ error: checked.error }, { status: 400 });
    const delta = customDelta(customInput, checked.custom ?? {});
    if (delta) set.custom = customMergeSql(deployments.custom, delta, { empty: "object" });
  }
  if (Object.keys(set).length === 0) {
    return NextResponse.json({ error: `This ${W.deployment} already exists and the request names nothing to change.` }, { status: 400 });
  }
  const [row] = await withOrgRls(orgId, (tx) => tx.update(deployments).set(set).where(where).returning({ id: deployments.deploymentId }));
  if (!row) return NextResponse.json({ error: `${W.Deployment} ${deploymentId} was removed while it was being updated.` }, { status: 409 });
  return NextResponse.json({ item: { id: row.id }, updated: true }, { status: 200 });
}

/** GET /api/ops/deployments — deployment cards + container-picker rows. */
export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
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
