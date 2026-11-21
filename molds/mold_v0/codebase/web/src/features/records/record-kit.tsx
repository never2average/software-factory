'use client';
// The rail style's blocks (mold_v0-331; a layout's `style: "rail"`, drawn by ./detail-page.tsx): one look for every
// record's details, flat (no card per part), in the record panel and on the record's own page. Each block is the one way
// its content is shown:
//   RailFields    label and value, one label width (130px); a falsy row is left out, an empty value reads "—"
//   RailSection   a small title (13.5px, semibold) over its content; a title that repeats its tab is for screen readers
//   LinkRow       a link to related records: the title, one muted line saying what is there, a "View →" text link
//   RailNumbers   a few counts: the number in a fixed right-aligned column, its label beside it, no lines
//   RailSteps     progress along a lifecycle: circles joined by a thin line, done ones checked, the current one marked
//   NoticeLine    one line for a notice: a mark and its words, no box
//   RailEmpty     a section with nothing in it: one muted line
//   CopyLink      a value's Copy, as a text link that says "Copied" for a moment
//   TextLink      the one action look of the style: a text link in the brand colour, never a box
// Pure decisions (the steps' states, the header's line, a link row's words) are in ./detail-layout.ts.
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { STEP_WORD, stepMark, type DotTone, type StepState } from './detail-layout';

const TEXT_LINK = 'text-primary inline-flex items-center gap-1 rounded-sm text-[13px] whitespace-nowrap hover:underline focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none';

/** The style's one action look: a text link (a page's link, or a button). */
export function TextLink({ label, href, onClick, ariaLabel, className, ...rest }: { label: ReactNode; href?: string; onClick?: () => void; ariaLabel?: string; className?: string; [data: `data-${string}`]: string | undefined }) {
  return href
    ? <Link href={href} className={cn(TEXT_LINK, className)} aria-label={ariaLabel} {...rest}>{label}</Link>
    : <Button type='button' variant='ghost' size='xs' onClick={onClick} className={cn(TEXT_LINK, 'hover:text-primary', className)} aria-label={ariaLabel} {...rest}>{label}</Button>;
}

/** A value's Copy: says "Copied" for a moment (the copy itself, with its toast, is the caller's). */
export function CopyLink({ onCopy, what }: { onCopy: () => Promise<void> | void; what: string }) {
  const [done, setDone] = useState(false);
  return (
    <TextLink label={done ? 'Copied' : 'Copy'} ariaLabel={`Copy ${what}`} data-copy='' className='text-xs'
      onClick={() => { void Promise.resolve(onCopy()).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }} />
  );
}

/** A label and its value; a falsy row is left out. `wide`: the value under its label, across the whole width (a long text, a list). */
export type RailRow = { key: string; label: ReactNode; value: ReactNode; wide?: boolean; copy?: ReactNode; attrs?: Record<string, string>;
  /** The section's title already says it (a section of one field): the label for a screen reader only, the value across the width. */
  labelHidden?: boolean } | null | undefined | false;

