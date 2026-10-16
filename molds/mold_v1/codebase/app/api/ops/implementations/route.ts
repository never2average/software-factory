import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { customers, implementation, solutions } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { customerInOrg, orgContextForRequest } from "@/lib/org-context";
import { isForeignKeyViolation, isUniqueViolation } from "@/lib/pg-error";
import { choiceSchema, customBodySchema, customForWrite, pickProfileFields, profileFieldSchemas } from "@/lib/ops-domain-fields";
import { CHOICE_MEANINGS } from "@/agent/lib/customer-schema";
import { asCustomValues, customDelta } from "@/agent/lib/custom-fields";
import { customMergeSql } from "@/agent/lib/custom-merge-sql";
import { implementationKey, manyPerAccount } from "@/agent/lib/implementation-ids";
import { an, W } from "@/lib/ui-words";
import { isDeclared } from "@/agent/lib/record-area-records";
import { checkOnly } from "@/agent/lib/record-area-write";
import { callerEmail } from "@/lib/work-periods-server";
import { accountNames, declaredItem, declaredUpsert, listQueryOf, queryRows, refused } from "@/lib/record-area-routes";

/** Drawn from its definition (records.areas.implementations): every write and the list go through lib/record-area-routes.ts. */
const DECLARED = isDeclared("implementations");

/**
 * A row's id in the list (agent/lib/implementation-ids.ts implementationKey): its own id when an account holds several
 * (`per_account: "many"`, a declared area only); else, when a profile GROUPS rows by rolloutId (a portfolio, a
 * programme), many rows share one rolloutId, so it stops identifying a row and the id is the account; ungrouped, as
 * before (its rolloutId, else the account).
 */
const MANY = manyPerAccount();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/ops/implementations — hand-create a rollout. One implementation per company here (a profile that keeps
 *  several per account is a declared one, written by lib/record-area-routes.ts): its id is the company's id, so a
 *  second create for the same company updates it. Stage/risk/progress default to a
 *  fresh rollout the operator refines in the detail panel. */
const createSchema = z.object({
  customerId: z.string().min(1, `Pick ${an(W.account)} ${W.account}.`),
  // One of the stored values (the schema's enums), or a 400 that lists them. The defaults are values of those enums
  // (CHOICE_MEANINGS): they were "scoping" and "low", which no screen, count or check knew (mold_v1-251).
  implementationStage: choiceSchema("implementations", "implementationStage").default(CHOICE_MEANINGS.implementations.defaults.implementationStage),
  implementationRiskLevel: choiceSchema("implementations", "implementationRiskLevel").default(CHOICE_MEANINGS.implementations.defaults.implementationRiskLevel),
  implementationProgressPct: z.number().min(0).max(100).default(0),
  implementationOwnerEmail: z.string().trim().optional().nullable(),
  displayName: z.string().trim().optional().nullable(),
  // Any other single-value column, for a deployment profile that puts it on the "New …" form (`domains`).
  ...profileFieldSchemas("implementations", ["implementationOwnerEmail"]),
  // The profile's OWN fields (`custom_fields`), by key. Checked below by the shared validator, not by zod.
  custom: customBodySchema,
});

