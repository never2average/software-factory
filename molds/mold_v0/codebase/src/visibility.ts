/**
 * Per-record visibility (mold_v0-259, flag teams; sql/migrations/0050_teams_and_visibility.sql). A record area that
 * declares `visibility` (src/pack-api.ts VisibilitySchema) gives each record its own: open to the workspace, shared with
 * one team (src/teams.ts), or private to its owner, with collaborators named on it where the area allows them.
 *
 * Who sees what is decided in one place, the database: the restrictive policy record_visibility on workspace_records,
 * for every query of the tenant role, against app.viewer (src/tenant-scope.ts). This module decides only who the viewer
 * is, from the person a door acts for:
 *
 *   flag off                  nobody: every record is the workspace's, as before
 *   a workspace owner         nobody (every record), as are an account API key and the shell's own work (no role)
 *   viewer, member, billing   that person: what is open to the workspace, theirs, what they collaborate on, their teams'
 *   the developer API         "~api" (a workspace's backend, no person of it): what is open to the workspace
 *
 * The doors set it once per request or call (src/app.ts customerSession for the console's and the packs' routes and the
 * data API, src/packs.ts runPackTool for every MCP tool, the agent's included, src/developer-api.ts for /v1), and the
 * record store sets it again from the actor it is given (src/record-areas.ts), so a list, a record page, a related list,
 * a computed fact or column, the record picker, an export, a metric or chart count, a reference check and a write each
 * find only the records that person may see. Narrowing only: an owner's actor inside a person's request never widens it.
 *
 * The lookups a write makes (the writer's teams, a named team) run on the write's own transaction when it has one
 * (`tx`, mold_v0-262): a history section makes each write a transaction, and a lookup of its own would wait for a
 * second connection the embedded database never gives while the first is open (the write hung).
 *
 * Inherited (mold_v0-262, sql/migrations/0053): an area declaring `visibility: {inherit: <reference field>}` stores each
 * record as 'inherit' with the record that field names, and the same policy shows it exactly when its parent is shown.
 *
 * Writes (src/record-areas.ts putWorkspace): a new record takes the visibility it is given, else its area's default,
 * owned by the person who adds it; a change keeps it unless one is given, which only the record's owner, a lead of its
 * team or a workspace owner may (Share). A person cannot give a record a visibility that would hide it from themselves.
 */
import type { AccountRole } from "./account-roles.js";
import type { Queryable } from "./db.js";
import { featureSetting } from "./feature-flags.js";
import { inheritsVisibility, PackError, VISIBILITY_MODES, type InheritVisibilitySchema, type RecordVisibility, type VisibilityInput, type z, type VisibilitySchema } from "./pack-api.js";
import { currentViewer, withViewer } from "./tenant-scope.js";
import { findTeam, teamsOf } from "./teams.js";

export type VisibilityMode = (typeof VISIBILITY_MODES)[number];
type Declared = z.output<typeof VisibilitySchema>;
type Modes = Exclude<Declared, z.output<typeof InheritVisibilitySchema>>;
interface AreaLike { name: string; label: string; scope: string; visibility?: Declared; fields?: readonly { name: string; to?: string; label?: string }[] }
/** The modes an area declares (none: it inherits its parent's, mold_v0-262). */
const modesOf = (a: AreaLike): Modes | null => (a.visibility && !inheritsVisibility(a.visibility) ? (a.visibility as Modes) : null);
interface Actor { role: AccountRole | null; userId: string | null }

/** The teams flag (src/features.json): off, nothing of this module applies. */
export const teamsOn = () => featureSetting("teams");
/** An area's records carry their visibility: the flag is on and the area declares one. */
export const visibilityShown = (a: AreaLike | null | undefined): boolean => !!a && a.scope === "workspace" && !!a.visibility && teamsOn();

const PERSON = /^[A-Za-z0-9][A-Za-z0-9_.:@|-]{0,199}$/;
/** The viewer a door's own caller reads as when it is no person of the workspace (the developer API). */
export const API_VIEWER = "~api";
/** A person with a role but no id (never expected): sees only what is open to the workspace. */
const NOBODY = "~nobody";

/** Who `a` reads as: undefined when every record (flag off, an owner, an account key, the shell). */
export function viewerOf(a: Actor): string | undefined {
  if (!teamsOn() || a.role === null || a.role === "owner") return undefined;
  return a.userId && PERSON.test(a.userId) ? a.userId : NOBODY;
}
/** Run fn reading as `a` (a person's own view), else as the door already set (never wider). */
export function asViewerOf<T>(a: Actor, fn: () => T): T {
  const v = viewerOf(a);
  return v === undefined || v === currentViewer() ? fn() : withViewer(v, fn);
}
/**
 * The person a write is for, when it is one (a new record's owner): the viewer in scope (none for the developer API's
 * "~api"), else a signed-in owner; never an account key or the shell.
 */
