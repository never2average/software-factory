'use client';
// The analytics grid shared by admin Analytics and the portal Usage page: cells that share hairlines (the wrapper draws
// the top and left ones, each Box its right and bottom), at most two per row (`grid lg:grid-cols-2`), and ranked bars.
import type { ReactNode } from 'react';
import { Bar, BarChart, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { cn } from '@/lib/utils';

/** One cell of the grid: title, a one-line description, then the chart or table. */
export function Box({ title, description, action, className, children }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-3 border-r border-b p-4', className)}>
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div className='min-w-0'>
          <h2 className='text-sm font-semibold'>{title}</h2>
          {description && <p className='text-muted-foreground mt-0.5 text-xs'>{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A horizontal bar chart (rows in the order given): one bar per row, its name on the left and its value at the end. */
export function RankBars({ data, color, format, empty, mono, label = 'Value' }: {
  data: { name: string; value: number }[]; color: string; format: (v: number) => string; empty: string; mono?: boolean; label?: string;
}) {
  if (!data.length || data.every((d) => !d.value)) return <p className='text-muted-foreground py-10 text-center text-sm'>{empty}</p>;
  return (
    <ChartContainer config={{ value: { label, color } }} className='aspect-auto w-full' style={{ height: Math.max(120, data.length * 28 + 8) }}>
      <BarChart data={data} layout='vertical' margin={{ left: 0, right: 40, top: 0, bottom: 0 }}>
        <XAxis type='number' hide />
        <YAxis type='category' dataKey='name' width={128} tickLine={false} axisLine={false}
          tick={{ fontSize: 11, fontFamily: mono ? 'var(--font-mono)' : undefined }} tickFormatter={(v: string) => (v.length > 20 ? `${v.slice(0, 19)}…` : v)} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel={false} formatter={(v) => format(Number(v))} />} />
        <Bar dataKey='value' fill={color} radius={3} barSize={16} label={{ position: 'right', fontSize: 11, fill: 'var(--muted-foreground)', formatter: (v: unknown) => format(Number(v)) }} />
      </BarChart>
    </ChartContainer>
  );
}

/** The ten largest by `by`, largest first (zeros dropped). */
export const top = <T,>(xs: readonly T[], by: (x: T) => number, n = 10) => [...xs].sort((x, y) => by(y) - by(x)).slice(0, n).filter((x) => by(x) > 0);
