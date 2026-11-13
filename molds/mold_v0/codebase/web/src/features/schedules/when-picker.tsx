'use client';
// mold_v0-298: when a schedule runs, picked in plain choices in the person's own time zone (every hour, day, weekday,
// week or month, at a time), with the cron expression (UTC) kept as the Advanced choice. It writes the cron text the
// server keeps (./cron-words.ts) and says the result back in words under the fields.
import { useState, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { MONTH_DAYS, cronOf, cronWords, dayName, planOf, zoneName, type Every, type Plan } from './cron-words';

const EVERY: [Every, string][] = [
  ['hour', 'Every hour'], ['day', 'Every day'], ['weekdays', 'Every weekday (Monday to Friday)'], ['week', 'Every week'],
  ['month', 'Every month'], ['custom', 'Advanced (a cron expression, UTC)']
];
/** mold_v0-298: why the choices cannot be kept, in plain words. */
const whyNot = (p: Plan) => p.every === 'custom'
  ? 'Type a cron expression, or pick one of the other choices.'
  : `A monthly schedule is kept in UTC time, where this day and time fall outside day 1 to ${MONTH_DAYS} of the month (so it would miss some months). Pick another day, or another time.`;
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

/**
 * The choices for when a schedule runs, starting from `cron` (UTC); `onChange` gets the new cron text, or null while the
 * choices say nothing it can run (an empty Advanced box, a month day that moves before the 1st in UTC).
 */
export function WhenPicker({ cron, onChange, idPrefix }: { cron: string; onChange: (cron: string | null) => void; idPrefix: string }) {
  const [plan, setPlan] = useState<Plan>(() => planOf(cron));
  const set = (next: Partial<Plan>) => {
    const p = { ...plan, ...next };
    // Moving to Advanced starts from the cron the other choices wrote.
    if (next.every === 'custom' && plan.every !== 'custom') p.cron = cronOf(plan) ?? plan.cron;
    setPlan(p);
    onChange(cronOf(p));
  };
  const out = cronOf(plan);
  const id = (s: string) => `${idPrefix}-${s}`;
  const field = (label: string, key: string, control: ReactNode) => (
    <div className='flex flex-col gap-1.5'><Label htmlFor={id(key)}>{label}</Label>{control}</div>
  );
  const minutes = MINUTES.includes(plan.minute) ? MINUTES : [...MINUTES, plan.minute].sort((a, b) => a - b);
  return (
    <div className='flex flex-col gap-3' data-when-picker=''>
      {field('Repeats', 'every', (
        <NativeSelect id={id('every')} className='w-full' value={plan.every} onChange={(e) => set({ every: e.target.value as Every })}>
          {EVERY.map(([v, l]) => <NativeSelectOption key={v} value={v}>{l}</NativeSelectOption>)}
        </NativeSelect>
      ))}
      {plan.every === 'hour' && field('Minutes past the hour', 'minute', (
        <NativeSelect id={id('minute')} className='w-full' value={String(plan.minute)} onChange={(e) => set({ minute: Number(e.target.value) })}>
          {minutes.map((m) => <NativeSelectOption key={m} value={String(m)}>{m === 0 ? 'On the hour' : `${m} minutes past`}</NativeSelectOption>)}
        </NativeSelect>
      ))}
      {plan.every === 'week' && field('On', 'weekday', (
        <NativeSelect id={id('weekday')} className='w-full' value={String(plan.weekday)} onChange={(e) => set({ weekday: Number(e.target.value) })}>
          {[1, 2, 3, 4, 5, 6, 0].map((d) => <NativeSelectOption key={d} value={String(d)}>{dayName(d)}</NativeSelectOption>)}
        </NativeSelect>
      ))}
      {plan.every === 'month' && field('On day', 'day', (
        <NativeSelect id={id('day')} className='w-full' value={String(plan.day)} onChange={(e) => set({ day: Number(e.target.value) })}>
          {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <NativeSelectOption key={d} value={String(d)}>{d}</NativeSelectOption>)}
        </NativeSelect>
      ))}
      {['day', 'weekdays', 'week', 'month'].includes(plan.every) && field(`At (your time, ${zoneName()})`, 'time', (
        <Input id={id('time')} type='time' step={300} value={plan.time} onChange={(e) => e.target.value && set({ time: e.target.value })} />
      ))}
      {plan.every === 'custom' && field('Cron expression (UTC)', 'cron', (
        <Input id={id('cron')} className='font-mono text-xs' value={plan.cron} onChange={(e) => set({ cron: e.target.value })}
          aria-describedby={id('cron-help')} />
      ))}
      {plan.every === 'custom' && (
        <p id={id('cron-help')} className='text-muted-foreground text-xs'>
          Five fields, in UTC: minute, hour, day of the month, month, day of the week. It may run at most every 5 minutes.
        </p>
      )}
      <p className='text-sm' aria-live='polite'>
        {out ? <>Runs: <span className='font-medium'>{cronWords(out, { zone: true })}</span></> : <span className='text-destructive'>{whyNot(plan)}</span>}
      </p>
    </div>
  );
}
