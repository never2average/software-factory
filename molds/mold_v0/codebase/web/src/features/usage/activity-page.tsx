'use client';
// Activity (mold_v0-008; src/usage-report.ts): tool calls and cost per run, per member and per workspace, in the build's
// own words (a pack may call a workspace a "company" or a run an "audit"). /app/activity is one workspace's (its members),
// from GET /api/usage; /admin/activity is every workspace's, from GET /api/admin/onboarding/usage.
import { useEffect, useState, type ReactNode } from 'react';
import PageContainer from '@/components/layout/page-container';
import { StatStrip } from '@/components/layout/section';
import { Box, RankBars, top } from '@/components/layout/chart-grid';
import { DateRangePicker, last30, rangeQuery, type DateRange } from '@/components/layout/date-range-picker';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adminApi, apiClient } from '@/lib/api-client';
import { num, usd } from '@/lib/octillion-format';
import { RunTable } from '@/features/portal/usage';

type Words = { workspace: string; member: string; run: string; tool_call: string; key: string };
interface Calls {
  range: { from: string; to: string }; words: Words;
  totals: { calls: number; errors: number; error_rate: number; p50_ms: number | null; p95_ms: number | null; people: number };
  tools: { name: string; calls: number; errors: number; p50_ms: number | null; p95_ms: number | null }[];
  errors_by_class: { class: string; errors: number }[];
  active: { days: string[]; daily_people: number[]; daily_calls: number[]; dau_avg: number; wau: number };
  retention: { week: string; active: number; previous: number; retained: number; rate: number | null }[];
  clients: { name: string; version: string | null; calls: number }[];
}
interface WorkspaceReport extends Calls {
  members: { label: string; calls: number; errors: number; runs: number; run_tool_calls: number; run_cost_usd: number | null }[];
  runs: { runs: number; cost_usd: number; tool_calls: number; requests: number;
    by_kind: { kind: string; runs: number; tool_calls: number; cost_usd: number }[];
    recent: { id: string; kind: string; status: string; by: string; created_at: string; tool_calls: number; requests: number; cost_usd: number }[] };
}
interface OperatorReport extends Calls {
  workspaces: { slug: string; name: string; calls: number; errors: number; people: number; p95_ms: number | null; runs: number; run_tool_calls: number; run_cost_usd: number }[];
  runs: { runs: number; cost_usd: number; tool_calls: number };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (s: string) => (s.endsWith('s') ? s : `${s}s`);
const ms = (v: number | null) => (v == null ? '—' : `${num(v)} ms`);

function useReport<T>(load: (q: string) => Promise<T>, range: DateRange) {
  const [state, setState] = useState<{ data?: T; error?: Error }>({});
  useEffect(() => {
    let live = true;
    load(rangeQuery(range)).then((data) => live && setState({ data }), (error: Error) => live && setState({ error }));
    return () => { live = false; };
  }, [range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

function CallFigures({ r, extra }: { r: Calls; extra?: ReactNode }) {
  const w = r.words;
  return (
    <>
      <StatStrip className='border-x [&>div:first-child]:pl-4' items={[
        { label: cap(plural(w.tool_call)), value: num(r.totals.calls), spark: r.active.daily_calls },
        { label: 'Errors', value: `${num(r.totals.errors)} (${Math.round(r.totals.error_rate * 100)}%)` },
        { label: 'Latency p50 / p95', value: `${ms(r.totals.p50_ms)} / ${ms(r.totals.p95_ms)}` },
        { label: 'Active daily (avg) / last week', value: `${num(r.active.dau_avg)} / ${num(r.active.wau)}`, spark: r.active.daily_people }
      ]} />
      <div className='border-l'>
        <div className='grid lg:grid-cols-2'>
          <Box title={`${cap(plural(w.tool_call))} by tool`} description='The most called tools, with errors and latency.'>
            {r.tools.length ? (
              <Table>
                <TableHeader><TableRow><TableHead>Tool</TableHead><TableHead className='text-right'>Calls</TableHead><TableHead className='text-right'>Errors</TableHead>
                  <TableHead className='text-right'>p50</TableHead><TableHead className='text-right'>p95</TableHead></TableRow></TableHeader>
                <TableBody>{r.tools.slice(0, 15).map((t) => (
                  <TableRow key={t.name}><TableCell className='font-mono text-xs'>{t.name}</TableCell><TableCell className='text-right tabular-nums'>{num(t.calls)}</TableCell>
                    <TableCell className='text-right tabular-nums'>{num(t.errors)}</TableCell><TableCell className='text-right tabular-nums'>{ms(t.p50_ms)}</TableCell>
                    <TableCell className='text-right tabular-nums'>{ms(t.p95_ms)}</TableCell></TableRow>))}</TableBody>
              </Table>
            ) : <p className='text-muted-foreground py-10 text-center text-sm'>No {plural(w.tool_call)} in this period.</p>}
          </Box>
          <Box title='Errors by class' description='What kind of failure, never its arguments.'>
            <RankBars data={r.errors_by_class.map((c) => ({ name: c.class, value: c.errors }))} label='Errors' color='var(--destructive)' format={num} mono empty='No errors in this period.' />
          </Box>
        </div>
        <div className='grid lg:grid-cols-2'>
          <Box title='Week-over-week retention' description={`Of the people active one week, how many came back the next (a ${w.member}, or a ${w.key} with no ${w.member}).`}>
            <RankBars data={r.retention.filter((x) => x.rate != null).map((x) => ({ name: `Week of ${x.week}`, value: Math.round((x.rate ?? 0) * 100) }))}
              label='Retained' color='var(--chart-2)' format={(v) => `${v}%`} empty='Not enough weeks of activity yet.' />
          </Box>
          <Box title='Clients' description='Calls by the client and version that made them.'>
            <RankBars data={top(r.clients, (c) => c.calls).map((c) => ({ name: c.version ? `${c.name} ${c.version}` : c.name, value: c.calls }))} label='Calls' color='var(--chart-4)' format={num} mono empty='No calls in this period.' />
          </Box>
        </div>
        {extra}
      </div>
    </>
  );
}

/** /app/activity: the workspace's members and runs. */
export function WorkspaceActivityPage() {
  const [range, setRange] = useState<DateRange>(last30);
  const { data, error } = useReport((q) => apiClient<WorkspaceReport>(`/usage?${q}`), range);
  const w = data?.words;
  return (
    <PageContainer pageTitle='Activity' pageDescription={w ? `${cap(plural(w.tool_call))} and ${w.run} spend in this ${w.workspace}, per ${w.member} and per ${w.run}.` : 'Tool calls and run spend.'}
      pageHeaderAction={<DateRangePicker value={range} onChange={setRange} />}>
      {error ? <p className='text-destructive text-sm'>{error.message}</p> : !data ? <p className='text-muted-foreground text-sm'>Loading…</p> : (
        <CallFigures r={data} extra={<>
          <Box title={`Per ${data.words.member}`} description={`${cap(plural(data.words.tool_call))}, errors, ${plural(data.words.run)} and their spend.`}>
            {data.members.length ? (
              <Table>
                <TableHeader><TableRow><TableHead>{cap(data.words.member)}</TableHead><TableHead className='text-right'>Calls</TableHead><TableHead className='text-right'>Errors</TableHead>
                  <TableHead className='text-right'>{cap(plural(data.words.run))}</TableHead><TableHead className='text-right'>Spend</TableHead></TableRow></TableHeader>
                <TableBody>{data.members.map((m, i) => (
                  <TableRow key={i}><TableCell>{m.label}</TableCell><TableCell className='text-right tabular-nums'>{num(m.calls)}</TableCell><TableCell className='text-right tabular-nums'>{num(m.errors)}</TableCell>
                    <TableCell className='text-right tabular-nums'>{num(m.runs)}</TableCell><TableCell className='text-right tabular-nums'>{m.run_cost_usd == null ? '—' : usd(m.run_cost_usd)}</TableCell></TableRow>))}</TableBody>
              </Table>
            ) : <p className='text-muted-foreground py-10 text-center text-sm'>No activity in this period.</p>}
          </Box>
          {data.runs.runs > 0 && (
            <Box title={`Recent ${plural(data.words.run)}`} description={`${num(data.runs.runs)} ${plural(data.words.run)}: ${usd(data.runs.cost_usd)} of model spend, ${num(data.runs.tool_calls)} ${plural(data.words.tool_call)}.`}>
              <RunTable rows={data.runs.recent} run={cap(data.words.run)} />
            </Box>
          )}
        </>} />
      )}
    </PageContainer>
  );
}

/** /admin/activity: every workspace. */
export function OperatorActivityPage() {
  const [range, setRange] = useState<DateRange>(last30);
  const { data, error } = useReport((q) => adminApi<OperatorReport>('GET', `/usage?${q}`), range);
  return (
    <PageContainer pageTitle='Activity' pageDescription='Tool calls and run spend across every workspace.' pageHeaderAction={<DateRangePicker value={range} onChange={setRange} />}>
      {error ? <p className='text-destructive text-sm'>{error.message}</p> : !data ? <p className='text-muted-foreground text-sm'>Loading…</p> : (
        <CallFigures r={data} extra={
          <Box title={`Per ${data.words.workspace}`} description={`${cap(plural(data.words.tool_call))}, people, latency, ${plural(data.words.run)} and their spend.`}>
            {data.workspaces.length ? (
              <Table>
                <TableHeader><TableRow><TableHead>{cap(data.words.workspace)}</TableHead><TableHead className='text-right'>Calls</TableHead><TableHead className='text-right'>Errors</TableHead>
                  <TableHead className='text-right'>People</TableHead><TableHead className='text-right'>p95</TableHead><TableHead className='text-right'>{cap(plural(data.words.run))}</TableHead>
                  <TableHead className='text-right'>Spend</TableHead></TableRow></TableHeader>
                <TableBody>{data.workspaces.map((x) => (
                  <TableRow key={x.slug}><TableCell>{x.name}</TableCell><TableCell className='text-right tabular-nums'>{num(x.calls)}</TableCell><TableCell className='text-right tabular-nums'>{num(x.errors)}</TableCell>
                    <TableCell className='text-right tabular-nums'>{num(x.people)}</TableCell><TableCell className='text-right tabular-nums'>{ms(x.p95_ms)}</TableCell>
                    <TableCell className='text-right tabular-nums'>{num(x.runs)}</TableCell><TableCell className='text-right tabular-nums'>{usd(x.run_cost_usd)}</TableCell></TableRow>))}</TableBody>
              </Table>
            ) : <p className='text-muted-foreground py-10 text-center text-sm'>No activity in this period.</p>}
          </Box>
        } />
      )}
    </PageContainer>
  );
}
