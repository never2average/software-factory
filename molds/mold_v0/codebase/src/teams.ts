/**
 * Teams inside a workspace (mold_v0-259, flag teams; sql/migrations/0050_teams_and_visibility.sql): each with a name, an
 * optional description, and its people, each a member or a lead. A record shared with a team (src/visibility.ts) is seen
 * by its members and leads; a lead may also change who sees the team's records (Share). The workspace's owners manage
 * the teams (Settings › Teams; /api/teams, src/team-routes.ts); everyone in the workspace may list them and see who is in
 * each, so the forms' team picker offers a person the teams they are in.
 *
 * The tenant role reads these tables (its own workspace's rows) and writes none: every write here runs as the app's own
 * role, naming the workspace's org_id, for an owner the route checked. Every change is kept in workspace_team_changes
 * (who, what, when): a team's page shows them.
 *
 * Stays free of the server's modules: src/record-areas.ts reads a person's teams through src/visibility.ts.
 */
import { getDb, type Queryable } from "./db.js";
import { PackError } from "./pack-api.js";
import { asPlatform, withTenant } from "./tenant-scope.js";
import { PROFILE } from "./profile.js";

export type TeamRole = "member" | "lead";
/**
 * mold_v0-262: a team role in the app's words (profile.json or a pack's `team_roles`), each mapped onto a level: the
 * level decides what the role may do (a lead also changes who sees the team's records), the name is what people read.
 * Absent: Lead and Member, as before. `role_name` on a membership is its role's id (NULL: the level's own word).
 */
export interface TeamRoleDef { id: string; label: string; level: TeamRole }
const BUILT_IN: readonly TeamRoleDef[] = [{ id: "lead", label: "Lead", level: "lead" }, { id: "member", label: "Member", level: "member" }];
let testRoles: readonly TeamRoleDef[] | null = null;
/** Tests set the roles as the profile would (null: the profile's). */
export const setTeamRolesForTest = (r: readonly TeamRoleDef[] | null) => { testRoles = r; };
/** The workspace's team roles, in their order (the declared ones, else Lead and Member). */
export const teamRoles = (): readonly TeamRoleDef[] => testRoles ?? (PROFILE.team_roles?.length ? PROFILE.team_roles : BUILT_IN);
/** Whether the app names its own roles (else the built-in two, and no role_name is stored). */
const ownRoles = () => teamRoles() !== BUILT_IN;
/** A role asked for (its id, or a level's word): the role, or a refusal naming the roles. */
export function roleOf(asked: unknown): TeamRoleDef {
  const rs = teamRoles();
  const r = rs.find((x) => x.id === asked) ?? (asked === "lead" || asked === "member" ? rs.find((x) => x.level === asked) : undefined);
  if (!r) throw new PackError(`role: one of ${rs.map((x) => x.id).join(", ")}`, 400);
  return r;
}
/** The role a membership reads as: its stored role name when that is still a role of this level, else the level's first. */
export const roleView = (level: TeamRole, name: string | null | undefined): TeamRoleDef =>
  teamRoles().find((x) => x.id === name && x.level === level) ?? teamRoles().find((x) => x.level === level) ?? BUILT_IN.find((x) => x.level === level)!;
export interface TeamPerson { user_id: string; role: TeamRole; added_at: string; added_by: string | null;
  /** mold_v0-262: the role in the app's words (its id and label; the level is `role`), and the name stored (NULL: none). */
  role_id: string; role_label: string; role_name: string | null }
export interface Team {
  id: number; name: string; description: string | null; created_at: string; updated_at: string; created_by: string | null;
  members: number; leads: string[];
}
export interface TeamChange { id: number; action: string; team_id: number | null; team_name: string; user_id: string | null; detail: string | null; by: string | null; at: string }

/** At most this many teams in a workspace, and people in a team. */
export const MAX_TEAMS = 200, MAX_TEAM_PEOPLE = 500;
const PERSON = /^[A-Za-z0-9][A-Za-z0-9_.:@|-]{0,199}$/;
const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();
const clean = (s: string) => s.replace(/[\u0000-\u001f]/g, "").trim();

