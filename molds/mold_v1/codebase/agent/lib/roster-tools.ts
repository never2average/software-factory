/**
 * The roster tools: `list_roster`, `upsert_roster_member` (re-exported from
 * snake_case files under `agent/tools/`). The roster is the org graph — who is
 * on which team and who they report to — that powers the "me / my reportees /
 * my team / everyone" scope filters in the TODOs workspace. Keyed by email
 * (the same email that owns tickets/deployments/implementations).
 */
import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import { peopleRoster } from "./db/schema.ts";
import { orgForSession } from "./org-context.ts";
import { modelFacing } from "./model-facing/tools/model-facing.ts";

function requireDb() {
  const db = getDb();
  if (!db) throw new Error("The roster needs a database — DATABASE_URL is not configured.");
  return db;
}

export const listRosterTool = modelFacing("list_roster", defineTool({
  description:
    "List the {member} roster — email, name, team, and manager for each {member}. This is the org graph the TODO scope filters ('my reportees' / 'my team') resolve against.",
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
      })),
    };
  },
}));

export const upsertRosterMemberTool = modelFacing("upsert_roster_member", defineTool({
  description:
    "Add or update a {member} roster entry — set a person's team and/or who they report to (manager). Keyed by email; only the fields you pass are changed. Use this to build the org graph so the TODOs 'my reportees' and 'my team' scopes work. e.g. 'put alice@example.com on team platform-india reporting to lead@example.com'.",
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
      .describe("The email of who this person reports to; null to clear."),
  }),
  async execute({ email, name, team, managerEmail }, ctx) {
    const db = requireDb();
    const key = email.toLowerCase();
    const org = await orgForSession(ctx);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) set.name = name;
    if (team !== undefined) set.team = team;
    if (managerEmail !== undefined) set.managerEmail = managerEmail ? managerEmail.toLowerCase() : null;

    // Explicit select-then-upsert scoped to (org, email) — deliberately NOT
    // ON CONFLICT, so this tool is independent of whether the roster PK is
    // `email` or the composite `(org_id, email)` (the Phase-3 migration flips it
    // without a coordinated window).
    const [existing] = await withOrgDb(org, (tx) =>
      tx
        .select({ email: peopleRoster.email })
        .from(peopleRoster)
        .where(and(eq(peopleRoster.email, key), eq(peopleRoster.orgId, org))),
    );
    const [row] = await withOrgDb(org, (tx) =>
      existing
      ? tx
          .update(peopleRoster)
          .set(set)
          .where(and(eq(peopleRoster.email, key), eq(peopleRoster.orgId, org)))
          .returning()
      : tx
          .insert(peopleRoster)
          .values({
            email: key,
            orgId: org,
            name: name ?? null,
            team: team ?? null,
            managerEmail: managerEmail ? managerEmail.toLowerCase() : null,
          })
          .returning(),
    );
    return { ok: true as const, member: { email: row.email, team: row.team, managerEmail: row.managerEmail } };
  },
}));
