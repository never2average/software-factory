import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { z } from "zod";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { recordActivity } from "@/lib/ops-activity";
import { orgContextForRequest } from "@/lib/org-context";
import { WORK_PERIODS, mayActFor } from "@/agent/lib/work-periods";
import { refusalFor, rollOver, rolloverSentence, rosterLines } from "@/agent/lib/work-period-store";
import { callerEmail, periodsNotFound } from "@/lib/work-periods-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/ops/cycles/:id/rollover — move every unfinished (non-done,
 * non-archived) task out of this cycle into `target`: another cycle id, null =
 * backlog, or "next" = the period that follows (opened when there is none and
 * the profile gives periods a length).
 *
 * Mode team (the default profile): `target` omitted is the backlog, as it always was. Mode individual: omitted is
 * "next", each task keeps its assignee (so a person's unfinished items are theirs in their next period), and
 * `assignee` narrows the move to one person's — their own, or a reportee's on the roster.
 */
const bodySchema = z.strictObject({
  target: z.union([z.string().uuid(), z.literal("next")]).nullable().optional(),
  assignee: z.string().email().optional(),
  actor: z.string().min(1).optional(),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const off = periodsNotFound();
  if (off) return off;
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid cycle id" }, { status: 400 });
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const { actor = "web", assignee } = parsed.data;
  const target = parsed.data.target !== undefined ? parsed.data.target : WORK_PERIODS.individual ? "next" : null;
  try {
    if (assignee && WORK_PERIODS.individual) {
      const me = await callerEmail(request);
      if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      const roster = await withOrgRls(ctx.orgId, (tx) => rosterLines(tx, ctx.orgId));
      if (!mayActFor(roster, me, assignee)) return NextResponse.json({ error: refusalFor(assignee.toLowerCase()) }, { status: 403 });
    }
    const result = await withOrgRls(ctx.orgId, (tx) => rollOver(tx, ctx.orgId, id, { target, assignee: WORK_PERIODS.individual ? assignee : undefined, actor }));
    if ("notFound" in result) {
      // Mode team, a source this workspace does not hold: the answer it has always had (nothing matched, nothing
      // moved), activity line included. Everything else that is not there is a 404.
      if (result.notFound === "source" && WORK_PERIODS.team) {
        const none = { moved: 0, targetId: null, targetName: null, created: false };
        void recordActivity(db, { entityType: "cycle", entityId: id, actor, orgId: ctx.orgId, event: rolloverSentence(none) });
        return NextResponse.json({ ok: true, moved: 0 });
      }
      return NextResponse.json({ error: "Cycle not found" }, { status: 404 });
    }
    void recordActivity(db, {
      entityType: "cycle",
      entityId: id,
      actor,
      orgId: ctx.orgId,
      event: rolloverSentence(result),
    });
    return NextResponse.json({ ok: true, moved: result.moved, ...(target === "next" ? { target: result.targetId } : {}) });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
