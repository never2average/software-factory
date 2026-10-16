/**
 * WHAT THE LIFECYCLE OF AN ACCOUNT RECORD AREA READS FROM THE DATABASE BESIDES THE WRITE (deployments, implementations):
 * the writer's role in the workspace (a transition's `roles`), and who moved a stored record into its state (four eyes,
 * `not_by: "{entered_by}"`; agent/lib/record-lifecycle-store.ts whoEntered). The routes get both from the request
 * (lib/record-lifecycle-server.ts); the agent's paths (upsert_customer's nested rows, the per-area tools) read them here.
 * Under enforce "off" (the default) nothing is read.
 */
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { orgMembers } from "./db/schema.ts";
import type * as schema from "./db/schema.ts";
import type { RecordRole } from "./record-areas.generated.ts";
import type { AreaRow, AreaView } from "./record-areas.ts";
import { needsEnteredBy } from "./record-lifecycle.ts";
import { whoEntered, type ActivityEntityType } from "./record-lifecycle-store.ts";
import { DEPLOYMENT_PROFILE } from "./deployment-profile.generated.ts";
import type { AccountAreaId } from "./record-area-records.ts";
import { implementationKey } from "./implementation-ids.ts";

type Tx = Pick<PostgresJsDatabase<typeof schema>, "select" | "insert">;

/** Is this area's lifecycle enforced ("warn" or "strict")? */
export const enforced = (v: AreaView): boolean => Boolean(v.lifecycle && v.lifecycle.enforce !== "off");

/** The writer's role in the workspace (org_members), "member" when none is recorded: what a transition's `roles` read. */
export async function memberRole(tx: Tx, orgId: string, email: string): Promise<RecordRole> {
  if (!email.includes("@")) return "member";
  const [row] = await tx.select({ role: orgMembers.role }).from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.email, email.toLowerCase()))).limit(1);
  const role = row?.role;
  return role === "owner" || role === "admin" || role === "engineer" ? role : "member";
}

/** Who moved a stored record into its state, when a move out of it is four eyes; undefined when nothing needs it. */
export async function enteredByOf(tx: Tx, orgId: string, v: AreaView, entity: { type: ActivityEntityType; id: string }, before: AreaRow | null | undefined): Promise<string | null | undefined> {
  if (!before || !enforced(v)) return undefined;
  const from = v.get(before, v.lifecycle!.field);
  if (typeof from !== "string" || !needsEnteredBy(v, from)) return undefined;
  return whoEntered(tx, orgId, entity, v, before, from);
}

/**
 * A record's id as the lists, the activity feed and the tasks filed under it key it: a deployment by its id; an
 * implementation by its own id when an account holds several, else by its account when rows are grouped by rolloutId,
 * else by its rolloutId (the account when none) (agent/lib/implementation-ids.ts).
 */
export function recordEntityId(id: AccountAreaId, row: AreaRow, groupedByRollout = DEPLOYMENT_PROFILE.domains.implementations.group_by === "rolloutId"): string {
  if (id === "deployments") return String(row.deploymentId);
  return implementationKey(row, { grouped: groupedByRollout });
}
