/**
 * Metrics (mold_v0-063; molds/mold_v0/MOLD.md "Pack and record-area contract"): what a pack declares in `metrics`
 * (src/pack-api.ts MetricSchema), computed on the server for one workspace. Read only.
 *
 *   over a record area   its shared rows (platform_records) or the workspace's own (workspace_records), read inside
 *                        withTenant for the workspace with org_id named as well, so row-level security refuses another
 *                        workspace's rows whatever the query says
 *   over run_results     the workspace's run results; over runs: its runs (the same, under their own policies)
 *
 * How: one aggregate query per metric (count, sum, avg, a rate as avg of 0/1, a duration's avg, percentile or max; GROUP
 * BY a field's value, a due-date bucket or a date_trunc bucket), bounded by its workspace, area and window, a group LIMIT
 * and a statement timeout. Field names, values, states and buckets reach the query only as bound parameters; what is
 * written into its text comes from fixed tables here (a column of runs or run_results, an operator, an aggregate).
 * Sealed rows (an asset area's: their data is encrypted with the workspace key) cannot be read by SQL: they are opened
 * here and the same metric is evaluated in code over at most MAX_SEALED_ROWS of them (the answer then says `partial`).
 *
 * Who: a person reads a metric when their role may read its area (the area's `read` permission) and is in its `roles`;
 * an account API key has no role limits, as for every shell read. A reference's group label is its record's title only
 * when they may read that record's area, else its key.
 */
import { getDb } from "./db.js";
import { ensureOrgKey, isSealed, open, openJson } from "./orgcrypto.js";
import { PackError, type Metric } from "./pack-api.js";
import { columnOf, metricRoles, metricUnit, pointOf, RUN_SOURCES, viewsOf, type BuildViews, type Column, type RunSource, type SpecArea, type SpecMetric } from "./metric-spec.js";
import { packs } from "./packs.js";
import { findArea, may, type Actor } from "./record-areas.js";
import { withTenant } from "./tenant-scope.js";

/** Rows of a sealed area opened and evaluated in code, at most. */
export const MAX_SEALED_ROWS = 5000;
/** Bytes of a sealed area's rows opened for one request, at most (a row's data may be up to 256 KB). */
export const MAX_SEALED_BYTES = 32 * 1024 * 1024;
/** Metrics one request computes at once (each holds a database connection while it runs). */
export const METRIC_CONCURRENCY = 4;
/** One metric query's time on the database, at most. */
export const METRIC_TIMEOUT_MS = 5000;
/** Metrics one request may ask for, at most. */
export const MAX_METRICS_PER_REQUEST = 30;

export interface MetricAnswer {
  name: string; label: string; description: string | null;
  unit: ReturnType<typeof metricUnit>; measure: Metric["measure"];
  kind: "single" | "groups" | "series";
  value?: number | null;
  groups?: { key: string | null; label: string; value: number | null }[];
  /** More groups than `limit` exist (the largest are shown). */
  more?: boolean;
  /** Series: each bucket's first day (YYYY-MM-DD, UTC), and one series per group (one, keyed null, without group_by). */
  buckets?: string[];
  series?: { key: string | null; label: string; values: (number | null)[] }[];
  /** Rows the metric read (after `where`). */
  rows: number;
  /** A sealed area with more rows than MAX_SEALED_ROWS (or MAX_SEALED_BYTES): computed over its newest rows only. */
  partial?: boolean;
  as_of: string;
}
export type MetricResult = MetricAnswer | { name: string; error: string; status: number };

let cache: { from: unknown; views: BuildViews } | null = null;
export function buildViews(): BuildViews {
  const list = packs();
  if (cache?.from === list) return cache.views;
  cache = { from: list, views: viewsOf(list) };
  return cache.views;
}
export const findMetric = (name: string) => buildViews().metrics.find((m) => m.name === name) ?? null;

// ---------- time ----------

const DAY = 86_400_000;
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
/** A condition's date: YYYY-MM-DD (UTC midnight), today or now with +/- days. */
export function resolveDate(v: string, now: Date): Date {
  const m = /^(today|now)([+-]\d{1,4})?$/.exec(v);
  if (m) return new Date((m[1] === "today" ? utcDay(now) : now).getTime() + Number(m[2] ?? 0) * DAY);
  return new Date(safeTime(v) ?? Number.NaN);
}
/** The start of the bucket holding `d` (UTC; weeks start on Monday, as Postgres' date_trunc). */
export function bucketStart(d: Date, every: "day" | "week" | "month"): Date {
  const day = utcDay(d);
  if (every === "day") return day;
  if (every === "month") return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY);
}
const addBuckets = (d: Date, every: "day" | "week" | "month", n: number) =>
  every === "month" ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)) : new Date(d.getTime() + n * (every === "week" ? 7 : 1) * DAY);
