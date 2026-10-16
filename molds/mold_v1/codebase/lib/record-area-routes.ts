/**
 * THE OPS ROUTES OF THE TWO ACCOUNT RECORD AREAS, WHEN A PROFILE DRAWS THEM FROM THEIR DEFINITION (records.areas.<area>,
 * compiled with `declared: true`): app/api/ops/deployments/** and app/api/ops/implementations/** hand their work here
 * for such an area, and keep today's code for any other profile.
 *
 *   - a write (create, upsert, patch) is checked by the one validator (agent/lib/record-area-write.ts) and written as it
 *     says: the columns it names, the area's own fields merged per key in SQL onto what is stored at write time, the
 *     defaults and fixed values a new row needs; a refusal is a 400 with the sentences (`error`, and each in `errors`);
 *   - the lifecycle around it (lib/record-lifecycle-server.ts): who entered the stored state for four eyes, a strict
 *     refusal as its 409, the move and a broken rule in the activity feed, `warnings` in the answer under "warn";
 *   - a list is filtered, sorted and paged in the database (agent/lib/record-query.ts), from `?where=&sort=&q=&cursor=
 *     &limit=`, and each row carries its title (the definition's template) and its `values` by field key.
 *
 * Every query runs in the caller's workspace (withOrgRls) and names it (org_id), as every route here always has.
 */
import "server-only";
import { NextResponse } from "next/server";
import { and, eq, type SQL } from "drizzle-orm";
import { customers, deployments, implementation } from "@/agent/lib/db/schema";
import { withOrgRls, type Db } from "@/lib/ops-db";
import { recordFieldChanges } from "@/lib/ops-activity";
import { customMergeSql } from "@/agent/lib/custom-merge-sql";
import type { CustomDelta } from "@/agent/lib/custom-fields";
import { areaView, type AreaRow } from "@/agent/lib/record-areas";
import { recordTitle, recordValues, shown, type AccountAreaId } from "@/agent/lib/record-area-records";
import { prepareRecordWrite } from "@/agent/lib/record-area-write";
import { deleteRefusal, permissionsDeclared } from "@/agent/lib/record-permissions";
import { compileRecordQuery, encodeCursor, parseRecordQuery, defaultSort, type AreaTable, type RecordQueryInput } from "@/agent/lib/record-query";
import type { OrgContext } from "@/lib/org-context";
import { lifecycleConflictResponse, lifecycleContext, recordLifecycleOutcome } from "@/lib/record-lifecycle-server";
import { implementationKey, manyPerAccount, namedImplementationId, newImplementationId } from "@/agent/lib/implementation-ids";
import { an, W } from "@/lib/ui-words";

const TABLE = { deployments, implementations: implementation } as const;
const tableOf = (id: AccountAreaId) => TABLE[id] as unknown as AreaTable & typeof deployments;
const ENTITY = { deployments: "deployment", implementations: "implementation" } as const;

/** The list query a request names (`where` is JSON), or null when it names none (today's list). */
export function listQueryOf(url: URL): RecordQueryInput | null | { error: string } {
  const p = url.searchParams;
  if (!["where", "sort", "q", "cursor", "limit"].some((k) => p.has(k))) return null;
  let where: Record<string, unknown> | null = null;
  if (p.get("where")) {
    try {
      where = JSON.parse(p.get("where")!);
    } catch {
      return { error: "`where` must be JSON: an object that maps a field to the value it must have." };
    }
  }
  const limit = p.get("limit");
  return { where, sort: p.get("sort"), q: p.get("q"), cursor: p.get("cursor"), limit: limit === null ? null : Number(limit) };
}

/**
 * The rows of a list, from the caller's query (or the definition's default order). `legacyOrder` is today's order
 * (account, then id), used when neither the caller nor the definition sorts.
 */
