import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Flat page building blocks: the page is the container, so content sits in titled sections separated by space or a
 * hairline instead of boxed cards. Use a Card only for a dialog, a highlighted choice (e.g. a plan), or a call to action.
 */
export function Section({ title, titleId, description, action, children, className }: {
  title?: ReactNode; /** The heading's id, for a region named by it (aria-labelledby). */ titleId?: string; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-3', className)}>
      {(title || action) && (
        <div className='flex flex-wrap items-end justify-between gap-2'>
          <div className='min-w-0'>
            {title && <h2 id={titleId} className='text-base font-semibold tracking-tight'>{title}</h2>}
            {description && <p className='text-muted-foreground text-sm'>{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * A row of headline numbers divided by hairlines (wraps on small screens): replaces grids of stat cards. `quad` (a list
 * tab's four cards, mold_v0-181): four across from a wide screen, two by two below it, every cell one line of label and
 * one of value and sparkline (the line's place kept while it loads or has no weeks), so nothing moves as they fill in.
 */
export function StatStrip({ items, className, quad }: {
  items: {
    label: ReactNode; value: ReactNode; hint?: ReactNode; href?: string; spark?: number[];
    /** What the value and its sparkline say, for a screen reader (the line itself is a picture). */
    said?: string;
  }[]; className?: string; quad?: boolean;
}) {
  return (
    <dl className={cn(quad ? 'grid grid-cols-2 border-y lg:grid-cols-4' : 'grid grid-cols-2 border-y sm:flex sm:divide-x', className)}>
      {items.map((it, i) => {
        const body = (
          <>
            <dt className={cn('text-muted-foreground text-xs font-medium', quad && 'truncate')}>
              {it.href ? <a href={it.href} className='outline-hidden after:absolute after:inset-0 group-hover:underline'>{it.label}</a> : it.label}
            </dt>
            <dd className='mt-1 flex items-end justify-between gap-3' aria-hidden={it.said ? true : undefined}>
              <span className={cn('text-2xl font-semibold tabular-nums tracking-tight', quad && 'min-w-0 truncate')}>{it.value}</span>
              {it.spark && it.spark.length > 1 ? <Sparkline values={it.spark} /> : quad && <span className='mb-1 h-7 w-24 min-w-8 shrink' />}
            </dd>
            {it.said && <dd className='sr-only'>{it.said}</dd>}
            {it.hint && <dd className='text-muted-foreground mt-0.5 text-xs'>{it.hint}</dd>}
          </>
        );
        // A <dl> holds only <dt>/<dd> groups wrapped in a <div> (axe `definition-list`, `dlitem`), so a stat with a link
        // keeps that shape: the link is the label, stretched over the whole cell so the cell is still one tap target.
        return (
          <div key={i} className={cn(quad
            ? 'min-w-0 px-4 py-3 max-lg:odd:pl-0 max-lg:even:border-l max-lg:[&:nth-child(-n+2)]:border-b lg:first:pl-0 lg:not-first:border-l'
            : 'min-w-0 flex-1 px-4 py-3 first:pl-0 max-sm:border-b max-sm:odd:pl-0 max-sm:even:border-l', it.href && 'group relative has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring')}>
            {body}
          </div>
        );
      })}
    </dl>
  );
}

/** A tiny trend line for a stat: its history (the range's days, or the last hours), scaled to its own max. */
export function Sparkline({ values }: { values: number[] }) {
  const w = 96, h = 28, max = Math.max(...values, 0), step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, max ? h - 2 - (v / max) * (h - 4) : h - 2] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  return (
    // 96px wide where there is room; in a narrow cell (a tablet beside the sidebar) it narrows, down to 32px, rather
    // than push the strip past the page's edge. Stretched, not cropped; the line keeps its width.
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio='none' className='text-primary mb-1 h-7 w-24 min-w-8 shrink overflow-visible' aria-hidden>
      <path d={`${line}L${w},${h}L0,${h}Z`} fill='currentColor' opacity={0.12} />
      <path d={line} fill='none' stroke='currentColor' strokeWidth={1.5} strokeLinejoin='round' strokeLinecap='round' vectorEffect='non-scaling-stroke' />
    </svg>
  );
}

/** A hairline between sections. */
export const Rule = () => <hr className='border-border' />;