/** The `last` buckets up to now: their first days, the window's start and its end (exclusive). */
export function bucketsOf(by: NonNullable<Metric["by_time"]>, now: Date) {
  const cur = bucketStart(now, by.every);
  const start = addBuckets(cur, by.every, -(by.last - 1));
  const days = Array.from({ length: by.last }, (_, i) => addBuckets(start, by.every, i).toISOString().slice(0, 10));
  return { days, start, end: addBuckets(cur, by.every, 1) };
}

/**
 * A stored date as a point in time, never failing: YYYY-MM-DD (a day past the month's end rolls over, as the record
 * store's own check reads it; years 1000 to 9999) and an optional THH:MM (UTC); anything else is no date. The SQL below is the same rule.
 */
export function safeTime(s: unknown): number | null {
  if (typeof s !== "string" || !/^[1-9]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/.test(s)) return null;
  const base = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, 1) + (Number(s.slice(8, 10)) - 1) * DAY;
  return /^.{10}[T ]([01]\d|2[0-3]):[0-5]\d/.test(s) ? base + Number(s.slice(11, 13)) * 3_600_000 + Number(s.slice(14, 16)) * 60_000 : base;
}
const SAFE_TIME_SQL = (s: string) => `(CASE WHEN ${s} ~ '^[1-9]\\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])'
  THEN ((make_date(substr(${s}, 1, 4)::int, substr(${s}, 6, 2)::int, 1) + (substr(${s}, 9, 2)::int - 1))::timestamp
    + CASE WHEN ${s} ~ '^.{10}[T ]([01]\\d|2[0-3]):[0-5]\\d' THEN substr(${s}, 12, 5)::time ELSE time '00:00' END) AT TIME ZONE 'UTC' END)`;

// ---------- the SQL ----------

/** The source a metric reads: a record area (shared or the workspace's) or a run source. */
type Source = { area: SpecArea } | { run: RunSource };
const sourceOf = (m: SpecMetric): Source => ((RUN_SOURCES as readonly string[]).includes(m.over) ? { run: m.over as RunSource } : { area: buildViews().areas.find((a) => a.name === m.over)! });
const overOf = (s: Source) => ("area" in s ? s.area : s.run);

/** Columns of runs and run_results the engine may name in SQL: a fixed list, never a declaration's text. */
const RUN_SQL: Record<string, string> = {
  status: "t.status", check: "(t.check_area || '/' || t.check_key)", asset: "(CASE WHEN t.asset_key IS NULL THEN NULL ELSE t.asset_area || '/' || t.asset_key END)",
  source: "(CASE WHEN t.source_key IS NULL THEN NULL ELSE t.source_area || '/' || t.source_key END)", check_area: "t.check_area", kind: "t.kind",
  error_kind: "t.error_kind", cost_usd: "t.cost_usd", created_at: "t.created_at", started_at: "t.started_at", ended_at: "t.ended_at", updated_at: "t.updated_at",
};

class Sql {
  params: unknown[] = [];
  p(v: unknown) { this.params.push(v); return `$${this.params.length}`; }
  text(c: Column): string {
    if ("data" in c.at) return `(t.data ->> ${this.p(c.at.data)})`;
    if ("detail" in c.at) return `(t.detail ->> ${this.p(c.at.detail)})`;
    if ("state" in c.at) return `(t.data -> ${this.p("$state_at")} ->> ${this.p(c.at.state)})`;
    const col = RUN_SQL[c.at.column];
    if (!col) throw new Error(`no column ${c.at.column}`);
    return c.type === "time" ? `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS')` : `${col}::text`;
  }
  num(c: Column): string {
    if ("data" in c.at) { const k = this.p(c.at.data); return `(CASE WHEN jsonb_typeof(t.data -> ${k}) = 'number' THEN (t.data ->> ${k})::float8 END)`; }
    return `(${RUN_SQL[(c.at as { column: string }).column]})::float8`;
  }
  time(c: Column): string {
    if ("column" in c.at) return RUN_SQL[c.at.column]!;
    return SAFE_TIME_SQL(this.text(c));
  }
  bool(c: Column): string { const k = this.p((c.at as { data: string }).data); return `(CASE WHEN jsonb_typeof(t.data -> ${k}) = 'boolean' THEN (t.data ->> ${k})::boolean END)`; }
  /** A list field (enum, person or reference with `multiple`): its JSON array. */
  list(c: Column): string { return `(t.data -> ${this.p((c.at as { data: string }).data)})`; }
}