const nameOf = (v: unknown): string => {
  if (typeof v !== "string" || !clean(v)) throw new PackError("a team's name: 1-80 characters", 400);
  const n = clean(v).replace(/\s+/g, " ");
  if (n.length > 80) throw new PackError("a team's name: 1-80 characters", 400);
  return n;
};
const descriptionOf = (v: unknown): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 500) throw new PackError("a team's description: up to 500 characters", 400);
  return clean(v) || null;
};
export const checkPerson = (v: unknown, what = "a person"): string => {
  if (typeof v !== "string" || !PERSON.test(v)) throw new PackError(`${what}: a person's id in this workspace`, 400);
  return v;
};
const by = (who: string | null) => (who ? who.replace(/[\u0000-\u001f]/g, "").slice(0, 200) : null);

/** Read as the workspace (its row-level security): the tenant role sees its own teams only. */
const read = <T>(orgId: number, fn: () => Promise<T>) => withTenant(orgId, fn);
/**
 * The connection a read runs on: `on`, the caller's own transaction when it is inside one (mold_v0-262: a record write
 * made a transaction by its history section looks up the writer's teams; a read of its own would wait for a second
 * connection, which the embedded database never gives while the first one is open, and a full pool neither), else a
 * tenant transaction of its own.
 */
const on = async <T>(orgId: number, tx: Queryable | undefined, sql: string, params: unknown[]): Promise<T[]> =>
  tx ? tx.query<T>(sql, params) : read(orgId, async () => (await getDb()).query<T>(sql, params));

/** Every team of a workspace, by name, with how many people each has and who leads it. */
export async function listTeams(orgId: number, tx?: Queryable): Promise<Team[]> {
  const rows = await on<{ id: number; name: string; description: string | null; created_at: Date; updated_at: Date; created_by: string | null; members: number; leads: string[] | null }>(orgId, tx,
    `SELECT t.id, t.name, t.description, t.created_at, t.updated_at, t.created_by,
            (SELECT count(*)::int FROM workspace_team_members m WHERE m.org_id = t.org_id AND m.team_id = t.id) AS members,
            ARRAY(SELECT m.user_id FROM workspace_team_members m WHERE m.org_id = t.org_id AND m.team_id = t.id AND m.role = 'lead' ORDER BY m.user_id) AS leads
       FROM workspace_teams t WHERE t.org_id = $1 ORDER BY lower(t.name), t.id`, [orgId]);
  return rows.map((r) => ({ id: Number(r.id), name: r.name, description: r.description, created_at: iso(r.created_at), updated_at: iso(r.updated_at), created_by: r.created_by, members: r.members, leads: r.leads ?? [] }));
}

/** One team of the workspace, or null. `ref`: its id, or its name (any case). */
export async function findTeam(orgId: number, ref: unknown, tx?: Queryable): Promise<Team | null> {
  const all = await listTeams(orgId, tx);
  if (typeof ref === "number" || (typeof ref === "string" && /^\d{1,15}$/.test(ref))) return all.find((t) => t.id === Number(ref)) ?? null;
  if (typeof ref === "string" && ref.trim()) return all.find((t) => t.name.toLowerCase() === ref.trim().toLowerCase()) ?? null;
  return null;
}
export async function teamOrThrow(orgId: number, ref: unknown): Promise<Team> {
  const t = await findTeam(orgId, ref);
  if (!t) throw new PackError(`no team ${JSON.stringify(String(ref).slice(0, 80))} in this workspace`, 404);
  return t;
}

/** A team's people, leads first, then by when they were added. */
export async function teamPeople(orgId: number, teamId: number): Promise<TeamPerson[]> {
  return read(orgId, async () => (await (await getDb()).query<{ user_id: string; role: TeamRole; added_at: Date; added_by: string | null; role_name: string | null }>(
    "SELECT user_id, role, added_at, added_by, role_name FROM workspace_team_members WHERE org_id = $1 AND team_id = $2 ORDER BY role = 'lead' DESC, added_at, user_id", [orgId, teamId]))
    .map((r) => { const v = roleView(r.role, r.role_name); return { user_id: r.user_id, role: r.role, added_at: iso(r.added_at), added_by: r.added_by, role_id: v.id, role_label: v.label, role_name: r.role_name ?? null }; }));
}

