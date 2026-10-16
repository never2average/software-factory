/**
 * WHAT THE PERIODS SCREEN SHOWS WHEN THE PROFILE DECLARES THE AREA (records.areas.periods in the record-area form,
 * compiled with `declared: true`; agent/lib/period-area.ts): its words, the views it offers (table, a board by state, a
 * timeline, a calendar on one date field), the table's columns, the board's columns and tones, the sorts, the filters
 * (a field's choices, a date's presets, a person's "mine" / "unassigned"), the detail's sections, the create form, the
 * metrics, and how far each period's contained records are done (`relations.contains`, #185).
 *
 * The rest of the record-area screens' model is reused: matchesWhere and the metrics (./task-area-model.ts), the area
 * view (agent/lib/record-areas.ts). Base code branches on field TYPES and state CATEGORIES, never on a profile's values.
 * A profile that does not declare the area never reaches this: its period view is today's (./todos-panel.tsx).
 *
 * Pure: no React, no fetch.
 */
// Relative imports with their extension, so an offline test (scripts/test-period-area.mjs) runs this file as it ships.
import { areaView, periodCompletion, periodContains, TONE_CLASS, type AreaRow, type AreaView, type RecordAreas, type RecordField } from "../../../agent/lib/record-areas.ts";
import { RECORD_AREAS } from "../../../agent/lib/record-areas.generated.ts";
import { periodRow } from "../../../agent/lib/period-area.ts";
import { matchesWhere, taskMetrics, type TaskMetric, type TaskReadContext } from "./task-area-model.ts";

/** The screen's ways of showing the periods: the shared three, and a month calendar. */
export type PeriodViewMode = "table" | "kanban" | "timeline" | "calendar";
const MODE: Record<string, PeriodViewMode> = { table: "table", board: "kanban", timeline: "timeline", calendar: "calendar" };
const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayOf = (x: unknown): string | null => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}/.test(x) ? x.slice(0, 10) : null);
const blank = (x: unknown) => x === null || x === undefined || (typeof x === "string" && x.trim() === "") || (Array.isArray(x) && x.length === 0);
const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

export type PeriodPreset = "overdue" | "due_7d" | "due_30d" | "mine" | "unassigned";
const PRESET_LABEL: Record<PeriodPreset, string> = { overdue: "Overdue", due_7d: "Due in 7 days", due_30d: "Due in 30 days", mine: "Mine", unassigned: "Unassigned" };

/** One facet of the toolbar's Filter: its options, and whether a row passes the picked ones (any of them). */
export interface PeriodFacet {
  id: string;
  label: string;
  options: { value: string; label: string }[];
  passes: (row: AreaRow, picked: readonly string[], ctx: TaskReadContext) => boolean;
}

/** A detail section: its label, its fields (visible ones only), or the related list it shows. */
export interface PeriodSection { label: string | null; fields: RecordField[]; related: "tasks" | "files" | "activity" | "comments" | "subtasks" | null }

