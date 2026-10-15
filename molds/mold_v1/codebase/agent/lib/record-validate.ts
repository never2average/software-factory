/**
 * ONE VALIDATOR FOR EVERY WRITE to a record area (agent/lib/record-areas.ts; docs/DEPLOYMENT_PROFILE.md "records").
 *
 * Whatever writes a record (an ops API route, the agent's tools, a coding agent through MCP, which goes through the
 * API) calls validateRecordWrite() first and sends on only what it returns. It checks a write against the area's
 * compiled definition and answers in plain sentences a person and the model can act on:
 *
 *   - every key names a field of the area (or one the caller passes through untouched: an identifier, an audit label);
 *   - a value fits its field's type, choices, limits and pattern; an own field's value is put in its canonical form
 *     (numbers are numbers, dates yyyy-mm-dd, lists are lists), a column's keeps its wire format;
 *   - a computed field or one the system stamps is never written; a required one is given on create and never cleared;
 *   - hidden fixed values and defaults ({me}, {today}, {today+7d}) are filled on create;
 *   - the lifecycle: the state is one of the field's states, its category is derived (and, for a task whose states are
 *     its own, the stored status and done flag the task service keeps); a move (and a create in a state) is checked
 *     against the transitions by agent/lib/record-lifecycle.ts checkMove, the one rule book, and what happens to a
 *     move that breaks them is the lifecycle's `enforce`: "off" (the default) nothing, exactly as before; "warn" the
 *     move goes through with its stamps and `lifecycle` carries what to note; "strict" the write is refused with
 *     `conflict` (the ops API's 409 body) and a sentence naming the moves there are;
 *   - the area's own fields go out as a DELTA (key -> value, or null to clear), merged per key where they are stored,
 *     so a key the profile no longer declares is carried through untouched.
 *
 * coerceFieldValue() (agent/lib/record-values.ts) is the per-type rule; agent/lib/custom-fields.ts (the legacy own fields) uses it too, so a value
 * means the same thing wherever it is written.
 *
 * Pure: no database, no fetch, no zod. Relation checks that need a database (a referenced record exists in this
 * workspace) are the caller's.
 */
import { RECORD_AREAS, type RecordAreaId, type RecordField, type RecordRole } from "./record-areas.generated.ts";
import { areaView, CATEGORY_STATUS, type AreaRow, type RecordAreas } from "./record-areas.ts";
import { coerceFieldValue, fieldName } from "./record-values.ts";
import { checkMove, conflictBody, type LifecycleConflict, type MoveCheck } from "./record-lifecycle.ts";

export { coerceFieldValue, LONG_TEXT_MAX, realDate, TEXT_MAX, type CoercedValue, type CoercibleField } from "./record-values.ts";
const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A column's value as the API takes it: the type is checked, the wire format kept (a timestamp stays a string). */
function checkColumnValue(f: RecordField, raw: unknown): { value: unknown } | { error: string } {
  const name = fieldName(f);
  if (f.type === "pick_list") return coerceFieldValue(f, raw);
  if (f.type === "date" || f.type === "datetime") {
    if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) return { error: `${name} must be a date${f.type === "datetime" ? " and time" : ""}, for example 2026-07-31${f.type === "datetime" ? "T09:00:00Z" : ""}.` };
    return { value: raw };
  }
  if (f.type === "boolean") return typeof raw === "boolean" ? { value: raw } : { error: `${name} must be true or false.` };
  const out = coerceFieldValue({ ...f, type: f.type === "record" ? "text" : f.type }, raw);
  if ("error" in out) return out;
  // A text column keeps exactly what was sent (trimmed by the API as before); a number is a number.
  return { value: typeof out.value === "string" && typeof raw === "string" && f.type !== "person" ? raw : out.value };
}

