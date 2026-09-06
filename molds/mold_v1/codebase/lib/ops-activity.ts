/**
 * Best-effort activity-feed writes for the workspace ops routes
 * (`entity_activity`). Every mutating route on a task / cycle / deployment /
 * implementation appends one human-readable sentence per change through
 * `recordActivity`. Fire-and-forget — a bookkeeping failure is logged and
 * swallowed, never failing the mutation it describes. Twin of `lib/ops-audit.ts`
 * (which covers the automation entities).
 */
import "server-only";

import { entityActivity } from "@/agent/lib/db/schema";
import { withOrgRls, type Db } from "@/lib/ops-db";

export type ActivityEntity = "task" | "cycle" | "deployment" | "implementation" | "thread";

export async function recordActivity(
  db: Db,
  input: { entityType: ActivityEntity; entityId: string; actor: string; event: string; orgId: string },
): Promise<void> {
  try {
    // The workspace is REQUIRED. It was optional, falling back to a column
    // default of 'org-onfinance' — a workspace that does not exist — so an
    // omission filed the activity where nobody would ever read it.
    // Its own workspace-scoped transaction — see lib/ops-audit.ts for why a
    // fire-and-forget writer must not borrow the caller's.
    await withOrgRls(input.orgId, (tx) => tx.insert(entityActivity).values(input));
  } catch (error) {
    console.error(
      `[ops-activity] could not record activity for ${input.entityType}/${input.entityId}:`,
      error,
    );
  }
}

/** Records one sentence per changed field of a PATCH diff. */
export async function recordFieldChanges(
  db: Db,
  base: { entityType: ActivityEntity; entityId: string; actor: string; orgId: string },
  changes: { label: string; before: unknown; after: unknown }[],
): Promise<void> {
  const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));
  for (const c of changes) {
    if (String(c.before ?? "") === String(c.after ?? "")) continue;
    await recordActivity(db, { ...base, event: `${c.label} changed ${show(c.before)} → ${show(c.after)}` });
  }
}
