// A list tab's cards in words (mold_v0-181; ./sparklines.tsx draws them): a card's number and what its sparkline says,
// for a screen reader. Pure, relative imports only, so a test reads it without a browser (scripts/record-pages-test.ts).

export type Unit = 'count' | 'number' | 'usd' | 'percent' | 'percent_100' | 'days' | 'hours';
/** How a card reads its metric (src/metric-spec.ts SparkMode): a running total, week by week, or this period's bucket. */
export type SparkMode = 'total' | 'weekly' | 'latest';
/** The console's number format (./charts.tsx formatValue). */
export type Format = (v: number | null, unit: Unit) => string;

/** A card's number: an hour under one reads in minutes (a run's average duration). */
export function cardValue(v: number | null, unit: Unit, format: Format): string {
  if (unit === 'hours' && v !== null && v < 1) return `${Math.max(0, Math.round(v * 60))} min`;
  return format(v, unit);
}

/**
 * The trend in words: "Week by week: rising over the last 12 weeks, from 3 to 8." The first and last weeks that have a
 * value are compared (a week with nothing to average has none); within 5% of the larger is steady.
 */
export function trendWords(c: { series: (number | null)[]; unit: Unit; mode: SparkMode }, weeks: number, format: Format): string {
  const xs = c.series.filter((v): v is number => v !== null);
  const span = `the last ${weeks} weeks`;
  if (xs.length < 2) return `No trend yet over ${span}.`;
  const a = xs[0]!, z = xs[xs.length - 1]!;
  const what = c.mode === 'total' ? 'Running total' : 'Week by week';
  if (Math.abs(z - a) <= 0.05 * Math.max(Math.abs(a), Math.abs(z))) return `${what}: steady over ${span}, at ${cardValue(z, c.unit, format)}.`;
  return `${what}: ${z > a ? 'rising' : 'falling'} over ${span}, from ${cardValue(a, c.unit, format)} to ${cardValue(z, c.unit, format)}.`;
}
