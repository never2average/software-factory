/**
 * WHAT THE SCREEN OF A DECLARED ACCOUNT RECORD AREA SHOWS (deployments, implementations stated in the record-area form,
 * `records.areas.<area>` with `declared: true`): every word, column, board column, card line, sort, filter, group,
 * detail section and create field, read from the area's compiled definition (agent/lib/record-areas.ts). The panel
 * (app/_components/ops/record-area-panel.tsx) only draws what this returns.
 *
 * Base code branches on field TYPES and lifecycle CATEGORIES, never on a value a profile chose. A profile that does
 * not declare the area never reaches this: its screens are today's (app/_components/ops/todos-panel.tsx MineList).
 *
 * Pure: no React, no fetch. `areas` is a parameter so a preview page or a test can pass another profile's.
 */
import { RECORD_AREAS } from "../agent/lib/record-areas.generated.ts";
import { areaView, TONE_CLASS, type AreaView, type RecordAreas, type RecordField } from "../agent/lib/record-areas.ts";
import { ACCOUNT_FIELD, type AccountAreaId } from "../agent/lib/record-area-records.ts";
import type { RecordWhere } from "../agent/lib/record-areas.generated.ts";
import { W } from "./ui-words.ts";

/** The screen's three ways of showing a list (a definition's calendar is drawn as its timeline for now). */
export type AreaViewMode = "table" | "kanban" | "timeline";
const MODE: Record<string, AreaViewMode> = { table: "table", board: "kanban", timeline: "timeline", calendar: "timeline" };

export interface UiColumn { key: string; label: string; field: RecordField | null }
export interface UiFacet { key: string; label: string; options: { value: string; label: string }[] }
export type DatePreset = "overdue" | "due_7d" | "due_30d" | "this_period" | "mine" | "unassigned";
export interface UiPresetFilter { key: string; label: string; presets: { value: DatePreset; label: string }[] }

const PRESET_LABEL: Record<DatePreset, string> = { overdue: "Overdue", due_7d: "Due in 7 days", due_30d: "Due in 30 days", this_period: "This period", mine: "Mine", unassigned: "Unassigned" };

