'use client';
// /app Usage: the team's own activity (Pick rate, what agents picked, is its own page: src/features/portal/pick-rate.tsx) across every AI client, its simulations and what agents picked, and model spend,
// for everyone or for the people picked in the People filter (server-side). The layout is admin Analytics': one stat
// strip, then a grid of cells sharing hairlines, two per row at most (components/layout/chart-grid).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts';
import PageContainer from '@/components/layout/page-container';
import { StatStrip } from '@/components/layout/section';
import { Box, RankBars, top } from '@/components/layout/chart-grid';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { appApi } from '@/lib/api-client';
import { num, usd } from '@/lib/display-format';
import { DateRangePicker, last30, rangeQuery, type DateRange } from '@/components/layout/date-range-picker';
import { MultiSelectFilter, type FilterOption } from '@/components/layout/multi-select-filter';
import { Icons } from '@/components/icons';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ErrorState, LoadingCards, useOrgLoad } from './shared';
import { profile } from '@/config/profile.generated';

interface Week { week: string; partial: boolean }
interface Usage {
  days: number; range?: { from: string; to: string }; daily: { day: string; calls: number; errors: number; people: number }[];
  tools: { name: string; calls: number; errors: number; avg_ms: number | null }[];
  runs: { simulations: number; sessions: number; completed: number };
  people: { user_id: string; email: string; me: boolean; calls: number }[];
  active_people: number;
  use_cases?: { id: string; name: string; own: boolean; calls?: number }[];
  spend: { month_usd: number; budget_usd: number; filtered?: boolean };
  /** The cards' sparklines: people, simulations and finished sessions per day of the period; model spend per day this month. */
  series?: { days: string[]; people: number[]; simulations: number[]; completed: number[]; month_days: string[]; spend: number[] };
  /** The period's runs (mold_v0-008; src/usage-report.ts workspaceRunUsage): present only when there are any. */
  run_usage?: {
    runs: number; cost_usd: number; tool_calls: number; requests: number; tokens: number;
    by_kind: { pack: string; kind: string; runs: number; succeeded: number; failed: number; tool_calls: number; requests: number; cost_usd: number }[];
    by_person: { user_id: string | null; label: string; runs: number; tool_calls: number; cost_usd: number }[];
    recent: { id: string; kind: string; status: string; by: string; created_at: string; tool_calls: number; requests: number; cost_usd: number }[];
  };
  /** The grid's series (src/app.ts usageCharts). */
  charts?: {
    workflow: { id: string; label: string; used: number; total: number; calls: number }[];
    clients: { client: string; calls: number }[];
    sims_weekly: (Week & { completed: number; other: number })[];
    harnesses: { harness: string; sessions: number; completed: number }[];
    spend_by: { kind: 'person' | 'simulation'; rows: { key: string | null; name: string; usd: number }[] };
    /** Only for a Billing manager or Owner. */
    allowance_usd: number | null;
    recent: { id: string; name: string; product: string; status: string; created_at: string; by: string; sessions: number; scored: number; hits: number; hit_pct: number | null }[];
  };
}

const callsConfig = { calls: { label: 'Tool calls', color: 'var(--chart-1)' }, errors: { label: 'Errors', color: 'var(--destructive)' } } satisfies ChartConfig;
const peopleConfig = { people: { label: 'Active people', color: 'var(--chart-2)' } } satisfies ChartConfig;
const simsConfig = { completed: { label: 'Completed', color: 'var(--chart-2)' }, other: { label: 'Not completed', color: 'var(--chart-4)' } } satisfies ChartConfig;
const spendConfig = { usd: { label: 'Model spend', color: 'var(--chart-3)' } } satisfies ChartConfig;

const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayAxis = <XAxis dataKey='day' tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={shortDay} />;
const weekAxis = <XAxis dataKey='week' tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDay} />;
const weekLabel = (v: unknown, payload: readonly { payload?: { partial?: boolean } }[] = []) => `Week of ${shortDay(String(v))}${payload[0]?.payload?.partial ? ' (part)' : ''}`;
const tipRow = (label: ReactNode, value: ReactNode) => (
  <div className='flex w-full items-center justify-between gap-4'><span className='text-muted-foreground'>{label}</span><span className='text-foreground font-mono font-medium tabular-nums'>{value}</span></div>
);
const Empty = ({ children }: { children: ReactNode }) => <p className='text-muted-foreground py-16 text-center text-sm'>{children}</p>;

