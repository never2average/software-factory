/**
 * Metrics, charts and console tabs across a build (mold_v0-063, mold_v0-058; molds/mold_v0/MOLD.md "Pack and record-area
 * contract"): what each declaration names, checked against every pack's areas, fields, states and job kinds. Pure (no
 * database), so the server (src/packs.ts installPacks), the build (scripts/gen-packs.mjs) and the metric engine
 * (src/metrics.ts) share one reading of a metric: which columns it reads, of what type, and which roles may see it.
 */
import { ACCOUNT_ROLES, canAccount, type AccountRole } from "./account-roles.js";
import { ChartSchema, DECLARABLE_ROLES, MetricSchema, optionValues, RecordAreaSchema, TAB_SOURCE_COLUMN, TabSchema, z, type Chart, type Metric, type MetricUnit, type Tab } from "./pack-api.js";

export type SpecArea = z.output<typeof RecordAreaSchema> & { pack: string };
export type SpecMetric = Metric & { pack: string };
export type SpecChart = Chart & { pack: string };
export type SpecTab = Tab & { pack: string };

/**
 * The areas an area tab shows (mold_v0-135): its `area`, or each of its `areas` (a merged tab), first the tab's own.
 * Every other kind shows none.
 */
export interface MergedArea { area: string; rows: "all" | "matched"; source?: string }
export const tabAreas = (t: Pick<Tab, "kind" | "area" | "areas">): MergedArea[] =>
  t.kind !== "area" ? [] : t.areas ? t.areas.map((a) => ({ area: a.area, rows: a.rows ?? "all", ...(a.source !== undefined ? { source: a.source } : {}) })) : t.area ? [{ area: t.area, rows: "all" as const }] : [];
/** The area a tab is named and emptied by: its own (the first of a merged tab's areas). */
export const tabArea = (t: Pick<Tab, "kind" | "area" | "areas">): string | undefined => tabAreas(t)[0]?.area;

/**
 * A field as a merged tab shows it (mold_v0-135): the first of its areas that declares it gives its label and type; an
 * enum's options are every declaring area's, in order (a value is shown with the label of the first that has it). The
 * `source` column is an enum of the areas' source words. Null when no area of the tab declares it.
 */
export function tabField(t: Pick<Tab, "kind" | "area" | "areas">, areas: readonly SpecArea[], name: string): SpecArea["fields"][number] | null {
  const list = tabAreas(t);
  if (list.length > 1 && name === TAB_SOURCE_COLUMN) {
    const words = [...new Set(list.flatMap((a) => (a.source ? [a.source] : [])))];
    return words.length ? { name, label: "Source", type: "enum", options: words.map((w) => ({ value: w, label: w })) } as SpecArea["fields"][number] : null;
  }
  const declaring = list.map((a) => areas.find((x) => x.name === a.area)?.fields.find((f) => f.name === name)).filter((f): f is SpecArea["fields"][number] => !!f);
  const first = declaring[0];
  if (!first) return null;
  if (first.type !== "enum" || declaring.length === 1) return first;
  const options: { value: string; label?: string }[] = [];
  for (const f of declaring) for (const o of f.options ?? []) {
    const x = typeof o === "string" ? { value: o, label: o } : o;
    if (!options.some((y) => y.value === x.value)) options.push(x);
  }
  return { ...first, options } as SpecArea["fields"][number];
}

/**
 * A tab's table columns: its `columns`, else the area's list columns (a merged tab: the source column when an area has a
 * source word, then each area's list columns in order, without repeats, at most 8).
 */
export function tabColumns(t: Pick<Tab, "kind" | "area" | "areas" | "columns">, areas: readonly SpecArea[]): string[] {
  if (t.columns) return [...t.columns];
  const list = tabAreas(t);
  const cols: string[] = list.length > 1 && list.some((a) => a.source) ? [TAB_SOURCE_COLUMN] : [];
  for (const a of list) for (const c of areas.find((x) => x.name === a.area)?.list_columns ?? []) if (!cols.includes(c)) cols.push(c);
  return cols.slice(0, 8);
}

/** What a metric may be over besides a record area: the workspace's run results and its runs. */
export const RUN_SOURCES = ["run_results", "runs"] as const;
export type RunSource = (typeof RUN_SOURCES)[number];

/** A column a metric reads, as the engine sees it. */
export interface Column {
  /** text: compared as text; enum: one of `options`; number; time: a point in time; boolean; person and reference as text. */
  type: "text" | "enum" | "number" | "time" | "boolean" | "person" | "reference";
  multiple: boolean;
  options?: string[];
  labels?: Record<string, string>;
  /** A reference's area (group labels are its records' titles). */
  to?: string;
  /** Where it is: a field of the record's data, a column of the row, a run result's detail key, or a state's time. */
  at: { data: string } | { column: string } | { detail: string } | { state: string };
}

