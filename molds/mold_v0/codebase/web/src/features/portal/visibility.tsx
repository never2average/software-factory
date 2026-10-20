'use client';
// /app/pick-rate: did the coding agents in your simulations pick your product, and what did they pick instead. The
// data is GET /api/app/visibility `visibility` (src/visibility.ts visibilityCharts): scored sessions only, the hit rule
// of get_visibility_report, scoped to the account, the period, the product and the competitor / persona / task filters
// (the page header holds them: ./pick-rate.tsx). One stat strip, then Box cells two per row; a report (the print page)
// shows only the sections it includes, in the same order.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, LabelList, Line, ReferenceLine, XAxis, YAxis } from 'recharts';
import { StatStrip } from '@/components/layout/section';
import { Box } from '@/components/layout/chart-grid';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { num } from '@/lib/octillion-format';
import { cn } from '@/lib/utils';

interface Rate { scored: number; hits: number; misses: number; pick_pct: number | null; ci: [number, number] | null }
export interface Visibility {
  products: { id: number; name: string }[];
  product: number | null;
  totals: { scored: number; picked: number; pick_pct: number | null; ci: [number, number] | null; recommend: { scored: number; picked: number; missed: number };
    avoid: { scored: number; avoided: number; picked: number; avoid_pct: number | null }; competitor_losses: number; top_competitor: string | null };
  weekly: { week: string; partial: boolean; scored: number; picked: number; recommend_scored: number; recommend_picked: number; pick_pct: number | null; lo: number | null; hi: number | null;
    avoid_scored: number; avoided: number; avoid_pct: number | null; top_competitor: number }[];
  by_agent: (Rate & { key: string; name: string })[];
  by_harness: (Rate & { key: string; name: string })[];
  by_model: (Rate & { key: string; name: string })[];
  competitors: { name: string; sessions: number; share_pct: number }[];
  cloud: { name: string; weight: number; mentioned: number; chosen: number; installed: number; kind: 'tracked' | 'untracked' }[];
  head_to_head: { name: string; won: number; lost: number }[];
  reasons: {
    /** Sessions the agent didn't pick you in (a competitor won, or nothing of yours on a recommend task), and how many have a model's reason. */
    lost: number; explained: number; not_explained: number;
    categories: { id: string; label: string; sessions: number; share_pct: number; phrases: { phrase: string; sessions: number }[]; quotes: { quote: string; winner: string | null }[] }[];
    /** Competitor losses only: how the win showed up, and whether the agent named you. */
    losses: number; never_mentioned: number; how: { id: string; label: string; sessions: number }[];
  };
  by_task: (Rate & { id: number; title: string; expectation: string })[];
  by_persona: (Rate & { id: number; name: string })[];
  by_platform: (Rate & { platform: string; tasks: number })[];
  expectation: { expectation: 'recommend' | 'avoid'; tasks: number; scored: number; hits: number; misses: number; picked: number; pick_pct: number | null }[];
}

// Blue is you (and the pick rate), amber is the other tools: a CVD-safe pair, used the same way in every cell.
const YOU = 'var(--chart-2)', THEM = 'var(--chart-4)';
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);
const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const weekLabel = (v: unknown, payload: readonly { payload?: { partial?: boolean } }[] = []) => `Week of ${shortDay(String(v))}${payload[0]?.payload?.partial ? ' (part)' : ''}`;
const tipRow = (label: ReactNode, value: ReactNode) => (
  <div className='flex w-full items-center justify-between gap-4'><span className='text-muted-foreground'>{label}</span><span className='text-foreground font-mono font-medium tabular-nums'>{value}</span></div>
);
const Tip = ({ children }: { children: ReactNode }) => <div className='grid w-full min-w-40 gap-1'>{children}</div>;
const Empty = ({ children }: { children: ReactNode }) => <p className='text-muted-foreground py-14 text-center text-sm'>{children}</p>;
const clip = (v: string, n = 22) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);

