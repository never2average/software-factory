import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { cycles } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { recordFieldChanges } from "@/lib/ops-activity";
import { orgContextForRequest } from "@/lib/org-context";
import { WORK_PERIODS } from "@/agent/lib/work-periods";
import { callerEmail, periodsNotFound } from "@/lib/work-periods-server";
import { validateRecordWrite } from "@/agent/lib/record-validate";
import { areaView, type AreaRow } from "@/agent/lib/record-areas";
import { warningOf, type MoveCheck } from "@/agent/lib/record-lifecycle";
import { lifecycleConflictResponse, lifecycleContext, lifecycleEnforced, recordLifecycleOutcome } from "@/lib/record-lifecycle-server";
import { periodForbidden } from "@/lib/record-permissions-server";
import { periodChanges, periodDeclared, periodOut } from "@/agent/lib/period-area";
import { storedPeriod, writeDeclaredPeriod } from "@/agent/lib/period-area-store";
import type { OrgContext } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const patchShape = {
  name: z.string().min(1).optional(),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  state: z.enum(["planning", "active", "closed"]).optional(),
  goal: z.string().nullable().optional(),
  capacity: z.number().int().nonnegative().nullable().optional(),
  lead: z.string().nullable().optional(),
  actor: z.string().min(1).optional(),
};
/**
 * The periods' lifecycle (records.areas.periods.lifecycle; agent/lib/record-lifecycle.ts). Enforced ("warn" or
 * "strict"): a state change is checked against its transitions as the caller (role, four eyes, a comment as `reason`,
 * stamps), refused with 409 under strict, noted (activity feed and the answer's `warnings`) under warn. Under "off" (the
 * default) the route is exactly what it was: no `reason`, nothing more read.
 */
const PERIODS_ENFORCED = lifecycleEnforced("periods");
const patchSchema = PERIODS_ENFORCED ? z.strictObject({ ...patchShape, reason: z.string().max(2000).optional() }) : z.strictObject(patchShape);
const PERIODS = areaView("periods");
/**
 * The profile states the periods area in the record-area form (agent/lib/period-area.ts): a PATCH may set any of its
 * fields (its own under `custom`, merged per key) and moves between its declared states, all through the one validator
 * (agent/lib/period-area-store.ts writeDeclaredPeriod). Otherwise everything below is what it was.
 */