const RUN_RESULT_STATUSES = ["pass", "fail", "error", "not_applicable", "unknown"];
const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"];
const RUN_ERRORS = ["infrastructure", "run", "validation", "timeout", "cancelled"];
const STATUS_LABELS: Record<string, string> = {
  pass: "Pass", fail: "Fail", error: "Error", not_applicable: "Not applicable", unknown: "Unknown", queued: "Queued", running: "Running",
  succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled", infrastructure: "Infrastructure", run: "Run", validation: "Validation", timeout: "Timeout",
};
const labelsOf = (vals: string[]) => Object.fromEntries(vals.map((v) => [v, STATUS_LABELS[v] ?? v]));

/** The columns a run source offers, by name. */
const RUN_COLUMNS: Record<RunSource, Record<string, Column>> = {
  run_results: {
    status: { type: "enum", multiple: false, options: RUN_RESULT_STATUSES, labels: labelsOf(RUN_RESULT_STATUSES), at: { column: "status" } },
    check: { type: "reference", multiple: false, at: { column: "check" } },
    asset: { type: "reference", multiple: false, at: { column: "asset" } },
    source: { type: "reference", multiple: false, at: { column: "source" } },
    check_area: { type: "text", multiple: false, at: { column: "check_area" } },
    created: { type: "time", multiple: false, at: { column: "created_at" } },
  },
  runs: {
    status: { type: "enum", multiple: false, options: RUN_STATUSES, labels: labelsOf(RUN_STATUSES), at: { column: "status" } },
    kind: { type: "text", multiple: false, at: { column: "kind" } },
    error_kind: { type: "enum", multiple: false, options: RUN_ERRORS, labels: labelsOf(RUN_ERRORS), at: { column: "error_kind" } },
    cost_usd: { type: "number", multiple: false, at: { column: "cost_usd" } },
    created: { type: "time", multiple: false, at: { column: "created_at" } },
    started: { type: "time", multiple: false, at: { column: "started_at" } },
    ended: { type: "time", multiple: false, at: { column: "ended_at" } },
  },
};

/** The column `name` names in what a metric is over (an area or a run source), or a reason it names none. */
export function columnOf(over: SpecArea | RunSource, name: string): Column | string {
  if (typeof over === "string") {
    if (over === "run_results" && name.startsWith("detail.")) return { type: "text", multiple: false, at: { detail: name.slice(7) } };
    return RUN_COLUMNS[over][name] ?? `${over} has no column ${name} (it has ${Object.keys(RUN_COLUMNS[over]).join(", ")}${over === "run_results" ? ", detail.<word>" : ""})`;
  }
  if (name === "created" || name === "updated") {
    if (over.fields.some((f) => f.name === name)) return `area ${over.name} has a field named ${name}: it hides the row's own ${name} time`;
    return { type: "time", multiple: false, at: { column: `${name}_at` } };
  }
  if (name.startsWith("detail.")) return `detail.<word> is for run_results; area ${over.name} has fields`;
  const f = over.fields.find((x) => x.name === name);
  if (!f) return `area ${over.name} has no field ${name}`;
  const t = f.type;
  const multiple = !!f.multiple || t === "link";
  if (t === "enum") {
    const options = optionValues(f);
    return { type: "enum", multiple, options, labels: Object.fromEntries((f.options ?? []).map((o) => (typeof o === "string" ? [o, o] : [o.value, o.label ?? o.value]))), at: { data: f.name } };
  }
  if (t === "date") return { type: "time", multiple: false, at: { data: f.name } };
  if (t === "number" || t === "boolean" || t === "person" || t === "text") return { type: t, multiple, at: { data: f.name } };
  if (t === "reference" || t === "link") return { type: "reference", multiple, to: f.to ?? over.links?.find((l) => l.field === f.name)?.area, at: { data: f.name } };
  return `field ${name} of area ${over.name} is ${t}: a metric reads text, enum, number, date, boolean, person and reference fields`;
}

/** A point in time (by_time.at, duration.from/to, a timeline): a time column, or state:<value> of a lifecycle. */
export function pointOf(over: SpecArea | RunSource, p: string): Column | string {
  if (p.startsWith("state:")) {
    const v = p.slice(6);
    if (typeof over === "string") return `state:<value> is for a record area with a lifecycle; ${over} has none`;
    if (!over.lifecycle) return `area ${over.name} has no lifecycle, so it has no state times (${p})`;
    const f = over.fields.find((x) => x.name === over.lifecycle!.field);
    if (!f || !optionValues(f).includes(v)) return `${p}: ${v} is not a state of area ${over.name}`;
    if (over.scope !== "workspace") return `${p}: a shared area's records have no states`;
    return { type: "time", multiple: false, at: { state: v } };
  }
  const c = columnOf(over, p);
  if (typeof c === "string") return c;
  if (c.type !== "time") return `${p} is not a date or a time`;
  return c;
}