/** Everything the declared periods screen reads off the definition. */
export function periodAreaUi(areas: RecordAreas = RECORD_AREAS) {
  const v = areaView("periods", areas);
  const a = v.area;
  const views = a.views ?? {};
  const lc = v.lifecycle;
  const field = (k: string) => {
    const f = v.field(k);
    return f && !f.hidden ? f : null;
  };
  const stateOf = (row: AreaRow): string | null => {
    const s = v.get(row, "state");
    return typeof s === "string" ? v.canonical("state", s) : lc?.initial ?? null;
  };
  // The views: the definition's (board and calendar included), else today's three.
  const declaredModes = (views.available ?? ["board", "table", "timeline"]).map((m) => MODE[m]).filter(Boolean);
  const modes = [...new Set(declaredModes)].filter((m) => m !== "kanban" || v.board);
  const list = modes.length ? modes : (["table"] as PeriodViewMode[]);
  const wanted = MODE[views.default ?? ""];
  const defaultMode = wanted && list.includes(wanted) ? wanted : list[0];
  // The table: the definition's columns; else the name, the state, the window and every field marked for lists.
  const tableKeys = views.table?.columns ?? ["name", "state", "startsAt", "endsAt", ...v.visibleFields.filter((f) => f.show_in_list).map((f) => f.key)];
  const columns = tableKeys.flatMap((k) => {
    const f = field(k);
    return f ? [{ key: f.key, label: f.short_label ?? f.label ?? DEFAULT_LABEL[f.key] ?? f.key, field: f }] : [];
  });
  const board = v.board ? { by: v.board.by, columns: v.board.columns.map((c) => ({ key: c.key, label: c.label, tone: TONE_CLASS[c.tone ?? "muted"] })), card: v.board.card } : null;
  const dateKey = (k: string | undefined, fallback: string) => (k && field(k) ? field(k)!.key : fallback);
  const calendarDate = dateKey(views.calendar?.date, "endsAt");
  const timeline = { start: dateKey(views.timeline?.start, "startsAt"), end: dateKey(views.timeline?.end, "endsAt") };
  // Sorts: the definition's; else today's three (newest, start date, name).
  const sorts = v.sorts.length
    ? v.sorts.map((s) => ({ value: `${s.field}:${s.dir}`, label: s.label, default: s.default }))
    : [{ value: "createdAt:desc", label: "Newest", default: true }, { value: "startsAt:asc", label: "Start date", default: false }, { value: "name:asc", label: "Name", default: false }];
  const defaultSort = sorts.find((s) => s.default)?.value ?? sorts[0].value;
  // Filters: a choice field's choices (the state's by its words), a date's presets, a person's mine / unassigned.
  const facets: PeriodFacet[] = [];
  for (const flt of v.filters) {
    const f = flt.field ? field(flt.field) : null;
    if (!f) continue;
    if (flt.scope === "people" || ((f.type === "person" || f.type === "email") && flt.presets?.length)) {
      facets.push({
        id: `people:${f.key}`,
        label: f.label ?? f.key,
        options: (["mine", "unassigned"] as const).map((p) => ({ value: p, label: PRESET_LABEL[p] })),
        passes: (row, picked, ctx) => picked.some((p) => (p === "mine" ? Boolean(ctx.me) && [v.get(row, f.key)].flat().some((x) => same(x, ctx.me)) : blank(v.get(row, f.key)))),
      });
      continue;
    }
    if ((f.type === "date" || f.type === "datetime") && flt.presets?.length) {
      const presets = flt.presets.filter((p): p is "overdue" | "due_7d" | "due_30d" => p === "overdue" || p === "due_7d" || p === "due_30d");
      if (!presets.length) continue;
      facets.push({
        id: `date:${f.key}`,
        label: f.label ?? f.key,
        options: presets.map((p) => ({ value: p, label: PRESET_LABEL[p] })),
        passes: (row, picked, ctx) => picked.some((p) => datePasses(v, row, f.key, p as PeriodPreset, ctx, stateOf)),
      });
      continue;
    }
    if (f.type === "pick_list" || f.type === "multi_pick") {
      facets.push({
        id: `field:${f.key}`,
        label: f.short_label ?? f.label ?? f.key,
        options: v.options(f.key).map((o) => ({ value: o.value, label: o.label })),
        passes: (row, picked) => {
          const x = f.key === lc?.field ? stateOf(row) : v.get(row, f.key);
          return [x].flat().some((y) => typeof y === "string" && picked.includes(v.canonical(f.key, y)));
        },
      });
    }
  }
  // The detail: the definition's sections, else every visible field, then the contained records, activity, comments.
  const sections: PeriodSection[] = (views.detail?.sections?.length
    ? views.detail.sections
    : [{ label: "Properties", fields: v.visibleFields.map((f) => f.key) }, { related: "tasks" as const }, { related: "activity" as const }, { related: "comments" as const }]
  ).map((s) => ({
    label: s.label ?? null,
    related: s.related ?? null,
    fields: (s.fields ?? []).flatMap((k: unknown) => (typeof k === "string" && field(k) && !["createdBy", "createdAt", "updatedAt"].includes(field(k)!.key) ? [field(k)!] : [])),
  }));
  // The create form: the definition's fields, else every field a new period must be given.
  const createKeys = views.create?.fields ?? v.visibleFields.filter((f) => (f.required === true || f.required === "on_create") && !("default" in f) && f.key !== lc?.field).map((f) => f.key);
  const createFields = [...new Set(createKeys)].flatMap((k) => (field(k) && !field(k)!.computed ? [field(k)!] : []));
  return {
    view: v,
    singular: v.singular,
    noun: v.noun,
    nouns: v.nouns,
    navLabel: a.nav?.label ?? v.plural,
    blurb: v.description,
    createLabel: views.create?.submit_label ?? `New ${v.noun}`,
    createTitle: views.create?.title ?? `New ${v.noun}`,
    empty: views.empty ?? `No ${v.nouns} yet — hit ${views.create?.submit_label ?? `New ${v.noun}`}.`,
    emptyNoMatch: `No ${v.nouns} match.`,
    loading: views.loading ?? `Loading ${v.nouns}…`,
    modes: list,
    defaultMode,
    columns,
    board,
    calendarDate,
    timeline,
    sorts,
    defaultSort,
    facets,
    sections,
    createFields,
    lifecycle: lc,
    stateOf,
    /** Does the period contain another area's records, and is it measured by them? (relations.contains) */
    contains: periodContains(areas),
  };
}
export type PeriodAreaUi = ReturnType<typeof periodAreaUi>;

