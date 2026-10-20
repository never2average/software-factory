import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { workflowRefusal } from "@/lib/record-workflow-moves";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { cycles } from "@/agent/lib/db/schema";
import { areaView } from "@/agent/lib/record-areas";
import { lifecycleEnforced } from "@/lib/record-lifecycle-server";
import { callerEmail } from "@/lib/work-periods-server";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { newPeriodWindow, rollOverEnded, workspacePeriodLength } from "@/agent/lib/work-period-store";
import { periodsNotFound } from "@/lib/work-periods-server";
import { periodForbidden } from "@/lib/record-permissions-server";
import type { RecordRole } from "@/agent/lib/record-areas.generated";
import { periodDeclared, periodOut } from "@/agent/lib/period-area";
import { writeDeclaredPeriod } from "@/agent/lib/period-area-store";
import { warningOf } from "@/agent/lib/record-lifecycle";

/** The periods' lifecycle is enforced ("warn" or "strict"; agent/lib/record-lifecycle.ts). */
const PERIODS_ENFORCED = lifecycleEnforced("periods");
/**
 * The profile states the periods area in the record-area form (agent/lib/period-area.ts): a period carries its own
 * fields (`custom`) and its declared states, and a create is checked by the one validator. Otherwise the route is
 * byte for byte what it was (no `custom` on the wire).
 */
const DECLARED = periodDeclared();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET/POST /api/ops/cycles — the periods todos are grouped into. What a period is for this deployment (shared by the
 * team, held per person, or absent) is its profile's `work_periods` (agent/lib/work-periods.ts); under mode "off"
 * this route answers 404 like any path that does not exist.
 *
 * When the workspace's periods have a length (its admin's choice, else the profile's `length_days`), a POST without
 * dates opens the period that follows the latest one (or starts today), that long, and it may omit the name. With no
 * length (the default profile, a workspace that chose none) the request is what it always was.
 */
const createSchemaFor = (length: number | null) => z.strictObject({
  name: length === null ? z.string().min(1) : z.string().min(1).optional(),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  createdBy: z.string().min(1).default("web"),
});

export async function GET(request: NextRequest) {
  const off = periodsNotFound();
  if (off) return off;
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  if (!getOpsDb()) return NextResponse.json({ items: [] });
  try {
    const items = await withOrgRls(ctx.orgId, async (tx) => {
      // work_periods.auto_rollover: an ended period is closed and its unfinished tasks carried on, here, inside
      // this workspace's own transaction. Nothing happens when the profile leaves it off (the default).
      await rollOverEnded(tx, ctx.orgId);
      return tx.select().from(cycles).where(and(eq(cycles.orgId, ctx.orgId), isNull(cycles.archivedAt))).orderBy(asc(cycles.startsAt));
    });
    return NextResponse.json({ items: items.map((c) => periodOut(c)) });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const off = periodsNotFound();
  if (off) return off;
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (DECLARED) return createDeclared(request, ctx, body);
  try {
    const length = await withOrgRls(ctx.orgId, (tx) => workspacePeriodLength(tx, ctx.orgId));
    const parsed = createSchemaFor(length).safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
    }
    const { startsAt, endsAt, ...rest } = parsed.data;
    // Who may open a period (records.areas.periods.permissions): a 403 with the sentence; nothing read when undeclared.
    const no = await periodForbidden(request, ctx, "create", { patch: parsed.data });
    if (no) return no;
    // An enforced periods lifecycle (agent/lib/record-lifecycle.ts): a new period starts in its initial state, and is
    // filed under the signed-in person, not a label the body chose, since four eyes may fall back to its creator
    // (agent/lib/record-lifecycle-store.ts whoEntered). Under "off" (the default) the create is what it was.
    if (PERIODS_ENFORCED) {
      const me = await callerEmail(request);
      if (me) rest.createdBy = me;
      const initial = areaView("periods").lifecycle?.initial;
      if (initial) (rest as Record<string, unknown>).state = initial;
    }
    const [item] = await withOrgRls(ctx.orgId, async (tx) => {
      const window = startsAt == null && endsAt == null ? await newPeriodWindow(tx, ctx.orgId) : null;
      if (window) {
        return tx.insert(cycles).values({ ...rest, name: rest.name ?? window.name, orgId: ctx.orgId, startsAt: window.startsAt, endsAt: window.endsAt }).returning();
      }
      return tx
        .insert(cycles)
        .values({ ...rest, name: rest.name ?? "", orgId: ctx.orgId, startsAt: startsAt ? new Date(startsAt) : null, endsAt: endsAt ? new Date(endsAt) : null })
        .returning();
    });
    return NextResponse.json({ item: periodOut(item) }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

/**
 * A create under a declared periods area: any of its fields (columns by key, own fields under `custom`), checked by the
 * one validator (types, choices, required fields, who may, the lifecycle's initial state), filed under the signed-in
 * person; a body with no dates gets the workspace's next window as before. 400 / 403 / 409 with the sentences.
 */
async function createDeclared(request: NextRequest, ctx: { orgId: string; role?: RecordRole }, body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  try {
    const raw = body as Record<string, unknown>;
    const me = await callerEmail(request);
    const actor = me ?? (typeof raw.createdBy === "string" && raw.createdBy ? raw.createdBy : "web");
    const r = await withOrgRls(ctx.orgId, (tx) => writeDeclaredPeriod(tx, ctx.orgId, { id: null, body: raw, actor, role: ctx.role, deliver: (org, fn) => withOrgRls(org, fn as never) }));
    if (!r.ok) return NextResponse.json(r.conflict ?? { error: r.errors.join(" "), errors: r.errors }, { status: r.status });
    return NextResponse.json({ item: periodOut(r.row), ...(r.check && r.check.enforce === "warn" && !r.check.allowed ? { warnings: [warningOf(r.check)] } : {}) }, { status: 201 });
  } catch (e) {
    // A lifecycle that runs a workflow: its instance changed under the write (nothing was kept).
    const stopped = workflowRefusal(e, areaView("periods").noun);
    if (stopped) return NextResponse.json(stopped.body, { status: stopped.status });
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
