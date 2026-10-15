/**
 * Recurrence in the write path (agent/lib/task-recurrence.ts is the rule): after a task write landed, create the next
 * occurrence when the write completed a recurring task, once. Called by the ops API's task routes
 * (lib/record-lifecycle-server.ts afterTaskWrite) and the agent's upsert_todo with their own workspace-scoped
 * transaction (`withTx`: withOrgRls in the web app, withOrgDb in the agent). Once, at the database: a unique index
 * (drizzle/0042) lets one next occurrence per task in, so two completions at the same moment make one; the loser's
 * refusal is taken as done. Server-only.
 */
import { entityActivity } from "./db/schema.ts";
import { RECORD_AREAS } from "./record-areas.generated.ts";
import { areaView, type AreaRow, type RecordAreas } from "./record-areas.ts";
import type { NextOccurrence } from "./record-lifecycle.ts";
import { occurrenceOf, type LifecycleTx } from "./record-lifecycle-store.ts";
import { completes, nextOccurrence, recursOnDone } from "./task-recurrence.ts";
import { taskWorkflowRequest } from "./task-workflow-service.ts";

export async function recurAfterWrite(input: {
  orgId: string;
  actor: string;
  /** The stored task before the write (null: not read, nothing recurs). */
  before: AreaRow | null | undefined;
  /** The task as the service answered the write. */
  item: (AreaRow & { id?: unknown }) | null | undefined;
  withTx: <T>(fn: (tx: LifecycleTx) => Promise<T>) => Promise<T>;
  areas?: RecordAreas;
  now?: Date;
}): Promise<NextOccurrence | null> {
  const areas = input.areas ?? RECORD_AREAS;
  if (!recursOnDone(areas) || !input.before || !input.item || typeof input.item.id !== "string") return null;
  const v = areaView("tasks", areas);
  if (!completes(v, input.before, input.item)) return null;
  const prevId = input.item.id;
  if (await input.withTx((tx) => occurrenceOf(tx, input.orgId, prevId))) return null;
  const body = nextOccurrence(input.item, input.actor, input.now, areas);
  if (!body) return null;
  let made: { id: string; title: string; dueAt: string | null };
  try {
    made = await taskWorkflowRequest<{ id: string; title: string; dueAt: string | null }>(input.orgId, input.actor, "/api/v1/tasks", { method: "POST", body });
  } catch (error) {
    // Two completions at once: the database lets one next occurrence in (drizzle/0042) and the service refuses the
    // other. When one exists now, the other writer made it: nothing to do, and no error for this write.
    if (await input.withTx((tx) => occurrenceOf(tx, input.orgId, prevId))) return null;
    throw error;
  }
  const title = String(input.item.title ?? "");
  await input.withTx((tx) =>
    tx.insert(entityActivity).values([
      { orgId: input.orgId, entityType: "task", entityId: prevId, actor: input.actor, event: `Next occurrence created${made.dueAt ? `, due ${made.dueAt.slice(0, 10)}` : ""} [recurs: ${made.id}]` },
      { orgId: input.orgId, entityType: "task", entityId: made.id, actor: input.actor, event: `Recurs from "${title}" [recurs_from: ${prevId}]` },
    ]),
  );
  return { id: made.id, title: made.title, dueAt: made.dueAt ?? null };
}
