/**
 * THE METRICS AN ACCOUNT RECORD AREA DECLARES (records.areas.<area>.metrics; deployments, implementations), COUNTED IN
 * THE DATABASE: what the record-area panel shows above its list (GET /api/ops/record-metrics?area=), each with its
 * attention flag.
 *
 *   count: { where }       the records the condition holds for;
 *   ratio: { num, den }    of the records `den` holds for, the share `num` also holds for, as a percent (0 when none);
 *   sum:   { field, where } a number field added up over the records `where` holds for.
 *
 * A condition is the list query's (agent/lib/record-query.ts parseRecordQuery + compileRecordQuery): the same fields,
 * operators and categories, computed fields compiled to their CASE, `{today}` / `{today±Nd}` as the day it runs. So a
 * metric counts exactly the rows the list shows for that filter. One SELECT per area, every metric a FILTER of it,
 * inside the caller's workspace (withOrgDb / withOrgRls, and `org_id` named).
 *
 * A metric's text is formatted as it says (`count`, `percent`, `money`); `attention` holds when the definition flags
 * it and the value is not zero, as the tasks view shows its own (app/_components/ops/task-area-parts.tsx).
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { RECORD_AREAS, type RecordArea } from "./record-areas.generated.ts";
import { areaView, type RecordAreas } from "./record-areas.ts";
import type { AccountAreaId } from "./record-area-records.ts";
import { compileRecordQuery, numericFieldSql, parseRecordQuery, type AreaTable } from "./record-query.ts";

export type RecordMetricDef = NonNullable<RecordArea["metrics"]>[number];
export interface RecordMetric {
  id: string;
  label: string;
  /** null when the definition's condition cannot be counted here (`error` says why). */
  value: number | null;
  text: string;
  /** The definition flags it and it is not zero: it asks to be looked at. */
  attention: boolean;
  format: "count" | "percent" | "money";
  error?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const DAY = 86_400_000;

/** `{today}` / `{today+7d}` / `{today-3d}` anywhere in a condition, as the day `now` falls on (yyyy-mm-dd). */
export function resolveToday(where: unknown, now: Date): unknown {
  if (typeof where === "string") {
    const m = /^\{today(?:([+-]\d{1,3})d)?\}$/.exec(where);
    return m ? new Date(now.getTime() + (m[1] ? Number(m[1]) : 0) * DAY).toISOString().slice(0, 10) : where;
  }
  if (Array.isArray(where)) return where.map((x) => resolveToday(x, now));
  if (isObj(where)) return Object.fromEntries(Object.entries(where).map(([k, x]) => [k, resolveToday(x, now)]));
  return where;
}

/** One condition as SQL over the area's table in `orgId`, or why it cannot be. */
function whereSql(id: AccountAreaId, where: unknown, t: AreaTable, orgId: string, areas: RecordAreas, now: Date): { sql: SQL } | { error: string } {
  const parsed = parseRecordQuery(id, { where: (resolveToday(where ?? {}, now) as Record<string, unknown>) ?? {}, limit: 1 }, areas);
  if (!parsed.ok) return { error: parsed.errors.join(" ") };
  return { sql: compileRecordQuery(id, parsed.query, t, orgId, areas, now).where };
}

/** The format a metric is shown in: its own, else a ratio's percent, else a count. */
export const formatOf = (m: RecordMetricDef): RecordMetric["format"] => m.format ?? (m.ratio ? "percent" : "count");

