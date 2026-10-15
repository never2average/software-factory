/**
 * WHAT THE TASKS VIEW READS OFF ITS DEFINITION BEYOND THE WORDS AND STATES (profiles records.areas.tasks;
 * agent/lib/record-areas.ts): the views it offers, its filter presets and field filters, its metrics, the fields its
 * cards carry, and, under a strict lifecycle, the board moves it forbids and why.
 *
 * Every answer comes from what the definition DECLARES, so the default definition (board, table and timeline; no
 * presets, no field filters, no metrics; due date and assignee on a card; lifecycle off) gives back exactly today's
 * view. Base code branches on categories, field types and the declared keys, never on a value a profile chose.
 *
 * Pure: no React, no fetch. The panel (./todos-panel.tsx) and its pieces (./task-area-parts.tsx) call it.
 */
import type { AreaRow, AreaView, RecordCategory, RecordRole } from "@/agent/lib/record-areas";
import type { WriteExtras } from "@/agent/lib/record-lifecycle";
import type { ViewMode } from "./workspace-views";

/* --------------------------------- views ---------------------------------- */

/** A declared view as the switcher's mode. A view this panel does not draw yet (calendar) is not offered. */
const VIEW_MODE: Record<string, ViewMode> = { board: "kanban", table: "table", timeline: "timeline" };
const ALL_MODES: readonly ViewMode[] = ["kanban", "table", "timeline"];

/** The views to offer, in the declared order, and the one to open on (the declared default when it is offered). */
export function taskViewModes(v: AreaView): { modes: ViewMode[]; initial: ViewMode } {
  const declared = v.area.views?.available;
  const modes = declared ? [...new Set(declared.flatMap((k) => (VIEW_MODE[k] ? [VIEW_MODE[k]] : [])))] : [...ALL_MODES];
  const list = modes.length ? modes : [...ALL_MODES];
  const wanted = VIEW_MODE[v.area.views?.default ?? "board"];
  return { modes: list, initial: wanted && list.includes(wanted) ? wanted : list[0] };
}

/** The timeline's bar: the declared start and end fields (the default's: created to due). */
export function timelineRange(v: AreaView, row: AreaRow): { start: string | null; end: string | null } {
  const t = v.area.views?.timeline ?? {};
  const str = (x: unknown) => (typeof x === "string" && x ? x : null);
  const start = str(v.get(row, t.start ?? "createdAt")) ?? str(row.createdAt);
  return { start, end: str(v.get(row, t.end ?? "dueAt")) ?? start };
}

/* ------------------------------ dates, values ----------------------------- */

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** A stored date or date-time as its day (yyyy-mm-dd), or null. */
function dayOf(x: unknown): string | null {
  if (typeof x !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(x)) return null;
  return x.slice(0, 10);
}
const blank = (x: unknown) => x === null || x === undefined || (typeof x === "string" && x.trim() === "") || (Array.isArray(x) && x.length === 0);

/** What a `where` and a preset are read against: the moment, who is signed in, a row's state and whether it is closed. */
export type TaskReadContext = {
  readonly now: number;
  readonly me?: string;
  /** The row's lifecycle state (its own field or its status; the initial one when none is stored). */
  readonly stateOf: (row: AreaRow) => string | null;
  /** The period the team is in now (work periods), for `this_period`. */
  readonly currentPeriodId?: string | null;
};

/** A token of a `where` value, resolved: {today}, {today+Nd}, {today-Nd}, {now}, {me}. */
function resolveToken(x: unknown, ctx: TaskReadContext): unknown {
  if (typeof x !== "string" || !x.startsWith("{")) return x;
  if (x === "{me}") return ctx.me?.toLowerCase() ?? null;
  if (x === "{now}") return new Date(ctx.now).toISOString();
  const m = /^\{today(?:([+-]\d{1,4})d)?\}$/.exec(x);
  return m ? isoDay(ctx.now + (m[1] ? Number(m[1]) : 0) * DAY) : x;
}

/** Order two values: days when the operand is a day, numbers as numbers, else as text. null when either is unset. */
function compare(a: unknown, b: unknown): number | null {
  if (blank(a) || blank(b)) return null;
  const bd = typeof b === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b) ? b : null;
  if (bd) {
    const ad = dayOf(a);
    return ad === null ? null : ad < bd ? -1 : ad > bd ? 1 : 0;
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  const an = Number(a);
  const bn = Number(b);
  if (typeof b === "number" && Number.isFinite(an)) return an - bn;
  return String(a).localeCompare(String(b));
}

