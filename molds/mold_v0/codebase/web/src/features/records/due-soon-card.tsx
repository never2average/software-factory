'use client';
// The home page's Due soon card (mold_v0-207): the records coming due or overdue across the workspace, from the record
// clocks (mold_v0-191; src/record-clocks.ts dueAcross, GET /api/records/due-soon). Overdue first, then the soonest due,
// up to DUE_SOON_ROWS, each row its record's title, area and clock, a badge and a relative date, a link to the record's
// page; View all opens the area's list (its Overdue filter on when something is overdue). The server reads the
// workspace's own records only (its tenant scope), of the areas this person's role may read.
//   No clock in the build: no card. A clock area left nothing to read for this role: no card either, as a
//   tab is never shown to a role that may not read it. Nothing due: a calm line, never an alarm.
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Icons } from '@/components/icons';
import { packTabs, recordAreas } from '@/config/pack-nav.generated';
import { FloatPanel } from '@/features/portal/float-panel';
import { ErrorState, useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export const DUE_SOON_ROWS = 6;
/** Whether any of the build's record areas declares a clock: without one the card is never drawn. */
export const buildHasClocks = recordAreas.some((a) => (a.clocks?.length ?? 0) > 0);

interface DueRow {
  area: string; area_label: string; key: string; title: string | null; clock: string; clock_label: string;
  status: 'overdue' | 'due_soon'; due_at: string | null; due_on: string | null; overdue: boolean; overdue_days: number | null;
}
interface DuePage { as_of: string; total: number; overdue: number; areas: { name: string; label: string }[]; records: DueRow[] }

/** Where an area's records are listed: its own list tab (inside a sections tab: that tab's page), else its records page. */
export function areaListUrl(area: string): string {
  const tab = packTabs.find((t) => t.kind === 'area' && t.area === area && !t.areas && !t.filtered);
  if (tab) {
    const host = packTabs.find((t) => t.kind === 'sections' && t.pack === tab.pack && t.sections?.includes(tab.id));
    return host ? `${host.url}?tab=${encodeURIComponent(tab.id)}` : tab.url;
  }
  return `/app/records/${encodeURIComponent(area)}`;
}
const withOverdue = (url: string) => `${url}${url.includes('?') ? '&' : '?'}overdue=1`;

const DAY = 86_400_000;
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
/** A deadline against the time the server read it: "yesterday", "in 3 days", "2 weeks ago". */
export function relativeDue(dueAt: string, asOf: string): string {
  const days = Math.round((Date.parse(dueAt) - Date.parse(asOf)) / DAY);
  if (Math.abs(days) >= 14) return rtf.format(Math.round(days / 7), 'week');
  return rtf.format(days, 'day');
}

export function DueSoonClocksCard() {
  const { data, error } = useOrgLoad(async () => {
    const res = await fetch(`/api/records/due-soon?limit=${DUE_SOON_ROWS}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as DuePage & { error?: string };
    if (!res.ok) throw httpError(res.status, body);
    return body;
  });
  if (!buildHasClocks) return null;
  // A role that may read no clock area: nothing this card could ever show it.
  if (data && !data.areas.length) return null;
  const shownAreas = data ? [...new Map(data.records.map((r) => [r.area, r.area_label])).entries()] : [];
  const viewAll = data && data.total > 0 ? shownAreas.slice(0, 2).map(([name, label]) => {
    const overdue = data.records.some((r) => r.area === name && r.overdue);
    return { name, label, href: overdue ? withOverdue(areaListUrl(name)) : areaListUrl(name) };
  }) : [];
  const one = viewAll.length === 1 ? viewAll[0] : null;
  return (
    <FloatPanel title='Due soon' icon={<Icons.calendar />}
      description={data && data.total > 0 ? `${data.overdue ? `${data.overdue} overdue, ` : ''}${data.total - data.overdue} due soon` : 'Deadlines coming up across this workspace.'}
      action={one ? <Link href={one.href} className='text-primary shrink-0 text-xs font-medium hover:underline' data-due-soon-all>View all</Link> : undefined}>
      {error ? <ErrorState error={error} /> : !data ? (
        <div className='flex flex-col gap-2' aria-busy='true' aria-label='Loading due dates'>
          {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className='h-10 w-full' />)}
        </div>
      ) : !data.records.length ? (
        <div className='flex items-center gap-3 rounded-lg border border-dashed px-3 py-4' data-due-soon-empty>
          <Icons.circleCheck aria-hidden className='text-muted-foreground size-5 shrink-0' />
          <div className='min-w-0'>
            <p className='text-sm font-medium'>Nothing is due or overdue</p>
            <p className='text-muted-foreground text-xs'>Records show here as their deadlines come near.</p>
          </div>
        </div>
      ) : (<>
        <ul className='-mx-1 flex flex-col gap-0.5' aria-label='Records due soon or overdue'>
          {data.records.map((r) => (
            <li key={`${r.area}/${r.key}/${r.clock}`}>
              <Link href={`/app/records/${encodeURIComponent(r.area)}/${encodeURIComponent(r.key)}`} data-due-row={r.status}
                className='hover:bg-muted/60 focus-visible:ring-ring flex items-start gap-3 rounded-lg px-2 py-2 outline-hidden focus-visible:ring-2'>
                <span className='min-w-0 flex-1'>
                  <span className='block truncate text-sm font-medium'>{r.title ?? r.key}</span>
                  <span className='text-muted-foreground block truncate text-xs'>{r.area_label} · {r.clock_label}</span>
                </span>
                <span className='flex shrink-0 flex-col items-end gap-1'>
                  <Badge variant={r.overdue ? 'destructive' : 'secondary'} data-clock-status={r.status}>
                    {r.overdue ? (r.overdue_days ? `Overdue ${r.overdue_days}d` : 'Overdue') : 'Due soon'}
                  </Badge>
                  {r.due_at && <time dateTime={r.due_at} title={r.due_on ?? undefined} className={cn('text-xs tabular-nums', r.overdue ? 'text-destructive' : 'text-muted-foreground')}>{relativeDue(r.due_at, data.as_of)}</time>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {viewAll.length > 1 && (
          <div className='flex flex-wrap gap-x-4 gap-y-1 px-1'>
            {viewAll.map((v) => <Link key={v.name} href={v.href} className='text-primary text-xs font-medium hover:underline' data-due-soon-all>View all {v.label.toLowerCase()}</Link>)}
          </div>
        )}
      </>)}
    </FloatPanel>
  );
}
