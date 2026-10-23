'use client';
// Small presentational pieces shared by the admin pages, on top of the template's shadcn components.
import { TablePager, usePaged } from '@/components/layout/table-pager';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Section as FlatSection } from '@/components/layout/section';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Icons } from '@/components/icons';
import { relative } from '@/lib/display-format';
import { cn } from '@/lib/utils';
import type { Subscription } from './lib';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';
const TONES: Record<Tone, string> = {
  ok: 'bg-emerald-500/10 text-emerald-700 ring-emerald-600/20 dark:text-emerald-400 dark:ring-emerald-400/25',
  warn: 'bg-amber-500/10 text-amber-800 ring-amber-600/25 dark:text-amber-300 dark:ring-amber-400/25',
  bad: 'bg-destructive/10 text-destructive ring-destructive/25',
  info: 'bg-primary/10 text-primary ring-primary/25',
  neutral: 'bg-muted/60 text-muted-foreground ring-border'
};

/** A status badge in one of five tones: a tinted chip with a dot in the tone's colour, first letter capitalised. */
export function StatusBadge({ tone = 'neutral', children, title, className }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <Badge variant='secondary' title={title} className={cn('gap-1.5 ring-1 ring-inset', TONES[tone], className)}>
      <span aria-hidden className='size-1.5 shrink-0 rounded-full bg-current opacity-80' />
      {typeof children === 'string' ? children.charAt(0).toUpperCase() + children.slice(1) : children}
    </Badge>
  );
}

export function SubBadge({ sub }: { sub: Subscription | null | undefined }) {
  if (!sub) return <span className='text-muted-foreground'>—</span>;
  const tone: Tone = sub.status === 'active' ? 'ok' : sub.status === 'trialing' ? 'info' : /past_due|unpaid|incomplete/.test(sub.status) ? 'bad' : 'neutral';
  return (
    <span className='inline-flex flex-wrap items-center gap-1.5'>
      <StatusBadge tone={tone}>{sub.status.replace(/_/g, ' ')}</StatusBadge>
      {sub.plan && <span className='text-sm'>{sub.plan}</span>}
    </span>
  );
}

/** "3h ago", exact time on hover. */
export function When({ d, className }: { d: string | Date | null | undefined; className?: string }) {
  if (!d) return <span className={cn('text-muted-foreground', className)}>never</span>;
  return (
    <time className={className} dateTime={new Date(d).toISOString()} title={new Date(d).toLocaleString()}>
      {relative(d)}
    </time>
  );
}

/** ▲ 12% / ▼ 30% vs the previous period. */
export function Trend({ pct }: { pct: number | null | undefined }) {
  if (pct == null) return <span className='text-muted-foreground text-xs'>new</span>;
  if (pct === 0) return <span className='text-muted-foreground text-xs'>±0%</span>;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-xs font-medium', pct > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
      {pct > 0 ? <Icons.trendingUp className='size-3.5' /> : <Icons.trendingDown className='size-3.5' />}
      {Math.abs(pct)}%
    </span>
  );
}

/** A titled section on the page itself (no card): see components/layout/section.tsx. */
export function Section({ title, description, action, children, className, contentClassName }: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <FlatSection title={title} description={description} action={action} className={className}>
      {contentClassName ? <div className={contentClassName}>{children}</div> : children}
    </FlatSection>
  );
}

export interface Col<T> {
  label: string;
  render: (row: T) => ReactNode;
  className?: string;
  key?: string;
}

/** A simple table on the page; scrolls sideways on small screens. */
/** `height` (a class, e.g. 'h-[28rem]') gives the list a fixed height like the full-page tables: the rows scroll under a
 *  sticky header and the pager stays put, however many rows there are. */