export interface WriteInput {
  mode: "create" | "update";
  /** The stored row before an update (its columns, and `custom`); null on create. */
  before?: AreaRow | null;
  /** What the caller asked to write: field keys (or aliases), and `custom` for the area's own fields. */
  patch: Record<string, unknown>;
  /** Who writes (an email): fills {me}. */
  actor: string;
  role?: RecordRole;
  now?: Date;
  /** Keys that are not fields of the area but belong to the request (an id, an audit label): passed on untouched. */
  passThrough?: readonly string[];
  /**
   * Under enforce "strict", refuse a move the lifecycle's rules do not allow (the default). false: report it only
   * (`lifecycle`), for a caller that checks a draft rather than writes.
   */
  enforceTransitions?: boolean;
  /** The comment the write carries (a task's `reason`): what a transition with `requires_comment` needs. */
  comment?: string | null;
  /** Who moved the record into its stored state (lib/record-lifecycle-server.ts), for `not_by: "{entered_by}"`. */
  enteredBy?: string | null;
}
export interface TransitionCheck {
  field: string;
  from: string | null;
  to: string;
  /** Allowed by the transitions list (always, when it has none). */
  allowed: boolean;
  /** Why not, or what the move still needs, in sentences. */
  reasons: string[];
}
export type WriteResult =
  | {
      ok: true;
      /** Column fields and passed-through keys, as the API takes them. */
      columns: Record<string, unknown>;
      /** The area's own fields that change: a value, or null to clear. Empty when none. */
      customDelta: Record<string, unknown>;
      /** The own fields as the record holds them after the write (stored ones carried through). */
      custom: Record<string, unknown>;
      /** What the write implies: the lifecycle state's category; for a task with its own states, the status and done flag. */
      derived: { category?: string; status?: string; done?: boolean };
      transition: TransitionCheck | null;
      /**
       * The move this write makes, checked against the lifecycle's rules (agent/lib/record-lifecycle.ts), when the
       * lifecycle is enforced ("warn" or "strict") and the write moves the state or creates a record in one; else null.
       * The caller writes moveEvent (and, when not allowed, warnEvent) to the activity feed once the write landed.
       */
      lifecycle: MoveCheck | null;
      warnings: string[];
    }
  | { ok: false; errors: string[]; conflict?: LifecycleConflict };

const today = (now: Date, days = 0) => new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
function resolveDefault(f: RecordField, actor: string, now: Date): unknown {
  const d = f.default;
  if (typeof d !== "string" || !d.startsWith("{")) return d;
  if (d === "{me}") return actor;
  const m = /^\{today(?:([+-]\d{1,3})d)?\}$/.exec(d);
  if (m) {
    const day = today(now, m[1] ? Number(m[1]) : 0);
    return f.type === "datetime" || f.column ? `${day}T09:00:00.000Z` : day;
  }
  return undefined; // {account.owner}: the caller fills it (it needs the account)
}