export async function queryRows(id: AccountAreaId, orgId: string, input: RecordQueryInput): Promise<{ rows: Record<string, unknown>[]; nextCursor: string | null } | { errors: string[] }> {
  const parsed = parseRecordQuery(id, { ...input, sort: input.sort ?? defaultSort(id) }, undefined);
  if (!parsed.ok) return { errors: parsed.errors };
  const t = tableOf(id);
  const q = compileRecordQuery(id, parsed.query, t, orgId);
  const rows = await withOrgRls(orgId, (tx) => tx.select().from(t).where(q.where).orderBy(...q.orderBy).limit(q.limit + 1).offset(q.offset));
  const more = rows.length > q.limit;
  return { rows: (more ? rows.slice(0, q.limit) : rows) as Record<string, unknown>[], nextCursor: more ? encodeCursor(q.offset + q.limit) : null };
}

/** What a declared area's list row adds to today's: its title by the definition, every visible field by key, `custom` whole. */
export function declaredItem(id: AccountAreaId, row: AreaRow, legacyLabel: string, displayName: string | null | undefined) {
  const v = areaView(id);
  return {
    label: displayName?.trim() || recordTitle(v, row, legacyLabel),
    title: recordTitle(v, row, legacyLabel),
    values: recordValues(v, row),
    custom: row.custom && typeof row.custom === "object" && !Array.isArray(row.custom) ? row.custom : {},
  };
}

/** A 400 with the validator's sentences. */
export const refused = (errors: string[], status = 400) => NextResponse.json({ error: errors.join(" "), errors }, { status });

const customSql = (id: AccountAreaId, delta: { set: Record<string, unknown>; clear: string[] }) => customMergeSql(tableOf(id).custom, { set: delta.set, clear: delta.clear, append: {} } as unknown as CustomDelta, { empty: "object" });

/**
 * The row a write names: deployments by (account, id); implementations by their own id when an account holds several
 * (agent/lib/implementation-ids.ts), else by the account (one each).
 */
function rowWhere(id: AccountAreaId, orgId: string, customerId: string, recordId?: string): SQL {
  const t = tableOf(id);
  if (id === "deployments") return and(eq(t.orgId, orgId), eq(t.customerId, customerId), eq(deployments.deploymentId, recordId ?? ""))!;
  if (manyPerAccount()) return and(eq(t.orgId, orgId), eq(implementation.implementationId, recordId ?? ""))!;
  return and(eq(t.orgId, orgId), eq(t.customerId, customerId))!;
}

/**
 * The implementation row a request names by its id, in the caller's workspace, when an account holds several: the row,
 * or the answer (404 when there is none, 409 when it is another account's: a row is never moved between accounts).
 */
export async function implementationById(orgId: string, implementationId: string, customerId: string | null): Promise<{ row: AreaRow; where: SQL } | { refusal: NextResponse }> {
  const where = and(eq(implementation.orgId, orgId), eq(implementation.implementationId, implementationId))!;
  const [row] = await withOrgRls(orgId, (tx) => tx.select().from(implementation).where(where));
  if (!row) return { refusal: NextResponse.json({ error: `${W.Implementation} not found` }, { status: 404 }) };
  if (customerId && row.customerId !== customerId) return { refusal: refused([`That ${W.implementation} belongs to another ${W.account}.`], 409) };
  return { row: row as AreaRow, where };
}

/** The activity feed's lines for what a write changed, in the definition's labels and words. */
async function recordChanges(db: Db, id: AccountAreaId, ctx: OrgContext, entityId: string, actor: string, before: AreaRow, after: AreaRow, moveNoted: boolean) {
  const v = areaView(id);
  const changes = v.visibleFields
    // An enforced lifecycle notes its own move (recordLifecycleOutcome); the state is not said twice.
    .filter((f) => !f.computed && !(moveNoted && f.key === v.lifecycle?.field))
    .map((f) => ({ label: f.label ?? f.key, before: shown(v, before, f.key) || null, after: shown(v, after, f.key) || null }));
  await recordFieldChanges(db, { entityType: ENTITY[id], entityId, actor, orgId: ctx.orgId }, changes);
}

/**
 * POST /api/ops/<area> for a declared area: create the record, or update the one with this key (the routes are
 * upserts). `body` is the request's JSON.
 */