/** Who may read an area's records (its declared `read`, the platform's own otherwise): src/record-areas.ts allowedRoles. */
export const areaReadRoles = (a: SpecArea): AccountRole[] => ACCOUNT_ROLES.filter((r) => (a.permissions?.read ?? DECLARABLE_ROLES).includes(r) && canAccount(r, "read"));
/** Who may read a metric: its `roles`, narrowed by its area's read permission (run results: every check and asset area's). */
export function metricRoles(m: SpecMetric, areas: readonly SpecArea[]): AccountRole[] {
  const area = areas.find((a) => a.name === m.over);
  // Run results name check, asset and source records (and their detail): readable by the roles that may read every check
  // and asset area of the build. Runs carry only their kind, status, times and cost: every role, as on the usage pages.
  const base: readonly AccountRole[] = area ? areaReadRoles(area)
    : ACCOUNT_ROLES.filter((r) => canAccount(r, "read") && (m.over !== "run_results" || areas.filter((a) => a.role !== "source").every((a) => areaReadRoles(a).includes(r))));
  return base.filter((r) => !m.roles || m.roles.includes(r));
}

/** How the console shows a metric's numbers. */
export function metricUnit(m: Metric, over: SpecArea | RunSource | null): MetricUnit {
  if (m.unit) return m.unit;
  if (m.measure === "count") return "count";
  if (m.measure === "rate") return "percent";
  if (m.measure === "duration") return m.duration!.unit;
  if (over === "runs" && m.field === "cost_usd") return "usd";
  return "number";
}

/** The shape of a metric's answer: one value, a value per group, a series (per group), for the charts' checks. */
const shapeOf = (m: Metric) => (m.by_time ? (m.group_by ? "series_by_group" : "series") : m.group_by ? "groups" : "single");
const groupKey = (m: Metric) => JSON.stringify([m.group_by ?? null, m.group_by_list ?? null]);
/** Series share their buckets when they share `every` and `last` (each may read its own point in time). */
const timeKey = (m: Metric) => JSON.stringify(m.by_time ? [m.by_time.every, m.by_time.last] : null);

export interface BuildViews {
  areas: readonly SpecArea[];
  metrics: readonly SpecMetric[];
  charts: readonly SpecChart[];
  tabs: readonly SpecTab[];
  /** What else the build has: job kinds (runs, reports, schedules tabs), credential fields, due-date areas, pages per pack. */
  jobKinds: number;
  credentials: number;
  dueAreas: number;
  pages?: Record<string, string[]>;
  /** The packs with a workspace store (a kind with workspace: true, or an agent-workspace kind): the files tab (mold_v0-056). */
  stores?: readonly string[];
  /** The packs' onboarding steps and job kinds, for the tabs' empty states (mold_v0-107). */
  steps?: readonly { pack: string; id: string; label: string; help?: string; done_when: string }[];
  kinds?: readonly { pack: string; name: string; label?: string }[];
}