/** Validate one write to an area. See the file's header. */
export function validateRecordWrite(areaId: RecordAreaId, input: WriteInput, areas: RecordAreas = RECORD_AREAS): WriteResult {
  const v = areaView(areaId, areas);
  const now = input.now ?? new Date();
  const errors: string[] = [];
  const warnings: string[] = [];
  const columns: Record<string, unknown> = {};
  const customDelta: Record<string, unknown> = {};
  const pass = new Set(input.passThrough ?? []);
  const before = input.before ?? null;
  const storedCustom: Record<string, unknown> = isObj(before?.custom) ? { ...before.custom } : {};
  const stamped = new Set(["doneAt", "createdBy", "createdAt", "updatedAt"]);
  const lc = v.area.lifecycle ?? null;
  const ownLifecycle = Boolean(lc && v.field(lc.field) && !v.field(lc.field)!.column);
  const fieldsList = () => v.visibleFields.filter((f) => !f.computed).map((f) => `\`${f.key}\``).join(", ");

  const put = (f: RecordField, raw: unknown) => {
    if (f.computed) { errors.push(`${fieldName(f)} is computed from the record's other fields; it is never set.`); return; }
    if (f.column && stamped.has(f.key) && !pass.has(f.key)) { errors.push(`${fieldName(f)} is stamped by the system; it is never set.`); return; }
    if (f.hidden && f.fixed !== undefined && !isBlank(raw) && JSON.stringify(raw) !== JSON.stringify(f.fixed)) { errors.push(`${fieldName(f)} is not used here; it always holds ${JSON.stringify(f.fixed)}.`); return; }
    if (isBlank(raw) || (Array.isArray(raw) && raw.length === 0)) {
      if (f.required === true && input.mode === "update") errors.push(`${fieldName(f)} is required, so it cannot be cleared.`);
      else if (f.column) columns[f.key] = null;
      else customDelta[f.key] = null;
      return;
    }
    const out = f.column ? checkColumnValue(f, raw) : coerceFieldValue(f, raw);
    if ("error" in out) errors.push(out.error);
    else if (f.column) columns[f.key] = out.value;
    else customDelta[f.key] = out.value;
  };

  for (const [key, raw] of Object.entries(input.patch)) {
    if (key === "custom") {
      if (raw === undefined || raw === null) continue;
      if (!isObj(raw)) { errors.push("`custom` must be an object that maps a field key to its value."); continue; }
      for (const [k, x] of Object.entries(raw)) {
        const f = v.field(k);
        if (f && !f.column) put(f, x);
        else if (!f && isBlank(x) && input.mode === "update" && k in storedCustom) customDelta[k] = null; // a stored key no longer declared may be cleared
        else errors.push(v.ownFields.length ? `There is no own field "${k}" here. The own fields are: ${v.ownFields.filter((o) => !o.hidden).map((o) => `\`${o.key}\``).join(", ")}.` : `There is no own field "${k}" here: this kind of record declares none.`);
      }
      continue;
    }
    const f = v.field(key);
    if (f) { put(f, raw); continue; }
    if (pass.has(key)) { columns[key] = raw; continue; }
    errors.push(`There is no field "${key}" here. Its fields are: ${fieldsList()}.`);
  }

  // A task whose states are its own: its status follows the state, so a write names the state, not the status.
  if (ownLifecycle && areaId === "tasks") {
    for (const k of ["status", "done"]) if (k in input.patch) errors.push(`\`${k}\` follows \`custom.${lc!.field}\` here; set the state instead (${v.lifecycle!.states.filter((s) => !s.retired).map((s) => JSON.stringify(s.value)).join(", ")}).`);
  }

  if (input.mode === "create") {
    for (const f of v.fields) {
      const given = f.column ? f.key in columns : f.key in customDelta;
      if (given || f.computed) continue;
      if (f.hidden && f.fixed !== undefined) { if (f.column) columns[f.key] = f.fixed; else customDelta[f.key] = f.fixed; continue; }
      if (lc && f.key === lc.field && v.lifecycle!.initial && (ownLifecycle || f.required === true)) { if (f.column) columns[f.key] = v.lifecycle!.initial; else customDelta[f.key] = v.lifecycle!.initial; continue; }
      if ("default" in f) {
        const d = resolveDefault(f, input.actor, now);
        if (d !== undefined && !isBlank(d)) { if (f.column) columns[f.key] = d; else customDelta[f.key] = d; continue; }
      }
      if ((f.required === true || f.required === "on_create") && !f.hidden && !stamped.has(f.key)) errors.push(`${fieldName(f)} is required.`);
    }
  }
  if (errors.length) return { ok: false, errors };

  const custom: Record<string, unknown> = { ...storedCustom };
  for (const [k, x] of Object.entries(customDelta)) {
    if (x === null) delete custom[k];
    else custom[k] = x;
  }

  // The lifecycle: the state after the write, its category, the move.
  const derived: { category?: string; status?: string; done?: boolean } = {};
  let transition: TransitionCheck | null = null;
  let lifecycle: MoveCheck | null = null;
  if (lc) {
    const own = ownLifecycle;
    const named = own ? lc.field in customDelta : lc.field in columns;
    const after = own ? custom[lc.field] : named ? columns[lc.field] : before ? before[lc.field] : undefined;
    const prev = before ? (own ? storedCustom[lc.field] : before[lc.field]) : null;
    const category = v.lifecycle!.categoryOf(after);
    if (category && (named || input.mode === "create")) {
      derived.category = category;
      if (own && areaId === "tasks") {
        derived.status = CATEGORY_STATUS[category];
        derived.done = category === "done";
      }
    }
    const mode = v.lifecycle!.enforce;
    // A move is checked from a state the caller read (an update with the stored row); a create, from nothing, unless it
    // starts where every record starts (its initial state: nothing to check, nothing to note).
    const moves = named && typeof after === "string" && (input.mode === "update" ? Boolean(before) && after !== prev : after !== v.lifecycle!.initial);
    if (moves) {
      const from = input.mode === "update" && typeof prev === "string" ? prev : null;
      const row: AreaRow = { ...(before ?? {}), ...columns, custom };
      const check = checkMove(v, { from, to: after as string, row, before, actor: input.actor, role: input.role, comment: input.comment, enteredBy: input.enteredBy, now });
      if (input.mode === "update") transition = { field: lc.field, from, to: after as string, allowed: check.allowed, reasons: check.allowed ? [] : [check.sentence] };
      if (mode !== "off") {
        if (!check.allowed && mode === "strict" && input.enforceTransitions !== false) return { ok: false, errors: [check.sentence], conflict: conflictBody(check) };
        if (!check.allowed) warnings.push(check.sentence);
        // The move's stamps (`set`): written with it, under warn as under strict. Never under "off".
        for (const [k, x] of Object.entries(check.stamp)) {
          const f = v.field(k);
          if (!f) continue;
          if (f.column) columns[f.key] = x;
          else {
            customDelta[f.key] = x;
            custom[f.key] = x;
          }
        }
        lifecycle = check;
      }
    }
  }
  return { ok: true, columns, customDelta, custom, derived, transition, lifecycle, warnings };
}

/** Is a move allowed by the transitions list, and what does it still need? (agent/lib/record-lifecycle.ts checkMove.) */
export function checkTransition(
  v: ReturnType<typeof areaView>,
  from: string | null,
  to: string,
  row: AreaRow,
  who: { actor: string; role?: RecordRole; comment?: string | null; enteredBy?: string | null },
): TransitionCheck {
  const c = checkMove(v, { from, to, row, before: null, actor: who.actor, role: who.role, comment: who.comment, enteredBy: who.enteredBy });
  return { field: c.field, from, to, allowed: c.allowed, reasons: c.allowed ? [] : [c.sentence] };
}
