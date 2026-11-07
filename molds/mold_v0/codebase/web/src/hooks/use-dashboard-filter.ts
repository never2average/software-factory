'use client';
// A dashboard's filter (mold_v0-260, flag filters_in_address): kept in the page's address while the flag is on, so a
// link reproduces the view and Back steps through the filters; off, kept in the page as it always was. The flag is the
// build's (one value for the life of the page), so the same hooks are called in the same order either way.
import { useState } from 'react';
import { useQueryState } from 'nuqs';
import { featureOn } from '@/config/features';
import { last30, type DateRange } from '@/components/layout/date-range-picker';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A text filter (a search, a kind, a status): `?<key>=` while the flag is on; empty is absent. */
export function useDashboardText(key: string, initial = ''): [string, (v: string) => void] {
  const inAddress = featureOn('filters_in_address');
  const [own, setOwn] = useState(initial);
  const [q, setQ] = useQueryState(key, { defaultValue: initial });
  return inAddress ? [q, (v) => void setQ(v === initial ? null : v)] : [own, setOwn];
}

/** A period: `?from=&to=` (YYYY-MM-DD) while the flag is on, the last 30 days when absent or not a date. */
export function useDashboardRange(make: () => DateRange = last30): [DateRange, (r: DateRange) => void] {
  const inAddress = featureOn('filters_in_address');
  const [own, setOwn] = useState<DateRange>(make);
  const [from, setFrom] = useQueryState('from');
  const [to, setTo] = useQueryState('to');
  if (!inAddress) return [own, setOwn];
  const d = make();
  const range = from && to && DAY.test(from) && DAY.test(to) && from <= to ? { from, to } : d;
  const set = (r: DateRange) => {
    const same = r.from === d.from && r.to === d.to;
    void setFrom(same ? null : r.from); void setTo(same ? null : r.to);
  };
  return [range, set];
}