const same = (a: unknown, b: unknown) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Does a row satisfy a definition's `where` (a metric's count, a reminder's `unless`)? Every key must hold. */
export function matchesWhere(v: AreaView, row: AreaRow, where: Record<string, unknown> | undefined, ctx: TaskReadContext): boolean {
  if (!where) return true;
  const lcField = v.lifecycle?.field;
  for (const [key, cond] of Object.entries(where)) {
    const raw = key === lcField ? ctx.stateOf(row) : v.get(row, key);
    const values = Array.isArray(raw) ? raw : [raw];
    const canon = (x: unknown) => (typeof x === "string" ? v.canonical(key, x) : x);
    if (cond === null || typeof cond !== "object" || Array.isArray(cond)) {
      const want = resolveToken(cond, ctx);
      if (!values.some((x) => same(canon(x), want))) return false;
      continue;
    }
    for (const [op, operand] of Object.entries(cond as Record<string, unknown>)) {
      const val = resolveToken(operand, ctx);
      const list = Array.isArray(val) ? val.map((x) => resolveToken(x, ctx)) : [val];
      let ok: boolean;
      switch (op) {
        case "eq": ok = values.some((x) => same(canon(x), val)); break;
        case "ne": ok = !values.some((x) => same(canon(x), val)); break;
        case "in": ok = values.some((x) => list.some((y) => same(canon(x), y))); break;
        case "not_in": ok = !values.some((x) => list.some((y) => same(canon(x), y))); break;
        case "lt": case "lte": case "gt": case "gte": {
          const c = compare(raw, val);
          ok = c !== null && (op === "lt" ? c < 0 : op === "lte" ? c <= 0 : op === "gt" ? c > 0 : c >= 0);
          break;
        }
        case "set": ok = Boolean(val) === !blank(raw); break;
        case "category": {
          const cats = (Array.isArray(operand) ? operand : [operand]) as RecordCategory[];
          const c = v.lifecycle?.categoryOf(key === lcField ? ctx.stateOf(row) : raw) ?? null;
          ok = c !== null && cats.includes(c);
          break;
        }
        default: ok = true;
      }
      if (!ok) return false;
    }
  }
  return true;
}

/** Is the row finished (its state's category done or cancelled)? */
function closedRow(v: AreaView, row: AreaRow, ctx: TaskReadContext): boolean {
  const c = v.lifecycle?.categoryOf(ctx.stateOf(row)) ?? null;
  return c === "done" || c === "cancelled";
}

/* --------------------------------- filters -------------------------------- */

export type TaskPreset = "overdue" | "due_7d" | "due_30d" | "this_period" | "mine" | "unassigned";
const PRESET_LABEL: Record<TaskPreset, string> = {
  overdue: "Overdue",
  due_7d: "Due in 7 days",
  due_30d: "Due in 30 days",
  this_period: "This period",
  mine: "Mine",
  unassigned: "Unassigned",
};

/** One facet of the toolbar's Filter, from the definition: a field's presets, or a field's values. */
export type TaskFilterFacet = {
  readonly id: string;
  readonly label: string;
  readonly options: readonly { value: string; label: string }[];
  /** Does a row pass when `selected` (never empty) is picked? Any of them. */
  readonly passes: (row: AreaRow, selected: readonly string[]) => boolean;
};

/** Does a row pass one preset on a date (or person) field? */
function presetPasses(v: AreaView, row: AreaRow, field: string, preset: TaskPreset, ctx: TaskReadContext): boolean {
  const today = isoDay(ctx.now);
  const dateField = ["date", "datetime"].includes(v.field(field)?.type ?? "") ? field : "dueAt";
  const personField = v.field(field)?.type === "person" ? field : "assignee";
  switch (preset) {
    case "overdue": {
      const d = dayOf(v.get(row, dateField));
      return d !== null && d < today && !closedRow(v, row, ctx);
    }
    case "due_7d":
    case "due_30d": {
      const d = dayOf(v.get(row, dateField));
      const until = isoDay(ctx.now + (preset === "due_7d" ? 7 : 30) * DAY);
      return d !== null && d >= today && d <= until && !closedRow(v, row, ctx);
    }
    case "this_period":
      return Boolean(ctx.currentPeriodId) && row.cycleId === ctx.currentPeriodId;
    case "mine": {
      const p = v.get(row, personField);
      return Boolean(ctx.me) && (Array.isArray(p) ? p : [p]).some((x) => same(x, ctx.me));
    }
    case "unassigned":
      return blank(v.get(row, personField));
  }
}

/**
 * The definition's filters as the toolbar's facets: each field with presets (overdue, due in 7 or 30 days, this
 * period, mine, unassigned) a facet of them; each other field a facet of its values (its choices, else the values the
 * rows carry). A `scope: "people"` filter is the toolbar's Scope facet, already there. None declared: none.
 */