/** Label and value, one label width. */
export function RailFields({ rows, ...attrs }: { rows: readonly RailRow[]; [data: `data-${string}`]: string | undefined }) {
  return (
    <dl className='m-0 grid grid-cols-[minmax(0,130px)_minmax(0,1fr)] gap-x-2.5 gap-y-[7px] text-sm' data-rail-fields='' {...attrs}>
      {rows.map((r) => r && (
        <div key={r.key} className={cn('contents')} data-detail-field='' {...r.attrs}>
          <dt className={cn('text-muted-foreground min-w-0 break-words', r.labelHidden ? 'sr-only' : r.wide && 'col-span-2')} data-label-hidden={r.labelHidden ? '' : undefined}>{r.label}</dt>
          <dd className={cn('m-0 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 [overflow-wrap:anywhere]', (r.wide || r.labelHidden) && 'col-span-2', r.wide && !r.labelHidden && '-mt-1')}>
            <span className='min-w-0'>{r.value ?? <span className='text-muted-foreground'>—</span>}</span>
            {r.copy}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A section: its small title, then its content. `titleHidden`: the title says what the tab above it says (kept for a screen reader). */
export function RailSection({ id, title, titleHidden = false, action, children, ...attrs }: {
  id: string; title: ReactNode; titleHidden?: boolean; action?: ReactNode; children: ReactNode; [data: `data-${string}`]: string | undefined;
}) {
  return (
    <section className='grid min-w-0 gap-2' aria-labelledby={`${id}-title`} role='region' data-detail-section={id} {...attrs}>
      <div className={cn('flex min-w-0 items-baseline justify-between gap-3', titleHidden && !action && 'sr-only')}>
        <h3 id={`${id}-title`} className={cn('m-0 text-[13.5px] font-semibold', titleHidden && 'sr-only')} data-title-repeats-tab={titleHidden ? '' : undefined}>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A section with nothing to show: one muted line. */
export function RailEmpty({ children }: { children: ReactNode }) {
  return <p className='text-muted-foreground m-0 text-[13px]' data-section-empty=''>{children}</p>;
}

/** A link to related records: the title, one plain muted line, the text link at the right. Hairlines between neighbours. */
export function LinkRow({ id, title, detail, action, href, ...attrs }: { id: string; title: ReactNode; detail: ReactNode; action: string; href?: string | null; [data: `data-${string}`]: string | undefined }) {
  return (
    <div className='grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2.5 py-[7px]' role='region' aria-labelledby={`${id}-title`} data-link-row='' data-detail-section={id} {...attrs}>
      <div className='min-w-0'>
        <span id={`${id}-title`} className='font-medium'>{title}</span>
        <span className='text-muted-foreground ml-2 text-[13px]' data-link-row-detail=''>{detail}</span>
      </div>
      {href ? <TextLink label={`${action} →`} href={href} ariaLabel={typeof title === 'string' ? `${action}: ${title}` : action} data-link-row-open='' /> : <span />}
    </div>
  );
}

/** A few counts: the number right-aligned in a fixed column, its label beside it. */
export function RailNumbers({ items }: { items: readonly { key: string; label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className='m-0 grid grid-cols-[minmax(76px,auto)_minmax(0,1fr)] gap-x-2.5 gap-y-[5px] text-sm' data-rail-numbers=''>
      {items.map((it) => (
        <div key={it.key} className='contents' data-detail-field=''>
          <dd className='m-0 text-right font-semibold tabular-nums'>{it.value}</dd>
          <dt className='text-muted-foreground'>{it.label}</dt>
        </div>
      ))}
    </dl>
  );
}

const CIRCLE: Record<StepState, string> = {
  done: 'bg-primary text-primary-foreground border-primary',
  now: 'border-primary text-primary bg-background',
  todo: 'text-muted-foreground bg-background',
};

/** Progress along a lifecycle: numbered circles, a thin connector (filled once done), the current step in the brand colour. */
export function RailSteps({ steps, label }: { steps: readonly { key: string; label: ReactNode; state: StepState }[]; label: string }) {
  return (
    <ol className='m-0 list-none p-0' aria-label={label} data-rail-steps=''>
      {steps.map((s, i) => (
        <li key={s.key} className='relative' data-state={s.state} aria-current={s.state === 'now' ? 'step' : undefined}>
          {i < steps.length - 1 && <span className={cn('absolute top-[25px] -bottom-[5px] left-2.5 w-px', s.state === 'done' ? 'bg-primary' : 'bg-border')} aria-hidden />}
          <div className='grid w-full grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-2 py-[5px] text-left text-[13px]'>
            <span className={cn('relative z-10 grid size-5 place-items-center rounded-full border text-[11px]', CIRCLE[s.state])} aria-hidden>{stepMark(s.state, i)}</span>
            <span className={cn('min-w-0', s.state === 'now' && 'text-primary font-medium')}>{s.label}</span>
            <span className='text-muted-foreground text-[12.5px]'>{STEP_WORD[s.state]}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

const NOTICE_TEXT = { danger: 'text-destructive', warning: 'text-foreground', info: 'text-muted-foreground', success: 'text-muted-foreground' } as const;
const NOTICE_MARK = { danger: 'text-destructive', warning: 'text-amber-600 dark:text-amber-400', info: 'text-primary', success: 'text-emerald-600 dark:text-emerald-400' } as const;

/** One line for a notice: a mark (▲ for a warning or a problem, ● otherwise), its title in bold, its words. No box. */
export function NoticeLine({ tone, title, text }: { tone: keyof typeof NOTICE_TEXT; title?: string; text: string }) {
  return (
    <div role={tone === 'info' || tone === 'success' ? 'status' : 'alert'} data-record-notice={tone} className={cn('flex items-baseline gap-[7px] text-[13px] leading-snug', NOTICE_TEXT[tone])}>
      <span className={cn('shrink-0', NOTICE_MARK[tone])} aria-hidden>{tone === 'warning' || tone === 'danger' ? '▲' : '●'}</span>
      <span className='min-w-0 [overflow-wrap:anywhere]'>{title && <span className='font-semibold'>{title}. </span>}{text}</span>
    </div>
  );
}

const DOT: Record<DotTone, string> = { good: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-destructive', info: 'bg-primary', neutral: 'bg-muted-foreground' };

/**
 * The rail header row: the status dot, the title, the muted "status · context" (it truncates first), a spacer, then
 * `trailing` (the main action as a text link). In a record panel it sits in the panel's own header row.
 */
export function RailHeading({ title, tone, status, context, trailing, level }: {
  title: ReactNode; tone?: DotTone | null; status?: string | null; context: string; trailing?: ReactNode; level: 'h1' | 'h2';
}) {
  const H = level;
  return (
    // The title on its first line; the "status · context" line under it in full (it wraps, never cut short); the main
    // action and its neighbours at the right of both lines when the row has room (44rem), else on a line of their own
    // under the context. One element each (a grid), so nothing is drawn twice.
    <div className='@container/rail-head min-w-0' data-rail-header=''>
      <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] items-center gap-x-3 gap-y-1 @[44rem]/rail-head:grid-cols-[minmax(0,1fr)_auto]'>
        <div className='flex min-w-0 items-center gap-[7px]'>
          {tone && <span className={cn('size-[7px] shrink-0 rounded-full', DOT[tone])} data-status-dot={tone} title={status ?? undefined} aria-hidden />}
          <H className='m-0 min-w-0 truncate text-base leading-tight font-semibold tracking-tight' data-testid={level === 'h2' ? 'detail-panel-title' : undefined} title={typeof title === 'string' ? title : undefined}>{title}</H>
        </div>
        {context && <p className={cn('text-muted-foreground m-0 min-w-0 text-[13px] leading-snug break-words @[44rem]/rail-head:col-start-1', tone && 'pl-[14px]')} data-rail-context=''>{context}</p>}
        {trailing && <div className={cn('flex min-w-0 flex-wrap items-center gap-2 @[44rem]/rail-head:col-start-2 @[44rem]/rail-head:row-span-2 @[44rem]/rail-head:row-start-1 @[44rem]/rail-head:justify-end', tone && 'pl-[14px] @[44rem]/rail-head:pl-0')} data-rail-actions=''>{trailing}</div>}
      </div>
    </div>
  );
}
