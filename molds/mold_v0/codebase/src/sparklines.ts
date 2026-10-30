/**
 * A list tab's four cards (mold_v0-181; molds/mold_v0/MOLD.md "Pack and record-area contract"): between the toolbar
 * and the table of an area, runs, reports or schedules tab, four cards, each a label, a value and a sparkline of its
 * last SPARK_WEEKS weeks. Which four is pure (src/metric-spec.ts sparkPlan: the tab's `sparklines`, else the shell's for
 * its kind); this computes them for one workspace, as `actor` may read them: every number is a metric computed by the
 * metric engine (src/metrics.ts computeSpec), under its workspace's row-level security, with its area's read permission
 * and its roles checked for the person. No SQL of its own.
 *
 * A card the person may not read (its metric's roles, its area's read permission) or that fails says so alone (`error`,
 * `status`), so one card never hides the others, as on the charts.
 */
import { metricRoles, metricUnit, RUN_SOURCES, sparkPlan, sparkSeries, SPARK_WEEKS, tabLabel, type RunSource, type SparkMode, type SpecMetric, type SpecTab } from "./metric-spec.js";
import { bucketsOf, buildViews, computeSpec, type MetricAnswer, type MetricOptions, type Sealed } from "./metrics.js";
import { packOpWithheld } from "./mcp-withheld.js";
import { PackError } from "./pack-api.js";
import type { Actor } from "./record-areas.js";
import { fill } from "./vocabulary.js";

export interface SparkAnswer {
  id: string;
  label: string;
  unit: ReturnType<typeof metricUnit>;
  mode: SparkMode;
  /** The card's number (null: nothing to measure yet, as a metric's average of no rows). */
  value: number | null;
  /** One value per week of `buckets` (the answer's), oldest first. */
  series: (number | null)[];
  /** The card could not be read by this person (403) or computed (500): its label stays, its numbers do not. */
  error?: string;
  status?: number;
}
export interface SparkAnswers { weeks: number; buckets: string[]; as_of: string; cards: SparkAnswer[] }

const overOf = (m: SpecMetric) => ((RUN_SOURCES as readonly string[]).includes(m.over) ? (m.over as RunSource) : buildViews().areas.find((a) => a.name === m.over) ?? null);
const lastOf = (a: MetricAnswer) => a.series?.[0]?.values.at(-1) ?? null;
const valuesOf = (a: MetricAnswer) => a.series?.[0]?.values ?? [];

/** The four cards of `tab` for one workspace, as `actor` may read them. `now` fixes "this week" (tests pass their own). */
export async function computeSparklines(orgId: number, tab: SpecTab, actor: Actor, now = new Date()): Promise<SparkAnswers> {
  const b = buildViews();
  const readable = (m: SpecMetric) => !packOpWithheld(m.pack, "metrics") && (actor.role === null || metricRoles(m, b.areas).includes(actor.role));
  const plan = sparkPlan(tab, b, { readable, fill, label: tabLabel(tab, b) });
  const opts: MetricOptions = { sealed: new Map<string, Promise<Sealed>>() };
  const { days } = bucketsOf({ at: "created", every: "week", last: SPARK_WEEKS }, now);
  const cards: SparkAnswer[] = [];
  // One card at a time: a request holds one database connection (each card is one or two aggregate queries).
  for (const c of plan) {
    const over = overOf(c.value);
    const base = { id: c.id, label: c.label, unit: metricUnit(c.value, over), mode: c.mode };
    try {
      // A declared metric its pack withholds (mold_v0-067) is withheld here too, as on /api/metrics.
      if (!c.id.startsWith("_") && packOpWithheld(c.value.pack, "metrics")) throw new PackError(`no metric ${c.id}`, 404);
      const v = await computeSpec(orgId, c.value, actor, now, opts);
      if (c.top) {
        // The most common value of the main enum (ties: the first in its options' order), and its rows by week added.
        const top = (v.groups ?? []).reduce<NonNullable<MetricAnswer["groups"]>[number] | null>((x, g) => (g.key !== null && (g.value ?? 0) > (x?.value ?? 0) ? g : x), null);
        if (!top || top.key === null) { cards.push({ ...base, unit: "count", label: c.top.label, value: 0, series: days.map(() => 0) }); continue; }
        const only: SpecMetric = { ...c.value, group_by: undefined, where: [...(c.value.where ?? []), { field: c.top.field, op: "eq", value: top.key }] };
        const s = await computeSpec(orgId, sparkSeries(only), actor, now, opts);
        cards.push({ ...base, unit: "count", label: `${c.top.label}: ${top.label}`, value: top.value, series: running(top.value ?? 0, valuesOf(s)) });
        continue;
      }
      if (c.mode === "latest") { cards.push({ ...base, value: lastOf(v), series: valuesOf(c.series === c.value ? v : await computeSpec(orgId, c.series, actor, now, opts)) }); continue; }
      const s = await computeSpec(orgId, c.series, actor, now, opts);
      cards.push({ ...base, value: v.value ?? null, series: c.mode === "total" ? running(v.value ?? 0, valuesOf(s)) : valuesOf(s) });
    } catch (e) {
      if (e instanceof PackError) { cards.push({ ...base, value: null, series: [], error: e.message, status: e.status }); continue; }
      // A database error can echo row values: its code only (as /api/metrics answers).
      const code = (e as { code?: unknown }).code;
      console.error(`sparkline ${tab.pack}/${tab.id}/${c.id}: ${(e as Error).message}`);
      cards.push({ ...base, value: null, series: [], error: typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? `The card could not be computed (database error ${code}).` : "The card could not be computed.", status: 500 });
    }
  }
  return { weeks: SPARK_WEEKS, buckets: days, as_of: now.toISOString(), cards };
}

/**
 * A running total ending at `total`: the rows a count (or sum) reads today, by the week each was added. Week i holds
 * everything added up to its end: the total less what was added in the weeks after it.
 */
export function running(total: number, weekly: (number | null)[]): number[] {
  const out = new Array<number>(weekly.length);
  let after = 0;
  for (let i = weekly.length - 1; i >= 0; i--) {
    out[i] = Math.round((total - after) * 1e6) / 1e6;
    after += weekly[i] ?? 0;
  }
  return out;
}