/** What the activity feed and today's screen call a period's columns, for a field the definition gives no label. */
export const DEFAULT_LABEL: Record<string, string> = { name: "Name", startsAt: "Starts", endsAt: "Ends", state: "State", goal: "Goal", lead: "Lead", capacity: "Capacity" };

/** Does a row pass a date preset on `key`? Overdue and due-soon count only periods still to finish. */
function datePasses(v: AreaView, row: AreaRow, key: string, preset: PeriodPreset, ctx: TaskReadContext, stateOf: (r: AreaRow) => string | null): boolean {
  const d = dayOf(v.get(row, key));
  if (d === null) return false;
  const c = v.lifecycle?.categoryOf(stateOf(row)) ?? null;
  if (c === "done" || c === "cancelled") return false;
  const today = isoDay(ctx.now);
  if (preset === "overdue") return d < today;
  return d >= today && d <= isoDay(ctx.now + (preset === "due_7d" ? 7 : 30) * DAY);
}

/** A period as the screen reads it: its columns by key (dates as ISO text), its own fields under `custom`. */
export const periodAreaRow = (p: Record<string, unknown>): AreaRow => periodRow(p);

/** The rows the toolbar leaves: the search over the name and every visible text, then each picked facet. */
export function filterPeriods(ui: PeriodAreaUi, rows: readonly AreaRow[], q: string, picks: Record<string, string[]>, ctx: TaskReadContext): AreaRow[] {
  const query = q.trim().toLowerCase();
  return rows.filter((r) => {
    if (query) {
      const text = [String(r.name ?? ""), ...ui.view.visibleFields.map((f) => ui.view.display(f.key, ui.view.get(r, f.key)))].join(" ").toLowerCase();
      if (!text.includes(query)) return false;
    }
    return ui.facets.every((f) => !(picks[f.id]?.length) || f.passes(r, picks[f.id], ctx));
  });
}

/** Sort rows by `field:dir`: dates and text as text (ISO sorts), numbers as numbers, a state by its order; unset last. */
export function sortPeriods(ui: PeriodAreaUi, rows: readonly AreaRow[], sort: string): AreaRow[] {
  const [key, dir] = sort.split(":");
  const sign = dir === "desc" ? -1 : 1;
  const v = ui.view;
  const order = new Map((ui.lifecycle?.states ?? []).map((s, i) => [s.value, i]));
  const valueOf = (r: AreaRow): unknown => {
    if (key === ui.lifecycle?.field) return order.get(ui.stateOf(r) ?? "") ?? null;
    return v.get(r, key) ?? r[key];
  };
  return [...rows].sort((a, b) => {
    const x = valueOf(a);
    const y = valueOf(b);
    if (blank(x) && blank(y)) return 0;
    if (blank(x)) return 1;
    if (blank(y)) return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
}

/** How far each period's contained records are done (#185 periodCompletion), by period id. Empty when it contains none. */
export function completionOf(rows: readonly AreaRow[], areas: RecordAreas = RECORD_AREAS): Map<string, { total: number; done: number }> {
  return periodCompletion(rows as AreaRow[], areas);
}

/** The definition's metrics over the periods in hand (count, ratio, sum), flagged as it says. */
export function periodMetrics(ui: PeriodAreaUi, rows: readonly AreaRow[], ctx: TaskReadContext): TaskMetric[] {
  return taskMetrics(ui.view, rows, ctx);
}

/** Does a row satisfy a `where` of the definition (re-exported for the panel's tests)? */
export const periodMatches = (ui: PeriodAreaUi, row: AreaRow, where: Record<string, unknown> | undefined, ctx: TaskReadContext) => matchesWhere(ui.view, row, where, ctx);

/** The month a calendar shows, as its weeks of days (Monday first), each day yyyy-mm-dd; days outside the month are null. */
export function monthGrid(year: number, month: number): (string | null)[][] {
  const first = Date.UTC(year, month, 1);
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lead = (new Date(first).getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => isoDay(first + i * DAY))];
  while (cells.length % 7) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** The rows that fall on each day of the calendar (their date field's day). */
export function byDay(ui: PeriodAreaUi, rows: readonly AreaRow[]): Map<string, AreaRow[]> {
  const out = new Map<string, AreaRow[]>();
  for (const r of rows) {
    const d = dayOf(ui.view.get(r, ui.calendarDate));
    if (!d) continue;
    out.set(d, [...(out.get(d) ?? []), r]);
  }
  return out;
}