const DECLARED = periodDeclared();

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const off = periodsNotFound();
  if (off) return off;
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid cycle id" }, { status: 400 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (DECLARED) return patchDeclared(request, ctx, db, id, body);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  // Mode individual: a period has no shared lead and no team capacity (each person's goal and planned count are
  // their own, /api/ops/cycles/:id/goals). Clearing one that an earlier mode stored is still allowed.
  if (WORK_PERIODS.individual && (parsed.data.lead != null || parsed.data.capacity != null)) {
    return NextResponse.json({ error: "lead and capacity are not used here" }, { status: 400 });
  }
  const { startsAt, endsAt, actor = "web", reason, ...rest } = parsed.data as typeof parsed.data & { reason?: string };
  const set: Record<string, unknown> = { ...rest, updatedAt: new Date() };
  if (startsAt !== undefined) set.startsAt = startsAt ? new Date(startsAt) : null;
  if (endsAt !== undefined) set.endsAt = endsAt ? new Date(endsAt) : null;
  try {
    // Who may change it (records.areas.periods.permissions): a 403 with the sentence; nothing read when undeclared.
    const no = await periodForbidden(request, ctx, "update", { id, patch: parsed.data });
    if (no) return no;
    const [before] = await withOrgRls(ctx.orgId, (tx) =>
      tx.select().from(cycles).where(and(eq(cycles.id, id), eq(cycles.orgId, ctx.orgId))),
    );
    let check: MoveCheck | null = null;
    let mover = actor;
    if (PERIODS_ENFORCED && before && rest.state !== undefined) {
      mover = (await callerEmail(request)) ?? actor;
      const row = before as unknown as AreaRow;
      const extra = await lifecycleContext(ctx.orgId, "periods", { type: "cycle", id }, row);
      const r = validateRecordWrite("periods", { mode: "update", before: row, patch: { state: rest.state }, actor: mover, role: ctx.role, comment: reason ?? null, ...extra });
      if (!r.ok) return r.conflict ? lifecycleConflictResponse(r.conflict) : NextResponse.json({ error: r.errors.join(" "), errors: r.errors }, { status: 400 });
      // The move's stamps (`set`): a date or time field is stored as one.
      for (const [k, x] of Object.entries(r.columns)) {
        if (k === "state") continue;
        const t = PERIODS.field(k)?.type;
        set[k] = (t === "date" || t === "datetime") && typeof x === "string" ? new Date(x) : x;
      }
      check = r.lifecycle;
    }
    const [item] = await withOrgRls(ctx.orgId, (tx) =>
      tx.update(cycles).set(set).where(and(eq(cycles.id, id), eq(cycles.orgId, ctx.orgId))).returning(),
    );
    if (!item) return NextResponse.json({ error: "Cycle not found" }, { status: 404 });
    if (before) {
      void recordFieldChanges(
        db,
        { entityType: "cycle", entityId: id, actor, orgId: ctx.orgId },
        [
          { label: "State", before: before.state, after: item.state },
          { label: "Goal", before: before.goal, after: item.goal },
          { label: "Capacity", before: before.capacity, after: item.capacity },
          { label: "Lead", before: before.lead, after: item.lead },
        ],
      );
    }
    if (check) await recordLifecycleOutcome(ctx.orgId, "periods", { type: "cycle", id }, mover, check, reason ?? null);
    return NextResponse.json({ item: periodOut(item), ...(check && check.enforce === "warn" && !check.allowed ? { warnings: [warningOf(check)] } : {}) });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

/**
 * A PATCH under a declared periods area: the period's fields by key (its own under `custom`), a move to any of its
 * declared states with `reason` as the move's comment, `actor` the audit label when nobody is signed in. Who may, the
 * types and choices and the lifecycle are the one validator's; 400 / 403 / 404 / 409 answer its sentences. Each changed
 * field is a line in the activity feed by its label, as the state, goal, capacity and lead always were (the move's own
 * line, when the lifecycle is enforced, is written by the write).
 */
async function patchDeclared(request: NextRequest, ctx: OrgContext, db: NonNullable<ReturnType<typeof getOpsDb>>, id: string, body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const raw = body as Record<string, unknown>;
  try {
    // Who moves it (the lifecycle's rules, its line) is the signed-in person; the field lines carry the request's audit
    // label, as they always have.
    const label = typeof raw.actor === "string" && raw.actor ? raw.actor : "web";
    const me = await callerEmail(request);
    const r = await withOrgRls(ctx.orgId, (tx) => writeDeclaredPeriod(tx, ctx.orgId, { id, body: raw, actor: me ?? label, role: ctx.role }));
    if (!r.ok) {
      if (r.status === 404) return NextResponse.json({ error: "Cycle not found" }, { status: 404 });
      return NextResponse.json(r.conflict ?? { error: r.errors.join(" "), errors: r.errors }, { status: r.status });
    }
    if (r.before && r.changed.length) {
      void recordFieldChanges(db, { entityType: "cycle", entityId: id, actor: label, orgId: ctx.orgId }, periodChanges(storedPeriod(r.before), storedPeriod(r.row), r.changed));
    }
    return NextResponse.json({ item: periodOut(r.row), ...(r.warnings.length ? { warnings: r.warnings } : {}) });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const off = periodsNotFound();
  if (off) return off;
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid cycle id" }, { status: 400 });
  try {
    const no = await periodForbidden(request, ctx, "delete", { id });
    if (no) return no;
    // Hard delete — the period's row is removed. Its todos keep their (now
    // dangling) cycleId and simply fall out of any cycle grouping.
    const [item] = await withOrgRls(ctx.orgId, (tx) =>
      tx.delete(cycles).where(and(eq(cycles.id, id), eq(cycles.orgId, ctx.orgId))).returning({ id: cycles.id }),
    );
    if (!item) return NextResponse.json({ error: "Cycle not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