/** Usage: the team's activity, for everyone or the people and use cases picked. */
export function UsagePage() {
  const [range, setRange] = useState<DateRange>(last30);
  const [users, setUsers] = useState<string[]>([]);
  const [useCases, setUseCases] = useState<string[]>([]);
  const userQ = (users.length ? `&user=${encodeURIComponent(users.join(','))}` : '') + (useCases.length ? `&use_case=${encodeURIComponent(useCases.join(','))}` : '');
  const { data: u, error } = useOrgLoad(() => appApi<Usage>('GET', `/usage?${rangeQuery(range)}${userQ}`), [range.from, range.to, userQ]);
  const [ucOpts, setUcOpts] = useState<FilterOption[]>([]);
  useEffect(() => { if (u?.use_cases) setUcOpts(u.use_cases.map((x) => ({ value: x.id, label: x.name, hint: x.own ? 'yours' : undefined, count: x.calls }))); }, [u?.use_cases]);
  // keep the people list from the last load, so the picker does not empty while a new selection loads
  const [peopleOpts, setPeopleOpts] = useState<FilterOption[]>([]);
  useEffect(() => {
    if (u?.people) setPeopleOpts(u.people.map((p) => ({ value: p.user_id, label: p.me ? `${p.email} (you)` : p.email, count: p.calls })));
  }, [u?.people]);
  return (
    <PageContainer
      pageTitle='Usage'
      pageDescription={users.length ? `${users.length === 1 ? 'One person' : `${users.length} people`} on your team, across every AI client.` : 'Your whole team, across every AI client.'}
      pageHeaderAction={
        <div className='flex flex-wrap items-center gap-2'>
          <MultiSelectFilter noun='use cases' icon={<Icons.route />} options={ucOpts} value={useCases} onChange={setUseCases} />
          <MultiSelectFilter noun='people' icon={<Icons.teams />} options={peopleOpts} value={users} onChange={setUsers} />
          <DateRangePicker value={range} onChange={setRange} />
        </div>
      }
    >
      {error ? <ErrorState error={error} /> : !u ? <LoadingCards count={4} />
        : <UsageBody u={u} users={users} />}
    </PageContainer>
  );
}

