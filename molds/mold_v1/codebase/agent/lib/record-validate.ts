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
 *     its own, the stored status and done flag the task service keeps); the move is checked against the transitions
 *     and reported in `transition` (refusing a move is the caller's choice, by `enforce`, and off by default);
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
  /** Refuse a move the lifecycle's transitions do not allow, under enforce "strict" (off until the routes say so). */
  enforceTransitions?: boolean;
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
      warnings: string[];
    }
  | { ok: false; errors: string[] };

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
    // A move is checked only from a state the caller read (an update with the stored row); a new record starts where
    // it is created.
    if (named && input.mode === "update" && before && typeof after === "string" && after !== prev) {
      transition = checkTransition(v, typeof prev === "string" ? prev : null, after, { ...before, ...columns, custom }, input);
      if (!transition.allowed) {
        const mode = v.lifecycle!.enforce;
        const sentence = transition.reasons.join(" ");
        if (mode === "strict" && input.enforceTransitions) return { ok: false, errors: [sentence] };
        if (mode !== "off") warnings.push(sentence);
      }
    }
  }
  return { ok: true, columns, customDelta, custom, derived, transition, warnings };
}

/** Is a move allowed by the transitions list, and what does it still need? Sentences name labels, never keys alone. */
export function checkTransition(
  v: ReturnType<typeof areaView>,
  from: string | null,
  to: string,
  row: AreaRow,
  who: { actor: string; role?: RecordRole },
): TransitionCheck {
  const lc = v.lifecycle!;
  const label = (s: string | null) => (s === null ? "nothing" : `"${v.display(lc.field, s)}"`);
  const ts = v.area.lifecycle?.transitions ?? [];
  if (!ts.length) return { field: lc.field, from, to, allowed: true, reasons: [] };
  const candidates = ts.filter((t) => t.to === to && (t.from === "*" || (from !== null && t.from.includes(from))));
  const reasons: string[] = [];
  for (const t of candidates) {
    const why: string[] = [];
    if (t.roles && (!who.role || !t.roles.includes(who.role))) why.push(`only ${t.roles.join(" or ")} may make it`);
    if (t.not_by && String(v.get(row, t.not_by) ?? "").toLowerCase() === who.actor.toLowerCase()) why.push(`not by the ${v.label(t.not_by).toLowerCase()}`);
    const missing = (t.requires ?? []).filter((k) => isBlank(v.get(row, k)) || (Array.isArray(v.get(row, k)) && (v.get(row, k) as unknown[]).length === 0));
    if (missing.length) why.push(`it needs ${missing.map((k) => `"${v.label(k)}"`).join(" and ")}`);
    if (!why.length) return { field: lc.field, from, to, allowed: true, reasons: [] };
    reasons.push(`${label(to)}${t.label ? ` (${t.label})` : ""}: ${why.join("; ")}.`);
  }
  const moves = lc.movesFrom(from, who.role).map((m) => `${label(m.to)}${m.transition?.label ? ` (${m.transition.label})` : ""}`);
  const head = candidates.length ? `Moving from ${label(from)} to ${label(to)} is not possible now: ${reasons.join(" ")}` : `${label(from)} cannot move to ${label(to)}.`;
  return { field: lc.field, from, to, allowed: false, reasons: [`${head} From ${label(from)} you can move to: ${moves.length ? moves.join(", ") : "nothing"}.`] };
}
