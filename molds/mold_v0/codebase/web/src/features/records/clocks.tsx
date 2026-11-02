'use client';
// A record area's clocks in the console (mold_v0-191; src/record-clocks.ts): every record of an area that declares a
// clock carries `clocks` {name: {due_at, status, overdue, ...}} from /api/records. The list shows each clock as a column
// (its deadline and a status badge) with its status as a filter, and an Overdue toggle above the table; the record page
// shows each clock and what it did (its reminders and escalation steps).
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { RecordCol } from '@/components/layout/record-view';
import type { RecordAreaSpec } from '@/config/pack-nav.generated';

export type ClockStatus = 'not_started' | 'on_track' | 'due_soon' | 'overdue' | 'paused' | 'met' | 'missed';
export interface ClockView {
  name: string; label: string; status: ClockStatus; started_at: string | null; due_at: string | null; due_on: string | null;
  overdue: boolean; overdue_days: number | null; paused_ms: number; stopped_at: string | null;
}
export interface ClockEvent { clock: string; label: string; step: string; what: string; due_at: string | null; at: string }
type WithClocks = { clocks?: Record<string, ClockView> };

/** The statuses in words, in the order the filter lists them. */
export const CLOCK_STATUS_LABELS: Record<ClockStatus, string> = {
  overdue: 'Overdue', due_soon: 'Due soon', on_track: 'On track', paused: 'Paused', missed: 'Missed', met: 'Met', not_started: 'No deadline'
};
const VARIANT: Record<ClockStatus, 'destructive' | 'secondary' | 'outline'> = {
  overdue: 'destructive', missed: 'destructive', due_soon: 'secondary', on_track: 'outline', paused: 'outline', met: 'outline', not_started: 'outline'
};

/** A clock's status as a badge; overdue says by how many days. */
export function ClockBadge({ v }: { v: ClockView }) {
  const text = v.status === 'overdue' && v.overdue_days ? `Overdue ${v.overdue_days}d` : CLOCK_STATUS_LABELS[v.status];
  return <Badge variant={VARIANT[v.status]} data-clock-status={v.status}>{text}</Badge>;
}

/** Each clock of the area as two columns: its deadline (a date, with the status beside it) and its status (a filter). */
export function clockColumns<T extends WithClocks>(area: RecordAreaSpec): RecordCol<T>[] {
  return (area.clocks ?? []).flatMap((c): RecordCol<T>[] => [
    {
      key: `_clock_${c.name}`, label: c.label, type: 'date', keep: false,
      value: (r) => r.clocks?.[c.name]?.due_at ?? null,
      render: (r) => {
        const v = r.clocks?.[c.name];
        if (!v?.due_on) return <span className='text-muted-foreground'>—</span>;
        return <span className='flex items-center gap-2 whitespace-nowrap'><span className='tabular-nums'>{v.due_on}</span><ClockBadge v={v} /></span>;
      }
    },
    {
      key: `_clock_${c.name}_status`, label: `${c.label}: status`, type: 'select', keep: false, hidden: true,
      options: (Object.keys(CLOCK_STATUS_LABELS) as ClockStatus[]).map((s) => ({ value: s, label: CLOCK_STATUS_LABELS[s] })),
      value: (r) => r.clocks?.[c.name]?.status ?? null,
      render: (r) => { const v = r.clocks?.[c.name]; return v ? <ClockBadge v={v} /> : <span className='text-muted-foreground'>—</span>; }
    }
  ]);
}

/** Whether any clock of the record is overdue. */
export const isOverdue = (r: WithClocks) => Object.values(r.clocks ?? {}).some((v) => v.overdue);

/** The Overdue filter above the table: a toggle with the count. */
export function OverdueToggle({ count, on, onChange }: { count: number; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <Button variant={on ? 'secondary' : 'outline'} size='sm' aria-pressed={on} data-overdue-filter onClick={() => onChange(!on)}>
      Overdue <span className='tabular-nums'>{count}</span>
    </Button>
  );
}

/** The record page's clocks: each deadline and status, then what the clocks did, newest first. */
export function ClockSection({ record, events }: { record: WithClocks; events?: ClockEvent[] }) {
  const views = Object.values(record.clocks ?? {});
  if (!views.length) return null;
  return (
    <section className='flex flex-col gap-3' aria-label='Deadlines'>
      <h2 className='text-sm font-medium'>Deadlines</h2>
      <dl className='grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[12rem_1fr]'>
        {views.map((v) => (
          <div key={v.name} className='contents'>
            <dt className='text-muted-foreground text-sm'>{v.label}</dt>
            <dd className='flex flex-wrap items-center gap-2 text-sm'>
              <span className='tabular-nums'>{v.due_on ?? '—'}</span><ClockBadge v={v} />
              {v.stopped_at && <span className='text-muted-foreground'>stopped {v.stopped_at.slice(0, 10)}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {!!events?.length && (
        <ul className='flex flex-col gap-1 text-sm'>
          {events.map((e, i) => (
            <li key={i} className='text-muted-foreground'><span className='tabular-nums'>{e.at.slice(0, 10)}</span> · {e.label}: {e.what}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
