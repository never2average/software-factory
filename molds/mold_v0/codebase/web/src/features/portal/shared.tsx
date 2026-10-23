'use client';
// Small helpers shared by the portal pages: data loading keyed by the active Clerk organization, spend meter,
// copy buttons, relative times, loading and error states.
import { useAuth } from '@/lib/auth';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { relative, usd } from '@/lib/display-format';

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

export function When({ d }: { d: string | Date | null | undefined }) {
  if (!d) return <span className='text-muted-foreground'>never</span>;
  return <span title={new Date(d).toLocaleString()}>{relative(d)}</span>;
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
    <Alert variant='destructive'>
      <Icons.alertCircle />
      <AlertTitle>Could not load this page</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
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