/** Every problem with the build's metrics, charts and tabs, each naming its pack. Empty when they are sound. */
export function checkViews(b: BuildViews): string[] {
  const problems: string[] = [];
  const at = (pack: string, what: string) => problems.push(`pack ${pack}: ${what}`);
  const area = (n: string) => b.areas.find((a) => a.name === n) ?? null;
  const overOf = (m: SpecMetric): SpecArea | RunSource | null => ((RUN_SOURCES as readonly string[]).includes(m.over) ? (m.over as RunSource) : area(m.over));

  // ---------- metrics ----------
  const metricOwner = new Map<string, string>();
  for (const m of b.metrics) {
    const p = m.pack, w = `metric ${m.name}`;
    if (metricOwner.has(m.name)) at(p, `${w} is already pack ${metricOwner.get(m.name)}'s (metric names are unique in a build)`);
    else metricOwner.set(m.name, p);
    const over = overOf(m);
    if (!over) { at(p, `${w} is over ${m.over}, which is neither a record area of this build nor run_results or runs`); continue; }
    const col = (name: string, why: string) => { const c = columnOf(over, name); if (typeof c === "string") { at(p, `${w}: ${why}: ${c}`); return null; } return c; };
    const conditions = (list: NonNullable<z.output<typeof MetricSchema>["where"]>, why: string) => {
      for (const c of list) {
        const k = col(c.field, why);
        if (!k) continue;
        const vals = c.value === undefined ? [] : Array.isArray(c.value) ? c.value : [c.value];
        if (["lt", "lte", "gt", "gte"].includes(c.op)) {
          if (k.type !== "number" && k.type !== "time") at(p, `${w}: ${why}: ${c.op} compares numbers or dates; ${c.field} is ${k.type}`);
          else if (k.type === "number" && typeof c.value !== "number") at(p, `${w}: ${why}: ${c.field} is a number: compare it with a number`);
          else if (k.type === "time" && typeof c.value !== "string") at(p, `${w}: ${why}: ${c.field} is a date: compare it with a date, today or now`);
          continue;
        }
        if (c.op === "empty" || c.op === "not_empty") continue;
        if (k.type === "time" || k.type === "number") { at(p, `${w}: ${why}: ${c.field} is a ${k.type === "time" ? "date" : "number"}: use lt, lte, gt or gte`); continue; }
        if (k.multiple && (c.op === "ne" || c.op === "not_in")) at(p, `${w}: ${why}: ${c.field} holds a list: use eq or in (it holds the value), empty or not_empty`);
        if (k.type === "boolean" && vals.some((v) => typeof v !== "boolean")) at(p, `${w}: ${why}: ${c.field} is true or false`);
        if (k.type !== "boolean" && vals.some((v) => typeof v !== "string")) at(p, `${w}: ${why}: ${c.field} is compared with words`);
        if (k.type === "enum") for (const v of vals) if (typeof v === "string" && !k.options!.includes(v)) at(p, `${w}: ${why}: ${v} is not one of ${c.field}'s options (${k.options!.join(", ")})`);
      }
    };
    conditions(m.where ?? [], "where");
    if (m.rate) conditions(m.rate.where, "rate.where");
    if (m.field !== undefined) { const k = col(m.field, `the ${m.measure} of ${m.field}`); if (k && k.type !== "number") at(p, `${w}: a ${m.measure} reads a number field; ${m.field} is ${k.type}`); }
    if (m.duration) for (const end of [m.duration.from, m.duration.to]) { const c = pointOf(over, end); if (typeof c === "string") at(p, `${w}: duration: ${c}`); }
    if (m.by_time) { const c = pointOf(over, m.by_time.at); if (typeof c === "string") at(p, `${w}: by_time.at: ${c}`); }
    if (m.group_by !== undefined) {
      if (typeof m.group_by === "object") {
        const c = typeof over === "string" ? `due dates are a record area's` : (() => { const k = columnOf(over, m.group_by.due); return typeof k === "string" ? k : k.type !== "time" || !("data" in k.at) ? `${m.group_by.due} is not a date field` : null; })();
        if (c) at(p, `${w}: group_by.due: ${c}`);
      } else {
        const k = col(m.group_by, "group_by");
        if (k) {
          if (k.multiple && !m.group_by_list) at(p, `${w}: group_by: ${m.group_by} holds a list: group by a single-valued field, or declare group_by_list (first: its first item; each: a row in the group of every item)`);
          else if (!k.multiple && m.group_by_list) at(p, `${w}: group_by_list: ${m.group_by} holds one value, not a list: drop group_by_list`);
          else if (k.type === "time" || k.type === "number") at(p, `${w}: group_by: ${m.group_by} is a ${k.type === "time" ? "date" : "number"}: group by a word field (use by_time for dates)`);
          else if (m.by_time && !(k.type === "boolean" || (k.type === "enum" && k.options!.length <= 8) || (typeof over === "string" && m.group_by === "kind" && b.jobKinds <= 8)))
            at(p, `${w}: a series grouped by ${m.group_by} could have many groups: group a series by an enum of at most 8 options, a true/false field, a status, or a kind (in a build of at most 8)`);
        }
      }
    }
  }

  // ---------- charts: each form takes the shapes it can draw, on one axis ----------
  const metric = (n: string) => b.metrics.find((m) => m.name === n) ?? null;
  for (const c of b.charts) {
    const p = c.pack, w = `chart ${c.name} (${c.type})`;
    const ms = c.metrics.map(metric).filter((m): m is SpecMetric => !!m);
    if (ms.length !== c.metrics.length) continue; // named by validatePack
    const shapes = ms.map(shapeOf);
    const units = new Set(ms.map((m) => metricUnit(m, overOf(m))));
    const same = (k: (m: Metric) => string) => new Set(ms.map(k)).size === 1;
    if (c.type !== "number" && c.type !== "table" && units.size > 1) at(p, `${w} would need two y-axes (${[...units].join(" and ")}): show each in its own chart`);
    switch (c.type) {
      case "number":
        if (shapes.some((s) => s !== "single")) at(p, `${w}: a number tile shows one value per metric: drop group_by and by_time`);
        if (ms.length > 4) at(p, `${w}: at most 4 tiles in a row`);
        break;
      case "bar":
        if (ms.length !== 1) at(p, `${w}: a bar chart shows one metric (several: stacked_bar, or a table)`);
        else if (shapes[0] !== "groups" && shapes[0] !== "series") at(p, `${w}: a bar chart shows a metric by group or by time (a group over time: stacked_bar; one value: number)`);
        break;
      case "stacked_bar":
        if (ms.length === 1 ? shapes[0] !== "series_by_group" : !(ms.length <= 6 && shapes.every((s) => s === "groups") && same(groupKey)))
          at(p, `${w}: a stacked bar shows one metric with group_by and by_time, or 2 to 6 metrics with the same group_by`);
        if (ms.some((m) => m.measure !== "count" && m.measure !== "sum")) at(p, `${w}: stacked parts must add up to a whole: counts or sums only`);
        break;
      case "line": case "area":
        if (ms.length === 1 ? !shapes[0]!.startsWith("series") : !(ms.length <= 4 && shapes.every((s) => s === "series") && same(timeKey)))
          at(p, `${w}: a ${c.type} chart shows 1 to 4 metrics over the same time buckets (by_time with the same every and last), or one with by_time and group_by`);
        break;
      case "table":
        if (!same((m) => `${shapeOf(m)} ${groupKey(m)} ${timeKey(m)}`)) at(p, `${w}: a table's metrics share their grouping (the same group_by and by_time)`);
        break;
    }
    if (c.palette === "ordinal") {
      const g = ms.length === 1 && typeof ms[0]!.group_by === "string" ? columnOf(overOf(ms[0]!)!, ms[0]!.group_by) : null;
      if (!g || typeof g === "string" || g.type !== "enum") at(p, `${w}: an ordinal palette colours the ordered options of one metric's enum group_by`);
      else if (g.options!.length > 5) at(p, `${w}: an ordinal palette has 5 steps; ${ms[0]!.group_by} has ${g.options!.length} options (use categorical, or a table)`);
    }
  }

  // ---------- tabs ----------
  const chart = (pack: string, n: string) => b.charts.find((c) => c.pack === pack && c.name === n) ?? null;
  for (const t of b.tabs) {
    const p = t.pack, w = `tab ${t.id}`;
    if (b.tabs.some((x) => x !== t && x.pack === p && x.id === t.id)) at(p, `${w} is declared twice`);
    if ((b.pages?.[p] ?? []).includes(t.id)) at(p, `${w}: its id is also a page of the pack (both would be /app/packs/${p}/${t.id})`);
    if (t.kind === "area" && !t.areas) {
      const a = area(t.area!);
      if (!a) { at(p, `${w} shows area ${t.area}, which no pack declares`); continue; }
      const views = t.views ?? ["table", "detail"];
      if (views.includes("board")) {
        const by = t.board_by ?? a.lifecycle?.field;
        const f = by ? a.fields.find((x) => x.name === by) : null;
        if (!by) at(p, `${w}: a board needs board_by (an enum field) when area ${a.name} has no lifecycle`);
        else if (!f || f.type !== "enum" || f.multiple) at(p, `${w}: board_by ${by} must name a single-choice enum field of area ${a.name}`);
      }
      if (views.includes("timeline")) {
        const c = pointOf(a, t.timeline_by ?? "updated");
        if (typeof c === "string") at(p, `${w}: timeline_by: ${c}`);
        else if (!("data" in c.at) && (t.timeline_by ?? "updated") !== "updated") at(p, `${w}: timeline_by: a timeline orders records by one of their date fields or by updated`);
      }
      for (const c of t.columns ?? []) if (!a.fields.some((f) => f.name === c)) at(p, `${w}: column ${c} is not a field of area ${a.name}`);
    }
    if (t.kind === "area" && t.areas) {
      // A merged tab (mold_v0-135): every area declared; a field it shows means one thing in every area that has it.
      const list = tabAreas(t);
      const found = list.map((x) => area(x.area));
      const missing = list.filter((_, i) => !found[i]).map((x) => x.area);
      if (missing.length) { at(p, `${w} merges area${missing.length > 1 ? "s" : ""} ${missing.join(", ")}, which no pack declares`); continue; }
      const as = found as SpecArea[];
      const sourced = list.some((x) => x.source);
      const clash = as.filter((a) => a.fields.some((f) => f.name === TAB_SOURCE_COLUMN)).map((a) => a.name);
      if (sourced && clash.length) at(p, `${w}: area ${clash.join(", ")} has a field named ${TAB_SOURCE_COLUMN}, the merged tab's column of its areas' source words: drop the source words, or show another tab`);
      const kind = (f: SpecArea["fields"][number]) => `${f.type}${f.multiple ? "[]" : ""}`;
      /** A field the tab shows: declared by one of its areas, of one type wherever it is declared. */
      const shown = (name: string, why: string): SpecArea["fields"][number] | null => {
        if (name === TAB_SOURCE_COLUMN && sourced) return tabField(t, as, name);
        const decl = as.flatMap((a) => a.fields.filter((f) => f.name === name).map((f) => ({ a: a.name, f })));
        if (!decl.length) { at(p, `${w}: ${why} ${name} is not a field of ${as.map((a) => a.name).join(", ")}`); return null; }
        const kinds = [...new Set(decl.map((d) => kind(d.f)))];
        if (kinds.length > 1) { at(p, `${w}: ${why} ${name} is ${decl.map((d) => `${kind(d.f)} in area ${d.a}`).join(" and ")}: a merged column is one type in every area that has it`); return null; }
        return tabField(t, as, name);
      };
      const views = t.views ?? ["table", "detail"];
      if (views.includes("board")) {
        if (!t.board_by) at(p, `${w}: a merged tab's board names its board_by (an enum field of its areas, or ${TAB_SOURCE_COLUMN})`);
        else { const f = shown(t.board_by, "board_by"); if (f && (f.type !== "enum" || f.multiple)) at(p, `${w}: board_by ${t.board_by} must be a single-choice enum field`); }
      }
      if (views.includes("timeline") && (t.timeline_by ?? "updated") !== "updated") {
        const f = shown(t.timeline_by!, "timeline_by");
        if (f && f.type !== "date") at(p, `${w}: timeline_by: a timeline orders records by one of their date fields or by updated`);
      }
      for (const c of t.columns ?? []) shown(c, "column");
    }
    if (t.kind === "runs" || t.kind === "reports") { if (!b.jobKinds) at(p, `${w}: the build has no job kind, so there are no runs to show`); }
    if (t.kind === "schedules" && !b.jobKinds) at(p, `${w}: the build has no job kind to schedule, so it has no Schedules page`);
    if (t.kind === "credentials" && !b.credentials) at(p, `${w}: the build declares no credential field, so it has no Credentials page`);
    if (t.kind === "notices" && !b.dueAreas) at(p, `${w}: the build has no due dates, so it has no Notices page`);
    // An overview's included sections (mold_v0-134): what each shows must exist, one tab of the build shows each, and the
    // shell page it replaces is not a tab of its own (that page now redirects to this one).
    for (const x of t.include ?? []) {
      if (x === "notices" && !b.dueAreas) at(p, `${w}: include notices: the build has no due dates, so there are no notices to show`);
      const other = b.tabs.find((y) => y !== t && (y.include ?? []).includes(x));
      if (other && b.tabs.indexOf(other) < b.tabs.indexOf(t)) at(p, `${w}: include ${x}: tab ${other.id}${other.pack !== p ? ` of pack ${other.pack}` : ""} already includes it (one home page per build)`);
      const page = b.tabs.find((y) => y.kind === x);
      if (page) at(p, `${w}: include ${x}: tab ${page.id}${page.pack !== p ? ` of pack ${page.pack}` : ""} is the ${x === "setup" ? "Setup" : "Notices"} page, which this tab now shows; drop that tab (its address redirects here)`);
    }
    if (t.kind === "files" && !(b.stores ?? []).includes(p)) at(p, `${w}: the pack has no workspace store (no kind with workspace: true), so it has no files to show`);
    if (t.kind === "page" && b.pages && !(b.pages[p] ?? []).includes(t.page!)) at(p, `${w}: the pack has no app page ${t.page}`);
    const act = t.empty?.cta?.action;
    if (act?.startsWith("onboarding:") && b.steps && !b.steps.some((s) => s.pack === p && s.id === act.slice(11))) at(p, `${w}: empty.cta.action names onboarding step ${act.slice(11)}, which this pack does not declare`);
    if (act?.startsWith("run:") && b.kinds && !b.kinds.some((k) => k.pack === p && k.name === act.slice(4))) at(p, `${w}: empty.cta.action names job kind ${act.slice(4)}, which this pack does not declare`);
    if (tabRoles(t, b).length === 0) at(p, `${w}: no role may read what it shows (its roles, its area's read permission or its metrics' roles leave none)`);
    for (const n of t.charts ?? []) if (!chart(p, n)) at(p, `${w} shows chart ${n}, which the pack does not declare`);
  }
  // Tabs from several packs make one sidebar: an id is a page path per pack, a label must not repeat in a group.
  const seen = new Map<string, string>();
  for (const t of b.tabs) {
    const k = `${t.group ?? ""}\u0000${tabLabel(t, b)}`;
    if (seen.has(k)) at(t.pack, `tab ${t.id}: the sidebar already has "${tabLabel(t, b)}"${t.group ? ` in ${t.group}` : ""} (tab ${seen.get(k)})`);
    else seen.set(k, `${t.pack}/${t.id}`);
  }
  return problems;
}

