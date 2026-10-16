/**
 * THE PERIODS AS A RECORD AREA (profiles `records.areas.periods` stated in the record-area form, compiled with
 * `declared: true`; docs/DEPLOYMENT_PROFILE.md "records"). A pack can then make a period whatever bounded container its
 * work comes in (a "Regulatory filing": a fixed set of obligations due together), with:
 *
 *   - its OWN FIELDS, stored in `cycles.custom` (drizzle/0045_cycles_custom.sql) and merged per key;
 *   - its own STATES, each with a category (backlog, open, active, blocked, done, cancelled), in place of the three the
 *     base product stores (planning, active, closed). Stored values are never rewritten: a profile keeps the three it
 *     has rows in and adds its own, or maps a retired spelling with `legacy_values`;
 *   - every write (the ops routes, the agent's upsert_cycle) checked by the one validator (agent/lib/record-validate.ts):
 *     types, choices, required fields, the lifecycle (#175/#177) and who may (#180).
 *
 * Base code branches on a state's CATEGORY, never on its name: the system's rollover opens a period in the initial
 * state, starts the current one in its first "active" state, and closes an ended one in a "done" state, by the
 * declared transitions where they lead there.
 *
 * A profile that does not declare the area (the default, a legacy `work_periods`, both live packs' fixtures) reads the
 * literal three states, carries no `custom` on the wire, and every caller takes the path it always took.
 *
 * Pure: no database, no fetch (agent/lib/period-area-store.ts is the database half).
 */
import { RECORD_AREAS, type RecordRole } from "./record-areas.generated.ts";
import { areaView, type AreaRow, type AreaView, type RecordAreas, type RecordCategory } from "./record-areas.ts";
import { validateRecordWrite, type TransitionCheck } from "./record-validate.ts";
import { warningOf, type LifecycleConflict, type MoveCheck, type WriteWarning } from "./record-lifecycle.ts";
import { createRefusal, updateRefusal } from "./record-permissions.ts";

/** The three states the cycles table has always stored, as the default profile names them. */
export const DEFAULT_PERIOD_STATES = ["planning", "active", "closed"] as const;

/** Is the periods area drawn from its definition here: stated in the record-area form, and periods on? */
export function periodDeclared(areas: RecordAreas = RECORD_AREAS): boolean {
  const a = areas.periods;
  return Boolean(a.declared) && a.enabled && a.period?.mode !== "off";
}

export interface PeriodStates {
  /** Every state a period may be written in, in order (retired ones aside). */
  values: string[];
  /** Where a new period starts. */
  initial: string;
  /** The state the period that has begun is moved into (the first whose category is "active"); null when none. */
  active: string | null;
  /** A state that finishes a period (the first whose category is "done"). */
  done: string;
  /** Is a period in this state finished (category done or cancelled)? */
  isClosed: (state: unknown) => boolean;
  /** Is a period in this state not started yet (category open or backlog)? */
  notStarted: (state: unknown) => boolean;
}

const DEFAULT_STATES: PeriodStates = {
  values: [...DEFAULT_PERIOD_STATES],
  initial: "planning",
  active: "active",
  done: "closed",
  isClosed: (s) => s === "closed",
  notStarted: (s) => s === "planning",
};

/** The states the system moves a period through: the declared ones by category, else today's three. */
export function periodStates(areas: RecordAreas = RECORD_AREAS): PeriodStates {
  if (!periodDeclared(areas)) return DEFAULT_STATES;
  const v = areaView("periods", areas);
  const lc = v.lifecycle;
  if (!lc) return DEFAULT_STATES;
  const live = lc.states.filter((s) => !s.retired);
  const of = (c: RecordCategory) => live.find((s) => s.category === c)?.value ?? null;
  const cat = (s: unknown) => lc.categoryOf(s);
  return {
    values: live.map((s) => s.value),
    initial: lc.initial ?? live[0]?.value ?? "planning",
    active: of("active"),
    done: of("done") ?? live.at(-1)?.value ?? "closed",
    isClosed: (s) => cat(s) === "done" || cat(s) === "cancelled",
    notStarted: (s) => cat(s) === "open" || cat(s) === "backlog",
  };
}

/**
 * The state the system moves a period into from `from` to reach `category` (closing an ended period: "done"; starting
 * the one that has begun: "active"): a declared transition out of `from` that leads to such a state, else the first
 * state of that category. Under the default, today's literal.
 */
export function systemTarget(from: string, category: "done" | "active", areas: RecordAreas = RECORD_AREAS): string | null {
  const st = periodStates(areas);
  if (!periodDeclared(areas)) return category === "done" ? st.done : st.active;
  const v = areaView("periods", areas);
  const lc = v.lifecycle!;
  const via = (v.area.lifecycle?.transitions ?? []).find((t) => (t.from === "*" || t.from.includes(from)) && t.to !== from && lc.categoryOf(t.to) === category && !lc.states.find((s) => s.value === t.to)?.retired);
  return via?.to ?? (category === "done" ? st.done : st.active);
}

/**
 * A stored period as the API and the tools answer it: under a declared area with its own fields under `custom`; under
 * any other profile exactly the row it always was (no `custom`), so its wire and its model surface do not move.
 */
export function periodOut<T extends Record<string, unknown>>(row: T, areas: RecordAreas = RECORD_AREAS): T {
  if (!row || typeof row !== "object") return row;
  const { custom, ...rest } = row as T & { custom?: unknown };
  if (!periodDeclared(areas)) return rest as T;
  return { ...rest, custom: custom && typeof custom === "object" && !Array.isArray(custom) ? custom : {} } as unknown as T;
}

/** Request keys that are not fields of a period: who writes (the routes' audit label, the row's filer) and a move's comment. */
export const PERIOD_PASS_THROUGH: readonly string[] = ["actor", "createdBy", "reason"];

