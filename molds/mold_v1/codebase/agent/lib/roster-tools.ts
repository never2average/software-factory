/**
 * The roster tools: `list_roster`, `upsert_roster_member` (re-exported from
 * snake_case files under `agent/tools/`). The roster is the org graph — who is
 * on which team and who they report to — that powers the "me / my reportees /
 * my team / everyone" scope filters in the TODOs workspace. Keyed by email
 * (the same email that owns tickets/deployments/implementations).
 *
 * People data (agent/lib/people-data.ts): `list_roster` also reports each person's departments, in the profile's
 * words, when the deployment declares any (otherwise its description and results are what they were). Who someone
 * reports to is the workspace owner's to set: `upsert_roster_member` changes it only for a caller who is the
 * workspace's owner or an admin, to someone of the same workspace, never closing a reporting loop.
 */
import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import { peopleRoster } from "./db/schema.ts";
import { callerFromCtx, orgForSession } from "./org-context.ts";
import { PEOPLE, canSetPeopleData, checkReporting, declaredDepartments, departmentLabel, workspaceRole } from "./people-data.ts";
// The record hub's name (profiles records.hub): the screen whose scope filters the roster serves.
import { RECORD_HUB } from "./deployment-profile.generated.ts";
import { hubAttributive } from "./record-hub.ts";
import { modelFacing } from "./model-facing/tools/model-facing.ts";

function requireDb() {
  const db = getDb();
  if (!db) throw new Error("The roster needs a database — DATABASE_URL is not configured.");
  return db;
}

export const listRosterTool = modelFacing("list_roster", defineTool({
  description:
    `List the {member} roster — email, name, team, and manager for each {member}. This is the org graph the ${hubAttributive(RECORD_HUB)} scope filters ('my reportees' / 'my team') resolve against.${PEOPLE.hasDepartments ? ` Each also carries \`departments\`: the ${PEOPLE.department.plural} they are in, by name.` : ""}`,
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const db = requireDb();
    const org = await orgForSession(ctx);
    const rows = await withOrgDb(org, (tx) =>
      tx
        .select()
        .from(peopleRoster)
        .where(and(eq(peopleRoster.orgId, org), isNull(peopleRoster.archivedAt)))
        .orderBy(asc(peopleRoster.email)),
    );
    return {
      roster: rows.map((r) => ({
        email: r.email,
        name: r.name,
        team: r.team,
        managerEmail: r.managerEmail,
        ...(PEOPLE.hasDepartments ? { departments: declaredDepartments(r.departments).map(departmentLabel) } : {}),
      })),
    };
  },
}));

export const upsertRosterMemberTool = modelFacing("upsert_roster_member", defineTool({
  description:
    `Add or update a {member} roster entry — set a person's name or team. Keyed by email; only the fields you pass are changed. Use this to build the org graph so the ${RECORD_HUB.label} 'my reportees' and 'my team' scopes work. e.g. 'put alice@example.com on team platform-india'. Who someone reports to (managerEmail) is set only when the person you act for is the workspace's owner or an admin; for anyone else, and in a run with no person behind it (a schedule, a workflow, a delegated step), it is refused and nothing is written.`,
  approval: once(),
  inputSchema: z.object({
    email: z.string().email().describe("The person's email (the roster key)."),
    name: z.string().nullable().optional(),
    team: z.string().nullable().optional().describe("Team slug, e.g. 'platform-india'; null to clear."),
    managerEmail: z
      .string()
      .email()
      .nullable()
      .optional()
      .describe("Who this person reports to: someone of this workspace; null to clear. Only for a workspace owner or admin."),
  }),
  async execute({ email, name, team, managerEmail }, ctx) {
    const db = requireDb();
    const key = email.toLowerCase();
    const org = await orgForSession(ctx);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) set.name = name;
    if (team !== undefined) set.team = team;
    if (managerEmail !== undefined) set.managerEmail = managerEmail ? managerEmail.toLowerCase() : null;

    // Who someone reports to is the workspace owner's to set (agent/lib/people-data.ts): the caller must be its owner
    // or an admin, read in the write's own transaction, and the line is checked against the workspace's under its lock.
    // A session with no person behind it (a schedule, a workflow or app step, a delegated child) has no role: refused.
    const caller = callerFromCtx(ctx).email;

    // Scoped to (org, email), the roster's key (drizzle/0049): another workspace holding the same email has its own
    // row, which this never reads or touches. The insert conflicts on that key, so a row a concurrent write added
    // between the read and the insert is updated, not a database error.
    const out = await withOrgDb(org, async (tx) => {
      if (managerEmail !== undefined) {
        if (!caller) {
          return { refused: "Only the workspace's owner or an admin can set who someone reports to, and this run has no person behind it (a schedule, a workflow or a delegated step), so it cannot. Ask an owner or admin to set it in the Control Panel's People tab." } as const;
        }
        const role = await workspaceRole(tx, org, caller);
        if (!canSetPeopleData(role)) {
          return { refused: `Only the workspace's owner or an admin can set who someone reports to; ${caller} holds neither role here. Ask an owner or admin to set it.` } as const;
        }
        const problem = await checkReporting(tx, org, new Map([[key, managerEmail ? managerEmail.toLowerCase() : null]]));
        if (problem) return { refused: problem } as const;
      }
      const [existing] = await tx
        .select({ email: peopleRoster.email })
        .from(peopleRoster)
        .where(and(eq(peopleRoster.email, key), eq(peopleRoster.orgId, org)));
      const [row] = existing
        ? await tx
            .update(peopleRoster)
            .set(set)
            .where(and(eq(peopleRoster.email, key), eq(peopleRoster.orgId, org)))
            .returning()
        : await tx
            .insert(peopleRoster)
            .values({
              email: key,
              orgId: org,
              name: name ?? null,
              team: team ?? null,
              managerEmail: managerEmail ? managerEmail.toLowerCase() : null,
            })
            .onConflictDoUpdate({ target: [peopleRoster.orgId, peopleRoster.email], set })
            .returning();
      return { row } as const;
    });
    if ("refused" in out) throw new Error(`${out.refused} Nothing was changed.`);
    const row = out.row;
    return { ok: true as const, member: { email: row.email, team: row.team, managerEmail: row.managerEmail } };
  },
}));
