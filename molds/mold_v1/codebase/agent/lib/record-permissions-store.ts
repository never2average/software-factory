/**
 * WHO MAY WRITE A TASK OR A PERIOD, READ FROM THE DATABASE (agent/lib/record-permissions.ts is the rule book): the
 * writer's role in the workspace (org_members) and the stored record an `own` rule reads, for the paths that hold a
 * transaction (the cycles routes, the period and task tools, a task's delete). Each answers the refusal's sentence,
 * or null to go on. An area that declares no permissions reads nothing and answers null.
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { cycles } from "./db/schema.ts";
import type * as schema from "./db/schema.ts";
import { RECORD_AREAS, type RecordRole } from "./record-areas.generated.ts";
import type { AreaRow, RecordAreas } from "./record-areas.ts";
import { memberRole } from "./record-area-store.ts";
import { storedTask } from "./record-lifecycle-store.ts";
import { createRefusal, deleteRefusal, permissionsDeclared, updateRefusal } from "./record-permissions.ts";

type Tx = Pick<PostgresJsDatabase<typeof schema>, "select" | "insert">;

/** A period write: create (no id), update (id and the fields it sets), rollover (an update of the whole period), delete. */
export async function periodRefusal(
  tx: Tx,
  orgId: string,
  /** The writer; `role` when the caller already resolved it (a route's org context), else read from org_members. */
  caller: { actor: string; role?: RecordRole },
  action: "create" | "update" | "rollover" | "delete",
  target: { id?: string | null; patch?: Record<string, unknown> } = {},
  areas: RecordAreas = RECORD_AREAS,
): Promise<string | null> {
  if (!permissionsDeclared("periods", areas)) return null;
  const who = { role: caller.role ?? (await memberRole(tx, orgId, caller.actor)), actor: caller.actor };
  if (action === "create") return createRefusal("periods", who, target.patch ?? {}, areas);
  const [row] = target.id ? await tx.select().from(cycles).where(and(eq(cycles.id, target.id), eq(cycles.orgId, orgId))).limit(1) : [];
  // A period that is not there is the caller's own "not found".
  if (!row) return null;
  if (action === "delete") return deleteRefusal("periods", row as unknown as AreaRow, who, areas);
  return updateRefusal("periods", target.patch ?? {}, row as unknown as AreaRow, who, areas, action === "rollover");
}

/** A task's delete (the ops API's DELETE): who may, against the stored task. */
export async function taskDeleteRefusal(tx: Tx, orgId: string, caller: { actor: string; role?: RecordRole }, taskId: string, areas: RecordAreas = RECORD_AREAS): Promise<string | null> {
  if (!permissionsDeclared("tasks", areas)) return null;
  const before = await storedTask(tx, orgId, taskId);
  if (!before) return null;
  return deleteRefusal("tasks", before, { role: caller.role ?? (await memberRole(tx, orgId, caller.actor)), actor: caller.actor }, areas);
}
