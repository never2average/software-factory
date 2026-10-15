/**
 * WHO MAY CREATE, CHANGE AND DELETE A RECORD OF AN AREA (records.areas.<area>.permissions; docs/DEPLOYMENT_PROFILE.md
 * "records"): the one rule book every write path reads, the ops routes, upsert_customer's nested rows, the agent's
 * tools and MCP (which goes through the routes), and what the screens offer.
 *
 *   create / update / delete   "*" (anyone in the workspace) or a list of roles (owner, admin, engineer, member).
 *   own: { field, may }        a person field: whoever it names may also do `may` ("update", "delete", "transition")
 *                              to THAT record, whatever their role. "transition" is a move of the lifecycle's state
 *                              alone (a task's done flag and pipeline stage are moves too).
 *   fields: { key: { update } } who may change one field (on create as on update), beside the row's own rule.
 *   read                       only "*" for now: the generator refuses anything else, so no list hides a row.
 *
 * An area that declares no permissions (every default) allows everything, exactly as before, and nothing here reads
 * anything. A role the caller cannot name (undefined) is in no list: a declared rule fails closed, "*" still allows.
 * A refusal is one plain sentence, which the routes answer with a 403.
 *
 * Pure: no database, no fetch. `areas` is a parameter so a test or a preview can pass another profile's.
 */
import { RECORD_AREAS, type RecordAreaId, type RecordRole, type RecordRoles } from "./record-areas.generated.ts";
import { areaView, type AreaRow, type AreaView, type RecordAreas } from "./record-areas.ts";

export type RecordAction = "create" | "update" | "delete";
export interface PermissionWho {
  /** The caller's role in the workspace; undefined is no role. */
  role?: RecordRole;
  /** The caller's email: what an `own` field is compared with. */
  actor: string;
}

const ROLE_WORD: Record<RecordRole, string> = { owner: "an owner", admin: "an admin", engineer: "an engineer", member: "a member" };
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

/** Does the area say anything about who may write it? False for every default: then nothing is checked. */
export function permissionsDeclared(id: RecordAreaId, areas: RecordAreas = RECORD_AREAS): boolean {
  const p = areas[id].permissions;
  if (!p) return false;
  const limits = (r: RecordRoles | undefined) => r !== undefined && r !== "*";
  return limits(p.create) || limits(p.update) || limits(p.delete) || Object.values(p.fields ?? {}).some((f) => limits(f.update));
}

/** Does a check on an update or a delete need the stored row (an `own` rule, or a field rule compared with it)? */
export function permissionsNeedRow(id: RecordAreaId, areas: RecordAreas = RECORD_AREAS): boolean {
  return permissionsDeclared(id, areas);
}

const allows = (roles: RecordRoles | undefined, role: RecordRole | undefined) => roles === undefined || roles === "*" || (role !== undefined && roles.includes(role));
/** "an owner or an admin" */
function rolesText(roles: RecordRoles): string {
  const words = (roles === "*" ? [] : roles).map((r) => ROLE_WORD[r]);
  return words.length <= 1 ? words[0] ?? "nobody" : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}