const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
/** One condition as SQL over the row `t`. */
function condSql(q: Sql, over: SpecArea | RunSource, c: NonNullable<Metric["where"]>[number], now: Date): string {
  const col = columnOf(over, c.field) as Column;
  const vals = c.value === undefined ? [] : Array.isArray(c.value) ? c.value : [c.value];
  if (col.multiple) {
    const l = q.list(col);
    const empty = `(jsonb_typeof(${l}) IS DISTINCT FROM 'array' OR jsonb_array_length(${l}) = 0)`;
    if (c.op === "empty") return empty;
    if (c.op === "not_empty") return `NOT ${empty}`;
    return `(jsonb_typeof(${l}) = 'array' AND ${l} ?| ${q.p(vals.map(asText))}::text[])`;
  }
  if (col.type === "number" || col.type === "time") {
    const x = col.type === "number" ? q.num(col) : q.time(col);
    if (c.op === "empty") return `(${x} IS NULL)`;
    if (c.op === "not_empty") return `(${x} IS NOT NULL)`;
    const op = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[c.op as "lt"]!;
    return col.type === "number" ? `(${x} ${op} ${q.p(c.value)}::float8)` : `(${x} ${op} ${q.p(resolveDate(String(c.value), now).toISOString())}::timestamptz)`;
  }
  if (col.type === "boolean") {
    const x = q.bool(col);
    if (c.op === "empty") return `(${x} IS NULL)`;
    if (c.op === "not_empty") return `(${x} IS NOT NULL)`;
    const any = `(${x} = ANY (${q.p(vals)}::boolean[]))`;
    return c.op === "eq" || c.op === "in" ? any : `(${x} IS NULL OR NOT ${any})`;
  }
  const x = q.text(col);
  if (c.op === "empty") return `(${x} IS NULL OR ${x} = '')`;
  if (c.op === "not_empty") return `(${x} IS NOT NULL AND ${x} <> '')`;
  const any = `(${x} = ANY (${q.p(vals.map(asText))}::text[]))`;
  return c.op === "eq" || c.op === "in" ? any : `(${x} IS NULL OR NOT ${any})`;
}

/** The measure's aggregate over the rows of a group, and the expression of the value it reads (to count those rows). */
function measureSql(q: Sql, m: SpecMetric, over: SpecArea | RunSource, now: Date): { agg: string; counted: string } {
  switch (m.measure) {
    case "count": return { agg: "count(*)::float8", counted: "count(*)" };
    case "sum": { const x = q.num(columnOf(over, m.field!) as Column); return { agg: `coalesce(sum(${x}), 0)::float8`, counted: "count(*)" }; }
    case "average": { const x = q.num(columnOf(over, m.field!) as Column); return { agg: `avg(${x})::float8`, counted: `count(${x})` }; }
    case "rate": return { agg: `avg(CASE WHEN ${m.rate!.where.map((c) => condSql(q, over, c, now)).join(" AND ")} THEN 1.0 ELSE 0.0 END)::float8`, counted: "count(*)" };
    case "duration": {
      const d = m.duration!;
      const raw = `(EXTRACT(EPOCH FROM (${q.time(pointOf(over, d.to) as Column)} - ${q.time(pointOf(over, d.from) as Column)})) / ${d.unit === "days" ? 86400 : 3600}.0)`;
      // A span that ends before it starts (a state entered again since: fixed, reopened, ...) is not a duration.
      const span = `(CASE WHEN ${raw} >= 0 THEN ${raw} END)`;
      const agg = d.stat === "average" ? `avg(${span})` : d.stat === "max" ? `max(${span})` : `percentile_cont(${d.stat === "median" ? 0.5 : 0.9}) WITHIN GROUP (ORDER BY ${span})`;
      return { agg: `${agg}::float8`, counted: `count(${span})` };
    }
  }
}

/**
 * A list field's items as rows of one text column `v` (a lateral join on `t`): its distinct string items, a single
 * string as one item (a link may hold one key), nothing otherwise. group_by_list "each" (mold_v0-076).
 */