export async function declaredUpsert(id: AccountAreaId, ctx: OrgContext, body: unknown, me: string, retried = false): Promise<NextResponse> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return refused(["The body must be a JSON object."]);
  const b = body as Record<string, unknown>;
  const customerId = typeof b.customerId === "string" ? b.customerId.trim() : "";
  if (!customerId) return refused([`Pick ${an(W.account)} ${W.account}.`]);
  // An implementation's own id, when an account holds several: the one named (to change it, or to create it under that
  // id), else a new one. One per account: the account is the id, as it always was.
  const many = id === "implementations" && manyPerAccount();
  const named = many ? namedImplementationId(b.implementationId) : { id: null };
  if ("error" in named) return refused([named.error]);
  const recordId = id === "deployments" ? (typeof b.deploymentId === "string" ? b.deploymentId.trim() : "") : many ? named.id ?? newImplementationId() : undefined;
  if (id === "deployments" && !recordId) {
    const v = areaView(id);
    return refused([`"${v.area.id?.label ?? `${W.Deployment} id`}" is required.`]);
  }
  const t = tableOf(id);
  const where = rowWhere(id, ctx.orgId, customerId, recordId);
  const [before] = await withOrgRls(ctx.orgId, (tx) => tx.select().from(t).where(where));
  // A row of another account under this id is not this account's to change, nor its id to take.
  if (many && before && (before as AreaRow).customerId !== customerId) return refused([`That ${W.implementation} belongs to another ${W.account}.`], 409);
  const mode = before ? "update" : "create";
  const { customerId: _c, ...rest } = b;
  const entity = { type: ENTITY[id], id: before ? itemId(id, before as AreaRow) : recordId ?? customerId };
  const comment = typeof b.reason === "string" ? b.reason : null;
  // The writer is the signed-in person ({me}, a lifecycle's roles and "not by"), never a name the body gives.
  const ctxLc = await lifecycleContext(ctx.orgId, id, entity, (before as AreaRow | undefined) ?? null);
  const prepared = prepareRecordWrite(id, mode, rest, { actor: me, role: ctx.role, before: (before as AreaRow | undefined) ?? null, enteredBy: ctxLc.enteredBy });
  if (!prepared.ok) return prepared.conflict ? lifecycleConflictResponse(prepared.conflict) : refused(prepared.errors, prepared.forbidden ? 403 : 400);
  if (before) {
    const set: Record<string, unknown> = { ...prepared.columns };
    delete set.deploymentId;
    if (prepared.customDelta) set.custom = customSql(id, prepared.customDelta);
    if (!Object.keys(set).length) return refused([`This ${id === "deployments" ? W.deployment : W.implementation} already exists and the request names nothing to change.`]);
    const [row] = await withOrgRls(ctx.orgId, (tx) => tx.update(t).set(set).where(where).returning());
    if (!row) return refused([`It was removed while it was being updated.`], 409);
    await recordLifecycleOutcome(ctx.orgId, id, entity, me, prepared.lifecycle, comment);
    return NextResponse.json({ item: { id: itemId(id, row as AreaRow) }, updated: true, ...(prepared.warnings.length ? { warnings: prepared.warnings } : {}) }, { status: 200 });
  }
  const values: Record<string, unknown> = {
    ...prepared.columns,
    ...(id === "deployments" ? { deploymentId: recordId } : { implementationId: recordId ?? customerId }),
    customerId,
    custom: prepared.custom,
    // The tenant: a NULL org_id matches no workspace under org_isolation, so the row would be invisible.
    orgId: ctx.orgId,
  };
  const [row] = await withOrgRls(ctx.orgId, (tx) => tx.insert(t).values(values as never).onConflictDoNothing().returning());
  // Created by someone else since the read: this call is an update of it.
  if (!row) return retried ? refused(["It changed while it was being written; send it again."], 409) : declaredUpsert(id, ctx, body, me, true);
  await recordLifecycleOutcome(ctx.orgId, id, { type: ENTITY[id], id: itemId(id, row as AreaRow) }, me, prepared.lifecycle, comment);
  return NextResponse.json({ item: { id: itemId(id, row as AreaRow) }, created: true, ...(prepared.warnings.length ? { warnings: prepared.warnings } : {}) }, { status: 201 });
}

