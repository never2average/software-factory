/**
 * A DECLARED PERIOD WRITTEN TO THE DATABASE (agent/lib/period-area.ts is the pure half): the one write path the ops
 * routes (app/api/ops/cycles/**) and the agent's upsert_cycle share when the profile states the periods area in the
 * record-area form, so both doors apply one rule.
 *
 *   1. the stored period (an update), the writer's role in the workspace (org_members, unless the caller already
 *      knows it), and who entered its state when a move out of it is four eyes (`not_by: "{entered_by}"`);
 *   2. a create given no dates gets the workspace's next window and its name, as today (newPeriodWindow);
 *   3. preparePeriodWrite: who may (#180), the definition's types and choices, the lifecycle (#175/#177);
 *   4. the row written: columns set, own fields merged PER KEY in SQL onto what is stored at write time
 *      (customMergeSql), so a key the write does not name, or the profile no longer declares, is never touched;
 *   5. the move's activity lines (and a broken rule's, under "warn") in the same transaction.
 *
 * Every function takes the caller's workspace-scoped transaction (`withOrgRls` in the web app, `withOrgDb` in the
 * agent) and also filters on org_id: row-level security is the fence, the filter is the query saying what it means.
 *
 * Server-only (it imports the schema).
 */
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "./db/schema.ts";
import { cycles } from "./db/schema.ts";
import { RECORD_AREAS, type RecordRole } from "./record-areas.generated.ts";
import { areaView, type AreaRow, type RecordAreas } from "./record-areas.ts";
import { customMergeSql } from "./custom-merge-sql.ts";
import type { CustomDelta } from "./custom-fields.ts";
import { needsEnteredBy, storedStateOf, type LifecycleConflict, type MoveCheck, type WriteWarning } from "./record-lifecycle.ts";
import { whoEntered, writeOutcome } from "./record-lifecycle-store.ts";
import { memberRole } from "./record-area-store.ts";
import { periodRow, preparePeriodWrite } from "./period-area.ts";
import { WORK_PERIODS, type WorkPeriods } from "./work-periods.ts";
import { newPeriodWindow } from "./work-period-store.ts";

type Tx = Pick<PostgresJsDatabase<typeof schema>, "select" | "insert" | "update" | "delete">;
export type CycleRow = typeof cycles.$inferSelect;

export type PeriodWriteResult =
  | {
      ok: true;
      row: CycleRow;
      before: CycleRow | null;
      /** The keys the write changed (columns and own fields), for the activity feed's field lines. */
      changed: string[];
      /** The checked move (enforced lifecycles only): its lines are already written. */
      check: MoveCheck | null;
      warnings: WriteWarning[];
    }
  | { ok: false; status: 400 | 403 | 404 | 409; errors: string[]; conflict?: LifecycleConflict };

/**
 * Create (`id` null) or update one declared period in `orgId`. `body`: field keys (or their aliases), `custom` for own
 * fields, `reason` (a move's comment), `createdBy` (who files a new one when there is no signed-in person). `actor`:
 * the signed-in person (or the agent's caller); `role` when the caller already resolved it.
 */
export async function writeDeclaredPeriod(
  tx: Tx,
  orgId: string,
  input: { id: string | null; body: Record<string, unknown>; actor: string; role?: RecordRole; now?: Date },
  areas: RecordAreas = RECORD_AREAS,
  wp: WorkPeriods = WORK_PERIODS,
): Promise<PeriodWriteResult> {
  const v = areaView("periods", areas);
  const lc = v.lifecycle;
  const body: Record<string, unknown> = { ...input.body };
  let before: CycleRow | null = null;
  if (input.id) {
    [before] = await tx.select().from(cycles).where(and(eq(cycles.id, input.id), eq(cycles.orgId, orgId))).limit(1);
    if (!before) return { ok: false, status: 404, errors: [`No ${v.noun} with that id.`] };
  }
  const enforced = Boolean(lc && lc.enforce !== "off");
  // A move's comment is taken only where a lifecycle is enforced, as the routes always had it.
  if (!enforced && "reason" in body) return { ok: false, status: 400, errors: ["`reason` is not a field here: a move needs no comment unless the lifecycle is enforced."] };
  // Mode individual: a period has no shared lead and no team capacity (each person's goal is their own).
  if (wp.individual && (body.lead != null || body.capacity != null)) return { ok: false, status: 400, errors: ["lead and capacity are not used here"] };
  const role = input.role ?? (await memberRole(tx, orgId, input.actor));
  const stored = before ? periodRow(before as unknown as Record<string, unknown>) : null;
  let enteredBy: string | null | undefined;
  if (enforced && lc && stored && input.id && typeof body[lc.field] === "string") {
    const from = storedStateOf(v, stored);
    if (from !== null && from !== body[lc.field] && needsEnteredBy(v, from, body[lc.field] as string)) {
      enteredBy = await whoEntered(tx, orgId, { type: "cycle", id: input.id }, v, stored, from);
    }
  }
  // A create given no dates: the workspace's next window, and its name when none is given (today's rule).
  if (!input.id && body.startsAt === undefined && body.endsAt === undefined) {
    const window = await newPeriodWindow(tx, orgId, wp);
    if (window) {
      body.startsAt = window.startsAt.toISOString();
      body.endsAt = window.endsAt.toISOString();
      if (body.name === undefined || body.name === null || body.name === "") body.name = window.name;
    }
  }
  const prepared = preparePeriodWrite(input.id ? "update" : "create", body, { actor: input.actor, role, now: input.now, before: stored, enteredBy }, areas);
  if (!prepared.ok) return { ok: false, status: prepared.forbidden ? 403 : prepared.conflict ? 409 : 400, errors: prepared.errors, ...(prepared.conflict ? { conflict: prepared.conflict } : {}) };
  const changed = [...Object.keys(prepared.columns), ...Object.keys(prepared.customDelta?.set ?? {}), ...(prepared.customDelta?.clear ?? [])];
  let row: CycleRow | undefined;
  if (input.id) {
    const set: Record<string, unknown> = { ...prepared.columns, updatedAt: new Date() };
    if (prepared.customDelta) set.custom = customMergeSql(cycles.custom, prepared.customDelta as unknown as CustomDelta, { empty: "object" });
    [row] = await tx.update(cycles).set(set).where(and(eq(cycles.id, input.id), eq(cycles.orgId, orgId))).returning();
    if (!row) return { ok: false, status: 404, errors: [`No ${v.noun} with that id.`] };
  } else {
    // Filed under the signed-in person when the lifecycle is enforced (four eyes may fall back to the creator), else
    // under the label the body gives, as the route always filed it.
    const label = typeof body.createdBy === "string" && body.createdBy ? body.createdBy : null;
    const createdBy = enforced && input.actor.includes("@") ? input.actor : label ?? input.actor;
    [row] = await tx
      .insert(cycles)
      .values({ ...(prepared.columns as { name: string }), custom: prepared.custom, orgId, createdBy })
      .returning();
  }
  const comment = typeof body.reason === "string" ? body.reason : null;
  if (prepared.lifecycle) await writeOutcome(tx, orgId, { type: "cycle", id: row.id }, input.actor, v, prepared.lifecycle, comment);
  return { ok: true, row, before, changed, check: prepared.lifecycle, warnings: prepared.warnings };
}

/** A stored period as the rule book reads it (re-exported for the routes). */
export const storedPeriod = (row: CycleRow): AreaRow => periodRow(row as unknown as Record<string, unknown>);