/** The shell's word for each tab kind (a tab's label when it gives none and shows no area). */
export const TAB_KIND_LABELS: Record<Tab["kind"], string> = {
  overview: "Overview", area: "Records", runs: "Runs", reports: "Reports", credentials: "Credentials", usage: "Activity", schedules: "Schedules",
  notices: "Notices", setup: "Setup", billing: "Billing", profile: "Profile", page: "Page", files: "Files",
};
export const tabLabel = (t: Tab, b: Pick<BuildViews, "areas">) => t.label ?? (t.kind === "area" ? b.areas.find((a) => a.name === tabArea(t))?.label : undefined) ?? TAB_KIND_LABELS[t.kind];

/**
 * Who sees a tab: its `roles` (every role when absent), narrowed by what it shows. An area tab: the area's read
 * permission. An overview: the roles that may read at least one of its charts' metrics. The shell's pages keep their own
 * rules (credentials and schedules show every member what they may see, as today).
 */
export function tabRoles(t: Tab & { pack: string }, b: Pick<BuildViews, "areas" | "metrics" | "charts">): AccountRole[] {
  let roles: AccountRole[] = ACCOUNT_ROLES.filter((r) => !t.roles || t.roles.includes(r));
  if (t.kind === "area") {
    // A merged tab (mold_v0-135): the roles that may read every one of its areas.
    for (const { area } of tabAreas(t)) {
      const a = b.areas.find((x) => x.name === area);
      roles = a ? roles.filter((r) => areaReadRoles(a).includes(r)) : [];
    }
  }
  // A files tab (mold_v0-056): the roles that may read every area of the pack (src/workspace-files.ts storeReadable).
  if (t.kind === "files") roles = roles.filter((r) => b.areas.filter((a) => a.pack === t.pack).every((a) => areaReadRoles(a).includes(r)));
  // An overview that includes a shell section (mold_v0-134) is a home page: every role it names sees it (each section
  // and each chart then shows what the person may read).
  if (t.kind === "overview" && !t.include?.length) {
    const readable = new Set((t.charts ?? []).flatMap((n) => b.charts.find((c) => c.pack === t.pack && c.name === n)?.metrics ?? [])
      .flatMap((n) => { const m = b.metrics.find((x) => x.name === n); return m ? metricRoles(m, b.areas) : []; }));
    roles = roles.filter((r) => readable.has(r));
  }
  return roles;
}

