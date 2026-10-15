/**
 * What the lifecycle rules need from the database, and where their outcome is written (agent/lib/record-lifecycle.ts
 * is the pure rule book). Every function takes the caller's workspace-scoped transaction (`withOrgDb` in the agent,
 * `withOrgRls` in the web app), so row-level security scopes every read and write exactly as the routes' own, and also
 * filters on org_id itself.
 *
 *   enteredBy          who moved a record into a state: the actor of the latest activity line that ends with that
 *   whoEntered         move's marker (moveEvent). Read only when a transition out of the state says
 *                      `not_by: "{entered_by}"`. When no move line says (the record was moved before its lifecycle was
 *                      enforced, or by a door that writes none), whoEntered falls back, failing CLOSED: to the last
 *                      person the record's activity feed shows changing it (any line by a person: "Status changed …",
 *                      "Task created: …"), else to its creator (`createdBy`). Only a record with neither refuses nobody.
 *   writeOutcome       the activity lines of a move under "warn" or "strict": the move (with its comment and marker)
 *                      and, when it broke a rule under "warn", the rule. Nothing under "off".
 *   storedTask         a task as its lifecycle reads it (columns by key, own fields under `custom`).
 *   stageStateOf       the lifecycle state a task's requested pipeline stage stands for (stateForStage).
 *
 * Server-only (it imports the schema).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./db/schema.ts";
import { entityActivity, projectWorkflowVersions, taskWorkflowInstances, todos } from "./db/schema.ts";
import type { AreaRow, AreaView } from "./record-areas.ts";
import { enteredSuffix, moveEvent, stateForStage, warnEvent, type MoveCheck } from "./record-lifecycle.ts";

export type LifecycleTx = Pick<PostgresJsDatabase<typeof schema>, "select" | "insert">;
export type ActivityEntityType = "task" | "cycle" | "deployment" | "implementation";

/** Who moved the record into `state` most recently, by the activity feed's move lines; null when none says. */
export async function enteredBy(tx: LifecycleTx, orgId: string, entity: { type: ActivityEntityType; id: string }, field: string, state: string): Promise<string | null> {
  const suffix = enteredSuffix(state);
  const [row] = await tx
    .select({ actor: entityActivity.actor })
    .from(entityActivity)
    .where(and(
      eq(entityActivity.orgId, orgId),
      eq(entityActivity.entityType, entity.type),
      eq(entityActivity.entityId, entity.id),
      sql`strpos(${entityActivity.event}, ${`[${field}: `}) > 0`,
      sql`right(${entityActivity.event}, ${suffix.length}) = ${suffix}`,
    ))
    .orderBy(desc(entityActivity.createdAt))
    .limit(1);
  return row?.actor ?? null;
}

/**
 * Who moved a stored record into its state `from`, for four eyes: the latest move line's actor; with none, the last
 * person the feed shows changing the record; with none, its creator. A person is an email: the feed's "system" and the
 * routes' "web" label are nobody.
 */
export async function whoEntered(tx: LifecycleTx, orgId: string, entity: { type: ActivityEntityType; id: string }, v: AreaView, before: AreaRow, from: string): Promise<string | null> {
  const lc = v.lifecycle!;
  const by = await enteredBy(tx, orgId, entity, lc.field, from);
  if (by) return by;
  const last = await lastChangedBy(tx, orgId, entity);
  if (last) return last;
  return typeof before.createdBy === "string" && before.createdBy.includes("@") ? before.createdBy : null;
}

/** The last person (an email) the record's activity feed shows changing it, or null. */
export async function lastChangedBy(tx: LifecycleTx, orgId: string, entity: { type: ActivityEntityType; id: string }): Promise<string | null> {
  const [row] = await tx
    .select({ actor: entityActivity.actor })
    .from(entityActivity)
    .where(and(eq(entityActivity.orgId, orgId), eq(entityActivity.entityType, entity.type), eq(entityActivity.entityId, entity.id), sql`strpos(${entityActivity.actor}, '@') > 0`))
    .orderBy(desc(entityActivity.createdAt))
    .limit(1);
  return row?.actor ?? null;
}

/** The activity lines of a checked move (none when the lifecycle is not enforced). */
export function outcomeEvents(v: AreaView, check: MoveCheck | null | undefined, comment?: string | null): string[] {
  if (!check || check.enforce === "off") return [];
  return [moveEvent(v, check, comment), ...(check.allowed ? [] : [warnEvent(check)])];
}

/** Write a checked move's activity lines: the move, and the broken rule under "warn". */
export async function writeOutcome(
  tx: LifecycleTx,
  orgId: string,
  entity: { type: ActivityEntityType; id: string },
  actor: string,
  v: AreaView,
  check: MoveCheck | null | undefined,
  comment?: string | null,
): Promise<string[]> {
  const events = outcomeEvents(v, check, comment);
  // One statement shares one now(): each line gets its own time, a millisecond apart, so the feed reads in order.
  const at = Date.now();
  if (events.length) await tx.insert(entityActivity).values(events.map((event, i) => ({ orgId, entityType: entity.type, entityId: entity.id, actor, event, createdAt: new Date(at + i) })));
  return events;
}

/** A task as its lifecycle reads it, or null (not in this workspace). */
export async function storedTask(tx: LifecycleTx, orgId: string, id: string): Promise<AreaRow | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const [row] = await tx.select().from(todos).where(and(eq(todos.id, id), eq(todos.orgId, orgId))).limit(1);
  if (!row) return null;
  return { ...row, custom: (row.custom ?? {}) as Record<string, unknown> } as AreaRow;
}

/** The state a pipeline stage the task may move to stands for, or null (no pipeline, no such stage, no state). */
export async function stageStateOf(tx: LifecycleTx, orgId: string, v: AreaView, taskId: string, stageId: string): Promise<string | null> {
  const [row] = await tx
    .select({ stages: projectWorkflowVersions.stages })
    .from(taskWorkflowInstances)
    .innerJoin(projectWorkflowVersions, and(eq(projectWorkflowVersions.id, taskWorkflowInstances.workflowVersionId), eq(projectWorkflowVersions.orgId, taskWorkflowInstances.orgId)))
    .where(and(eq(taskWorkflowInstances.taskId, taskId), eq(taskWorkflowInstances.orgId, orgId)))
    .limit(1);
  const stages = (row?.stages ?? []) as { id: string; label: string; category?: string }[];
  const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const stage = stages.find((s) => s.id === stageId || norm(s.label) === norm(stageId));
  return stage ? stateForStage(v, stage) : null;
}

/** The task's next occurrence (a task in the workspace whose `custom.recurs_from` is it), or null: recurrence's idempotency. */
export async function occurrenceOf(tx: LifecycleTx, orgId: string, taskId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: todos.id })
    .from(todos)
    .where(and(eq(todos.orgId, orgId), sql`${todos.custom} @> ${JSON.stringify({ recurs_from: taskId })}::text::jsonb`))
    .limit(1);
  return row?.id ?? null;
}