export function DataList<T>({ cols, rows, empty, onRow, minWidth = 640, noun, height }: { cols: Col<T>[]; rows: T[] | undefined; empty: ReactNode; onRow?: (r: T) => void; minWidth?: number; noun?: string; height?: string }) {
  const p = usePaged(rows ?? []);
  return (
    <div>
    <div className={cn('overflow-x-auto', height && cn('overflow-y-auto overscroll-contain', height))}>
      <Table style={{ minWidth }}>
        <TableHeader className={height ? 'bg-background sticky top-0 z-10' : undefined}>
          <TableRow>
            {cols.map((c) => (
              <TableHead key={c.key ?? c.label} className={c.className}>
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {!rows?.length && (
            <TableRow><TableCell colSpan={cols.length} className='text-muted-foreground py-10 text-center whitespace-normal'>{empty}</TableCell></TableRow>
          )}
          {p.rows.map((r, i) => (
            <TableRow
              key={i}
              className={onRow ? 'cursor-pointer' : undefined}
              onClick={onRow ? () => onRow(r) : undefined}
              onKeyDown={onRow ? (e) => e.key === 'Enter' && onRow(r) : undefined}
              tabIndex={onRow ? 0 : undefined}
            >
              {cols.map((c) => (
                <TableCell key={c.key ?? c.label} className={cn('align-top whitespace-normal', c.className)}>
                  {c.render(r)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
    <TablePager p={p} noun={noun} />
    </div>
  );
}

export function copyText(text: string, what = 'Copied') {
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast.success(what), () => window.prompt('Copy:', text));
  else window.prompt('Copy:', text);
}

/** A read-only value with a Copy button. */
export function CopyField({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn('flex gap-2', className)}>
      <Input readOnly value={value} className='font-mono text-xs' onFocus={(e) => e.currentTarget.select()} />
      <Button variant='outline' onClick={() => copyText(value)}>
        Copy
      </Button>
    </div>
  );
}

/** A button that asks before doing something hard to undo. */
export function ConfirmButton({ label, title, description, confirmLabel, onConfirm, variant = 'outline', size = 'sm', disabled }: {
  label: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  variant?: 'outline' | 'destructive' | 'default' | 'ghost' | 'secondary';
  size?: 'sm' | 'xs' | 'default';
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} disabled={disabled} onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        {label}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={variant === 'destructive' ? 'destructive' : 'default'} onClick={() => { setOpen(false); onConfirm(); }}>
              {confirmLabel ?? 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function LoadingCards({ count = 4, tall }: { count?: number; tall?: boolean }) {
  return (
    <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={cn('rounded-xl', tall ? 'h-56' : 'h-24')} />
      ))}
    </div>
  );
}

export function ErrorBox({ error }: { error: Error | null | undefined }) {
  if (!error) return null;
  return (
    <div role='alert' className='border-destructive/30 bg-destructive/5 text-destructive mb-4 rounded-lg border px-4 py-3 text-sm'>
      {error.message}
    </div>
  );
}

export function Notice({ tone = 'warn', children }: { tone?: 'warn' | 'ok' | 'info'; children: ReactNode }) {
  const cls = tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/8 text-emerald-800 dark:text-emerald-300' : tone === 'info' ? 'border-primary/30 bg-primary/5' : 'border-amber-500/30 bg-amber-500/8 text-amber-800 dark:text-amber-300';
  return <div className={cn('rounded-lg border px-4 py-3 text-sm', cls)}>{children}</div>;
}

/** A row of dots for the 8 onboarding stages. */
export function StageDots({ index, total = 8 }: { index: number; total?: number }) {
  return (
    <span className='mr-1.5 inline-flex gap-0.5 align-middle' aria-hidden>
      {Array.from({ length: total }, (_, k) => (
        <i key={k} className={cn('size-1.5 rounded-full', k <= index ? 'bg-primary' : 'bg-muted-foreground/25')} />
      ))}
    </span>
  );
}

export const Mono = ({ children }: { children: ReactNode }) => <span className='font-mono text-xs'>{children}</span>;

/** One form input per row: its label above, the input, then an optional hint. */
export function FormRow({ id, label, hint, children }: { id: string; label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className='grid min-w-0 gap-1.5'>
      <label htmlFor={id} className='text-sm leading-none font-medium'>{label}</label>
      {children}
      {hint && <p className='text-muted-foreground text-xs'>{hint}</p>}
    </div>
  );
}

/** Values as small chips (a stack, tags); "—" when there are none. */
/** `oneLine` keeps table rows one height: the chips never wrap, the rest is a +N count. */
export function Chips({ items, max, oneLine }: { items: readonly string[] | null | undefined; max?: number; oneLine?: boolean }) {
  const list = items ?? [], shown = max ? list.slice(0, max) : list;
  if (!list.length) return <span className='text-muted-foreground'>—</span>;
  return (
    <span className={cn('inline-flex gap-1', oneLine ? 'max-w-full flex-nowrap overflow-hidden' : 'flex-wrap')} title={oneLine ? list.join(', ') : undefined}>
      {shown.map((s) => <Badge key={s} variant='outline' className='font-normal'>{s}</Badge>)}
      {list.length > shown.length && <span className='text-muted-foreground text-xs leading-5'>+{list.length - shown.length}</span>}
    </span>
  );
}