/** A value as the metric shows it. */
export function metricText(m: RecordMetricDef, value: number | null, currency?: string): string {
  if (value === null) return "—";
  const format = formatOf(m);
  if (format === "percent") return `${Math.round(value)}%`;
  if (format === "money") return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ""}`;
  return value.toLocaleString("en-US");
}

/** A metric's value and how it reads. */
export function metricOf(m: RecordMetricDef, value: number | null, areas: RecordAreas, id: AccountAreaId, error?: string): RecordMetric {
  const currency = m.sum?.field ? areaView(id, areas).field(m.sum.field)?.currency : undefined;
  return { id: m.id, label: m.label, value, text: metricText(m, value, currency), attention: Boolean(m.attention) && value !== null && value > 0, format: formatOf(m), ...(error ? { error } : {}) };
}

/**
 * The SELECT list that counts every metric of the area in one pass: `m<i>` (a count, a sum, a ratio's numerator) and
 * `d<i>` (a ratio's denominator). Metrics whose condition cannot be compiled come back in `errors` by index.
 */
export function compileMetrics(id: AccountAreaId, t: AreaTable, orgId: string, areas: RecordAreas = RECORD_AREAS, now: Date = new Date()): { select: Record<string, SQL>; errors: Map<number, string> } {
  const select: Record<string, SQL> = {};
  const errors = new Map<number, string>();
  for (const [i, m] of (areas[id].metrics ?? []).entries()) {
    try {
      if (m.ratio) {
        const den = whereSql(id, m.ratio.den, t, orgId, areas, now);
        const num = whereSql(id, m.ratio.num, t, orgId, areas, now);
        if ("error" in den || "error" in num) { errors.set(i, "error" in den ? den.error : (num as { error: string }).error); continue; }
        select[`m${i}`] = sql<number>`(count(*) filter (where ${den.sql} and ${num.sql}))::int`;
        select[`d${i}`] = sql<number>`(count(*) filter (where ${den.sql}))::int`;
      } else if (m.sum) {
        const w = whereSql(id, m.sum.where, t, orgId, areas, now);
        if ("error" in w) { errors.set(i, w.error); continue; }
        select[`m${i}`] = sql<number>`coalesce(sum(${numericFieldSql(id, m.sum.field ?? "", t, areas, now)}) filter (where ${w.sql}), 0)::float8`;
      } else {
        const w = whereSql(id, m.count?.where, t, orgId, areas, now);
        if ("error" in w) { errors.set(i, w.error); continue; }
        select[`m${i}`] = sql<number>`(count(*) filter (where ${w.sql}))::int`;
      }
    } catch (e) {
      errors.set(i, e instanceof Error ? e.message : String(e));
    }
  }
  return { select, errors };
}

/** The metrics from the one row compileMetrics' SELECT returned. */
export function metricsFrom(id: AccountAreaId, row: Record<string, unknown> | undefined, errors: Map<number, string>, areas: RecordAreas = RECORD_AREAS): RecordMetric[] {
  return (areas[id].metrics ?? []).map((m, i) => {
    const err = errors.get(i);
    if (err) return metricOf(m, null, areas, id, err);
    const n = Number(row?.[`m${i}`] ?? 0);
    if (m.ratio) {
      const d = Number(row?.[`d${i}`] ?? 0);
      return metricOf(m, d ? (n / d) * 100 : 0, areas, id);
    }
    return metricOf(m, n, areas, id);
  });
}

type SelectTx = { select: (fields: Record<string, SQL>) => { from: (t: never) => { where: (w: SQL) => PromiseLike<Record<string, unknown>[]> } } };

/** Count the area's metrics in the caller's workspace. `tx` is a transaction scoped to `orgId` (withOrgDb / withOrgRls). */
export async function countRecordMetrics(tx: unknown, id: AccountAreaId, t: AreaTable, orgId: string, areas: RecordAreas = RECORD_AREAS, now: Date = new Date()): Promise<RecordMetric[]> {
  if (!(areas[id].metrics ?? []).length) return [];
  const { select, errors } = compileMetrics(id, t, orgId, areas, now);
  // The rows are the workspace's (and every metric's own condition names it again).
  const rows = Object.keys(select).length ? await (tx as SelectTx).select(select).from(t as never).where(eq(t.orgId, orgId)) : [{}];
  return metricsFrom(id, rows[0], errors, areas);
}