/** `accountLabel`: what the account column is called when the definition gives no label; the profile's word by default. */
export function recordAreaUi(id: AccountAreaId, areas: RecordAreas = RECORD_AREAS, accountLabel: string = W.Account) {
  const v = areaView(id, areas);
  const a = v.area;
  const views = a.views ?? {};
  const idField = id === "deployments" ? a.id?.field ?? "deploymentId" : null;
  const column = (key: string): UiColumn | null => {
    if (key === ACCOUNT_FIELD) return { key, label: a.relations?.account?.label ?? accountLabel, field: null };
    if (key === "title") return { key, label: "Title", field: null };
    const f = v.field(key);
    if (!f || f.hidden) return null;
    return { key: f.key, label: f.short_label ?? f.label ?? (f.key === idField ? a.id?.label ?? f.key : f.key), field: f };
  };
  const lc = v.lifecycle;
  // The table: the definition's columns; else the account, the id, the state, and every field marked for lists.
  const tableKeys = views.table?.columns ?? [ACCOUNT_FIELD, ...(idField ? [idField] : []), ...(lc ? [lc.field] : []), ...v.visibleFields.filter((f) => f.show_in_list).map((f) => f.key)];
  const available = [...new Set((views.available ?? ["table", ...(v.board ? ["board"] : []), ...(views.timeline || views.calendar ? ["timeline"] : [])]).map((m) => MODE[m]).filter(Boolean))] as AreaViewMode[];
  const modes = available.filter((m) => m !== "kanban" || v.board);
  const defaultMode = MODE[views.default ?? ""] && modes.includes(MODE[views.default!]) ? MODE[views.default!] : modes[0] ?? "table";
  const board = v.board ? { by: v.board.by, columns: v.board.columns.map((c) => ({ key: c.key, label: c.label, tone: TONE_CLASS[c.tone ?? "muted"] })), card: v.board.card } : null;
  const dateOf = (k: string | undefined) => (k && (k === ACCOUNT_FIELD || v.field(k)) ? k : null);
  const timeline = { start: dateOf(views.timeline?.start ?? views.calendar?.date), end: dateOf(views.timeline?.end ?? views.calendar?.date) };
  const sortLabel = (field: string, dir: "asc" | "desc") => {
    const base = field === ACCOUNT_FIELD ? a.relations?.account?.label ?? accountLabel : v.label(field);
    return dir === "desc" ? `${base} (newest first)` : base;
  };
  const sorts = v.sorts.map((s) => ({ value: `${s.field}:${s.dir}`, label: s.label === s.field || s.label === v.label(s.field) ? sortLabel(s.field, s.dir) : s.label, default: s.default }));
  // Filters: a choice field is a facet of its choices; a date field takes its presets; `scope: people` is mine / unassigned.
  const facets: UiFacet[] = [];
  const presets: UiPresetFilter[] = [];
  for (const flt of v.filters) {
    if (!flt.field) continue;
    const f = flt.field === ACCOUNT_FIELD ? null : v.field(flt.field);
    if (flt.field !== ACCOUNT_FIELD && (!f || f.hidden || f.computed)) continue;
    if (flt.scope === "people") {
      presets.push({ key: f!.key, label: f!.label ?? f!.key, presets: (["mine", "unassigned"] as const).map((p) => ({ value: p, label: PRESET_LABEL[p] })) });
      continue;
    }
    if (f && (f.type === "pick_list" || f.type === "multi_pick")) facets.push({ key: f.key, label: f.short_label ?? f.label ?? f.key, options: v.options(f.key).map((o) => ({ value: o.value, label: o.label })) });
    if (f && (f.type === "date" || f.type === "datetime") && flt.presets?.length) presets.push({ key: f.key, label: f.label ?? f.key, presets: flt.presets.filter((p) => p !== "this_period").map((p) => ({ value: p, label: PRESET_LABEL[p] })) });
  }
  const groupBy = views.group_by?.filter((k) => k === ACCOUNT_FIELD || (v.field(k) && !v.field(k)!.hidden)) ?? (a.relations?.group?.field ? [a.relations.group.field] : []);
  // The detail: the definition's sections, else one with every visible field.
  const sections = (views.detail?.sections?.length ? views.detail.sections : [{ label: "Properties", fields: v.visibleFields.map((f) => f.key) }])
    .map((s) => ({ label: s.label ?? null, related: s.related ?? null, fields: (s.fields ?? []).flatMap((k: unknown) => (typeof k === "string" && v.field(k) && !v.field(k)!.hidden && v.field(k)!.key !== idField ? [v.field(k)!] : [])) }));
  // The create form: the account, the id, then the definition's fields (else every field a new record must be given).
  const lcInitial = lc?.initial ? lc.field : null;
  const listed = views.create?.fields ?? v.visibleFields.filter((f) => (f.required === true || f.required === "on_create") && !("default" in f) && f.key !== lcInitial).map((f) => f.key);
  const createFields = [...new Set(listed)].flatMap((k) => (k === ACCOUNT_FIELD || k === idField ? [] : v.field(k) && !v.field(k)!.hidden && !v.field(k)!.computed ? [v.field(k)!] : []));
  return {
    id,
    view: v,
    navLabel: a.nav?.label ?? v.plural,
    blurb: v.description,
    noun: v.noun,
    nouns: v.nouns,
    singular: v.singular,
    createLabel: v.submitLabel,
    createTitle: views.create?.title ?? `New ${v.noun}`,
    loading: views.loading ?? `Loading ${v.nouns}…`,
    empty: views.empty ?? `No ${v.nouns} yet — hit ${v.submitLabel}.`,
    idField,
    idLabel: a.id?.label ?? "Id",
    idPlaceholder: a.id?.placeholder ?? v.field(idField ?? "")?.placeholder,
    accountLabel: a.relations?.account?.label ?? accountLabel,
    columns: tableKeys.flatMap((k) => column(k) ?? []),
    modes,
    defaultMode,
    board,
    timeline,
    sorts,
    defaultSort: sorts.find((s) => s.default)?.value ?? sorts[0]?.value ?? "",
    facets,
    presets,
    groupBy,
    sections,
    createFields,
    lifecycle: lc,
  };
}
export type RecordAreaUi = ReturnType<typeof recordAreaUi>;

/**
 * The toolbar's picks as the list route's `where` (agent/lib/record-query.ts): a facet is `in` its values, a date preset
 * a range from today, `mine` the person's email, `unassigned` no value.
 */
export function whereOf(picks: { facets: Record<string, string[]>; presets: Record<string, DatePreset[]> }, me: string | undefined, now: Date = new Date(), lifecycleField: string | null = null): RecordWhere {
  const where: RecordWhere = {};
  for (const [k, vals] of Object.entries(picks.facets)) if (vals.length) where[k] = { in: vals };
  const day = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString().slice(0, 10);
  for (const [k, ps] of Object.entries(picks.presets)) {
    const p = ps[0];
    if (!p) continue;
    if (p === "overdue") {
      where[k] = { lt: day(0) };
      // Overdue is still to do: a record whose state is finished (done or cancelled) is not overdue.
      if (lifecycleField) where[lifecycleField] = { ...(where[lifecycleField] as object | undefined), category: ["backlog", "open", "active", "blocked"] };
    }
    else if (p === "due_7d") where[k] = { gte: day(0), lte: day(7) };
    else if (p === "due_30d") where[k] = { gte: day(0), lte: day(30) };
    else if (p === "mine" && me) where[k] = me.toLowerCase();
    else if (p === "unassigned") where[k] = { set: false };
  }
  return where;
}

/** The list route's query string for the toolbar's state. */
export function listQuery(where: RecordWhere, sort: string, q: string): string {
  const p = new URLSearchParams();
  p.set("where", JSON.stringify(where));
  if (sort) {
    const [field, dir] = sort.split(":");
    p.set("sort", dir === "desc" ? `-${field}` : field);
  }
  if (q.trim()) p.set("q", q.trim());
  return p.toString();
}