export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const body = await request.json().catch(() => null);
  if (DECLARED) {
    const customerId = body && typeof body === "object" && typeof (body as { customerId?: unknown }).customerId === "string" ? (body as { customerId: string }).customerId : "";
    if (customerId && !(await customerInOrg(ctx.orgId, customerId))) return noAccount();
    try {
      return await declaredUpsert("implementations", ctx, body, (await callerEmail(request)) ?? "");
    } catch (e) {
      if (isForeignKeyViolation(e)) return noAccount();
      return NextResponse.json({ error: errorText(e) }, { status: 500 });
    }
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  const { custom: customInput, ...data } = parsed.data;
  // The fields the caller SENT. zod fills the create defaults (stage, risk, progress) into `data`; an update of an
  // existing rollout must not write those back over its real stage.
  const sent = new Set(body && typeof body === "object" ? Object.keys(body) : []);
  // The account must be this workspace's: the foreign key is checked past row-level security, so a create naming
  // another workspace's account id used to succeed. Absent and not-yours read the same (the 409 below).
  if (!(await customerInOrg(ctx.orgId, data.customerId))) {
    return NextResponse.json(
      { error: `No ${W.account} with that id exists yet, so this record has nothing to attach to. Create the ${W.account} first (POST /api/ops/customers, or customer_create from the CLI).` },
      { status: 409 },
    );
  }
  try {
    // This route is an UPSERT, so whether the custom fields are a create (required ones enforced) or a partial
    // change merged onto the stored ones depends on the row being there. Read inside the caller's scope.
    const [existing] = await withOrgRls(ctx.orgId, (tx) =>
      tx.select({ custom: implementation.custom }).from(implementation).where(and(eq(implementation.orgId, ctx.orgId), eq(implementation.customerId, data.customerId))),
    );
    // The one validator every write to the area goes through (agent/lib/record-area-write.ts): only its refusal is
    // used here. An update is checked for what the caller sent; a create for the row as it will be written.
    const refusal = existing
      ? checkOnly("implementations", "update", Object.fromEntries(Object.entries(parsed.data).filter(([k]) => sent.has(k))), { actor: "web", role: ctx.role, before: { custom: existing.custom as Record<string, unknown> } })
      : checkOnly("implementations", "create", { ...parsed.data, blockerOwner: CHOICE_MEANINGS.implementations.defaults.blockerOwner }, { actor: "web", role: ctx.role });
    if (refusal.length) return refused(refusal);
    const checked = customForWrite("implementations", customInput, existing ?? null);
    if (checked.error) return NextResponse.json({ error: checked.error }, { status: 400 });
    const written = { ...data, ...(checked.custom ? { custom: checked.custom } : {}) };
    const delta = checked.custom === undefined ? undefined : customDelta(customInput, checked.custom);
    const values = {
      ...written,
      // One per company: the row's own id is the company's (agent/lib/implementation-ids.ts), so the key below finds it.
      implementationId: data.customerId,
      // Stamp the tenant — a NULL org_id matches no workspace under the
      // org_isolation policy, so the row would be written yet invisible.
      orgId: ctx.orgId,
      implementationOwnerEmail: data.implementationOwnerEmail || null,
      displayName: data.displayName || null,
      // NOT NULL with no DB default: "no blocker owner yet" is the enum's own value for it (it was "", not a value).
      blockerOwner: CHOICE_MEANINGS.implementations.defaults.blockerOwner,
    };
    const update: Record<string, unknown> = {
      ...Object.fromEntries(Object.entries(data).filter(([k, v]) => k !== "customerId" && v !== undefined && sent.has(k))),
      ...(delta ? { custom: customMergeSql(implementation.custom, delta, { empty: "object" }) } : {}),
    };
    // Naming nothing to change still answers with the row (a no-op SET), as before.
    if (!Object.keys(update).length) update.customerId = data.customerId;
    // A genuine UPSERT, because that is what the operation is called and what
    // callers reasonably expect. It was a plain INSERT that 409'd on the second
    // call, so correcting a rollout's stage — the single most common thing
    // anyone does to one — was impossible without going through the console.
    const [row] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .insert(implementation)
        .values(values)
        .onConflictDoUpdate({
          // The record's whole key (org_id, implementation_id), its id the company's: one per company, and a company
          // is per workspace.
          target: [implementation.orgId, implementation.implementationId],
          // Never blank a field the caller didn't mention; blockerOwner in
          // particular is ours, not theirs, and would wipe a real owner.
          // `custom` only by the keys the body names, merged in SQL onto what is stored at write time.
          set: update,
        })
        .returning(),
    );
    return NextResponse.json({ item: { id: implementationKey(row) } }, { status: 201 });
  } catch (e) {
    const msg = String(e);
    // A raw driver dump reached the caller here: the whole 52-column INSERT,
    // twice, with no Postgres message and no constraint name. Two operators hit
    // it and neither could tell what was wrong — the actual cause is a foreign
    // key to `customers`, i.e. "that customer does not exist yet", which is
    // both the commonest mistake and completely fixable by the caller.
    if (isForeignKeyViolation(e)) {
      return NextResponse.json(
        {
          error:
            `No ${W.account} with that id exists yet, so this record has nothing to attach to. ` +
            `Create the ${W.account} first (POST /api/ops/customers, or customer_create from the CLI).`,
        },
        { status: 409 },
      );
    }
    const conflict = isUniqueViolation(e);
    return NextResponse.json(
      { error: conflict ? `This ${W.account} already has one.` : errorText(msg) },
      { status: conflict ? 409 : 500 },
    );
  }
}

