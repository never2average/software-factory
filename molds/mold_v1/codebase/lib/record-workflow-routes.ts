import "server-only";

/**
 * THE OPS API OF A RECORD'S WORKFLOW (phase 7, docs/WORKFLOW_ENGINE.md "Surfaces"): app/api/ops/record-workflow/** call
 * these. Every answer is in the caller's workspace (withOrgRls) and in the reader's view of people
 * (lib/record-workflow-doors.ts): names on the roster, emails only for an owner or an admin.
 *
 *   GET  /api/ops/record-workflow?area=<area>&id=<id>[&customerId=<account>]    the record's workflow, and what the
 *        caller may change on it
 *   GET  /api/ops/record-workflow?area=<area>&refs=[{"id":…,"customerId":…},…]   the cards' line for each
 *   POST /api/ops/record-workflow/holder {area, id, customerId?, step, holders}  who holds a step (supervisors only)
 *   POST /api/ops/record-workflow/due    {area, id, customerId?, step, due_on}   a step's one-time due-date extension
 *
 * A deployment whose lifecycles run no workflow answers 404 here: nothing is read.
 */
import { NextRequest, NextResponse } from "next/server";
import { withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest, type OrgContext } from "@/lib/org-context";
import { callerEmail } from "@/lib/work-periods-server";
import { RECORD_AREAS, type RecordAreaId } from "@/agent/lib/record-areas.generated";
import { areaView } from "@/agent/lib/record-areas";
import { recordWorkflowBound, workflowRefusal, type StepActionRunner, type StepChangeRequest } from "@/lib/record-workflow-moves";
import { changeStepDoor, nextStepsDoor, readWorkflowDoor, type RecordRef } from "@/lib/record-workflow-doors";

const AREAS: RecordAreaId[] = ["deployments", "implementations", "tasks", "periods"];
const deliverInOrg: StepActionRunner = (org, fn) => withOrgRls(org, fn as never);

/** The areas whose lifecycle runs a workflow in this deployment. */
export const workflowAreas = (): RecordAreaId[] => AREAS.filter((a) => RECORD_AREAS[a]?.enabled !== false && recordWorkflowBound(a));

async function context(request: NextRequest): Promise<{ ctx: OrgContext; me: string } | NextResponse> {
  if (!workflowAreas().length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx as NextResponse;
  const me = await callerEmail(request);
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return { ctx, me };
}

const areaOf = (v: unknown): RecordAreaId | null => (typeof v === "string" && workflowAreas().includes(v as RecordAreaId) ? (v as RecordAreaId) : null);
const refOf = (o: Record<string, unknown>): RecordRef | null =>
  typeof o.id === "string" && o.id ? { id: o.id, customerId: typeof o.customerId === "string" && o.customerId ? o.customerId : null } : null;
const bad = (error: string) => NextResponse.json({ error, errors: [error] }, { status: 400 });

export async function getRecordWorkflow(request: NextRequest): Promise<Response> {
  const c = await context(request);
  if (c instanceof NextResponse) return c;
  const url = new URL(request.url);
  const area = areaOf(url.searchParams.get("area"));
  if (!area) return bad(`area must be one of: ${workflowAreas().join(", ")}`);
  const reader = { email: c.me, role: c.ctx.role };
  const refs = url.searchParams.get("refs");
  if (refs !== null) {
    let list: unknown;
    try {
      list = JSON.parse(refs);
    } catch {
      return bad("refs must be a JSON list of record references, each with its `id`");
    }
    if (!Array.isArray(list)) return bad("refs must be a JSON list of record references, each with its `id`");
    const parsed = list.flatMap((x) => (x && typeof x === "object" ? refOf(x as Record<string, unknown>) ?? [] : []));
    const items = await withOrgRls(c.ctx.orgId, (tx) => nextStepsDoor(tx as never, c.ctx.orgId, area, parsed, reader));
    return NextResponse.json({ items });
  }
  const ref = refOf({ id: url.searchParams.get("id"), customerId: url.searchParams.get("customerId") });
  if (!ref) return bad("id is required");
  try {
    const answer = await withOrgRls(c.ctx.orgId, (tx) => readWorkflowDoor(tx as never, c.ctx.orgId, area, ref, reader, { deliver: deliverInOrg }));
    return NextResponse.json(answer.body, { status: answer.status });
  } catch (e) {
    const r = workflowRefusal(e, areaView(area).noun);
    if (r) return NextResponse.json(r.body, { status: r.status });
    throw e;
  }
}

/** POST …/holder and …/due: one step change. */
export async function changeRecordWorkflowStep(request: NextRequest, kind: StepChangeRequest["kind"]): Promise<Response> {
  const c = await context(request);
  if (c instanceof NextResponse) return c;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return bad("a JSON body is required");
  const area = areaOf(body.area);
  if (!area) return bad(`area must be one of: ${workflowAreas().join(", ")}`);
  const ref = refOf(body);
  if (!ref) return bad("id is required");
  if (typeof body.step !== "string" || !body.step) return bad("step is required (a step's id)");
  const change: StepChangeRequest = kind === "holders" ? { kind, stepId: body.step, holders: body.holders } : { kind, stepId: body.step, dueOn: body.due_on };
  try {
    const answer = await withOrgRls(c.ctx.orgId, (tx) => changeStepDoor(tx as never, c.ctx.orgId, area, ref, { email: c.me, role: c.ctx.role }, change, { deliver: deliverInOrg }));
    return NextResponse.json(answer.body, { status: answer.status });
  } catch (e) {
    const r = workflowRefusal(e, areaView(area).noun);
    if (r) return NextResponse.json(r.body, { status: r.status });
    throw e;
  }
}