export function taskFilterFacets(
  v: AreaView,
  rows: readonly AreaRow[],
  ctx: TaskReadContext,
  words: { periodLabel?: string | null } = {},
): TaskFilterFacet[] {
  const out: TaskFilterFacet[] = [];
  for (const f of v.filters) {
    if (!f.field || f.scope === "people") continue;
    const key = f.field;
    if (f.presets?.length) {
      const presets = f.presets.filter((p) => p !== "this_period" || words.periodLabel) as TaskPreset[];
      if (!presets.length) continue;
      out.push({
        id: `preset:${key}`,
        label: v.label(key, key),
        options: presets.map((p) => ({ value: p, label: p === "this_period" ? `This ${words.periodLabel!.toLowerCase()}` : PRESET_LABEL[p] })),
        passes: (row, selected) => selected.some((p) => presetPasses(v, row, key, p as TaskPreset, ctx)),
      });
      continue;
    }
    const isState = key === v.lifecycle?.field;
    const valueOf = (row: AreaRow): unknown[] => {
      const x = isState ? ctx.stateOf(row) : v.get(row, key);
      return (Array.isArray(x) ? x : [x]).filter((y) => !blank(y)).map((y) => (typeof y === "string" ? v.canonical(key, y) : y));
    };
    const choices = v.options(key);
    const options = choices.length
      ? choices.map((o) => ({ value: o.value, label: o.label }))
      : [...new Set(rows.flatMap((r) => valueOf(r).map(String)))].sort((a, b) => a.localeCompare(b)).map((x) => ({ value: x, label: v.display(key, x) || x }));
    if (!options.length) continue;
    out.push({
      id: `field:${key}`,
      label: v.label(key, key),
      options,
      passes: (row, selected) => valueOf(row).some((x) => selected.includes(String(x))),
    });
  }
  return out;
}

/* --------------------------------- metrics -------------------------------- */

export type TaskMetric = {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly text: string;
  /** The definition flags it (`attention`) and it is not zero: it asks to be looked at. */
  readonly attention: boolean;
};

/** The definition's metrics over `rows`: a count, a ratio (as a percent) or a sum, formatted as it says. */
export function taskMetrics(v: AreaView, rows: readonly AreaRow[], ctx: TaskReadContext): TaskMetric[] {
  return (v.area.metrics ?? []).map((m) => {
    let value = 0;
    if (m.ratio) {
      const den = rows.filter((r) => matchesWhere(v, r, m.ratio!.den, ctx));
      const num = den.filter((r) => matchesWhere(v, r, m.ratio!.num, ctx));
      value = den.length ? (num.length / den.length) * 100 : 0;
    } else if (m.sum) {
      const key = m.sum.field ?? "";
      value = rows.filter((r) => matchesWhere(v, r, m.sum!.where, ctx)).reduce((s, r) => s + (Number(v.get(r, key)) || 0), 0);
    } else {
      const where = m.count?.where;
      value = rows.filter((r) => matchesWhere(v, r, where, ctx)).length;
    }
    const format = m.format ?? (m.ratio ? "percent" : "count");
    const currency = m.sum?.field ? v.field(m.sum.field)?.currency : undefined;
    const text =
      format === "percent" ? `${Math.round(value)}%`
      : format === "money" ? `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ""}`
      : value.toLocaleString("en-US");
    return { id: m.id, label: m.label, value, text, attention: Boolean(m.attention) && value > 0 };
  });
}

/* ---------------------------------- cards --------------------------------- */

/** The keys a card shows on its own today, beside the definition's meta: everything else is a field chip. */
const CARD_BUILT_IN = new Set(["title", "dueAt", "assignee", "priority", "cycleId", "containerId", "containerLabel"]);

/** What the definition puts on a card: its title field, whether due and assignee show, the badge, the other fields. */
export function taskCardSpec(v: AreaView) {
  const card = v.board?.card ?? {};
  const meta = card.meta ?? ["dueAt", "assignee"];
  const badge = card.badge ?? "priority";
  return {
    titleKey: card.title ?? "title",
    showDue: meta.includes("dueAt"),
    showAssignee: meta.includes("assignee"),
    /** The priority badge as today's card draws it (the definition's badge is the priority). */
    priorityBadge: badge === "priority",
    /** Fields shown as chips, in order: a badge that is not the priority first, then the other meta fields. */
    chips: [...(badge !== "priority" ? [badge] : []), ...meta.filter((k) => !CARD_BUILT_IN.has(k) && k !== badge)],
  };
}

/** A card's chips for a row: each chip field's value as a person reads it, skipped when unset. */
export function taskCardChips(v: AreaView, keys: readonly string[], row: AreaRow, stateOf: (row: AreaRow) => string | null) {
  return keys.flatMap((key) => {
    const raw = key === v.lifecycle?.field ? stateOf(row) : v.get(row, key);
    const text = v.display(key, raw);
    return text ? [{ key, label: v.label(key, key), text, tone: v.tone(key, raw) }] : [];
  });
}

