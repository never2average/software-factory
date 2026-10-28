'use client';
// The charts a pack declares (mold_v0-063): pack.json `charts` over its `metrics`, drawn here by the shell for any pack,
// so one product's pick-rate charts and another's vulnerabilities by severity come from the same code. Numbers come from
// GET /api/metrics (src/metrics.ts: computed on the server for this workspace, as the person's role may read them).
//
// The chart rules (the dataviz method): the form follows the data's job (tiles for single values, bars for magnitude,
// a stacked bar for part-to-whole, lines for trends; no donut, never two y-axes); colours are tokens
// (web/src/styles/theme.css --viz-*, validated for colour-blind separation, light and dark each its own steps), assigned
// by the entity (an option or a metric keeps its slot), never by rank; thin marks (bars <= 24px, rounded data end, 2px
// lines), recessive grid; a legend for two series or more; text in text colours, never the series colour; a tooltip on
// every mark; and a table view of every chart, with an accessible summary, so nothing depends on colour alone.
import React, { useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Tooltip, XAxis, YAxis, type TooltipContentProps, type TooltipValueType } from 'recharts';
type TipProps = TooltipContentProps<TooltipValueType, string | number>;
import { ResponsiveContainer } from 'recharts';
import { Box } from '@/components/layout/chart-grid';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { PackChartSpec } from '@/config/pack-nav.generated';
import { Skeleton } from '@/components/ui/skeleton';

export type Unit = 'count' | 'number' | 'usd' | 'percent' | 'percent_100' | 'days' | 'hours';
export interface MetricAnswer {
  name: string; label: string; description: string | null; unit: Unit; measure: string;
  kind: 'single' | 'groups' | 'series';
  value?: number | null;
  groups?: { key: string | null; label: string; value: number | null }[];
  more?: boolean;
  buckets?: string[];
  series?: { key: string | null; label: string; values: (number | null)[] }[];
  rows: number; partial?: boolean; as_of: string;
}
export type MetricResult = MetricAnswer | { name: string; error: string; status: number };
export const isAnswer = (r: MetricResult | undefined): r is MetricAnswer => !!r && !('error' in r);