const article = (noun: string) => (/^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`);

/** Is `actor` the person the area's `own` field names on `row`? */
export function ownsRow(v: AreaView, row: AreaRow | null | undefined, actor: string): boolean {
  const key = v.area.permissions?.own?.field;
  if (!key || !row || !actor.includes("@")) return false;
  const x = v.get(row, key);
  const me = actor.trim().toLowerCase();
  return (Array.isArray(x) ? x : [x]).some((p) => typeof p === "string" && p.trim().toLowerCase() === me);
}

/** The lifecycle's keys, and the keys that move it on a task (done, status, a pipeline stage). */
function moveKeys(v: AreaView): Set<string> {
  const keys = new Set<string>();
  const lc = v.lifecycle;
  if (lc) keys.add(lc.field);
  if (v.id === "tasks" && lc && !lc.own) for (const k of ["done", "status", "stageId"]) keys.add(k);
  return keys;
}

/**
 * What an update changes, by field key: each key the body names whose value differs from the stored row's (every
 * named key when there is no stored row to compare with). `custom` is read per own key; an alias is its field. Keys
 * that are not fields (an id, an audit label, a comment) change nothing, except the record's edited title
 * (`displayName`) and a task's moves (`done`, `stageId`), which do.
 */
export function changedKeys(v: AreaView, patch: Record<string, unknown>, before: AreaRow | null | undefined): string[] {
  const out: string[] = [];
  const same = (key: string, x: unknown) => {
    if (!before) return false;
    const was = key === "displayName" ? before.displayName : v.get(before, key);
    if (blank(was) && blank(x)) return true;
    const norm = (y: unknown) => (typeof y === "string" ? y.trim().toLowerCase() : JSON.stringify(y ?? null));
    return Array.isArray(was) || Array.isArray(x) ? JSON.stringify(was ?? []) === JSON.stringify(x ?? []) : norm(was) === norm(x);
  };
  const consider = (key: string, x: unknown) => {
    if (x === undefined) return;
    if (!same(key, x)) out.push(key);
  };
  for (const [k, x] of Object.entries(patch)) {
    if (k === "custom") {
      if (isObj(x)) for (const [ck, cx] of Object.entries(x)) consider(v.field(ck)?.key ?? ck, cx);
      continue;
    }
    const f = v.field(k);
    if (f) consider(f.key, x);
    else if (k === "displayName" || (v.id === "tasks" && (k === "done" || k === "stageId"))) consider(k, x);
  }
  return out;
}

/** Is a task patch an archive (the tasks' soft delete: hide_todo, the "…" menu's delete)? */
export const archives = (id: RecordAreaId, patch: Record<string, unknown>) => id === "tasks" && patch.archived === true;

/**
 * Why `who` may not create a record of the area, or null when they may. `patch` is what the create names: a field
 * rule holds for a value given on create as for a change.
 */
export function createRefusal(id: RecordAreaId, who: PermissionWho, patch: Record<string, unknown> = {}, areas: RecordAreas = RECORD_AREAS): string | null {
  if (!permissionsDeclared(id, areas)) return null;
  const v = areaView(id, areas);
  const p = v.area.permissions!;
  if (!allows(p.create, who.role)) return `Only ${rolesText(p.create!)} can add ${article(v.noun)}.`;
  const named = changedKeys(v, patch, null).filter((k) => !blank(valueOf(v, patch, k)));
  return fieldRefusal(v, named, who);
}

function valueOf(v: AreaView, patch: Record<string, unknown>, key: string): unknown {
  if (key in patch) return patch[key];
  const f = v.field(key);
  if (f?.alias && f.alias in patch) return patch[f.alias];
  return isObj(patch.custom) ? patch.custom[key] : undefined;
}

function fieldRefusal(v: AreaView, keys: string[], who: PermissionWho): string | null {
  for (const k of keys) {
    const rule = v.area.permissions?.fields?.[k]?.update;
    if (!allows(rule, who.role)) return `Only ${rolesText(rule!)} can change "${v.label(k)}" on ${article(v.noun)}.`;
  }
  return null;
}

/**
 * Why `who` may not make this change to the stored record `before`, or null when they may. An archive (a task's
 * `archived: true`) is a delete. A change of nothing is allowed (nothing is written).
 */
export function updateRefusal(
  id: RecordAreaId,
  patch: Record<string, unknown>,
  before: AreaRow | null | undefined,
  who: PermissionWho,
  areas: RecordAreas = RECORD_AREAS,
  /** The write changes the record as a whole, whatever `patch` names (a period's rollover). */
  whole = false,
): string | null {
  if (!permissionsDeclared(id, areas)) return null;
  if (archives(id, patch)) {
    const r = deleteRefusal(id, before, who, areas);
    if (r) return r;
  }
  const v = areaView(id, areas);
  const p = v.area.permissions!;
  const changed = changedKeys(v, patch, before);
  if (!changed.length && !whole) return null;
  if (!allows(p.update, who.role)) {
    const own = ownsRow(v, before, who.actor);
    const may = p.own?.may ?? [];
    const moves = moveKeys(v);
    const onlyMoves = !whole && changed.every((k) => moves.has(k));
    const ok = own && (may.includes("update") || (onlyMoves && may.includes("transition")));
    if (!ok) return updateSentence(v, p.update!, may, onlyMoves);
  }
  return fieldRefusal(v, changed, who);
}

function updateSentence(v: AreaView, roles: RecordRoles, may: readonly string[], move: boolean): string {
  const ownKey = v.area.permissions?.own?.field;
  const whose = ownKey ? `its ${v.label(ownKey).toLowerCase()}` : "";
  if (ownKey && (may.includes("update") || (move && may.includes("transition")))) {
    return `You can ${move && !may.includes("update") ? "move" : "change"} ${article(v.noun)} only when you are ${whose}; ${rolesText(roles)} can change any.`;
  }
  if (ownKey && may.includes("transition")) return `You can only move ${article(v.noun)} you are ${whose} from one state to the next; ${rolesText(roles)} can change it.`;
  return `Only ${rolesText(roles)} can change ${article(v.noun)}.`;
}

/** Why `who` may not delete the stored record `before`, or null when they may. */
export function deleteRefusal(id: RecordAreaId, before: AreaRow | null | undefined, who: PermissionWho, areas: RecordAreas = RECORD_AREAS): string | null {
  if (!permissionsDeclared(id, areas)) return null;
  const v = areaView(id, areas);
  const p = v.area.permissions!;
  if (allows(p.delete, who.role)) return null;
  if ((p.own?.may ?? []).includes("delete") && ownsRow(v, before, who.actor)) return null;
  const ownKey = p.own?.field;
  if (ownKey && (p.own?.may ?? []).includes("delete")) return `You can delete ${article(v.noun)} only when you are its ${v.label(ownKey).toLowerCase()}; ${rolesText(p.delete!)} can delete any.`;
  return `Only ${rolesText(p.delete!)} can delete ${article(v.noun)}.`;
}

/**
 * What a screen offers `who`: the same rules, asked as yes/no. Everything is true when the area declares nothing.
 * `field(key, row)` is whether the field may be edited on that row (null row: the create form).
 */
export function recordAccess(id: RecordAreaId, who: PermissionWho, areas: RecordAreas = RECORD_AREAS) {
  const declared = permissionsDeclared(id, areas);
  const v = areaView(id, areas);
  const p = v.area.permissions ?? {};
  const own = (row: AreaRow | null | undefined) => ownsRow(v, row, who.actor);
  const may = p.own?.may ?? [];
  const fieldOk = (key: string) => allows(p.fields?.[key]?.update, who.role);
  return {
    declared,
    create: !declared || allows(p.create, who.role),
    /** May change the row's fields (beyond a move). */
    update: (row: AreaRow | null | undefined) => !declared || allows(p.update, who.role) || (may.includes("update") && own(row)),
    /** May move the row's state. */
    transition: (row: AreaRow | null | undefined) => !declared || allows(p.update, who.role) || ((may.includes("update") || may.includes("transition")) && own(row)),
    delete: (row: AreaRow | null | undefined) => !declared || allows(p.delete, who.role) || (may.includes("delete") && own(row)),
    /** May edit this field: on a row (its row rule and the field's), or on the create form (row null). */
    field: (key: string, row: AreaRow | null | undefined) => {
      if (!declared) return true;
      if (!fieldOk(key)) return false;
      if (row === null || row === undefined) return allows(p.create, who.role);
      const isMove = moveKeys(v).has(key);
      return allows(p.update, who.role) || (own(row) && (may.includes("update") || (isMove && may.includes("transition"))));
    },
  };
}
export type RecordAccess = ReturnType<typeof recordAccess>;