/** GET /api/ops/implementations — pipeline rows for the TODO board + container picker. */
export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ items: [] });
  const asked = listQueryOf(new URL(request.url));
  if (asked && "error" in asked) return refused([asked.error]);
  if (DECLARED || asked) {
    // Filtered, sorted and paged in the database (agent/lib/record-query.ts); a declared area's rows carry its fields.
    try {
      const found = await queryRows("implementations", ctx.orgId, asked ?? {});
      if ("errors" in found) return refused(found.errors);
      const customerName = await accountNames(ctx.orgId);
      const items = found.rows.map((r) => {
        const row = r as typeof implementation.$inferSelect;
        const legacy = {
          id: implementationKey(row),
          // Its own id, the one every write names, when an account holds several.
          ...(MANY ? { implementationId: row.implementationId } : {}),
          label: row.displayName?.trim() || [row.customerId, row.implementationStage].filter(Boolean).join(" · ") || row.rolloutId || row.customerId,
          displayName: row.displayName ?? null,
          owner: row.implementationOwnerEmail ?? null,
          stage: row.implementationStage,
          risk: row.implementationRiskLevel,
          progress: row.implementationProgressPct,
          customer: row.customerId,
          customerLabel: customerName(row.customerId),
          solutionName: null,
          goLiveDate: row.actualGoLiveDate ?? row.targetGoLiveDate ?? null,
          fields: pickProfileFields("implementations", row),
          custom: asCustomValues(row.custom),
        };
        return DECLARED ? { ...legacy, ...declaredItem("implementations", r, legacy.label, row.displayName) } : legacy;
      });
      return NextResponse.json({ items, ...(found.nextCursor ? { nextCursor: found.nextCursor } : {}) });
    } catch (e) {
      return NextResponse.json({ error: errorText(e) }, { status: 500 });
    }
  }
  try {
  // Workspace-scoped. These tables had no org_id until the tenancy migration,
  // so this route returned every workspace's rows to any signed-in caller.
    const [rows, sols, custs] = await withOrgRls(ctx.orgId, (tx) =>
      Promise.all([
        tx.select().from(implementation).where(eq(implementation.orgId, ctx.orgId))
          .orderBy(asc(implementation.customerId), asc(implementation.rolloutId)).limit(300),
        tx.select({ customerId: solutions.customerId, solutionId: solutions.solutionId, useCase: solutions.useCase })
          .from(solutions).where(eq(solutions.orgId, ctx.orgId)),
        tx.select({ id: customers.customerId, name: customers.customerName }).from(customers)
          .where(eq(customers.orgId, ctx.orgId)),
      ]));
    const customerName = (id: string | null | undefined) =>
      (id ? custs.find((c) => c.id === id)?.name : null) ?? id ?? null;
    // The launch-scope solutions' use-cases → the card title (join if several).
    const solutionName = (r: (typeof rows)[number]): string | null => {
      const ids = r.launchScopeSolutionIds ?? [];
      const names = ids
        .map((sid) => sols.find((s) => s.customerId === r.customerId && s.solutionId === sid)?.useCase)
        .filter((n): n is string => Boolean(n));
      if (names.length === 0) return null;
      if (names.length <= 2) return names.join(" + ");
      return `${names[0]} +${names.length - 1} more`;
    };
    const items = rows.map((r) => ({
      id: implementationKey(r),
      label:
        r.displayName?.trim() ||
        [r.customerId, r.implementationStage].filter(Boolean).join(" · ") ||
        r.rolloutId ||
        r.customerId,
      displayName: r.displayName ?? null,
      // Extras for the "My implementations" TODO view (pickers ignore these).
      owner: r.implementationOwnerEmail ?? null,
      stage: r.implementationStage,
      risk: r.implementationRiskLevel,
      progress: r.implementationProgressPct,
      customer: r.customerId,
      customerLabel: customerName(r.customerId),
      solutionName: solutionName(r),
      goLiveDate: r.actualGoLiveDate ?? r.targetGoLiveDate ?? null,
      // The columns this deployment's profile shows or edits beyond the defaults ({} for the default profile).
      fields: pickProfileFields("implementations", r),
      // The values of the profile's own fields (`custom_fields`), by key.
      custom: asCustomValues(r.custom),
      // V1 go-live readiness gates — powers the collaborative readiness board.
      readiness: {
        data: r.dataReadinessPct ?? null,
        integration: r.integrationReadinessPct ?? null,
        security: r.securityReviewStatus ?? null,
        eval: r.evalAcceptanceStatus ?? null,
        uat: r.uatStatus ?? null,
        launchStatus: r.launchCriteriaStatus ?? null,
        goLiveConfidence: r.goLiveConfidencePct ?? null,
        blocker: r.blocker ?? null,
        blockerSeverity: r.blockerSeverity ?? null,
        openBlockers: r.openBlockerCount ?? null,
        targetGoLive: r.targetGoLiveDate ?? null,
        actualGoLive: r.actualGoLiveDate ?? null,
      },
    }));
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

/** The 409 for an account that is not this workspace's (absent and not-yours read the same). */
function noAccount(): NextResponse {
  return NextResponse.json(
    { error: `No ${W.account} with that id exists yet, so this record has nothing to attach to. Create the ${W.account} first (POST /api/ops/customers, or customer_create from the CLI).` },
    { status: 409 },
  );
}
