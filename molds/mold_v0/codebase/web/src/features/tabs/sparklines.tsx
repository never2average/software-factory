'use client';
// A list tab's four cards (mold_v0-181): between the toolbar (search, filters, Export CSV) and the table of an area,
// runs, reports or schedules tab, four cards, each a label, a value and a sparkline of its last weeks. Which four, and
// their numbers, are the server's (GET /api/sparklines/<pack>/<tab>, src/sparklines.ts: the tab's pack.json
// `sparklines`, else the shell's for its kind), for this workspace, as the person's role may read each. Drawn as the
// console's headline numbers (StatStrip, the Health and Spend pages' cards): four across on a wide screen, two by two
// below, a fixed height with placeholders while they load, and each card's value and trend said in words.
import { useMemo } from 'react';
import { StatStrip } from '@/components/layout/section';
import type { PackTabSpec } from '@/config/pack-nav.generated';
import { useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { formatValue } from './charts';
import { cardValue, trendWords, type SparkMode, type Unit } from './spark-words';

export interface SparkCard {
  id: string; label: string; unit: Unit; mode: SparkMode;
  value: number | null; series: (number | null)[]; error?: string; status?: number;
}
export interface SparkAnswers { weeks: number; buckets: string[]; as_of: string; cards: SparkCard[] }

const value = (v: number | null, unit: Unit) => cardValue(v, unit, formatValue);

/** A week with nothing to measure (no row to average) draws at the week before it (the first: at the first that has one). */
const drawn = (series: (number | null)[]) => {
  let last = series.find((v) => v !== null) ?? 0;
  return series.map((v) => (v === null ? last : (last = v)));
};

const pulse = <span className='bg-muted inline-block h-7 w-16 animate-pulse rounded-md align-bottom' />;
const labelPulse = <span className='bg-muted inline-block h-3 w-24 animate-pulse rounded-sm align-middle' />;

/** The four cards of a list tab, for the RecordView's `summary` (below its toolbar) or above a board or timeline. */
export function TabSparklines({ tab }: { tab: Pick<PackTabSpec, 'pack' | 'id'> }) {
  const url = `/api/sparklines/${encodeURIComponent(tab.pack)}/${encodeURIComponent(tab.id)}`;
  const { data, error } = useOrgLoad(async () => {
    const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as SparkAnswers & { error?: string };
    if (!res.ok) throw httpError(res.status, body);
    return body;
  }, [url]);
  const items = useMemo(() => {
    if (!data) return Array.from({ length: 4 }, () => ({ label: labelPulse, value: pulse }));
    return data.cards.map((c) => {
      // A card this role may not read, or that failed, keeps its place and its label, and says why.
      if (c.error) return { label: c.label, value: '—', said: c.status === 403 ? 'Not shown to your role.' : 'Not available.' };
      return {
        label: c.label, value: value(c.value, c.unit), spark: c.series.some((v) => v !== null) ? drawn(c.series) : undefined,
        // Read after the label (the list's term): the number, then the trend.
        said: `${value(c.value, c.unit)}. ${trendWords(c, data.weeks, formatValue)}`
      };
    });
  }, [data]);
  // Cards that cannot be read at all (the API predates them, a network failure) leave the list as it was.
  if (error || (data && !data.cards.length)) return null;
  return (
    <section aria-label='Key numbers' aria-busy={!data || undefined} data-sparklines={`${tab.pack}/${tab.id}`}>
      <StatStrip quad items={items} />
    </section>
  );
}