/** What a tab shows while it has nothing to show (mold_v0-107): a title, a line of text and an optional link. */
export interface ResolvedEmpty { title: string; text: string; cta: { label: string; href: string } | null }
/** The Setup page's anchor of a pack's onboarding step (web/src/features/portal/setup.tsx PackChecklist). */
export const onboardingAnchor = (pack: string, step: string) => `onboarding-${pack}-${step}`.replace(/[^A-Za-z0-9_-]/g, "-");
/** "Findings" -> "findings", "Control library" -> "control library"; "API keys" stays (an initialism). */
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/**
 * A tab's empty state (mold_v0-107): its pack.json `empty` where it says one, the shell's default for the rest. The
 * shell's text is a template in the build's words (`fill`: src/words.ts fillWith with the build's words and name); a
 * pack's own text and labels are put in as they are, never filled. `addable(area)`: the area's create tool is on the
 * customer MCP server (src/mcp-catalog.ts: a workspace area, writable, not withheld), so an AI client can add a record.
 * The default for an area tab, in order:
 *   1. an onboarding step that is done when the area has a record (done_when record:<area>): its help, and a link to it
 *   2. a shared (platform) area: the platform adds its records
 *   3. an addable area: ask the AI client to add one, and a link to the Setup page (where a client is connected)
 *   4. an area of a pack with job kinds: its runs add them, and a link to the Setup page
 *   5. else: they appear here as they are added
 * A runs or reports tab ("No <its label> yet.", the label the page is titled with): start one from the AI client, and a
 * link to the Setup page. Other kinds have none (null).
 */