// ---------- numbers in words ----------

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
export function formatValue(v: number | null | undefined, unit: Unit, short = false): string {
  if (v === null || v === undefined) return '—';
  switch (unit) {
    case 'percent': return `${plain.format(Math.round(v * 1000) / 10)}%`;
    // A value already 0 to 100 (mold_v0-079): shown as it is.
    case 'percent_100': return `${plain.format(Math.round(v * 10) / 10)}%`;
    case 'usd': return `$${v >= 1000 && short ? compact.format(v) : v.toFixed(2)}`;
    case 'days': return `${plain.format(Math.round(v * 10) / 10)} ${short ? 'd' : Math.round(v * 10) / 10 === 1 ? 'day' : 'days'}`;
    case 'hours': return `${plain.format(Math.round(v * 10) / 10)} ${short ? 'h' : Math.round(v * 10) / 10 === 1 ? 'hour' : 'hours'}`;
    case 'count': return v >= 10_000 || short ? compact.format(v) : Math.round(v).toLocaleString();
    default: return short ? compact.format(v) : plain.format(v);
  }
}
/** A bucket's first day as a short label: "Oct 13" for days and weeks, "Oct 2026" for months. */
const bucketLabel = (d: string, all: string[]) => {
  const t = new Date(`${d}T00:00:00Z`);
  const monthly = all.length > 1 && all.every((x) => x.endsWith('-01'));
  return t.toLocaleDateString(undefined, monthly ? { month: 'short', year: 'numeric', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

// ---------- colour roles ----------

/** The categorical slot of the i-th entity (an option in declared order, a metric in the chart's order). */
const slot = (i: number) => `var(--viz-${(i % 8) + 1})`;
/** The ordinal step of option i of n (5 steps, light to dark on the light theme). */
const step = (i: number, n: number) => `var(--viz-ord-${n <= 1 ? 3 : Math.round((i * 4) / (n - 1)) + 1})`;

// ---------- the pieces ----------

const AXIS = { fontSize: 11, fill: 'var(--muted-foreground)' } as const;
const tooltipStyle = 'bg-popover text-popover-foreground rounded-md border px-2.5 py-1.5 text-xs shadow-sm';

function Tip({ active, payload, label, unit, labelOf }: TipProps & { unit: Unit; labelOf?: (l: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className={tooltipStyle}>
      {label !== undefined && <div className='mb-1 font-medium'>{labelOf ? labelOf(String(label)) : String(label)}</div>}
      {payload.map((p) => (
        <div key={String(p.dataKey)} className='flex items-center gap-2'>
          <span aria-hidden className='inline-block size-2 shrink-0 rounded-full' style={{ background: (p.payload?.__fill as string) ?? p.color }} />
          <span className='text-muted-foreground'>{p.name}</span>
          <span className='ml-auto pl-3 font-medium tabular-nums'>{formatValue(p.value as number, unit)}</span>
        </div>
      ))}
    </div>
  );
}

/** The legend: a swatch beside each name (text in text colours). Shown for two series or more. */
function Legend({ items }: { items: { label: string; color: string }[] }) {
  if (items.length < 2) return null;
  return (
    <ul className='text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs' aria-label='Legend'>
      {items.map((it, i) => (
        <li key={i} className='flex items-center gap-1.5'>
          <span aria-hidden className='inline-block h-2 w-3 rounded-sm' style={{ background: it.color }} />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

/** The table view of a chart: rows by group or bucket, a column per series. */
function DataTable({ head, rows, unit, caption }: { head: string[]; rows: { label: string; values: (number | null)[] }[]; unit: Unit; caption: string }) {
  return (
    <Table>
      <caption className='sr-only'>{caption}</caption>
      <TableHeader>
        <TableRow>{head.map((h, i) => <TableHead key={i} className={i ? 'text-right' : undefined}>{h}</TableHead>)}</TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i}>
            <TableCell>{r.label}</TableCell>
            {r.values.map((v, j) => <TableCell key={j} className='text-right tabular-nums'>{formatValue(v, unit)}</TableCell>)}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** A chart's data, flattened once: its categories (groups or buckets), its series and their colours. */
interface Frame {
  unit: Unit;
  categories: string[];
  series: { key: string; label: string; color: string; values: (number | null)[]; colors?: string[] }[];
  /** The x axis is time (buckets), else groups. */
  time: boolean;
  note: string | null;
}
function frameOf(chart: PackChartSpec, ms: MetricAnswer[]): Frame {
  const unit = ms[0]!.unit;
  const notes = [ms.some((m) => m.more) && 'Largest groups shown.', ms.some((m) => m.partial) && 'Computed over the first 5,000 records.'].filter(Boolean).join(' ');
  const note = notes || null;
  const first = ms[0]!;
  if (first.kind === 'series') {
    const categories = first.buckets!.map((d) => bucketLabel(d, first.buckets!));
    const series = ms.length === 1
      ? first.series!.map((s, i, all) => ({ key: `s${i}`, label: s.label, values: s.values, color: chart.palette === 'ordinal' ? step(i, all.length) : slot(i) }))
      : ms.map((m, i) => ({ key: `s${i}`, label: m.label, values: m.series![0]!.values, color: slot(i) }));
    return { unit, categories, series, time: true, note };
  }
  if (first.kind === 'groups') {
    const categories = first.groups!.map((g) => g.label);
    if (ms.length === 1) {
      const colors = first.groups!.map((_, i, all) => (chart.palette === 'ordinal' ? step(i, all.length) : slot(0)));
      return { unit, categories, series: [{ key: 's0', label: first.label, values: first.groups!.map((g) => g.value), color: slot(0), colors }], time: false, note };
    }
    // Several metrics over the same groups: match their groups by key.
    return { unit, categories, time: false, note,
      series: ms.map((m, i) => ({ key: `s${i}`, label: m.label, color: slot(i), values: first.groups!.map((g) => m.groups!.find((x) => x.key === g.key)?.value ?? null) })) };
  }
  return { unit, categories: [first.label], series: ms.map((m, i) => ({ key: `s${i}`, label: m.label, color: slot(i), values: [m.value ?? null] })), time: false, note };
}

/** A sentence a screen reader reads for the chart (the table view has every number). */
function summary(chart: PackChartSpec, f: Frame) {
  const parts = f.series.map((s) => {
    const pts = f.categories.map((c, i) => `${c} ${formatValue(s.values[i], f.unit)}`);
    const shown = pts.length > 8 ? [...pts.slice(0, 3), '…', ...pts.slice(-3)] : pts;
    return `${f.series.length > 1 ? `${s.label}: ` : ''}${shown.join(', ')}`;
  });
  return `${chart.title}. ${parts.join('; ')}.`;
}

/** The plot's box: the cell's width (a fixed width when given: a rendered snapshot, scripts/console-tabs-test.ts). */
function Sized({ width, height, children }: { width?: number; height: number; children: React.ReactElement }) {
  if (width) return <div style={{ width, height }}>{React.cloneElement(children as React.ReactElement<{ width?: number; height?: number }>, { width, height })}</div>;
  return <ResponsiveContainer width='100%' height={height}>{children}</ResponsiveContainer>;
}

function Plot({ chart, f, width }: { chart: PackChartSpec; f: Frame; width?: number }) {
  // A single series coloured per bar (an ordinal palette) carries each bar's colour for its tooltip swatch.
  const data = f.categories.map((c, i) => Object.fromEntries([['name', c], ...f.series.map((s) => [s.key, s.values[i]]), ...(f.series[0]?.colors ? [['__fill', f.series[0].colors[i]]] : [])]));
  const tick = (v: number) => formatValue(v, f.unit, true);
  const tip = (props: TipProps) => <Tip {...props} unit={f.unit} />;
  const grid = <CartesianGrid vertical={false} stroke='var(--viz-grid)' strokeWidth={1} />;
  const stacked = chart.type === 'stacked_bar';
  // Magnitude by group reads best as horizontal bars (long names stay readable); time runs left to right.
  if ((chart.type === 'bar' || stacked) && !f.time) {
    const height = Math.max(120, f.categories.length * 32 + 24);
    return (
      <Sized width={width} height={height}>
        <BarChart accessibilityLayer={false} data={data} layout='vertical' margin={{ left: 0, right: 48, top: 4, bottom: 0 }} barCategoryGap={8}>
          <CartesianGrid horizontal={false} stroke='var(--viz-grid)' strokeWidth={1} />
          <XAxis type='number' tickFormatter={tick} tick={AXIS} axisLine={false} tickLine={false} allowDecimals={f.unit !== 'count'} />
          <YAxis type='category' dataKey='name' width={132} tick={AXIS} axisLine={{ stroke: 'var(--viz-axis)' }} tickLine={false}
            tickFormatter={(v: string) => (v.length > 22 ? `${v.slice(0, 21)}…` : v)} />
          <Tooltip cursor={{ fill: 'var(--muted)', opacity: 0.5 }} content={tip} />
          {f.series.map((s, si) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} stackId={stacked ? 'a' : undefined} fill={s.color} barSize={16} isAnimationActive={false}
              // A 2px surface gap between touching segments; the data end is rounded, the baseline square.
              stroke={stacked ? 'var(--background)' : undefined} strokeWidth={stacked ? 2 : 0}
              radius={!stacked || si === f.series.length - 1 ? [0, 4, 4, 0] : 0}
              label={!stacked && f.series.length === 1 ? { position: 'right', fontSize: 11, fill: 'var(--foreground)', formatter: (v: unknown) => formatValue(Number(v), f.unit, true) } : undefined}>
              {s.colors?.map((c, i) => <Cell key={i} fill={c} />)}
            </Bar>
          ))}
        </BarChart>
      </Sized>
    );
  }
  const x = <XAxis dataKey='name' tick={AXIS} axisLine={{ stroke: 'var(--viz-axis)' }} tickLine={false} interval='preserveStartEnd' minTickGap={16} />;
  const y = <YAxis tickFormatter={tick} tick={AXIS} axisLine={false} tickLine={false} width={48} allowDecimals={f.unit !== 'count'} />;
  if (chart.type === 'bar' || stacked) {
    return (
      <Sized width={width} height={220}>
        <BarChart accessibilityLayer={false} data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }} barCategoryGap='25%'>
          {grid}{x}{y}
          <Tooltip cursor={{ fill: 'var(--muted)', opacity: 0.5 }} content={tip} />
          {f.series.map((s, si) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} stackId={stacked ? 'a' : undefined} fill={s.color} maxBarSize={24} isAnimationActive={false}
              stroke={stacked ? 'var(--background)' : undefined} strokeWidth={stacked ? 2 : 0} radius={!stacked || si === f.series.length - 1 ? [4, 4, 0, 0] : 0} />
          ))}
        </BarChart>
      </Sized>
    );
  }
  if (chart.type === 'area') {
    return (
      <Sized width={width} height={220}>
        <AreaChart accessibilityLayer={false} data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
          {grid}{x}{y}
          <Tooltip cursor={{ stroke: 'var(--viz-axis)' }} content={tip} />
          {f.series.map((s) => (
            <Area key={s.key} dataKey={s.key} name={s.label} type='linear' stroke={s.color} strokeWidth={2} fill={s.color} fillOpacity={0.1}
              connectNulls={false} dot={false} activeDot={{ r: 5, stroke: 'var(--background)', strokeWidth: 2 }} isAnimationActive={false} />
          ))}
        </AreaChart>
      </Sized>
    );
  }
  return (
    <Sized width={width} height={220}>
      <LineChart accessibilityLayer={false} data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
        {grid}{x}{y}
        <Tooltip cursor={{ stroke: 'var(--viz-axis)' }} content={tip} />
        {f.series.map((s) => (
          <Line key={s.key} dataKey={s.key} name={s.label} type='linear' stroke={s.color} strokeWidth={2} strokeLinecap='round' strokeLinejoin='round'
            connectNulls={false} dot={false} activeDot={{ r: 5, stroke: 'var(--background)', strokeWidth: 2 }} isAnimationActive={false} />
        ))}
      </LineChart>
    </Sized>
  );
}

/**
 * Stat tiles: one per metric (label, then the value; the value's own figures, not tabular, at this size). `compact`: two
 * a row at any width, without the metrics' descriptions (a card of the home page's right column, mold_v0-172).
 */
function Tiles({ ms, compact = false }: { ms: MetricAnswer[]; compact?: boolean }) {
  return (
    <dl className={compact ? 'grid grid-cols-2 gap-x-4 gap-y-3' : 'grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4'}>
      {ms.map((m) => (
        <div key={m.name} className='min-w-0' title={compact && m.description ? m.description : undefined}>
          <dt className='text-muted-foreground text-xs font-medium'>{m.label}</dt>
          <dd className={compact ? 'mt-0.5 text-xl font-semibold tracking-tight' : 'mt-1 text-2xl font-semibold tracking-tight'}>{formatValue(m.value, m.unit)}</dd>
          {!compact && m.description && <dd className='text-muted-foreground mt-0.5 text-xs'>{m.description}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** A number chart's tiles alone (no cell around them): a skeleton until its metrics are in, a refusal's reason. */
export function ChartTiles({ chart, results, compact = false }: { chart: PackChartSpec; results: Map<string, MetricResult>; compact?: boolean }) {
  const rs = chart.metrics.map((n) => results.get(n));
  const failed = rs.find((r): r is { name: string; error: string; status: number } => !!r && 'error' in r);
  if (failed) return <p className='text-muted-foreground text-sm'>{failed.error}</p>;
  const ms = rs.filter(isAnswer);
  return ms.length !== chart.metrics.length ? <Skeleton className='h-24 w-full' /> : <Tiles ms={ms} compact={compact} />;
}

/** One chart in a grid cell: its title, the plot or the table, and a button between the two. */
export function ChartCell({ chart, results, width }: { chart: PackChartSpec; results: Map<string, MetricResult>; width?: number }) {
  const [asTable, setAsTable] = useState(chart.type === 'table');
  const rs = chart.metrics.map((n) => results.get(n));
  const ms = rs.filter(isAnswer);
  // A metric the person's role may not read hides the chart; another refusal says why.
  if (rs.some((r) => r && 'error' in r && r.status === 403)) return null;
  const failed = rs.find((r): r is { name: string; error: string; status: number } => !!r && 'error' in r);
  const frame = ms.length === chart.metrics.length && chart.type !== 'number' ? frameOf(chart, ms) : null;
  const empty = ms.length > 0 && ms.every((m) => m.rows === 0);
  const toggle = chart.type !== 'number' && chart.type !== 'table' && frame && !empty ? (
    <Button variant='ghost' size='sm' className='h-7 text-xs' aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>
      {asTable ? 'Show chart' : 'Show table'}
    </Button>
  ) : undefined;
  return (
    <Box title={chart.title} description={chart.description ?? frame?.note ?? undefined} action={toggle} className={chart.type === 'number' ? 'lg:col-span-2' : undefined}>
      {failed ? <p className='text-muted-foreground text-sm'>{failed.error}</p>
        : ms.length !== chart.metrics.length ? <Skeleton className='h-40 w-full' />
        : chart.type === 'number' ? <Tiles ms={ms} />
        : empty ? <p className='text-muted-foreground py-10 text-center text-sm'>Nothing to show yet.</p>
        : asTable ? (
          <DataTable caption={chart.title} unit={frame!.unit}
            head={[frame!.time ? 'Period' : 'Group', ...frame!.series.map((s) => s.label)]}
            rows={frame!.categories.map((c, i) => ({ label: c, values: frame!.series.map((s) => s.values[i] ?? null) }))} />
        ) : (
          <figure className='flex flex-col gap-2' role='img' aria-label={summary(chart, frame!)}>
            <Legend items={frame!.series.length > 1 ? frame!.series.map((s) => ({ label: s.label, color: s.color }))
              : chart.palette === 'ordinal' && frame!.series[0]!.colors ? frame!.categories.map((c, i) => ({ label: c, color: frame!.series[0]!.colors![i]! })) : []} />
            <div aria-hidden><Plot chart={chart} f={frame!} width={width} /></div>
          </figure>
        )}
    </Box>
  );
}
