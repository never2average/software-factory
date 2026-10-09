import { and, eq, gt, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
// Relative, with extensions: Next's bundler and plain node (scripts/test-workspace-attention-db.mjs) both load this.
import type * as schema from "../agent/lib/db/schema.ts";
import {
  deployments,
  implementation,
  inboxItems,
  tickets,
  todos,
  workflowRuns,
} from "../agent/lib/db/schema.ts";

type Tx = PostgresJsDatabase<typeof schema>;

/**
 * Run `fn` inside ONE workspace's row-level-security scope: `withOrgRls` (lib/ops-db.ts) on the web, `withOrgDb`
 * (agent/lib/db/index.ts) in the tests. Passed in, so this module holds no database handle of its own.
 */
export type InWorkspace = <T>(orgId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;

/**
 * How many things need attention, per workspace.
 *
 * This exists so the workspace SWITCHER can carry the number. Deciding which
 * workspace to go to is exactly the moment you need it, and it is the one
 * moment the answer is unavailable: a per-workspace count is not something the
 * workspace you are currently in can tell you.
 *
 * EACH WORKSPACE IS COUNTED INSIDE ITS OWN SCOPE (mold_v1-099). This used to be
 * six grouped queries across every workspace at once, on the bare handle, so
 * under the fail-closed `org_isolation` policy (no app.org_id → no rows) every
 * count came back 0 and the switcher confidently showed nothing to do. It was
 * the one pending web file in check:tenancy's baseline. Now: one transaction
 * per workspace (`inWorkspace`, which sets app.org_id), the six counts inside
 * it, a few workspaces at a time. The caller only ever asks for workspaces it
 * is a member of (app/api/ops/me/workspaces), so no cross-workspace reader is
 * needed at all.
 *
 * Best-effort per section: a missing table (or any failing count) contributes
 * nothing for that section rather than failing the switcher, which must open
 * regardless. Each count runs in its own savepoint so one failure cannot abort
 * the workspace's transaction for the others.
 */

const OPEN_TICKETS = ["Open", "In Progress", "Needs Triage", "Reopened", "Blocked"];
const URGENT = ["P0-Critical", "P1-High"];

export async function attentionCounts(
  orgIds: readonly string[],
  inWorkspace: InWorkspace,
  opts: { concurrency?: number } = {},
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const ids = [...new Set(orgIds.filter(Boolean))];
  for (const id of ids) out[id] = 0;
  if (ids.length === 0) return out;

  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const n = sql<number>`count(*)::int`;

  /** The six counts, for one workspace, inside its scope. The `org_id =` terms are belt and braces over RLS. */
  const countIn = (orgId: string) =>
    inWorkspace(orgId, async (tx) => {
      let total = 0;
      const safe = async (fn: (sp: Tx) => Promise<{ n: number }[]>) => {
        try {
          // A savepoint: a failed count (a table not migrated yet) rolls back to here, not the whole scope.
          const rows = await tx.transaction((sp) => fn(sp as unknown as Tx));
          total += Number(rows[0]?.n) || 0;
        } catch {
          /* one absent table must not blank the switcher */
        }
      };
      await safe((db) =>
        db.select({ n }).from(inboxItems).where(and(eq(inboxItems.orgId, orgId), eq(inboxItems.status, "new"))),
      );
      await safe((db) =>
        db
          .select({ n })
          .from(tickets)
          .where(
            and(
              eq(tickets.orgId, orgId),
              inArray(tickets.ticketStatus, OPEN_TICKETS),
              inArray(tickets.ticketPriority, URGENT),
            ),
          ),
      );
      await safe((db) =>
        db
          .select({ n })
          .from(todos)
          .where(
            and(
              eq(todos.orgId, orgId),
              eq(todos.done, false),
              ne(todos.status, "cancelled"),
              isNotNull(todos.dueAt),
              lt(todos.dueAt, now),
            ),
          ),
      );
      await safe((db) =>
        db.select({ n }).from(deployments).where(and(eq(deployments.orgId, orgId), ne(deployments.healthStatus, "Healthy"))),
      );
      await safe((db) =>
        db
          .select({ n })
          .from(implementation)
          .where(
            and(
              eq(implementation.orgId, orgId),
              or(
                inArray(implementation.implementationRiskLevel, ["High", "Critical"]),
                isNotNull(implementation.blocker),
              ),
            ),
          ),
      );
      await safe((db) =>
        db
          .select({ n })
          .from(workflowRuns)
          .where(and(eq(workflowRuns.orgId, orgId), eq(workflowRuns.status, "failed"), gt(workflowRuns.updatedAt, dayAgo))),
      );
      return total;
    });

  // A few workspaces at a time: each holds a pooled connection for its transaction.
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        out[id] = await countIn(id);
      } catch {
        out[id] = 0; // a workspace whose scope cannot be entered shows nothing, and the switcher still opens
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ids.length, Math.max(1, opts.concurrency ?? 3)) }, worker));
  return out;
}