/** The teams a person is in (each with their role in it). */
export async function teamsOf(orgId: number, userId: string, tx?: Queryable): Promise<{ id: number; name: string; role: TeamRole }[]> {
  return (await on<{ id: number; name: string; role: TeamRole }>(orgId, tx,
    `SELECT t.id, t.name, m.role FROM workspace_team_members m JOIN workspace_teams t ON t.id = m.team_id AND t.org_id = m.org_id
      WHERE m.org_id = $1 AND m.user_id = $2 ORDER BY lower(t.name)`, [orgId, userId])).map((r) => ({ id: Number(r.id), name: r.name, role: r.role }));
}

/** A team's changes, newest first (Show more: `before`, a change's id). */
export async function teamChanges(orgId: number, teamId: number, opts: { limit?: number; before?: number | null } = {}): Promise<{ changes: TeamChange[]; more: boolean }> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 100);
  const rows = await read(orgId, async () => (await getDb()).query<{ id: number; action: string; team_id: number | null; team_name: string; user_id: string | null; detail: string | null; by: string | null; at: Date }>(
    `SELECT id, action, team_id, team_name, user_id, detail, by, at FROM workspace_team_changes
      WHERE org_id = $1 AND team_id = $2 AND ($3::bigint IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`, [orgId, teamId, opts.before ?? null, limit + 1]));
  return { changes: rows.slice(0, limit).map((r) => ({ ...r, id: Number(r.id), team_id: r.team_id === null ? null : Number(r.team_id), at: iso(r.at) })), more: rows.length > limit };
}

// ---------- changes (the app's own role, for an owner the route checked) ----------