const personOf = (a: Actor): string | null => {
  const v = viewerOf(a) ?? currentViewer();
  if (v !== undefined && v !== null) return PERSON.test(v) ? v : null;
  return a.role !== null && a.userId && PERSON.test(a.userId) ? a.userId : null;
};
/** Whether the work in scope sees every record (no viewer: an owner, a key, the shell, or the flag off). */
const seesAll = (a: Actor) => viewerOf(a) === undefined && currentViewer() === null;

// ---------- the stored columns and what a read shows ----------

/** A record's visibility columns (workspace_records, 0050), as stored. */
export interface StoredVisibility { visibility: string | null; team_id: number | string | null; owner_id: string | null; collaborators: string[] | null; team_name?: string | null;
  /** mold_v0-262: the parent an 'inherit' record follows (0053). */
  inherit_area?: string | null; inherit_key?: string | null }
/** The columns a read selects for an area whose records carry their visibility. */
export const VISIBILITY_COLUMNS = "visibility, team_id, owner_id, collaborators, inherit_area, inherit_key, (SELECT t.name FROM workspace_teams t WHERE t.org_id = workspace_records.org_id AND t.id = workspace_records.team_id) AS team_name";
/** What a read shows: a record written before the flag (all NULL) is open to the workspace. */
export function visibilityOf(row: StoredVisibility): RecordVisibility {
  // mold_v0-262: a record that follows its parent's visibility says which record that is.
  if (row.visibility === "inherit" && row.inherit_area && row.inherit_key)
    return { mode: "inherit", team: null, owner: row.owner_id ?? null, collaborators: [], parent: { area: row.inherit_area, key: row.inherit_key } };
  const mode = (row.visibility === "team" || row.visibility === "private" ? row.visibility : "workspace") as VisibilityMode;
  const teamId = row.team_id === null || row.team_id === undefined ? null : Number(row.team_id);
  return { mode, team: mode === "team" && teamId !== null ? { id: teamId, name: row.team_name ?? `Team ${teamId}` } : null, owner: row.owner_id ?? null, collaborators: row.collaborators ?? [] };
}

/** The values a write stores (null: the visibility stays as it is). */
export interface VisibilityWrite { visibility: VisibilityMode | "inherit"; team_id: number | null; owner_id: string | null; collaborators: string[] | null;
  /** mold_v0-262: the parent an 'inherit' record follows (else null). */
  inherit_area?: string | null; inherit_key?: string | null }

const WORDS: Record<VisibilityMode, string> = { workspace: "everyone in the workspace", team: "one team", private: "only its owner" };
const MAX_COLLABORATORS = 50;

function parseInput(area: AreaLike, v: unknown): { mode: VisibilityMode; team: unknown; collaborators: string[] | undefined } {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new PackError("give `visibility`: {mode: workspace|team|private, team?, collaborators?}", 400);
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !["mode", "team", "collaborators"].includes(k));
  if (extra.length) throw new PackError(`\`visibility\` has no ${extra[0]!.slice(0, 40)}: give mode, team and collaborators`, 400);
  const modes = modesOf(area)!.modes;
  if (typeof o.mode !== "string" || !(modes as readonly string[]).includes(o.mode))
    throw new PackError(`\`visibility.mode\`: one of ${modes.join(", ")} (${area.label} records may be seen by ${modes.map((m) => WORDS[m]).join(", or ")})`, 400);
  let collaborators: string[] | undefined;
  if (o.collaborators !== undefined && o.collaborators !== null) {
    if (!modesOf(area)!.collaborators) throw new PackError(`${area.label} records name no collaborators`, 400);
    if (!Array.isArray(o.collaborators) || o.collaborators.length > MAX_COLLABORATORS || !o.collaborators.every((x) => typeof x === "string" && PERSON.test(x)))
      throw new PackError(`\`visibility.collaborators\`: up to ${MAX_COLLABORATORS} people's ids`, 400);
    collaborators = [...new Set(o.collaborators as string[])];
  }
  if (o.mode !== "team" && o.team !== undefined && o.team !== null && o.team !== "") throw new PackError("`visibility.team` is for mode team", 400);
  return { mode: o.mode as VisibilityMode, team: o.team, collaborators };
}

/** Whether `person` would see a record stored as `w` (the policy's rule, for a refusal in words before the database's). */
const wouldSee = (w: VisibilityWrite, person: string, myTeams: number[]) =>
  w.visibility === "workspace" || w.owner_id === person || (w.collaborators ?? []).includes(person) || (w.visibility === "team" && w.team_id !== null && myTeams.includes(w.team_id));

/**
 * What a write stores of a record's visibility (src/record-areas.ts putWorkspace), or null to keep what is stored:
 * a new record's (given, else its area's default; its owner the person adding it) or a change given on an existing one
 * (only by its owner, a lead of its team, or a workspace owner). Refused in words: a mode the area does not take, a team
 * that does not exist or that the person is not in, collaborators where the area names none, a visibility that would
 * hide the record from the person writing it.
 */