/* ---------------------------------- moves --------------------------------- */

/** What the Tasks view knows about a move before it is sent: whether it is refused here, and whether it needs a reason. */
export type ClientMove = {
  /** Why a STRICT lifecycle refuses it, as a sentence (greyed out, never sent); null when it may be made. */
  readonly blocked: string | null;
  /** The transition it is made by needs a comment: the view asks for one and sends it as the write's `reason`. */
  readonly needsComment: boolean;
  /** The transition's label ("Not applicable"), for the question. */
  readonly action: string | null;
};
const FREE: ClientMove = { blocked: null, needsComment: false, action: null };

/**
 * A move of `row` from `from` to `to` as the API's rule book reads it (agent/lib/record-lifecycle.ts checkMove), so the
 * view offers only what the server takes: a listed transition; its `roles` (when the caller's role is known); `not_by`
 * a person field holding the caller; `requires` fields still blank after the move's `set`. `requires_comment` never
 * refuses here: the view asks for the reason. Who entered the state (`{entered_by}`) is the server's to know, and the
 * server stays the authority (a refusal still answers 409).
 *
 * Under "off" nothing is read. Under "warn" nothing is refused (the API answers a warning), but a move whose
 * transition needs a comment still asks for one. Under "strict" a move no transition allows is `blocked`.
 */
export function clientMove(
  v: AreaView,
  row: AreaRow,
  from: string | null,
  to: string,
  who: { me?: string; role?: RecordRole } = {},
): ClientMove {
  const lc = v.lifecycle;
  const ts = v.area.lifecycle?.transitions ?? [];
  if (!lc || lc.enforce === "off" || !ts.length || from === to) return FREE;
  const strict = lc.enforce === "strict";
  const label = (s: string | null) => (s === null ? "nothing" : `"${v.display(lc.field, s)}"`);
  const candidates = ts.filter((t) => t.to === to && (t.from === "*" || (from !== null && t.from.includes(from))));
  if (!candidates.length) return strict ? { ...FREE, blocked: `${label(from)} cannot move to ${label(to)}.` } : FREE;
  const reasons: string[] = [];
  const passing: typeof candidates = [];
  for (const t of candidates) {
    const why: string[] = [];
    if (t.roles && who.role && !t.roles.includes(who.role)) why.push(`only ${t.roles.join(" or ")} may make it`);
    if (t.not_by && t.not_by !== "{entered_by}" && who.me) {
      const people = v.get(row, t.not_by);
      if ((Array.isArray(people) ? people : [people]).some((p) => same(p, who.me))) why.push(`not by the ${v.label(t.not_by, t.not_by).toLowerCase()}`);
    }
    const set = t.set ?? {};
    const missing = (t.requires ?? []).filter((k) => blank(set[k]) && blank(v.get(row, k)));
    if (missing.length) why.push(`it needs ${missing.map((k) => `"${v.label(k, k)}"`).join(" and ")}`);
    if (why.length) reasons.push(`${t.label ? `${t.label}: ` : ""}${why.join("; ")}`);
    else passing.push(t);
  }
  // The transition the move is made by: one that needs no comment when there is one, else the first that passes.
  const by = passing.find((t) => !t.requires_comment) ?? passing[0] ?? (strict ? null : candidates.find((t) => !t.requires_comment) ?? candidates[0]);
  if (!by) return { ...FREE, blocked: `${label(from)} to ${label(to)}: ${reasons.join(". ")}.` };
  return { blocked: null, needsComment: Boolean(by.requires_comment), action: by.label ?? null };
}

/* ------------------------------ what a write says ------------------------- */

/**
 * The notes a task write's answer carries besides its item (`WriteExtras`, agent/lib/record-lifecycle.ts): each
 * warning's sentence (a move that broke a rule under "warn"), and the next occurrence a recurring task's completion
 * created. As sentences for the toast; none for an answer without them.
 */
export function writeNotes(answer: unknown): string[] {
  if (!answer || typeof answer !== "object") return [];
  const { warnings, next } = answer as WriteExtras;
  const out = Array.isArray(warnings) ? warnings.flatMap((w) => (w && typeof w.message === "string" && w.message ? [w.message] : [])) : [];
  if (next && typeof next === "object" && typeof next.title === "string") {
    const due = next.dueAt && !Number.isNaN(Date.parse(next.dueAt)) ? new Date(next.dueAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : null;
    out.push(`Next one created: "${next.title}"${due ? `, due ${due}` : ""}.`);
  }
  return out;
}
