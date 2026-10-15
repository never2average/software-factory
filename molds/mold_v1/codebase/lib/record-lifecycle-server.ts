import "server-only";

/**
 * Lifecycle rules at the ops API (agent/lib/record-lifecycle.ts is the rule book, agent/lib/record-validate.ts applies
 * it to every write). What a route that writes a record with a lifecycle does around the validator:
 *
 *   1. before:  `lifecycleContext()` reads who entered the stored state, when a move out of it is four-eyes
 *               (`not_by: "{entered_by}"`); pass it to validateRecordWrite as `enteredBy`, with the stored row as
 *               `before`, the caller's `role` and the request's comment.
 *   2. refused: a result with `conflict` (enforce "strict") is answered by `lifecycleConflictResponse()`: 409, the
 *               sentence as `error`, the broken rules and the allowed moves.
 *   3. after:   once the write landed, `recordLifecycleOutcome()` writes the move to the activity feed and, under
 *               "warn", the rule it broke.
 *
 * Under enforce "off" (the default) none of it reads or writes anything: lifecycleContext answers {} without a query,
 * recordLifecycleOutcome writes nothing. The task routes (app/api/ops/todos) use it through guardTaskRequest
 * (lib/work-periods-server.ts) and `afterTaskWrite` below; the other areas' routes call the same three.
 */
import { NextResponse } from "next/server";
import { RECORD_AREAS, type RecordAreaId } from "@/agent/lib/record-areas.generated";
import { areaView, type AreaRow, type RecordAreas } from "@/agent/lib/record-areas";
import { needsEnteredBy, warningOf, type LifecycleConflict, type MoveCheck, type NextOccurrence, type WriteExtras } from "@/agent/lib/record-lifecycle";
import { recurAfterWrite } from "@/agent/lib/task-recurrence-run";
import { whoEntered, writeOutcome, type ActivityEntityType } from "@/agent/lib/record-lifecycle-store";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";

/** Is `areaId`'s lifecycle enforced ("warn" or "strict")? */
export function lifecycleEnforced(areaId: RecordAreaId, areas: RecordAreas = RECORD_AREAS): boolean {
  const lc = areaView(areaId, areas).lifecycle;
  return Boolean(lc && lc.enforce !== "off");
}

/**
 * What the validator needs besides the body, for an update of a stored record: who entered its state (only when a
 * move out of it is four-eyes). {} under "off", for a create, or with no database.
 */
export async function lifecycleContext(
  orgId: string,
  areaId: RecordAreaId,
  entity: { type: ActivityEntityType; id: string },
  before: AreaRow | null,
  areas: RecordAreas = RECORD_AREAS,
): Promise<{ enteredBy?: string | null }> {
  const v = areaView(areaId, areas);
  const lc = v.lifecycle;
  if (!lc || lc.enforce === "off" || !before || !getOpsDb()) return {};
  const from = v.get(before, lc.field);
  if (typeof from !== "string" || !needsEnteredBy(v, from)) return {};
  return { enteredBy: await withOrgRls(orgId, (tx) => whoEntered(tx, orgId, entity, v, before, from)) };
}

/** The answer to a write the lifecycle refused under "strict": 409 with the sentence, the rules and the moves. */
export function lifecycleConflictResponse(conflict: LifecycleConflict): NextResponse {
  return NextResponse.json(conflict, { status: 409 });
}

/** After the write landed: the move (and, under "warn", the broken rule) in the activity feed. Never throws. */
export async function recordLifecycleOutcome(
  orgId: string,
  areaId: RecordAreaId,
  entity: { type: ActivityEntityType; id: string },
  actor: string,
  check: MoveCheck | null | undefined,
  comment?: string | null,
  areas: RecordAreas = RECORD_AREAS,
): Promise<void> {
  if (!check || check.enforce === "off" || !getOpsDb()) return;
  try {
    await withOrgRls(orgId, (tx) => writeOutcome(tx, orgId, entity, actor, areaView(areaId, areas), check, comment));
  } catch (error) {
    console.error(`[record-lifecycle] could not record the move of ${entity.type}/${entity.id}:`, error);
  }
}

/** What a task write carries to its after-step (guardTaskRequest -> afterTaskWrite). */
export interface TaskLifecycleOutcome {
  /** The checked move, under "warn" or "strict"; null when only recurrence needs the after-step. */
  check: MoveCheck | null;
  /** The stored task before the write (for recurrence). */
  before?: AreaRow | null;
  actor: string;
  comment: string | null;
  areas: RecordAreas;
}

/**
 * After a task write was forwarded: once the service took it, record its move (and the broken rule under "warn"),
 * create the next occurrence of a recurring task it completed, and answer with what the UI shows: `warnings` (the
 * broken rules under "warn") and `next` (the occurrence created), beside the service's `item` (WriteExtras). Without
 * either, the service's answer goes back untouched.
 */
export async function afterTaskWrite(response: Response, orgId: string, taskId: string | null, outcome: TaskLifecycleOutcome | undefined): Promise<Response> {
  if (!outcome || !response.ok) return response;
  const payload = (await response.clone().json().catch(() => null)) as ({ item?: AreaRow & { id?: unknown } } & Record<string, unknown>) | null;
  const id = taskId ?? (typeof payload?.item?.id === "string" ? payload.item.id : null);
  if (!id) return response;
  if (outcome.check) await recordLifecycleOutcome(orgId, "tasks", { type: "task", id }, outcome.actor, outcome.check, outcome.comment, outcome.areas);
  let next: NextOccurrence | null = null;
  try {
    next = await recurAfterWrite({ orgId, actor: outcome.actor, before: outcome.before, item: payload?.item, areas: outcome.areas, withTx: (fn) => withOrgRls(orgId, fn) });
  } catch (error) {
    console.error(`[task-recurrence] could not create the next occurrence of task ${id}:`, error);
  }
  const extras: WriteExtras = {
    ...(outcome.check && outcome.check.enforce === "warn" && !outcome.check.allowed ? { warnings: [warningOf(outcome.check)] } : {}),
    ...(next ? { next } : {}),
  };
  if (!payload || !Object.keys(extras).length) return response;
  return NextResponse.json({ ...payload, ...extras }, { status: response.status });
}