/** A row's id as the lists and the activity feed key it (today's rule for each table; agent/lib/implementation-ids.ts). */
export function itemId(id: AccountAreaId, row: AreaRow): string {
  if (id === "deployments") return String(row.deploymentId);
  // Its own id when an account holds several; else as the list has always keyed it: by account when rows are grouped
  // by rolloutId, else its rolloutId.
  return implementationKey(row);
}

/**
 * PATCH /api/ops/<area>/:id for a declared area: change the fields the body names. `before` is the stored row.
 */
export async function declaredPatch(
  id: AccountAreaId,
  ctx: OrgContext,
  db: Db,
  where: SQL,
  body: Record<string, unknown>,
  activityId: string,
  /** The signed-in person: {me}, a lifecycle's roles and "not by". The activity feed keeps the body's `actor`, as before. */
  me: string,
): Promise<NextResponse> {
  const t = tableOf(id);
  const [before] = await withOrgRls(ctx.orgId, (tx) => tx.select().from(t).where(where));
  if (!before) return NextResponse.json({ error: `${id === "deployments" ? W.Deployment : W.Implementation} not found` }, { status: 404 });
  const actor = typeof body.actor === "string" && body.actor ? body.actor : "web";
  const { customerId: _c, entityId: _e, ...rest } = body;
  const entity = { type: ENTITY[id], id: activityId };
  const comment = typeof body.reason === "string" ? body.reason : null;
  const ctxLc = await lifecycleContext(ctx.orgId, id, entity, before as AreaRow);
  const prepared = prepareRecordWrite(id, "update", rest, { actor: me, role: ctx.role, before: before as AreaRow, enteredBy: ctxLc.enteredBy });
  if (!prepared.ok) return prepared.conflict ? lifecycleConflictResponse(prepared.conflict) : refused(prepared.errors, prepared.forbidden ? 403 : 400);
  const set: Record<string, unknown> = { ...prepared.columns };
  delete set.deploymentId;
  if (prepared.customDelta) set.custom = customSql(id, prepared.customDelta);
  if (!Object.keys(set).length) return refused(["Nothing to update"]);
  const [item] = await withOrgRls(ctx.orgId, (tx) => tx.update(t).set(set).where(where).returning());
  if (!item) return NextResponse.json({ error: `${id === "deployments" ? W.Deployment : W.Implementation} not found` }, { status: 404 });
  await recordLifecycleOutcome(ctx.orgId, id, entity, me, prepared.lifecycle, comment);
  void recordChanges(db, id, ctx, activityId, actor, before as AreaRow, item as AreaRow, Boolean(prepared.lifecycle));
  return NextResponse.json({ ok: true, ...(prepared.warnings.length ? { warnings: prepared.warnings } : {}) });
}

/**
 * DELETE /api/ops/<area>/:id: who may delete it (records.areas.<area>.permissions; agent/lib/record-permissions.ts).
 * A 403 with the sentence, or null to go on. For an area that declares no permissions nothing is read.
 */
export async function deleteForbidden(id: AccountAreaId, ctx: OrgContext, where: SQL, me: () => Promise<string | null>): Promise<NextResponse | null> {
  if (!permissionsDeclared(id)) return null;
  const t = tableOf(id);
  const [before] = await withOrgRls(ctx.orgId, (tx) => tx.select().from(t).where(where));
  // A row that is not there is the route's own 404.
  if (!before) return null;
  const refusal = deleteRefusal(id, before as AreaRow, { role: ctx.role, actor: (await me()) ?? "" });
  return refusal ? refused([refusal], 403) : null;
}

/** The account names a list row shows, for the rows of one page. */
export async function accountNames(orgId: string): Promise<(id: string | null | undefined) => string | null> {
  const custs = await withOrgRls(orgId, (tx) => tx.select({ id: customers.customerId, name: customers.customerName }).from(customers).where(eq(customers.orgId, orgId)));
  return (cid) => (cid ? custs.find((c) => c.id === cid)?.name : null) ?? cid ?? null;
}