function itemsSql(q: Sql, c: Column): string {
  const x = q.list(c);
  return `LEFT JOIN LATERAL (SELECT DISTINCT e.j #>> '{}' AS v FROM jsonb_array_elements(CASE jsonb_typeof(${x}) WHEN 'array' THEN ${x}
    WHEN 'string' THEN jsonb_build_array(${x}) ELSE '[]'::jsonb END) AS e(j) WHERE jsonb_typeof(e.j) = 'string') g ON true`;
}

/** The group key of a row: a field's value (as text), a list's first item or each item, or its due-date bucket. */
function groupSql(q: Sql, m: SpecMetric, over: SpecArea | RunSource, now: Date): string {
  const g = m.group_by!;
  if (typeof g === "string") {
    const col = columnOf(over, g) as Column;
    if (m.group_by_list === "each") return "g.v";
    if (m.group_by_list === "first") {
      const x = q.list(col);
      return `(CASE jsonb_typeof(${x}) WHEN 'array' THEN (CASE WHEN jsonb_typeof(${x} -> 0) = 'string' THEN ${x} ->> 0 END) WHEN 'string' THEN ${x} #>> '{}' END)`;
    }
    return col.type === "boolean" ? `(${q.bool(col)})::text` : q.text(col);
  }
  const d = q.time(columnOf(over, g.due) as Column);
  const today = utcDay(now);
  return `(CASE WHEN ${d} IS NULL THEN 'none' WHEN ${d} < ${q.p(today.toISOString())}::timestamptz THEN 'overdue'
    WHEN ${d} < ${q.p(new Date(today.getTime() + g.soon_days * DAY).toISOString())}::timestamptz THEN 'due_soon' ELSE 'later' END)`;
}

type Cell = { k: string | null; b: string | null; v: number | null; n: number };

/** A metric's cells, and (group_by_list "each", where a row may sit in several groups) the rows it read. */
type Cells = { cells: Cell[]; rows?: number };

