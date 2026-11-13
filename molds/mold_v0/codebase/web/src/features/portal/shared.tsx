'use client';
// Small helpers shared by the portal pages: data loading keyed by the active Clerk organization, spend meter,
// copy buttons, dates (one rule: When, dateLabel), loading and error states.
import { useAuth } from '@/lib/auth';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ApiErrorStatus } from '@/features/status/from-error';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { usd } from '@/lib/display-format';
import { dateWords } from '@/features/records/detail-layout';

/** Load on mount and whenever the active organization (or `deps`) changes; `reload` re-runs, keeping the old data meanwhile. */
export function useOrgLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const { orgId } = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(() => fn().then((d) => { setData(d); setError(null); return d; }, (e: Error) => { setError(e); return null; }), [orgId, ...deps]);
  useEffect(() => { setData(null); void run(); }, [run]);
  return { data, error, reload: run, setData };
}

export const fail = (e: unknown) => toast.error((e as Error)?.message || String(e));

export function copy(text: string) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast.success('Copied'), () => window.prompt('Copy:', text));
  else window.prompt('Copy:', text);
}

/** Copies `text`; reads "Copied" with a check for two seconds after. */
export function CopyButton({ text, label = 'Copy', className, variant = 'outline' }: { text: string; label?: string; className?: string; variant?: 'outline' | 'default' | 'ghost' }) {
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(false), 2000); return () => clearTimeout(t); }, [done]);
  return (
    <Button type='button' variant={variant} size='sm' className={className} onClick={() => { copy(text); setDone(true); }}>
      {done ? <Icons.check className='size-3.5' /> : <Icons.page className='size-3.5' />} {done ? 'Copied' : label}
    </Button>
  );
}

/** Within this many days a date reads relative ("3 hours ago", "yesterday", "in 2 days"); further off, as a day. */
const RELATIVE_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * mold_v0-298: the console's one date rule, for lists and panels alike: within 7 days relative words ("2 hours ago",
 * "yesterday", "in 3 days"), else the day ("12 Nov 2026"); `exact` is the full date (and time, in the viewer's own zone) for a hover, `iso` the
 * machine value. The words and the exact form are the record panel's (features/records/detail-layout.ts dateWords).
 * Null when the value is not a date.
 */
export function dateLabel(v: unknown, now = Date.now()): { text: string; exact: string; iso: string } | null {
  const w = dateWords(v instanceof Date ? v.toISOString() : v, now);
  if (!w) return null;
  const t = Date.parse(w.iso.length === 10 ? `${w.iso}T00:00:00Z` : w.iso);
  const near = Math.abs(t - now) < RELATIVE_DAYS * DAY_MS;
  // The hover reads in the viewer's own time (as it did before mold_v0-298); a day alone stays that day.
  const exact = w.iso.length === 10 ? w.absolute
    : new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return { text: near ? w.relative : w.absolute.replace(/,.*$/, ''), exact, iso: w.iso };
}

/** A date by the rule above, the full date on hover and to a screen reader (<time>); "never" when there is none. */
export function When({ d, never = 'never' }: { d: string | Date | null | undefined; never?: string }) {
  if (!d) return <span className='text-muted-foreground'>{never}</span>;
  const l = dateLabel(d);
  if (!l) return <span>{String(d)}</span>;
  return <time dateTime={l.iso} title={l.exact} className='whitespace-nowrap'>{l.text}</time>;
}

/** Spend against a cap; no cap = a plain line. */
export function SpendMeter({ spent, budget, className }: { spent: number; budget: number | null | undefined; className?: string }) {
  if (!budget) return <p className={cn('text-muted-foreground text-sm', className)}>No monthly cap · {usd(spent)} spent</p>;
  const p = Math.min(100, (spent / budget) * 100);
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className='bg-muted h-2 w-full overflow-hidden rounded-full'>
        <div className={cn('h-full rounded-full transition-all', p >= 100 ? 'bg-destructive' : p >= 80 ? 'bg-amber-500' : 'bg-primary')} style={{ width: `${p}%` }} />
      </div>
      <p className='text-muted-foreground text-xs'>
        {usd(spent)} of {usd(budget)} this month ({Math.round(p)}%)
      </p>
    </div>
  );
}

/** Loading placeholder: skeleton lines, no boxes (the pages are flat). */
export function LoadingCards({ count = 3 }: { count?: number }) {
  return (
    <div className='flex w-full flex-col gap-6'>
      <Skeleton className='h-16 w-full' />
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className='space-y-2'>
          <Skeleton className='h-4 w-40' />
          <Skeleton className='h-4 w-full' />
          <Skeleton className='h-4 w-5/6' />
        </div>
      ))}
    </div>
  );
}

export function ErrorState({ error }: { error: Error }) {
  return (
    // The console's status page for what the API answered (mold_v0-131): signed out, refused, not found, failed; no
    // account goes to the portal's own notice for it (mold_v0-098) through noAccountHandoff().
    <ApiErrorStatus error={error} />
  );
}

/** A labelled form row (label above the control). */
export function FormRow({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className='grid gap-1.5'>
      <label htmlFor={htmlFor} className='text-sm font-medium'>{label}</label>
      {children}
      {hint && <p className='text-muted-foreground text-xs'>{hint}</p>}
    </div>
  );
}