interface BarRow { name: string; value: number; end: string; tip: ReactNode }
/** Ranked horizontal bars in the order given, a value label at each bar's end and a tooltip with the counts. */
function Bars({ rows, color, label, empty, max }: { rows: BarRow[]; color: string; label: string; empty: string; max?: number }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <ChartContainer config={{ value: { label, color } }} className='aspect-auto w-full' style={{ height: Math.max(120, rows.length * 28 + 8) }}>
      <BarChart data={rows} layout='vertical' margin={{ left: 0, right: 72, top: 0, bottom: 0 }}>
        <XAxis type='number' hide domain={[0, max ?? 'dataMax']} />
        <YAxis type='category' dataKey='name' width={136} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} tickFormatter={(v: string) => clip(v)} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel={false} formatter={(_v, _n, item) => (item.payload as BarRow).tip} />} />
        <Bar dataKey='value' fill={color} radius={4} barSize={16} minPointSize={2}>
          <LabelList dataKey='end' position='right' fontSize={11} fill='var(--muted-foreground)' />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

/** A reason's tooltip: its share, the top phrases the model wrote and up to three of the agent's own words. */
function ReasonTip({ c, of }: { c: Visibility['reasons']['categories'][number]; of: number }) {
  return (
    <div className='grid w-full max-w-72 min-w-48 gap-1 whitespace-normal'>
      <div className='font-medium'>{c.label}</div>
      {tipRow('Sessions', `${num(c.sessions)} of ${num(of)}`)}
      {c.id === 'not_explained' && <p className='text-muted-foreground'>No model reason for these sessions yet.</p>}
      {c.phrases.length > 0 && <ul className='text-muted-foreground grid gap-0.5'>{c.phrases.map((p) => <li key={p.phrase}>{p.phrase}{p.sessions > 1 ? ` (${p.sessions})` : ''}</li>)}</ul>}
      {c.quotes.map((q, i) => <q key={i} className='text-foreground/80 border-l pl-2 italic'>{q.quote}</q>)}
    </div>
  );
}

const rateTip = (r: Rate) => (
  <Tip>{tipRow('Pick rate', pct(r.pick_pct))}{tipRow('Hits', `${num(r.hits)} of ${num(r.scored)}`)}{r.ci && tipRow('95% interval', `${r.ci[0]}–${r.ci[1]}%`)}</Tip>
);
const rateRows = <T extends Rate>(xs: T[], name: (x: T) => string, n = 10): BarRow[] =>
  xs.filter((x) => x.scored > 0).slice(0, n).map((x) => ({ name: name(x), value: x.pick_pct ?? 0, end: `${pct(x.pick_pct)} · n=${x.scored}`, tip: rateTip(x) }));

/** The report sections, in the page's order (src/visibility.ts SECTIONS has the same ids). */
export const SECTIONS = [
  { id: 'summary', label: 'Summary cards' },
  { id: 'weekly', label: 'Pick rate over time' },
  { id: 'by_agent', label: 'Pick rate by agent' },
  { id: 'by_harness', label: 'Pick rate by harness' },
  { id: 'by_model', label: 'Pick rate by model' },
  { id: 'competitors', label: 'Competitor share' },
  { id: 'cloud', label: 'Competitor word cloud (list)' },
  { id: 'by_task', label: 'Pick rate by task' },
  { id: 'by_persona', label: 'Pick rate by developer persona' },
  { id: 'head_to_head', label: 'Head-to-head' },
  { id: 'reasons', label: 'Why agents chose others' },
  { id: 'how_won', label: 'How the win showed up' },
  { id: 'expectation', label: 'Expectation check' },
  { id: 'by_platform', label: 'Pick rate by platform' }
] as const;
export type SectionId = (typeof SECTIONS)[number]['id'];

/**
 * The page body: the stat strip, then each section's cell, two per row. `sections` limits it to those (a report);
 * `after` renders something under a section's cell (the print page's table).
 */