function UsageBody({ u, users }: { u: Usage; users: string[] }) {
  const days = u.days;
  // Every day of the period, zero-filled, so the charts have a continuous axis.
  const series = useMemo(() => {
    const by = new Map(u.daily.map((d) => [d.day, d]));
    const start = u.range ? Date.parse(`${u.range.from}T00:00:00Z`) : Date.now() - (days - 1) * 86_400_000;
    return Array.from({ length: days }, (_, i) => {
      const k = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
      const d = by.get(k);
      return { day: k, calls: Number(d?.calls ?? 0), errors: Number(d?.errors ?? 0), people: Number(d?.people ?? 0) };
    });
  }, [u, days]);
  const spendDaily = useMemo(() => (u.series?.month_days ?? []).map((day, i) => ({ day, usd: Number(u.series?.spend[i] ?? 0) })), [u.series]);
  const c = u.charts;
  const calls = series.reduce((s, d) => s + d.calls, 0);
  const picked = new Set(users);
  const people = u.people.filter((p) => !picked.size || picked.has(p.user_id));
  // The allowance spread evenly over the month: the daily pace that uses it up on the last day.
  const now = new Date(), monthLen = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const pace = c?.allowance_usd && !u.spend.filtered ? c.allowance_usd / monthLen : null;
  return (
    <div className='flex w-full flex-col pb-4'>
      <StatStrip className='border-x [&>div:first-child]:pl-4 max-sm:[&>div:nth-child(odd)]:pl-4' items={[
        { label: 'Tool calls', value: num(calls), spark: series.map((d) => d.calls) },
        { label: 'Active people', value: num(u.active_people), spark: u.series?.people ?? series.map((d) => d.people) },
        { label: 'Simulations run', value: num(u.runs.simulations), spark: u.series?.simulations },
        { label: u.spend.filtered ? 'Their model spend this month' : 'Model spend this month', value: usd(u.spend.month_usd), spark: u.series?.spend }
      ]} />

      <div className='border-l'>
        <div className='grid lg:grid-cols-2'>
          <Box title='Tool calls per day' description={`Every ${profile.name} tool call, failed ones in red.`}>
            {calls ? (
              <ChartContainer config={callsConfig} className='aspect-auto h-[240px] w-full'>
                <AreaChart data={series} margin={{ left: 0, right: 8, top: 8 }}>
                  <defs>
                    <linearGradient id='fillUsageCalls' x1='0' y1='0' x2='0' y2='1'>
                      <stop offset='5%' stopColor='var(--color-calls)' stopOpacity={0.6} />
                      <stop offset='95%' stopColor='var(--color-calls)' stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} />
                  {dayAxis}
                  <YAxis width={32} tickLine={false} axisLine={false} allowDecimals={false} />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(v) => shortDay(String(v))} indicator='dot' />} />
                  <Area dataKey='calls' type='monotone' fill='url(#fillUsageCalls)' stroke='var(--color-calls)' strokeWidth={2} />
                  <Area dataKey='errors' type='monotone' fill='var(--color-errors)' fillOpacity={0.25} stroke='var(--color-errors)' strokeWidth={1.5} />
                  <ChartLegend content={<ChartLegendContent />} />
                </AreaChart>
              </ChartContainer>
            ) : <Empty>No tool calls in this period.</Empty>}
          </Box>
          <Box title='Active people per day' description='People who made at least one tool call that day.'>
            {calls ? (
              <ChartContainer config={peopleConfig} className='aspect-auto h-[240px] w-full'>
                <BarChart data={series} margin={{ left: 0, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} />
                  {dayAxis}
                  <YAxis width={32} tickLine={false} axisLine={false} allowDecimals={false} />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(v) => shortDay(String(v))} indicator='dashed' />} />
                  <Bar dataKey='people' fill='var(--color-people)' radius={3} />
                </BarChart>
              </ChartContainer>
            ) : <Empty>Nobody was active in this period.</Empty>}
          </Box>
        </div>

        <div className='grid lg:grid-cols-2'>
          <Box title='Calls by tool' description={`The ten most called ${profile.name} tools.`}>
            <RankBars data={top(u.tools, (t) => Number(t.calls)).map((t) => ({ name: t.name, value: Number(t.calls) }))} label='Tool calls' color='var(--chart-1)' format={num} mono empty='No tool calls in this period.' />
          </Box>
          <Box title='Calls by person' description='Tool calls by each person on your team, busiest first.'>
            <RankBars data={top(people, (p) => Number(p.calls)).map((p) => ({ name: p.me ? 'You' : p.email, value: Number(p.calls) }))} label='Tool calls' color='var(--chart-2)' format={num} empty='Nobody made a tool call in this period.' />
          </Box>
        </div>

        <div className='grid lg:grid-cols-2'>
          <Box title='Workflow adoption' description="Share of each workflow's tools your team called in this period.">
            <RankBars data={(c?.workflow ?? []).map((w) => ({ name: w.label, value: w.total ? Math.round((w.used / w.total) * 100) : 0 }))} label='Tools used' color='var(--chart-3)' format={(v) => `${v}%`} empty='No workflow used yet in this period.' />
          </Box>
          <Box title='AI clients used' description="Tool calls by the AI client of the caller's latest connection.">
            <RankBars data={top(c?.clients ?? [], (x) => x.calls).map((x) => ({ name: x.client, value: x.calls }))} label='Tool calls' color='var(--chart-4)' format={num} mono empty='No tool calls in this period.' />
          </Box>
        </div>

        <div className='grid lg:grid-cols-2'>
          <Box title='Simulations per week' description='Simulations started each week, completed and the rest.'>
            {(c?.sims_weekly ?? []).some((w) => w.completed + w.other > 0) ? (
              <ChartContainer config={simsConfig} className='aspect-auto h-[240px] w-full'>
                <BarChart data={c!.sims_weekly} margin={{ left: 0, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} />
                  {weekAxis}
                  <YAxis width={32} tickLine={false} axisLine={false} allowDecimals={false} />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={weekLabel} indicator='dot' />} />
                  <Bar dataKey='completed' stackId='sims' fill='var(--color-completed)' stroke='var(--background)' strokeWidth={1} />
                  <Bar dataKey='other' stackId='sims' fill='var(--color-other)' stroke='var(--background)' strokeWidth={1} radius={[3, 3, 0, 0]} />
                  <ChartLegend content={<ChartLegendContent />} />
                </BarChart>
              </ChartContainer>
            ) : <Empty>No simulations in this period.</Empty>}
          </Box>
          <Box title='Agent sessions by harness' description='Which coding agents worked your tasks in this period.'>
            <RankBars data={top(c?.harnesses ?? [], (h) => h.sessions).map((h) => ({ name: h.harness, value: h.sessions }))} label='Sessions' color='var(--chart-2)' format={num} mono empty='No agent sessions in this period.' />
          </Box>
        </div>

        <div className='grid lg:grid-cols-2'>
          <Box title='Model spend per day this month' description={pace ? 'Daily model spend; the dashed line is your allowance spread evenly over the month.' : 'Daily model spend on your simulations this month.'}>
            {spendDaily.some((d) => d.usd > 0) ? (
              <ChartContainer config={spendConfig} className='aspect-auto h-[240px] w-full'>
                <BarChart data={spendDaily} margin={{ left: 0, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} />
                  {dayAxis}
                  <YAxis width={48} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v}`} domain={[0, (max: number) => Math.max(max, pace ?? 0)]} />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(v) => shortDay(String(v))} formatter={(v) => tipRow('Model spend', usd(v))} />} />
                  <Bar dataKey='usd' fill='var(--color-usd)' radius={3} />
                  {pace && <ReferenceLine y={pace} stroke='var(--muted-foreground)' strokeDasharray='4 4'
                    label={{ value: `${usd(pace)}/day`, position: 'insideTopRight', fontSize: 11, fill: 'var(--muted-foreground)' }} />}
                </BarChart>
              </ChartContainer>
            ) : <Empty>No model spend this month.</Empty>}
          </Box>
          {c?.spend_by.kind === 'person' ? (
            <Box title='Spend by person' description='Model spend this month on the runs each person launched.'>
              <RankBars data={c.spend_by.rows.map((r) => ({ name: r.name, value: r.usd }))} label='Model spend' color='var(--chart-3)' format={usd} empty='No model spend this month.' />
            </Box>
          ) : (
            <Box title='Spend by simulation' description='Model spend this month on each simulation.'>
              <RankBars data={(c?.spend_by.rows ?? []).map((r) => ({ name: r.name, value: r.usd }))} label='Model spend' color='var(--chart-3)' format={usd} empty='No model spend this month.' />
            </Box>
          )}
        </div>

        <Box title='Recent simulations' description='Hit rate of the latest simulations in this period: how often agents picked your product.'>
          <RankBars data={(c?.recent ?? []).filter((r) => r.scored > 0).map((r) => ({ name: r.name, value: r.hit_pct ?? 0 }))}
            color='var(--chart-2)' format={(v) => `${v}%`} label='Hit rate' empty='No scored simulations in this period.' />
        </Box>
        {u.run_usage && <RunUsage r={u.run_usage} />}
      </div>
    </div>
  );
}

/** Runs in the period (mold_v0-008): shown only when there are any, so a workspace without runs sees the page as before. */
function RunUsage({ r }: { r: NonNullable<Usage['run_usage']> }) {
  return (
    <>
      <div className='grid lg:grid-cols-2'>
        <Box title='Runs by kind' description={`${num(r.runs)} runs in this period: ${usd(r.cost_usd)} of model spend, ${num(r.tool_calls)} tool calls, ${num(r.requests)} model requests.`}>
          <RankBars data={r.by_kind.map((k) => ({ name: k.kind, value: k.cost_usd }))} label='Model spend' color='var(--chart-3)' format={usd} mono empty='No run spend in this period.' />
        </Box>
        <Box title='Runs by person' description='Model spend on the runs each person started in this period.'>
          <RankBars data={r.by_person.map((p) => ({ name: p.label, value: p.cost_usd }))} label='Model spend' color='var(--chart-3)' format={usd} empty='No run spend in this period.' />
        </Box>
      </div>
      <Box title='Recent runs' description='The latest runs in this period, with their tool calls and model spend.'>
        <RunTable rows={r.recent} />
      </Box>
    </>
  );
}

/** The latest runs, one row each (shared with the neutral Activity page). */
export function RunTable({ rows, run = 'Run' }: { rows: { id: string; kind: string; status: string; by: string; created_at: string; tool_calls: number; requests: number; cost_usd: number }[]; run?: string }) {
  if (!rows.length) return <Empty>No runs in this period.</Empty>;
  return (
    <Table>
      <TableHeader><TableRow><TableHead>{run}</TableHead><TableHead>Status</TableHead><TableHead>Started by</TableHead><TableHead className='text-right'>Tool calls</TableHead>
        <TableHead className='text-right'>Model requests</TableHead><TableHead className='text-right'>Spend</TableHead></TableRow></TableHeader>
      <TableBody>
        {rows.map((x) => (
          <TableRow key={x.id}>
            <TableCell className='font-mono text-xs'>{x.kind}<div className='text-muted-foreground'>{shortDay(x.created_at.slice(0, 10))}</div></TableCell>
            <TableCell>{x.status}</TableCell><TableCell>{x.by}</TableCell>
            <TableCell className='text-right tabular-nums'>{num(x.tool_calls)}</TableCell><TableCell className='text-right tabular-nums'>{num(x.requests)}</TableCell>
            <TableCell className='text-right tabular-nums'>{usd(x.cost_usd)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
