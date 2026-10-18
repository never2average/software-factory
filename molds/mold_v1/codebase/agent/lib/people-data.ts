/**
 * PEOPLE DATA: what a workspace's owner (or an admin) records about each person on its roster, beside the name and
 * team it already had: the department(s) they are in, who they report to (their supervisor: the roster's reporting
 * line, `people_roster.manager_email`) and typed attributes. The workflow engine routes steps by these
 * (docs/WORKFLOW_ENGINE.md, phase 4; agent/lib/people-directory.ts builds its directory from them).
 *
 * The catalogue is the DEPLOYMENT's (profiles `people`, checked by scripts/lib/people-profile.mjs): which departments
 * exist and which attributes, with their types (the engine's four: choice, multi_choice, boolean, text). A workspace
 * fills in values, never keys. Values are stored by key in `people_roster.departments` / `.attributes` (drizzle/0046),
 * under the roster's row-level security, so another workspace reads none of them.
 *
 * The rules every writer holds (POST /api/ops/roster, the bulk and workbook imports, the model's upsert_roster_member):
 *   - only the workspace's owner or an admin sets a department, an attribute or a supervisor (canSetPeopleData);
 *   - a supervisor is someone of the SAME workspace (on its roster or one of its signed-in people), never the person
 *     themself, and never closes a loop in the reporting lines (reportingProblem), checked under a per-workspace lock
 *     so two writes at once cannot build a loop between them (lockReporting);
 *   - a department or attribute the profile does not declare, or a value of the wrong type, is refused with a
 *     sentence and nothing is stored.
 * Reading: everyone in the workspace reads each person's departments (as the team and reporting line before them); a
 * person's attributes are read by that person and by the workspace's owner and admins (visibleAttributes).
 *
 * The pure half (the catalogue, checks, merges, views) is agent/lib/people-catalogue.ts, safe in the browser; this
 * module re-exports it and adds what takes the caller's transaction.
 */
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { orgMembers, peopleRoster } from "./db/schema.ts";
import type * as schema from "./db/schema.ts";
import { reportingProblem } from "./people-catalogue.ts";

export * from "./people-catalogue.ts";

type Tx = Pick<PostgresJsDatabase<typeof schema>, "select" | "execute">;

/** Someone's role in the workspace (org_members), "member" when none is recorded. */
export async function workspaceRole(tx: Pick<Tx, "select">, orgId: string, email: string): Promise<string> {
  const [row] = await tx
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.email, email.toLowerCase())))
    .limit(1);
  return row?.role === "owner" || row?.role === "admin" || row?.role === "engineer" ? row.role : "member";
}

/**
 * Serialise reporting-line writes in one workspace for the rest of the caller's transaction, so two writes that are
 * each fine alone (a reports to b; b reports to a) cannot both pass. Another workspace's writes do not wait.
 */
export async function lockReporting(tx: Pick<Tx, "execute">, orgId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`people_roster.reporting:${orgId}`}))`);
}

/**
 * The workspace's reporting lines and its people, read in the caller's transaction (under the roster's row-level
 * security when the caller set the workspace). `lines` holds every stored line, an ARCHIVED row's included: an archived
 * person can still be one of the workspace's signed-in people, and a loop through their stored line (A archived with
 * A → B, then B → A) must still be refused. `people` is who may be named as a supervisor: the live roster and the
 * signed-in people.
 */
export async function workspacePeople(tx: Pick<Tx, "select">, orgId: string): Promise<{ lines: Map<string, string | null>; people: Set<string> }> {
  const [roster, members] = await Promise.all([
    tx
      .select({ email: peopleRoster.email, managerEmail: peopleRoster.managerEmail, archivedAt: peopleRoster.archivedAt })
      .from(peopleRoster)
      .where(eq(peopleRoster.orgId, orgId)),
    tx.select({ email: orgMembers.email }).from(orgMembers).where(eq(orgMembers.orgId, orgId)),
  ]);
  const lines = new Map(roster.map((r) => [r.email.toLowerCase(), r.managerEmail ? r.managerEmail.toLowerCase() : null]));
  const people = new Set([...roster.filter((r) => !r.archivedAt).map((r) => r.email.toLowerCase()), ...members.map((m) => m.email.toLowerCase())]);
  return { lines, people };
}

/**
 * Check new reporting lines against the workspace's, in the caller's transaction: lock, read, apply, check. `next` maps
 * a person to who they will report to (null clears); people it adds to the roster count as of the workspace.
 */
export async function checkReporting(tx: Tx, orgId: string, next: ReadonlyMap<string, string | null>, added: Iterable<string> = []): Promise<string | null> {
  await lockReporting(tx, orgId);
  const { lines, people } = await workspacePeople(tx, orgId);
  for (const e of added) people.add(e.toLowerCase());
  for (const [e, m] of next) {
    people.add(e.toLowerCase());
    lines.set(e.toLowerCase(), m ? m.toLowerCase() : null);
  }
  return reportingProblem(lines, people, next.keys());
}

