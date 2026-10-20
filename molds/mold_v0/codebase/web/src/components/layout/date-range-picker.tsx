'use client';
// A Firebase-style date range picker: presets on the left (today, yesterday, last 7/14/30/90 days, this and last month),
// two months of calendar for a custom range, and Apply / Cancel. Dates are whole days in UTC, both ends included.
import { useState } from 'react';
import type { DateRange as DayRange } from 'react-day-picker';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';

export interface DateRange { from: string; to: string } // YYYY-MM-DD

const DAY = 86_400_000;
const iso = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);
const local = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const back = (days: number) => new Date(today().getTime() - days * DAY);

export const PRESETS: { id: string; label: string; range: () => DateRange }[] = [
  { id: 'today', label: 'Today', range: () => ({ from: iso(today()), to: iso(today()) }) },
  { id: 'yesterday', label: 'Yesterday', range: () => ({ from: iso(back(1)), to: iso(back(1)) }) },
  { id: '7d', label: 'Last 7 days', range: () => ({ from: iso(back(6)), to: iso(today()) }) },
  { id: '14d', label: 'Last 14 days', range: () => ({ from: iso(back(13)), to: iso(today()) }) },
  { id: '30d', label: 'Last 30 days', range: () => ({ from: iso(back(29)), to: iso(today()) }) },
  { id: '90d', label: 'Last 90 days', range: () => ({ from: iso(back(89)), to: iso(today()) }) },
  { id: 'month', label: 'This month', range: () => { const t = today(); return { from: iso(new Date(t.getFullYear(), t.getMonth(), 1)), to: iso(t) }; } },
  { id: 'last-month', label: 'Last month', range: () => { const t = today(); return { from: iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)), to: iso(new Date(t.getFullYear(), t.getMonth(), 0)) }; } }
];

/** The default period: the last 30 days. */
export const last30 = () => PRESETS[4].range();
/** For an API query string: from=…&to=… */
export const rangeQuery = (r: DateRange) => `from=${r.from}&to=${r.to}`;

const fmt = (s: string, year: boolean) => local(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
export function rangeLabel(r: DateRange) {
  const preset = PRESETS.find((p) => { const x = p.range(); return x.from === r.from && x.to === r.to; });
  if (preset) return preset.label;
  const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
  return r.from === r.to ? fmt(r.from, true) : `${fmt(r.from, !sameYear)} – ${fmt(r.to, true)}`;
}

export function DateRangePicker({ value, onChange, className }: { value: DateRange; onChange: (r: DateRange) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DayRange | undefined>();
  const begin = (o: boolean) => { setOpen(o); if (o) setDraft({ from: local(value.from), to: local(value.to) }); };
  const apply = (r: DateRange) => { onChange(r); setOpen(false); };
  const active = PRESETS.find((p) => { const x = p.range(); return x.from === value.from && x.to === value.to; })?.id;
  return (
    <Popover open={open} onOpenChange={begin}>
      <PopoverTrigger render={<Button variant='outline' className={cn('justify-start gap-2 font-normal', className)} />}>
        <Icons.calendar className='size-4' /> <span className='truncate'>{rangeLabel(value)}</span>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-auto p-0'>
        <div className='flex max-sm:flex-col'>
          <ul className='flex shrink-0 flex-col gap-0.5 border-r p-2 max-sm:flex-row max-sm:flex-wrap max-sm:border-r-0 max-sm:border-b sm:w-40'>
            {PRESETS.map((p) => (
              <li key={p.id}>
                <button type='button' onClick={() => apply(p.range())}
                  className={cn('hover:bg-muted w-full rounded-md px-2.5 py-1.5 text-left text-sm leading-none', active === p.id && 'bg-primary/15 text-primary font-medium')}>
                  {p.label}
                </button>
              </li>
            ))}
          </ul>
          <div className='flex flex-col'>
            <Calendar mode='range' numberOfMonths={2} selected={draft} onSelect={setDraft} defaultMonth={draft?.from} disabled={{ after: today() }} autoFocus />
            <div className='flex items-center gap-2 border-t p-3'>
              <span className='text-muted-foreground text-xs'>
                {draft?.from ? `${fmt(iso(draft.from), true)}${draft.to ? ` – ${fmt(iso(draft.to), true)}` : ' – pick an end date'}` : 'Pick a start date'}
              </span>
              <Button variant='ghost' size='sm' className='ml-auto' onClick={() => setOpen(false)}>Cancel</Button>
              <Button size='sm' disabled={!draft?.from} onClick={() => draft?.from && apply({ from: iso(draft.from), to: iso(draft.to ?? draft.from) })}>Apply</Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