async function runSql(orgId: number, m: SpecMetric, src: Source, now: Date): Promise<Cells> {
  // One statement per call: the cells (grouped), or for "each" also the rows read (the same rows, not grouped).
  const statement = (grouped: boolean) => {
    const q = new Sql();
    const over = overOf(src);
    const each = grouped && m.group_by_list === "each" && typeof m.group_by === "string";
    const table = "area" in src ? (src.area.scope === "platform" ? "platform_records" : "workspace_records") : src.run === "runs" ? "runs" : "run_results";
    const join = each ? ` ${itemsSql(q, columnOf(over, m.group_by as string) as Column)}` : "";
    const scope = "area" in src
      ? src.area.scope === "platform"
        ? `t.pack = ${q.p(src.area.pack)} AND t.area = ${q.p(src.area.name)}`
        : `t.org_id = ${q.p(orgId)} AND t.pack = ${q.p(src.area.pack)} AND t.area = ${q.p(src.area.name)} AND NOT t.sealed`
      : `t.org_id = ${q.p(orgId)}`;
    const from = `FROM ${table} t${join} WHERE ${scope}`;
    const where = (m.where ?? []).map((c) => condSql(q, over, c, now));
    const { agg, counted } = measureSql(q, m, over, now);
    let bucket = "NULL::text";
    if (m.by_time) {
      const at = q.time(pointOf(over, m.by_time.at) as Column);
      const w = bucketsOf(m.by_time, now);
      where.push(`${at} >= ${q.p(w.start.toISOString())}::timestamptz AND ${at} < ${q.p(w.end.toISOString())}::timestamptz`);
      if (grouped) bucket = `to_char(date_trunc(${q.p(m.by_time.every)}, ${at} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
    }
    const filter = where.length ? ` AND ${where.join(" AND ")}` : "";
    if (!grouped) return { sql: `SELECT ${counted}::int AS n ${from}${filter}`, params: q.params };
    const key = m.group_by !== undefined ? groupSql(q, m, over, now) : "NULL::text";
    const col = typeof m.group_by === "string" ? (columnOf(over, m.group_by) as Column) : null;
    // A field's values (not an enum's options, a boolean or due buckets) are many: the largest groups, and one more to know.
    const bounded = m.group_by !== undefined && !m.by_time && col && col.type !== "enum" && col.type !== "boolean";
    return { sql: `SELECT ${key} AS k, ${bucket} AS b, ${agg} AS v, ${counted}::int AS n ${from}${filter}
    GROUP BY 1, 2${bounded ? ` ORDER BY 3 DESC NULLS LAST, 1 LIMIT ${q.p(m.limit + 1)}` : ""}`, params: q.params };
  };
  const db = await getDb();
  return withTenant(orgId, () => db.transaction(async (tx) => {
    await tx.query(`SET LOCAL statement_timeout = ${METRIC_TIMEOUT_MS}`);
    const c = statement(true);
    const cells = await tx.query<Cell>(c.sql, c.params);
    if (m.group_by_list !== "each") return { cells };
    const t = statement(false);
    const [r] = await tx.query<{ n: number }>(t.sql, t.params);
    return { cells, rows: Number(r?.n ?? 0) };
  }));
}

// ---------- the same rules in code, for sealed rows ----------

type Row = { data: Record<string, unknown>; created_at: string; updated_at: string };
function jsValue(c: Column, r: Row): unknown {
  if ("data" in c.at) return r.data[c.at.data];
  if ("state" in c.at) { const t = r.data["$state_at"]; return t && typeof t === "object" ? (t as Record<string, unknown>)[c.at.state] : undefined; }
  if ("column" in c.at) return c.at.column === "created_at" ? r.created_at : c.at.column === "updated_at" ? r.updated_at : undefined;
  return undefined;
}
const jsText = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));
const jsNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const jsTime = (c: Column, r: Row): number | null => {
  const v = jsValue(c, r);
  if ("column" in c.at) return v ? new Date(String(v)).getTime() : null;
  return safeTime(jsText(v));
};
function jsCond(over: SpecArea, c: NonNullable<Metric["where"]>[number], r: Row, now: Date): boolean {
  const col = columnOf(over, c.field) as Column;
  const vals = c.value === undefined ? [] : Array.isArray(c.value) ? c.value : [c.value];
  const v = jsValue(col, r);
  if (col.multiple) {
    const empty = !Array.isArray(v) || v.length === 0;
    if (c.op === "empty") return empty;
    if (c.op === "not_empty") return !empty;
    return Array.isArray(v) && v.some((x) => typeof x === "string" && vals.map(asText).includes(x));
  }
  if (col.type === "number" || col.type === "time") {
    const x = col.type === "number" ? jsNum(v) : jsTime(col, r);
    if (c.op === "empty") return x === null;
    if (c.op === "not_empty") return x !== null;
    if (x === null) return false;
    const y = col.type === "number" ? Number(c.value) : resolveDate(String(c.value), now).getTime();
    return c.op === "lt" ? x < y : c.op === "lte" ? x <= y : c.op === "gt" ? x > y : x >= y;
  }
  if (col.type === "boolean") {
    const x = typeof v === "boolean" ? v : null;
    if (c.op === "empty") return x === null;
    if (c.op === "not_empty") return x !== null;
    const any = x !== null && vals.includes(x);
    return c.op === "eq" || c.op === "in" ? any : !any;
  }
  const x = jsText(v);
  if (c.op === "empty") return x === null || x === "";
  if (c.op === "not_empty") return x !== null && x !== "";
  const any = x !== null && vals.map(asText).includes(x);
  return c.op === "eq" || c.op === "in" ? any : !any;
}
const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b), pos = p * (s.length - 1), lo = Math.floor(pos);
  return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (pos - lo);
};
/** A list field's string items, as the SQL reads them: a single string is one item (a link may hold one key). */
const jsItems = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter((x): x is string => typeof x === "string");
function jsCells(m: SpecMetric, area: SpecArea, rows: Row[], now: Date): Cells {
  const keep = rows.filter((r) => (m.where ?? []).every((c) => jsCond(area, c, r, now)));
  const cells = new Map<string, Row[]>();
  const read: Row[] = [];
  const w = m.by_time ? bucketsOf(m.by_time, now) : null;
  const atCol = m.by_time ? (pointOf(area, m.by_time.at) as Column) : null;
  for (const r of keep) {
    let b: string | null = null;
    if (w) {
      const t = jsTime(atCol!, r);
      if (t === null || t < w.start.getTime() || t >= w.end.getTime()) continue;
      b = bucketStart(new Date(t), m.by_time!.every).toISOString().slice(0, 10);
    }
    read.push(r);
    let ks: (string | null)[] = [null];
    if (typeof m.group_by === "string") {
      const col = columnOf(area, m.group_by) as Column;
      const v = jsValue(col, r);
      if (m.group_by_list === "each") { const items = [...new Set(jsItems(v))]; ks = items.length ? items : [null]; }
      else if (m.group_by_list === "first") ks = [Array.isArray(v) ? (typeof v[0] === "string" ? v[0] : null) : typeof v === "string" ? v : null];
      else ks = [col.type === "boolean" ? (typeof v === "boolean" ? String(v) : null) : jsText(v)];
    } else if (m.group_by) {
      const d = jsTime(columnOf(area, m.group_by.due) as Column, r), today = utcDay(now).getTime();
      ks = [d === null ? "none" : d < today ? "overdue" : d < today + m.group_by.soon_days * DAY ? "due_soon" : "later"];
    }
    for (const k of ks) {
      const id = JSON.stringify([k, b]);
      if (!cells.has(id)) cells.set(id, []);
      cells.get(id)!.push(r);
    }
  }
  const out: Cell[] = [];
  const measure = (rs: Row[]): { v: number | null; n: number } => {
    let v: number | null, n = rs.length;
    if (m.measure === "count") v = rs.length;
    else if (m.measure === "sum" || m.measure === "average") {
      const xs = rs.map((r) => jsNum(jsValue(columnOf(area, m.field!) as Column, r))).filter((x): x is number => x !== null);
      v = m.measure === "sum" ? xs.reduce((a, x) => a + x, 0) : xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null;
      if (m.measure === "average") n = xs.length;
    } else if (m.measure === "rate") v = rs.filter((r) => m.rate!.where.every((c) => jsCond(area, c, r, now))).length / rs.length;
    else {
      const d = m.duration!, from = pointOf(area, d.from) as Column, to = pointOf(area, d.to) as Column;
      const xs = rs.map((r) => { const a = jsTime(from, r), z = jsTime(to, r); return a === null || z === null ? null : (z - a) / (d.unit === "days" ? DAY : 3_600_000); })
        .filter((x): x is number => x !== null && x >= 0);
      n = xs.length;
      v = !xs.length ? null : d.stat === "average" ? xs.reduce((a, x) => a + x, 0) / xs.length : d.stat === "max" ? Math.max(...xs) : percentile(xs, d.stat === "median" ? 0.5 : 0.9);
    }
    return { v, n };
  };
  for (const [id, rs] of cells) {
    const [k, b] = JSON.parse(id) as [string | null, string | null];
    out.push({ k, b, ...measure(rs) });
  }
  const rowsRead = m.group_by_list === "each" ? { rows: measure(read).n } : {};
  const col = typeof m.group_by === "string" ? (columnOf(area, m.group_by) as Column) : null;
  if (m.group_by !== undefined && !m.by_time && col && col.type !== "enum" && col.type !== "boolean")
    return { cells: out.sort((x, y) => (y.v ?? -Infinity) - (x.v ?? -Infinity) || (x.k === y.k ? 0 : x.k === null ? 1 : y.k === null ? -1 : x.k.localeCompare(y.k))).slice(0, m.limit + 1), ...rowsRead };
  return { cells: out, ...rowsRead };
}

/**
 * A sealed area's rows, opened with the workspace's key: its newest MAX_SEALED_ROWS, and no more than MAX_SEALED_BYTES
 * of them (`partial` when either cut). Opened one at a time (the key loaded once), so one request holds one area's rows.
 */
export type Sealed = { rows: Row[]; partial: boolean };
async function sealedRows(orgId: number, area: SpecArea): Promise<Sealed> {
  return withTenant(orgId, async () => {
    const rows = await (await getDb()).query<{ data: unknown; created_at: Date | string; updated_at: Date | string; bytes: number }>(
      "SELECT data, created_at, updated_at, octet_length(data::text) AS bytes FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 ORDER BY id DESC LIMIT $4",
      [orgId, area.pack, area.name, MAX_SEALED_ROWS + 1]);
    const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();
    await ensureOrgKey(orgId);
    const out: Row[] = [];
    let bytes = 0;
    for (const r of rows.slice(0, MAX_SEALED_ROWS)) {
      bytes += Number(r.bytes);
      if (bytes > MAX_SEALED_BYTES) break;
      out.push({ data: await openJson(orgId, r.data), created_at: iso(r.created_at), updated_at: iso(r.updated_at) });
    }
    return { rows: out, partial: out.length < rows.length };
  });
}
/** Does the workspace hold sealed rows in this area? (An asset area's always are; mold_v0-066 may seal others.) */
async function hasSealed(orgId: number, area: SpecArea): Promise<boolean> {
  if (area.scope !== "workspace") return false;
  if (area.role === "asset") return true;
  const [r] = await withTenant(orgId, async () => (await getDb()).query<{ x: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND sealed) AS x", [orgId, area.pack, area.name]));
  return !!r?.x;
}

// ---------- answers ----------

const round = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6);
const DUE_LABELS = (soon: number): Record<string, string> => ({ overdue: "Overdue", due_soon: `Due within ${soon} day${soon === 1 ? "" : "s"}`, later: "Later", none: "No date" });

/** Group labels: an enum's option labels, Yes/No, due buckets, a referenced record's title (when the actor may read it). */
async function labeler(orgId: number, m: SpecMetric, over: SpecArea | RunSource, keys: (string | null)[], actor: Actor): Promise<(k: string | null) => string> {
  if (m.group_by === undefined) return () => m.label;
  if (typeof m.group_by === "object") { const l = DUE_LABELS(m.group_by.soon_days); return (k) => l[k ?? "none"] ?? String(k); }
  const col = columnOf(over, m.group_by) as Column;
  if (col.type === "enum") return (k) => (k === null ? "No value" : col.labels?.[k] ?? k);
  if (col.type === "boolean") return (k) => (k === "true" ? "Yes" : k === "false" ? "No" : "No value");
  if (col.type !== "reference" || (!col.to && typeof over !== "string")) return (k) => (k === null || k === "" ? "No value" : k);
  // A reference field's value is a key of its area; a run result's check, asset or source is "area/key".
  const byArea = new Map<string, string[]>();
  for (const k of keys.filter((x): x is string => !!x).slice(0, 51)) {
    const [areaName, key] = col.to ? [col.to, k] : [k.slice(0, k.indexOf("/")), k.slice(k.indexOf("/") + 1)];
    byArea.set(areaName!, [...(byArea.get(areaName!) ?? []), key!]);
  }
  const titles = new Map<string, string>(), restricted = new Set<string>();
  for (const [areaName, ks] of byArea) {
    const full = (key: string) => (col.to ? key : `${areaName}/${key}`);
    const a = findArea(areaName);
    if (!a) continue;
    // A record the person may not read is named neither by its title nor by its key.
    if (!may(a, "read", actor)) { for (const key of ks) restricted.add(full(key)); continue; }
    for (const [key, t] of await titlesOf(orgId, a, ks)) titles.set(full(key), t);
  }
  return (k) => (k === null ? "No value" : restricted.has(k) ? "Restricted" : titles.get(k) ?? k);
}

/** The titles of some records of an area, in one query (a sealed title opened with the workspace's key). */
async function titlesOf(orgId: number, a: NonNullable<ReturnType<typeof findArea>>, keys: string[]): Promise<Map<string, string>> {
  const db = await getDb();
  const rows = a.scope === "platform"
    ? await withTenant(orgId, () => db.query<{ key: string; title: string | null }>("SELECT key, title FROM platform_records WHERE pack = $1 AND area = $2 AND key = ANY ($3::text[])", [a.pack, a.name, keys]))
    : await withTenant(orgId, () => db.query<{ key: string; title: string | null }>("SELECT key, title FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = ANY ($4::text[])", [orgId, a.pack, a.name, keys]));
  const out = new Map<string, string>();
  for (const r of rows) if (r.title) out.set(r.key, isSealed(r.title) ? await withTenant(orgId, () => open(orgId, r.title!)) : r.title);
  return out;
}

/** One metric for one workspace, as `actor` may read it. `now` fixes "today" (tests pass their own clock). */
export async function computeMetric(orgId: number, name: string, actor: Actor, now = new Date(), opts: MetricOptions = {}): Promise<MetricAnswer> {
  const m = findMetric(name);
  if (!m) throw new PackError(`no metric ${JSON.stringify(String(name).slice(0, 64))}`, 404);
  return computeSpec(orgId, m, actor, now, opts);
}
export type MetricOptions = { forceCode?: boolean; sealed?: Map<string, Promise<Sealed>> };

/**
 * A metric given whole (a declared one, or one the shell makes from a declaration: a card's weekly series, its default
 * cards; src/sparklines.ts), over an area or run source of the build, under the same rules as a declared one.
 */
export async function computeSpec(orgId: number, m: SpecMetric, actor: Actor, now = new Date(), opts: MetricOptions = {}): Promise<MetricAnswer> {
  if (actor.role !== null && !metricRoles(m, buildViews().areas).includes(actor.role)) throw new PackError(`Your role can't read ${m.label}.`, 403);
  const src = sourceOf(m);
  const over = overOf(src);
  let got: Cells, partial = false;
  if ("area" in src && (opts.forceCode || (await hasSealed(orgId, src.area)))) {
    // One read of an area's sealed rows per request, shared by its metrics.
    const cache = opts.sealed ?? new Map<string, Promise<Sealed>>();
    if (!cache.has(src.area.name)) cache.set(src.area.name, sealedRows(orgId, src.area));
    const sealed = await cache.get(src.area.name)!;
    partial = sealed.partial;
    got = jsCells(m, src.area, sealed.rows, now);
  } else got = await runSql(orgId, m, src, now);
  const cells = got.cells;

  const base = { name: m.name, label: m.label, description: m.description ?? null, unit: metricUnit(m, over), measure: m.measure, as_of: now.toISOString(), ...(partial ? { partial } : {}) };
  // A row grouped by each item of its list sits in several groups: the rows read are counted once (got.rows).
  const rows = got.rows ?? cells.reduce((a, c) => a + Number(c.n), 0);
  const empty = m.measure === "count" || m.measure === "sum" ? 0 : null;
  const label = await labeler(orgId, m, over, [...new Set(cells.map((c) => c.k))], actor);
  /** A group the person may not read is shown without its key too. */
  const hide = (k: string | null, i: number) => (k !== null && label(k) === "Restricted" ? `restricted-${i}` : k);
  const col = typeof m.group_by === "string" ? (columnOf(over, m.group_by) as Column) : null;
  /** Group keys in their order: an enum's options (then any stored value no longer one), true/false, due buckets; else by value. */
  const ordered = (keys: (string | null)[]): (string | null)[] => {
    const fixed = typeof m.group_by === "object" ? ["overdue", "due_soon", "later", "none"] : col?.type === "enum" ? col.options! : col?.type === "boolean" ? ["true", "false"] : null;
    if (!fixed) return keys;
    return [...fixed, ...keys.filter((k) => k === null || !fixed.includes(k))].filter((k, i, a) => a.indexOf(k) === i);
  };
  if (!m.by_time && m.group_by === undefined) return { ...base, kind: "single", value: round(cells[0]?.v ?? empty), rows };
  if (!m.by_time) {
    const byKey = new Map(cells.map((c) => [c.k, c]));
    let keys = ordered(cells.map((c) => c.k));
    // An enum's options and the due buckets show at zero; a stored value outside them only when it has rows.
    if (typeof m.group_by === "object" || col?.type === "enum" || col?.type === "boolean") keys = keys.filter((k) => byKey.has(k) || (k !== null && (typeof m.group_by === "object" ? k !== "none" : true)));
    const more = keys.length > m.limit;
    return { ...base, kind: "groups", groups: keys.slice(0, m.limit).map((k, i) => ({ key: hide(k, i), label: label(k), value: round(byKey.get(k)?.v ?? empty) })), more, rows };
  }
  const { days } = bucketsOf(m.by_time, now);
  const keys = m.group_by === undefined ? [null] : ordered([...new Set(cells.map((c) => c.k))]).filter((k) => col?.type === "enum" || col?.type === "boolean" ? k !== null || cells.some((c) => c.k === null) : true);
  const at = new Map(cells.map((c) => [JSON.stringify([c.k, c.b]), c.v]));
  return {
    ...base, kind: "series", buckets: days, rows,
    series: keys.map((k, i) => ({ key: hide(k, i), label: m.group_by === undefined ? m.label : label(k), values: days.map((d) => round(at.get(JSON.stringify([k, d])) ?? empty)) })),
  };
}

/** Several metrics at once (the console's charts): each answer, or its refusal, by name. */
export async function computeMetrics(orgId: number, names: string[], actor: Actor, now = new Date()): Promise<MetricResult[]> {
  if (names.length > MAX_METRICS_PER_REQUEST) throw new PackError(`at most ${MAX_METRICS_PER_REQUEST} metrics at once`, 400);
  const sealed = new Map<string, Promise<Sealed>>();
  const one = async (n: string): Promise<MetricResult> => {
    try { return await computeMetric(orgId, n, actor, now, { sealed }); }
    catch (e) {
      if (e instanceof PackError) return { name: n, error: e.message, status: e.status };
      // A database error can echo row values: its code only (as the record tools do).
      const code = (e as { code?: unknown }).code;
      console.error(`metric ${n}: ${(e as Error).message}`);
      return { name: n, error: typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? `The metric could not be computed (database error ${code}).` : "The metric could not be computed.", status: 500 };
    }
  };
  // A few at a time: one request never holds more than METRIC_CONCURRENCY database connections.
  const list = [...new Set(names)], out: MetricResult[] = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(METRIC_CONCURRENCY, list.length) }, async () => {
    while (next < list.length) { const i = next++; out[i] = await one(list[i]!); }
  }));
  return out;
}