/** A per-key change of `cycles.custom` (agent/lib/custom-merge-sql.ts): set and clear, never append here. */
export interface PeriodCustomDelta { set: Record<string, unknown>; clear: string[]; append: Record<string, string> }

export type PreparedPeriodWrite =
  | {
      ok: true;
      /** The columns to write, by key: a date or time field as a Date (the cycles table's timestamps). */
      columns: Record<string, unknown>;
      /** The own fields that change; null when the write names none. */
      customDelta: PeriodCustomDelta | null;
      /** A new period's whole `custom`. */
      custom: Record<string, unknown>;
      /** The own fields as the period holds them after the write (the stored ones carried through). */
      customAfter: Record<string, unknown>;
      warnings: WriteWarning[];
      transition: TransitionCheck | null;
      /** The move, checked by the lifecycle's rules, when it is enforced (for the activity feed); else null. */
      lifecycle: MoveCheck | null;
    }
  | { ok: false; errors: string[]; conflict?: LifecycleConflict; forbidden?: true };

export interface PeriodWho {
  actor: string;
  role?: RecordRole;
  now?: Date;
  /** The stored period (its columns by key, and `custom`), on an update. */
  before?: AreaRow | null;
  /** Who moved the stored period into its state, for a four-eyes move. */
  enteredBy?: string | null;
  /** false: leave who-may to the API (a screen's own pre-check, which does not know the caller's role). */
  checkPermissions?: boolean;
}

/**
 * One write to a declared period, checked against its definition: `body` is what the caller sent (field keys or their
 * aliases, `custom` for own fields, and PERIOD_PASS_THROUGH). A create starts in the lifecycle's initial state unless it
 * names one (and a strict lifecycle then checks that move). Pure.
 */
export function preparePeriodWrite(mode: "create" | "update", body: Record<string, unknown>, who: PeriodWho, areas: RecordAreas = RECORD_AREAS): PreparedPeriodWrite {
  const v = areaView("periods", areas);
  if (who.checkPermissions !== false) {
    const refusal = mode === "create" ? createRefusal("periods", who, body, areas) : updateRefusal("periods", body, who.before, who, areas);
    if (refusal) return { ok: false, errors: [refusal], forbidden: true };
  }
  const patch: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(body)) if (!PERIOD_PASS_THROUGH.includes(k) && x !== undefined) patch[k] = x;
  const lc = v.lifecycle;
  if (mode === "create" && lc && !(lc.field in patch) && lc.initial) patch[lc.field] = lc.initial;
  const comment = typeof body.reason === "string" ? body.reason : null;
  const r = validateRecordWrite("periods", { mode, before: who.before ?? null, patch, actor: who.actor, role: who.role, now: who.now, comment, enteredBy: who.enteredBy }, areas);
  if (!r.ok) return { ok: false, errors: r.errors, ...(r.conflict ? { conflict: r.conflict } : {}) };
  const columns: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(r.columns)) {
    const f = v.field(k);
    columns[k] = f?.column && (f.type === "date" || f.type === "datetime") && typeof x === "string" ? new Date(x) : x;
  }
  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  for (const [k, x] of Object.entries(r.customDelta)) {
    if (x === null) clear.push(k);
    else set[k] = x;
  }
  const lifecycle = r.lifecycle ?? null;
  return {
    ok: true,
    columns,
    customDelta: Object.keys(set).length || clear.length ? { set, clear, append: {} } : null,
    custom: { ...set },
    customAfter: r.custom,
    warnings: lifecycle && lifecycle.enforce === "warn" && !lifecycle.allowed ? [warningOf(lifecycle)] : [],
    transition: r.transition,
    lifecycle,
  };
}

/** The fields of a declared period a write may set (visible, not computed, not stamped), in order. */
export function writablePeriodFields(v: AreaView = areaView("periods")) {
  const stamped = new Set(["createdBy", "createdAt", "updatedAt"]);
  return v.visibleFields.filter((f) => !f.computed && !stamped.has(f.key));
}

/** A stored period as the rule book reads it: its columns by key (timestamps as ISO text), its own fields under `custom`. */
export function periodRow(row: Record<string, unknown>): AreaRow {
  const out: AreaRow = {};
  for (const [k, x] of Object.entries(row)) out[k] = x instanceof Date ? x.toISOString() : x;
  out.custom = row.custom && typeof row.custom === "object" && !Array.isArray(row.custom) ? (row.custom as Record<string, unknown>) : {};
  return out;
}

/** What the activity feed has always called a period's columns, for a field the definition gives no label. */
const BUILT_IN_LABEL: Record<string, string> = { name: "Name", startsAt: "Starts", endsAt: "Ends", state: "State", goal: "Goal", lead: "Lead", capacity: "Capacity" };

/**
 * The activity lines a declared period's write leaves besides its move: each field it changed, by the definition's
 * label, as a person reads the value (the state included, as it always was; an enforced lifecycle's move line is
 * written beside it).
 */
export function periodChanges(before: AreaRow, after: AreaRow, keys: readonly string[], areas: RecordAreas = RECORD_AREAS): { label: string; before: string; after: string }[] {
  const v = areaView("periods", areas);
  const out: { label: string; before: string; after: string }[] = [];
  for (const key of keys) {
    const f = v.field(key);
    if (!f) continue;
    const shown = (row: AreaRow) => {
      const x = v.get(row, f.key);
      if (typeof x === "string" && (f.type === "date") && /^\d{4}-\d{2}-\d{2}T/.test(x)) return x.slice(0, 10);
      return v.display(f.key, x);
    };
    out.push({ label: v.label(f.key, BUILT_IN_LABEL[f.key] ?? f.key), before: shown(before), after: shown(after) });
  }
  return out;
}