type Q = import("./db.js").Queryable;
/** Run `fn` as one transaction of the app's own role (the tenant role writes nothing here). */
const write = <T>(fn: (tx: Q) => Promise<T>): Promise<T> => asPlatform(async () => (await getDb()).transaction(fn));
const note = (tx: Q, orgId: number, team: { id: number; name: string }, action: string, who: string | null, user: string | null = null, detail: string | null = null) =>
  tx.query("INSERT INTO workspace_team_changes (org_id, team_id, team_name, action, user_id, detail, by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [orgId, team.id, team.name.slice(0, 80), action, user, detail ? detail.slice(0, 300) : null, by(who)]);
const taken = (e: unknown) => (e as { code?: string }).code === "23505";

export async function createTeam(orgId: number, who: string | null, body: { name?: unknown; description?: unknown }): Promise<Team> {
  const name = nameOf(body?.name), description = descriptionOf(body?.description);
  if ((await listTeams(orgId)).length >= MAX_TEAMS) throw new PackError(`a workspace has at most ${MAX_TEAMS} teams`, 409);
  const id = await write(async (tx) => {
    const [t] = await tx.query<{ id: number }>("INSERT INTO workspace_teams (org_id, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING id", [orgId, name, description, by(who)]);
    await note(tx, orgId, { id: Number(t!.id), name }, "created", who);
    return Number(t!.id);
  }).catch((e) => { throw taken(e) ? new PackError(`a team named ${JSON.stringify(name)} exists already`, 409) : e; });
  return (await findTeam(orgId, id))!;
}

export async function updateTeam(orgId: number, who: string | null, ref: unknown, body: { name?: unknown; description?: unknown }): Promise<Team> {
  const team = await teamOrThrow(orgId, ref);
  const name = body?.name === undefined ? team.name : nameOf(body.name);
  const description = body?.description === undefined ? team.description : descriptionOf(body.description);
  if (name === team.name && description === team.description) return team;
  await write(async (tx) => {
    await tx.query("UPDATE workspace_teams SET name = $3, description = $4, updated_at = now() WHERE org_id = $1 AND id = $2", [orgId, team.id, name, description]);
    if (name !== team.name) await note(tx, orgId, { id: team.id, name }, "renamed", who, null, `from ${team.name}`);
  }).catch((e) => { throw taken(e) ? new PackError(`a team named ${JSON.stringify(name)} exists already`, 409) : e; });
  return (await findTeam(orgId, team.id))!;
}

/**
 * Delete a team. Its records stay with their owners, collaborators and the workspace's owners: each becomes private
 * (the team's people no longer see it through the team). Answers how many records that was. Refused while an
 * append-only, chained record is shared with it (such a record never changes).
 */
export async function deleteTeam(orgId: number, who: string | null, ref: unknown): Promise<{ deleted: true; records: number }> {
  const team = await teamOrThrow(orgId, ref);
  const records = await write(async (tx) => {
    // A chained record (0035) never changes, its team included: the team stays while one is shared with it.
    const [c] = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_records WHERE org_id = $1 AND team_id = $2 AND chained", [orgId, team.id]);
    if (c && c.n) throw new PackError(`${c.n} append-only record(s) are shared with ${team.name}: they never change, so the team stays`, 409);
    const moved = await tx.query("UPDATE workspace_records SET visibility = 'private', team_id = NULL WHERE org_id = $1 AND team_id = $2 RETURNING id", [orgId, team.id]);
    await note(tx, orgId, team, "deleted", who, null, moved.length ? `${moved.length} record(s) made private` : null);
    await tx.query("DELETE FROM workspace_teams WHERE org_id = $1 AND id = $2", [orgId, team.id]);
    return moved.length;
  });
  return { deleted: true, records };
}

/** How many of the workspace's records are shared with a team (its page; counted as the workspace, every record). */
export async function teamRecordCount(orgId: number, teamId: number): Promise<number> {
  const [r] = await asPlatform(async () => (await getDb()).query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_records WHERE org_id = $1 AND team_id = $2", [orgId, teamId]));
  return r?.n ?? 0;
}

/** Add people to a team (or change their role in it): `role` a role's id (mold_v0-262), or member (the default) or lead. */
export async function addTeamPeople(orgId: number, who: string | null, ref: unknown, people: unknown, role: unknown = "member"): Promise<TeamPerson[]> {
  const team = await teamOrThrow(orgId, ref);
  const list = (Array.isArray(people) ? people : [people]).map((p) => checkPerson(p));
  if (!list.length || list.length > 100) throw new PackError("people: 1-100 people's ids", 400);
  // mold_v0-262: a role in the app's words (its id) or a level's word; stored as its level and, when the app names its
  // own roles, its id.
  const def = roleOf(role), level = def.level, name = ownRoles() ? def.id : null;
  const now = await teamPeople(orgId, team.id);
  const added = list.filter((u) => !now.some((p) => p.user_id === u));
  if (now.length + new Set(added).size > MAX_TEAM_PEOPLE) throw new PackError(`a team has at most ${MAX_TEAM_PEOPLE} people`, 409);
  await write(async (tx) => {
    for (const u of new Set(list)) {
      const was = now.find((p) => p.user_id === u);
      if (was?.role === level && (was.role_name ?? null) === name) continue;
      await tx.query(`INSERT INTO workspace_team_members (org_id, team_id, user_id, role, added_by, role_name) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (team_id, user_id) DO UPDATE SET role = excluded.role, role_name = excluded.role_name`, [orgId, team.id, u, level, by(who), name]);
      const as = name ? `as ${def.label}` : level === "lead" ? "as a lead" : null;
      if (!was) await note(tx, orgId, team, "member_added", who, u, as);
      else if (was.role !== level) await note(tx, orgId, team, level === "lead" ? "lead_set" : "lead_unset", who, u, as);
      else await note(tx, orgId, team, "role_set", who, u, as);
    }
  });
  return teamPeople(orgId, team.id);
}

export async function setTeamRole(orgId: number, who: string | null, ref: unknown, userId: unknown, role: unknown): Promise<TeamPerson[]> {
  const team = await teamOrThrow(orgId, ref);
  const u = checkPerson(userId);
  if (!(await teamPeople(orgId, team.id)).some((p) => p.user_id === u)) throw new PackError("not in this team", 404);
  return addTeamPeople(orgId, who, team.id, [u], role);
}

export async function removeTeamPerson(orgId: number, who: string | null, ref: unknown, userId: unknown): Promise<TeamPerson[]> {
  const team = await teamOrThrow(orgId, ref);
  const u = checkPerson(userId);
  await write(async (tx) => {
    const gone = await tx.query("DELETE FROM workspace_team_members WHERE org_id = $1 AND team_id = $2 AND user_id = $3 RETURNING user_id", [orgId, team.id, u]);
    if (!gone.length) throw new PackError("not in this team", 404);
    await note(tx, orgId, team, "member_removed", who, u);
  });
  return teamPeople(orgId, team.id);
}

/** A person left the workspace: they leave its teams too (each change kept). */
export async function leaveAllTeams(orgId: number, who: string | null, userId: string): Promise<number> {
  const mine = await teamsOf(orgId, userId);
  for (const t of mine) await removeTeamPerson(orgId, who, t.id, userId).catch(() => undefined);
  return mine.length;
}
