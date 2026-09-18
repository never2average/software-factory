import { and, eq, gt, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import {
  deployments,
  implementation,
  inboxItems,
  tickets,
  todos,
  workflowRuns,
} from "@/agent/lib/db/schema";
import type { getOpsDb } from "@/lib/ops-db";

type Db = NonNullable<ReturnType<typeof getOpsDb>>;

/**
 * How many things need attention, per workspace.
 *
 * This exists so the workspace SWITCHER can carry the number. Deciding which
 * workspace to go to is exactly the moment you need it, and it is the one
 * moment the answer is unavailable: a per-workspace count is not something the
 * workspace you are currently in can tell you.
 *
 * Counted for every workspace at once, six grouped queries total rather than
 * six per workspace — the cost does not grow with how many workspaces someone
 * belongs to. Best-effort per section: a missing table returns nothing for that
 * section rather than failing the switcher, which must open regardless.
 */

const OPEN_TICKETS = ["Open", "In Progress", "Needs Triage", "Reopened", "Blocked"];
const URGENT = ["P0-Critical", "P1-High"];

export async function attentionCounts(
  db: Db,
  orgIds: readonly string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (orgIds.length === 0) return out;
  for (const id of orgIds) out[id] = 0;

  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const ids = [...orgIds];

  const add = (rows: { orgId: string | null; n: number }[]) => {
    for (const r of rows) {
      if (r.orgId && r.orgId in out) out[r.orgId] += Number(r.n) || 0;
    }
  };
  const safe = async (fn: () => Promise<{ orgId: string | null; n: number }[]>) => {
    try {
      add(await fn());
    } catch {
      /* one absent table must not blank the switcher */
    }
  };

  const n = sql<number>`count(*)::int`;

  await Promise.all([
    safe(() =>
      db
        .select({ orgId: inboxItems.orgId, n })
        .from(inboxItems)
        .where(and(inArray(inboxItems.orgId, ids), eq(inboxItems.status, "new")))
        .groupBy(inboxItems.orgId),
    ),
    safe(() =>
      db
        .select({ orgId: tickets.orgId, n })
        .from(tickets)
        .where(
          and(
            inArray(tickets.orgId, ids),
            inArray(tickets.ticketStatus, OPEN_TICKETS),
            inArray(tickets.ticketPriority, URGENT),
          ),
        )
        .groupBy(tickets.orgId),
    ),
    safe(() =>
      db
        .select({ orgId: todos.orgId, n })
        .from(todos)
        .where(
          and(
            inArray(todos.orgId, ids),
            eq(todos.done, false),
            ne(todos.status, "cancelled"),
            isNotNull(todos.dueAt),
            lt(todos.dueAt, now),
          ),
        )
        .groupBy(todos.orgId),
    ),
    safe(() =>
      db
        .select({ orgId: deployments.orgId, n })
        .from(deployments)
        .where(and(inArray(deployments.orgId, ids), ne(deployments.healthStatus, "Healthy")))
        .groupBy(deployments.orgId),
    ),
    safe(() =>
      db
        .select({ orgId: implementation.orgId, n })
        .from(implementation)
        .where(
          and(
            inArray(implementation.orgId, ids),
            or(
              inArray(implementation.implementationRiskLevel, ["High", "Critical"]),
              isNotNull(implementation.blocker),
            ),
          ),
        )
        .groupBy(implementation.orgId),
    ),
    safe(() =>
      db
        .select({ orgId: workflowRuns.orgId, n })
        .from(workflowRuns)
        .where(
          and(
            inArray(workflowRuns.orgId, ids),
            eq(workflowRuns.status, "failed"),
            gt(workflowRuns.updatedAt, dayAgo),
          ),
        )
        .groupBy(workflowRuns.orgId),
    ),
  ]);

  return out;
}