export function tabEmpty(t: SpecTab, b: Pick<BuildViews, "areas" | "steps" | "kinds">, o: { addable: (area: string) => boolean; fill: (text: string) => string }): ResolvedEmpty | null {
  if (t.kind !== "area" && t.kind !== "runs" && t.kind !== "reports") return null;
  const { fill } = o;
  const SETUP = { label: "Open setup", href: "/app" };
  const stepOf = (id: string) => (b.steps ?? []).find((s) => s.pack === t.pack && s.id === id) ?? null;
  const stepCta = (s: { pack: string; id: string }) => ({ label: SETUP.label, href: `/app#${onboardingAnchor(s.pack, s.id)}` });
  const stepText = (s: { label: string; help?: string }) => s.help?.trim() || `Next step on the Setup page: ${s.label}.`;
  let d: ResolvedEmpty;
  if (t.kind === "area") {
    // A merged tab (mold_v0-135) is emptied by its own area, the first: the one that brings its rows first.
    const own = tabArea(t) ?? "";
    const a = b.areas.find((x) => x.name === own);
    const label = a?.label ?? own;
    const title = `No ${lowerFirst(label)} yet.`;
    const step = (b.steps ?? []).filter((s) => s.done_when === `record:${own}`).sort((x, y) => Number(y.pack === t.pack) - Number(x.pack === t.pack))[0];
    if (step) d = { title, text: stepText(step), cta: stepCta(step) };
    else if (a?.scope === "platform") d = { title, text: fill("Every {workspace} shares these. They appear here once they are added for everyone."), cta: null };
    else if (o.addable(own)) d = { title, text: fill("Ask your AI client to add one. Not connected yet? The Setup page shows how."), cta: SETUP };
    else if ((b.kinds ?? []).some((k) => k.pack === a?.pack)) d = { title, text: fill("They appear here as {runs} add them. The Setup page shows how to start one."), cta: SETUP };
    else d = { title, text: fill("They appear here as they are added."), cta: null };
  } else if (t.kind === "runs") d = { title: `No ${lowerFirst(tabLabel(t, b))} yet.`, text: fill("Ask your AI client to start one: it shows here while it runs, and after."), cta: SETUP };
  else d = { title: `No ${lowerFirst(tabLabel(t, b))} yet.`, text: fill("Ask your AI client to start one: it shows here with its results once it finishes."), cta: SETUP };
  const e = t.empty;
  if (!e) return d;
  let cta = d.cta, text = e.text ?? d.text;
  const c = e.cta;
  if (c?.href) cta = { label: c.label!, href: c.href };
  else if (c?.action === "setup") cta = { label: c.label ?? SETUP.label, href: SETUP.href };
  else if (c?.action?.startsWith("onboarding:")) {
    const s = stepOf(c.action.slice(11));
    cta = s ? { ...stepCta(s), label: c.label ?? SETUP.label } : { label: c.label ?? SETUP.label, href: SETUP.href };
    if (s && e.text === undefined) text = stepText(s);
  } else if (c?.action?.startsWith("run:")) {
    const k = (b.kinds ?? []).find((x) => x.pack === t.pack && x.name === c.action!.slice(4));
    cta = { label: c.label ?? SETUP.label, href: SETUP.href };
    if (e.text === undefined) text = `Ask your AI client to start “${k?.label ?? c.action.slice(4)}”. Not connected yet? The Setup page shows how.`;
  }
  return { title: d.title, text, cta };
}