export function VisibilitySection({ v, sections, after, print }: { v: Visibility | undefined; sections?: readonly SectionId[]; after?: (id: SectionId) => ReactNode; print?: boolean }) {
  const t = v?.totals;
  const weekly = useMemo(() => (v?.weekly ?? []).map((w) => ({ ...w, band: w.lo == null || w.hi == null ? null : [w.lo, w.hi] })), [v?.weekly]);
  const any = Boolean(t?.scored);
  const top = v?.competitors[0];
  const h2h = (v?.head_to_head ?? []).map((x) => ({ ...x, lostNeg: -x.lost }));
  const scoredTasks = (v?.expectation ?? []).filter((e) => e.scored > 0);
  const show = (id: SectionId) => !sections || sections.includes(id);
  const dimBox = (d: 'agent' | 'harness' | 'model', rows: (Rate & { name: string })[]) => (
    <Box title={`Pick rate by ${d}`} description={`Picked on tasks you should win, for each ${d === 'agent' ? 'coding agent' : d}, with n.`}>
      <Bars rows={rateRows(rows, (x) => x.name)} color={YOU} label='Pick rate' max={100} empty='No scored sessions in this period.' />
    </Box>
  );
  const cells: Record<Exclude<SectionId, 'summary'>, ReactNode> = {
    weekly: (
      <Box title='Pick rate over time' description='Each week, picked on tasks you should win; the band is the 95% interval.'>
        {t?.recommend.scored ? (
          <ChartContainer config={{ pick_pct: { label: 'Pick rate', color: YOU }, band: { label: '95% interval', color: YOU } } satisfies ChartConfig} className='aspect-auto h-[240px] w-full'>
            <ComposedChart data={weekly} margin={{ left: 0, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey='week' tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDay} />
              <YAxis width={40} tickLine={false} axisLine={false} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(x) => `${x}%`} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={weekLabel}
                formatter={(_v, name, item) => name === 'band' ? null : (
                  <Tip>{tipRow('Pick rate', pct(item.payload.pick_pct))}{tipRow('Picked', `${num(item.payload.recommend_picked)} of ${num(item.payload.recommend_scored)}`)}
                    {item.payload.lo != null && tipRow('95% interval', `${item.payload.lo}–${item.payload.hi}%`)}</Tip>)} />} />
              <Area dataKey='band' type='monotone' fill='var(--color-band)' fillOpacity={0.15} stroke='none' connectNulls activeDot={false} isAnimationActive={false} />
              <Line dataKey='pick_pct' type='monotone' stroke='var(--color-pick_pct)' strokeWidth={2} connectNulls dot={{ r: 4, strokeWidth: 2, fill: 'var(--background)' }} activeDot={{ r: 5 }} isAnimationActive={!print} />
            </ComposedChart>
          </ChartContainer>
        ) : <Empty>No scored sessions on tasks you should win in this period.</Empty>}
      </Box>
    ),
    by_agent: dimBox('agent', v?.by_agent ?? []),
    by_harness: dimBox('harness', v?.by_harness ?? []),
    by_model: dimBox('model', v?.by_model ?? []),
    competitors: (
      <Box title='Competitor share' description="When an agent didn't pick you, the tool it picked instead, as a share of those sessions.">
        <Bars rows={(v?.competitors ?? []).slice(0, 10).map((c) => ({ name: c.name, value: c.share_pct, end: `${c.share_pct}%`,
          tip: <Tip>{tipRow('Picked instead of you', `${num(c.sessions)} of ${num(t?.competitor_losses ?? 0)}`)}{tipRow('Share', `${c.share_pct}%`)}</Tip> }))}
          color={THEM} label='Share' max={100} empty='No agent picked a competitor in this period.' />
      </Box>
    ),
    cloud: (
      <Box title='Competitor word cloud' description='Tools agents chose or named in your sessions, sized by how often.'>
        <WordCloud words={v?.cloud ?? []} openList={print} />
      </Box>
    ),
    by_task: (
      <Box title='Pick rate by task' description='Hits of scored sessions on each of your tasks, best first.'>
        <Bars rows={rateRows(v?.by_task ?? [], (x) => x.title, 12)} color={YOU} label='Pick rate' max={100} empty='No scored sessions in this period.' />
      </Box>
    ),
    by_persona: (
      <Box title='Pick rate by developer persona' description='Picked on tasks you should win, for each simulated developer.'>
        <Bars rows={rateRows(v?.by_persona ?? [], (x) => x.name)} color={YOU} label='Pick rate' max={100} empty='No scored sessions with a persona in this period.' />
      </Box>
    ),
    head_to_head: (
      <Box title='Head-to-head' description='On tasks you should win where a competitor came up: you picked (right) vs it picked (left).'>
        {h2h.length ? (
          <ChartContainer config={{ won: { label: 'You won', color: YOU }, lostNeg: { label: 'They won', color: THEM } } satisfies ChartConfig}
            className='aspect-auto w-full' style={{ height: Math.max(140, h2h.length * 30 + 48) }}>
            <BarChart data={h2h} layout='vertical' stackOffset='sign' margin={{ left: 0, right: 16, top: 0, bottom: 0 }}>
              <XAxis type='number' tickLine={false} axisLine={false} allowDecimals={false} tickFormatter={(x) => String(Math.abs(Number(x)))} fontSize={11} />
              <YAxis type='category' dataKey='name' width={120} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} tickFormatter={(x: string) => clip(x, 18)} />
              <ReferenceLine x={0} stroke='var(--border)' />
              <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel={false}
                formatter={(_v, name, item) => name === 'won' ? (
                  <Tip>{tipRow('You won', num(item.payload.won))}{tipRow(`${item.payload.name} won`, num(item.payload.lost))}
                    {tipRow('Your share', pct(item.payload.won + item.payload.lost ? Math.round((item.payload.won / (item.payload.won + item.payload.lost)) * 1000) / 10 : null))}</Tip>) : null} />} />
              <Bar dataKey='lostNeg' stackId='h' fill='var(--color-lostNeg)' radius={4} barSize={16} />
              <Bar dataKey='won' stackId='h' fill='var(--color-won)' radius={4} barSize={16} />
              <ChartLegend content={<ChartLegendContent />} />
            </BarChart>
          </ChartContainer>
        ) : <Empty>No competitor came up on a task you should win in this period.</Empty>}
      </Box>
    ),
    reasons: (
      <Box title='Why agents chose others' description={v?.reasons.lost
        ? `The main reason in the agent's own words, in ${num(v.reasons.lost)} sessions that didn't pick you${v.reasons.not_explained ? ` (${num(v.reasons.not_explained)} not explained yet)` : ''}.`
        : "The main reason in the agent's own words, in sessions that didn't pick you."}>
        {v?.reasons.lost ? (
          <div className='flex flex-col gap-2'>
            <Bars rows={v.reasons.categories.map((c) => ({ name: c.label, value: c.share_pct, end: `${c.share_pct}% · ${num(c.sessions)}`, tip: <ReasonTip c={c} of={v.reasons.lost} /> }))}
              color={THEM} label='Share' max={100} empty='' />
            <details className='text-muted-foreground group text-xs' open={print}>
              <summary className='hover:text-foreground cursor-pointer select-none'>Reasons and quotes</summary>
              <ol className='mt-2 grid gap-2'>
                {v.reasons.categories.filter((c) => c.phrases.length || c.quotes.length).map((c) => (
                  <li key={c.id} className='grid gap-0.5'>
                    <span className='text-foreground font-medium'>{c.label} <span className='text-muted-foreground font-normal tabular-nums'>· {num(c.sessions)}</span></span>
                    {c.phrases.length > 0 && <span>{c.phrases.map((p) => `${p.phrase}${p.sessions > 1 ? ` (${p.sessions})` : ''}`).join(' · ')}</span>}
                    {c.quotes.map((q, i) => <q key={i} className='text-foreground/80 italic'>{q.quote}</q>)}
                  </li>
                ))}
              </ol>
            </details>
          </div>
        ) : <Empty>Every session in this period picked you.</Empty>}
      </Box>
    ),
    how_won: (
      <Box title='How the win showed up' description={t?.competitor_losses ? `What the agent did with the other tool, in ${num(t.competitor_losses)} sessions lost to a competitor.` : 'What the agent did with the other tool, in sessions lost to a competitor.'}>
        {v?.reasons.losses ? (
          <div className='flex flex-col gap-3'>
            <Bars rows={v.reasons.how.map((r) => ({ name: r.label, value: r.sessions, end: `${num(r.sessions)} · ${Math.round((r.sessions / v.reasons.losses) * 100)}%`,
              tip: <Tip>{tipRow('Sessions', `${num(r.sessions)} of ${num(v.reasons.losses)}`)}</Tip> }))} color={THEM} label='Sessions' empty='' />
            <Bars rows={[
              { name: 'Never mentioned you', value: v.reasons.never_mentioned },
              { name: 'Mentioned you, chose it', value: v.reasons.losses - v.reasons.never_mentioned },
            ].map((r) => ({ ...r, end: `${num(r.value)} · ${Math.round((r.value / v.reasons.losses) * 100)}%`, tip: <Tip>{tipRow('Sessions', `${num(r.value)} of ${num(v.reasons.losses)}`)}</Tip> }))}
              color='var(--muted-foreground)' label='Sessions' empty='' />
          </div>
        ) : <Empty>No session lost to a competitor in this period.</Empty>}
      </Box>
    ),
    expectation: (
      <Box title='Expectation check' description='Tasks that should pick you vs tasks that should not: sessions that got it right and wrong.'>
        {scoredTasks.length ? (
          <ChartContainer config={{ hits: { label: 'Right call', color: YOU }, misses: { label: 'Wrong call', color: THEM } } satisfies ChartConfig}
            className='aspect-auto h-[150px] w-full'>
            <BarChart data={scoredTasks.map((e) => ({ ...e, name: e.expectation === 'recommend' ? 'Should pick you' : 'Should avoid you' }))} layout='vertical' margin={{ left: 0, right: 16, top: 0, bottom: 0 }}>
              <XAxis type='number' hide allowDecimals={false} />
              <YAxis type='category' dataKey='name' width={120} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel={false}
                formatter={(_v, name, item) => name === 'hits' ? (
                  <Tip>{tipRow('Right call', num(item.payload.hits))}{tipRow('Wrong call', num(item.payload.misses))}{tipRow('Picked you', num(item.payload.picked))}
                    {tipRow('Tasks', num(item.payload.tasks))}</Tip>) : null} />} />
              <Bar dataKey='hits' stackId='e' fill='var(--color-hits)' stroke='var(--background)' strokeWidth={2} barSize={20} />
              <Bar dataKey='misses' stackId='e' fill='var(--color-misses)' stroke='var(--background)' strokeWidth={2} barSize={20} radius={[0, 4, 4, 0]} />
              <ChartLegend content={<ChartLegendContent />} />
            </BarChart>
          </ChartContainer>
        ) : <Empty>No scored sessions in this period.</Empty>}
      </Box>
    ),
    by_platform: (
      <Box title='Pick rate by platform' description='Picked on tasks you should win, by the platform each task targets.'>
        <Bars rows={rateRows(v?.by_platform ?? [], (x) => x.platform)} color={YOU} label='Pick rate' max={100} empty='No scored sessions in this period.' />
      </Box>
    )
  };
  const ids = SECTIONS.map((s) => s.id).filter((id): id is Exclude<SectionId, 'summary'> => id !== 'summary' && show(id));
  // Two per row; on the print page a section's table goes right under the row holding its cell.
  const rows: (typeof ids)[] = [];
  for (let i = 0; i < ids.length; i += 2) rows.push(ids.slice(i, i + 2));
  return (
    <>
      {show('summary') && (
        <div className='break-inside-avoid'>
          <StatStrip className='border-x [&>div:first-child]:pl-4 max-sm:[&>div:nth-child(odd)]:pl-4' items={[
            { label: 'Pick rate', value: pct(t?.pick_pct), spark: weekly.map((w) => w.pick_pct ?? 0) },
            { label: 'Correctly avoided', value: t?.avoid.scored ? pct(t.avoid.avoid_pct) : '—', spark: weekly.map((w) => w.avoid_pct ?? 0) },
            { label: 'Top competitor', value: <span className='block max-w-[11rem] truncate' title={top?.name}>{top?.name ?? '—'}</span>, spark: weekly.map((w) => w.top_competitor) },
            { label: 'Sessions scored', value: num(t?.scored ?? 0), spark: weekly.map((w) => w.scored) },
          ]} />
          {after?.('summary')}
        </div>
      )}
      <div className={cn('border-l', !show('summary') && 'border-t')}>
        {rows.map((r) => (
          <div key={r.join()} className='break-inside-avoid'>
            <div className={cn('grid', print ? 'grid-cols-2' : 'lg:grid-cols-2')}>{r.map((id) => <div key={id} className='contents'>{cells[id]}</div>)}</div>
            {after && r.map((id) => <div key={id}>{after(id)}</div>)}
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- word cloud: a small spiral layout (no dependency) ----------

type Word = Visibility['cloud'][number];
const KIND = [
  { id: 'chosen', label: 'Picked over you', color: 'var(--chart-3)' },
  { id: 'mentioned', label: 'Named only', color: 'var(--chart-2)' },
  { id: 'untracked', label: 'Installed, not tracked', color: 'var(--muted-foreground)' },
] as const;
const kindOf = (w: Word) => (w.kind === 'untracked' ? KIND[2] : w.chosen ? KIND[0] : KIND[1]);

/** Place words biggest first along an Archimedean spiral from the centre, skipping any that would overlap or overflow. */
function layout(words: Word[], width: number, height: number) {
  const max = Math.max(...words.map((w) => w.weight), 1), min = Math.min(...words.map((w) => w.weight), max);
  const placed: { w: Word; x: number; y: number; size: number; box: [number, number, number, number] }[] = [];
  const big = Math.min(44, Math.max(22, width / 12));
  for (const w of words) {
    const t = max === min ? 1 : Math.sqrt((w.weight - min) / (max - min));
    const size = Math.round(12 + t * (big - 12));
    const bw = w.name.length * size * 0.58 + 6, bh = size * 1.15;
    for (let i = 0; i < 1500; i++) {
      const a = i * 0.35, r = 2.2 * a;
      const x = width / 2 + r * Math.cos(a) * 1.6, y = height / 2 + r * Math.sin(a);
      const box: [number, number, number, number] = [x - bw / 2, y - bh / 2, x + bw / 2, y + bh / 2];
      if (box[0] < 2 || box[2] > width - 2 || box[1] < 2 || box[3] > height - 2) { if (r > width) break; continue; }
      if (placed.some((p) => box[0] < p.box[2] && box[2] > p.box[0] && box[1] < p.box[3] && box[3] > p.box[1])) continue;
      placed.push({ w, x, y, size, box });
      break;
    }
  }
  return placed;
}

function WordCloud({ words, openList }: { words: Word[]; openList?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<Word | null>(null);
  const height = 240;
  useLayoutEffect(() => { if (ref.current) setWidth(ref.current.clientWidth); }, []);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const placed = useMemo(() => (width ? layout(words, width, height) : []), [words, width]);
  if (!words.length) return <Empty>No competitor or other tool came up in this period.</Empty>;
  const detail = (w: Word) => [w.chosen && `picked over you in ${num(w.chosen)}`, w.mentioned && `named in ${num(w.mentioned)}`, w.installed && `installed in ${num(w.installed)}`].filter(Boolean).join(', ') + ' sessions';
  return (
    <div className='flex flex-col gap-2'>
      <div ref={ref} className='relative w-full' style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} role='img' aria-label={`Word cloud of ${words.length} tools; the list below has the counts`}>
            {placed.map(({ w, x, y, size }) => (
              <text key={w.name} x={x} y={y} fontSize={size} textAnchor='middle' dominantBaseline='central' fill={kindOf(w).color}
                fontWeight={size > 24 ? 600 : 500} className='cursor-default transition-opacity' opacity={hover && hover !== w ? 0.35 : 1}
                onMouseEnter={() => setHover(w)} onMouseLeave={() => setHover(null)}>
                <title>{`${w.name}: ${detail(w)}`}</title>{w.name}
              </text>
            ))}
          </svg>
        )}
        {hover && (
          <div className='bg-background pointer-events-none absolute top-1 left-1 rounded-md border px-2.5 py-1.5 text-xs shadow-sm'>
            <div className='mb-1 font-medium'>{hover.name}</div>
            <Tip>{hover.kind === 'tracked' ? <>{tipRow('Picked over you', num(hover.chosen))}{tipRow('Named in', num(hover.mentioned))}</> : tipRow('Installed in', num(hover.installed))}{tipRow('Weight', num(hover.weight))}</Tip>
          </div>
        )}
      </div>
      <div className='text-muted-foreground flex flex-col gap-1 text-xs'>
        <div className='flex flex-wrap gap-x-3 gap-y-1'>
          {KIND.filter((k) => words.some((w) => kindOf(w).id === k.id)).map((k) => (
            <span key={k.id} className='flex items-center gap-1.5'><span className='size-2 rounded-full' style={{ background: k.color }} />{k.label}</span>
          ))}
        </div>
        <details className='group' open={openList}>
          <summary className='hover:text-foreground cursor-pointer select-none'>View as list</summary>
          <ol className='mt-2 grid gap-0.5'>
            {words.map((w) => <li key={w.name} className='flex justify-between gap-6'><span className='text-foreground'>{w.name}</span><span className='tabular-nums'>{detail(w)}</span></li>)}
          </ol>
        </details>
      </div>
    </div>
  );
}
