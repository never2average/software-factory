import "server-only";

/**
 * Who may write a period or delete a task, at the ops API (agent/lib/record-permissions.ts is the rule book;
 * agent/lib/record-permissions-store.ts reads the stored record). Each answers a 403 with the sentence, or null to
 * go on. An area that declares no permissions (every default) reads nothing, not even who is signed in, and answers
 * null, so the route is exactly what it was.
 *
 * The account areas' routes (deployments, implementations) check through the one validator and
 * lib/record-area-routes.ts deleteForbidden; a task's create and update through lib/work-periods-server.ts
 * guardTaskRequest (agent/lib/task-area.ts).
 */
import { NextResponse, type NextRequest } from "next/server";
import { RECORD_AREAS } from "@/agent/lib/record-areas.generated";
import type { RecordAreas } from "@/agent/lib/record-areas";
import { permissionsDeclared } from "@/agent/lib/record-permissions";
import { periodRefusal, taskDeleteRefusal } from "@/agent/lib/record-permissions-store";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import type { OrgContext } from "@/lib/org-context";
import { callerEmail } from "@/lib/work-periods-server";

const forbidden = (sentence: string) => NextResponse.json({ error: sentence, errors: [sentence] }, { status: 403 });

/** A period's create, update (the fields it sets) or delete; a rollover is an update of the period. */
export async function periodForbidden(
  request: NextRequest,
  ctx: OrgContext,
  action: "create" | "update" | "rollover" | "delete",
  target: { id?: string; patch?: Record<string, unknown> } = {},
  areas: RecordAreas = RECORD_AREAS,
): Promise<NextResponse | null> {
  if (!permissionsDeclared("periods", areas) || !getOpsDb()) return null;
  const actor = (await callerEmail(request)) ?? "";
  const refusal = await withOrgRls(ctx.orgId, (tx) => periodRefusal(tx, ctx.orgId, { actor, role: ctx.role }, action, target, areas));
  return refusal ? forbidden(refusal) : null;
}

/** A task's DELETE (the service deletes it; this is asked first). */
export async function taskDeleteForbidden(request: NextRequest, ctx: OrgContext, taskId: string, areas: RecordAreas = RECORD_AREAS): Promise<NextResponse | null> {
  if (!permissionsDeclared("tasks", areas) || !getOpsDb()) return null;
  const actor = (await callerEmail(request)) ?? "";
  const refusal = await withOrgRls(ctx.orgId, (tx) => taskDeleteRefusal(tx, ctx.orgId, { actor, role: ctx.role }, taskId, areas));
  return refusal ? forbidden(refusal) : null;
}