/** A build's views from its installed packs' definitions (validated), for checkViews and the engine. */
export function viewsOf(packs: readonly { id: string; definition: { recordAreas?: unknown[]; metrics?: unknown[]; charts?: unknown[]; tabs?: unknown[]; jobKinds?: unknown[]; agentJobKinds?: unknown[]; credentials?: unknown[]; onboarding?: unknown[] } }[], pages?: Record<string, string[]>): BuildViews {
  const flat = <T>(k: "recordAreas" | "metrics" | "charts" | "tabs", schema: z.ZodType<T>) =>
    packs.flatMap((p) => (p.definition[k] ?? []).map((x) => ({ ...(schema.parse(x) as object), pack: p.id }) as T & { pack: string }));
  const areas = flat("recordAreas", RecordAreaSchema) as SpecArea[];
  return {
    areas, metrics: flat("metrics", MetricSchema) as SpecMetric[], charts: flat("charts", ChartSchema) as SpecChart[], tabs: flat("tabs", TabSchema) as SpecTab[],
    jobKinds: packs.reduce((n, p) => n + (p.definition.jobKinds?.length ?? 0) + (p.definition.agentJobKinds?.length ?? 0), 0),
    credentials: packs.reduce((n, p) => n + (p.definition.credentials?.length ?? 0), 0),
    dueAreas: areas.filter((a) => a.due).length,
    steps: packs.flatMap((p) => (p.definition.onboarding ?? []).map((x) => ({ ...(x as { id: string; label: string; help?: string; done_when: string }), pack: p.id }))),
    kinds: packs.flatMap((p) => [...(p.definition.jobKinds ?? []), ...(p.definition.agentJobKinds ?? [])].map((k) => ({ pack: p.id, name: (k as { name: string }).name, label: (k as { label?: string }).label }))),
    stores: packs.filter((p) => (p.definition.agentJobKinds?.length ?? 0) > 0 || (p.definition.jobKinds ?? []).some((k) => (k as { workspace?: boolean })?.workspace === true)).map((p) => p.id),
    ...(pages ? { pages } : {}),
  };
}