export async function visibilityForWrite(orgId: number, area: AreaLike, actor: Actor, given: unknown, prev: StoredVisibility | null, tx?: Queryable, data?: unknown): Promise<VisibilityWrite | null> {
  if (!visibilityShown(area)) return null;
  // mold_v0-262: an area that inherits its visibility: none is chosen; every write follows the record its reference
  // names now (the reference check, as the person reads, has found it: they see it). Empty: open to the workspace.
  if (inheritsVisibility(area.visibility)) {
    const field = area.visibility.inherit, f = area.fields?.find((x) => x.name === field);
    if (given !== undefined && given !== null)
      throw new PackError(`${area.label} records are seen by whoever sees the record their ${(f?.label ?? field).toLowerCase()} names: they take no \`visibility\` of their own`, 400);
    const k = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>)[field] : undefined;
    const owner = prev ? prev.owner_id ?? null : personOf(actor);
    return typeof k === "string" && k && f?.to
      ? { visibility: "inherit", team_id: null, owner_id: owner, collaborators: null, inherit_area: f.to, inherit_key: k }
      : { visibility: "workspace", team_id: null, owner_id: owner, collaborators: null, inherit_area: null, inherit_key: null };
  }
  const decl = modesOf(area)!;
  const all = seesAll(actor);
  const person = personOf(actor);
  if (prev && (given === undefined || given === null)) return null;
  // A new record no person adds (a run, the shell, an account key) and that says nothing: open to the workspace, as every
  // record written before the flag.
  if (!prev && (given === undefined || given === null) && !person) return { visibility: "workspace", team_id: null, owner_id: null, collaborators: null };
  const myTeams = person ? await teamsOf(orgId, person, tx) : [];
  if (prev) {
    const was = visibilityOf(prev);
    const lead = was.mode === "team" && was.team && myTeams.some((t) => t.id === was.team!.id && t.role === "lead");
    if (!all && !(person && was.owner === person) && !lead)
      throw new PackError(`Only its owner${was.mode === "team" ? ", a lead of its team" : ""} or an owner of the workspace can change who sees this ${area.label} record.`, 403);
  }
  const ask = given === undefined || given === null ? { mode: decl.default as VisibilityMode, team: undefined, collaborators: undefined } : parseInput(area, given);
  let teamId: number | null = null;
  if (ask.mode === "team") {
    if (ask.team === undefined || ask.team === null || ask.team === "") {
      // The area's default is a team and none was named: the person's one team (several: they choose).
      const keep = prev ? visibilityOf(prev).team : null;
      if (keep && (all || myTeams.some((t) => t.id === keep.id))) teamId = keep.id;
      else if (myTeams.length === 1) teamId = myTeams[0]!.id;
      else throw new PackError(myTeams.length ? `Choose the team that sees this ${area.label} record: ${myTeams.map((t) => t.name).join(", ")}.` : `You are in no team: choose who sees this ${area.label} record${decl.modes.length > 1 ? ` (${decl.modes.filter((m) => m !== "team").join(" or ")})` : ""}, or ask an owner of the workspace to add you to a team.`, 400);
    } else {
      const team = await findTeam(orgId, ask.team, tx);
      if (!team) throw new PackError(`no team ${JSON.stringify(String(ask.team).slice(0, 80))} in this workspace`, 400);
      if (!all && !myTeams.some((t) => t.id === team.id)) throw new PackError(`You are not in ${team.name}: share it with a team you are in.`, 403);
      teamId = team.id;
    }
  }
  const owner = prev ? prev.owner_id ?? null : person;
  const collaborators = ask.collaborators !== undefined ? ask.collaborators.filter((c) => c !== owner) : prev ? prev.collaborators ?? null : null;
  const w: VisibilityWrite = { visibility: ask.mode, team_id: teamId, owner_id: owner, collaborators: collaborators && collaborators.length ? collaborators : null };
  if (!all && person && !wouldSee(w, person, myTeams.map((t) => t.id)))
    throw new PackError(`You would no longer see this ${area.label} record: keep yourself in it (its owner, a collaborator or its team).`, 400);
  if (!all && !person && w.visibility !== "workspace") throw new PackError(`This caller is no person of the workspace: its ${area.label} records are open to the workspace.`, 403);
  return w;
}

/** Whether `actor` may change who sees a record (the page's Share): its owner, a lead of its team, a workspace owner. */
export async function mayShare(orgId: number, area: AreaLike, actor: Actor, v: RecordVisibility): Promise<boolean> {
  if (!visibilityShown(area) || inheritsVisibility(area.visibility)) return false; // mold_v0-262: it follows its parent's
  if (seesAll(actor)) return true;
  const person = personOf(actor);
  if (!person) return false;
  if (v.owner === person) return true;
  return v.mode === "team" && !!v.team && (await teamsOf(orgId, person)).some((t) => t.id === v.team!.id && t.role === "lead");
}
