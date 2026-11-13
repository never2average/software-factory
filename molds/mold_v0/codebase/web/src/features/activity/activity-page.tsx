'use client';
// Activity (mold_v0-008; src/usage-report.ts): tool calls and cost per run, per member and per workspace, in the build's
// own words (a pack may call a workspace a "company" or a run an "audit"). /app/activity is one workspace's (its members),
// from GET /api/usage. (The staff's every-workspace page, /admin/activity, was removed in mold_v0-211.)
// mold_v0-298: plain figures first (runs, spend, people, calls), the timing, failure, return and app figures folded
// under "Technical details" in plain words; one empty state leading to Setup; the standard loading and error states;
// the page named as its sidebar entry (./title.ts).
import { useEffect, useState } from 'react';
import Link from 'next/link';
import PageContainer from '@/components/layout/page-container';
import { StatStrip } from '@/components/layout/section';
import { Box, RankBars, top } from '@/components/layout/chart-grid';
import { DateRangePicker, rangeQuery, type DateRange } from '@/components/layout/date-range-picker';
import { useDashboardRange } from '@/hooks/use-dashboard-filter';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { featureOn } from '@/config/features';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiClient } from '@/lib/api-client';
import { num, usd } from '@/lib/display-format';
import { RunTable } from '@/features/portal/usage';
import { ErrorState, LoadingCards } from '@/features/portal/shared';
import { EmptyState } from '@/features/tabs/empty';
import { useBreadcrumbTitle } from '@/lib/breadcrumb-leaf';
import { activityLabel } from './title';

type Words = { workspace: string; member: string; run: string; tool_call: string; key: string };
interface WorkspaceReport {
  range: { from: string; to: string }; words: Words;
  totals: { calls: number; errors: number; error_rate: number; p50_ms: number | null; p95_ms: number | null; people: number };
  tools: { name: string; calls: number; errors: number; p50_ms: number | null; p95_ms: number | null }[];
  errors_by_class: { class: string; errors: number }[];
  active: { days: string[]; daily_people: number[]; daily_calls: number[]; dau_avg: number; wau: number };
  retention: { week: string; active: number; previous: number; retained: number; rate: number | null }[];
  clients: { name: string; version: string | null; calls: number }[];
  members: { label: string; calls: number; errors: number; runs: number; run_tool_calls: number; run_cost_usd: number | null }[];
  runs: { runs: number; cost_usd: number; tool_calls: number; requests: number;
    by_kind: { kind: string; runs: number; tool_calls: number; cost_usd: number }[];
    recent: { id: string; kind: string; status: string; by: string; created_at: string; tool_calls: number; requests: number; cost_usd: number }[] };
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (s: string) => (s.endsWith('s') ? s : `${s}s`);
/** A time in plain words: under a second in milliseconds, else in seconds. */
const took = (v: number | null) => (v == null ? '—' : v < 1000 ? `${num(v)} ms` : `${(v / 1000).toFixed(1)} s`);

// mold_v0-298 (finding A3): every cell padded (the strip sits between side borders, so its first column needs room too)
// and every number on one line.
const STRIP = 'border-x [&>div]:pl-4! [&_dd>span]:whitespace-nowrap';
const NUM = 'text-right tabular-nums whitespace-nowrap';

function useReport<T>(load: (q: string) => Promise<T>, range: DateRange) {
  const [state, setState] = useState<{ data?: T; error?: Error }>({});
  useEffect(() => {
    let live = true;
    setState({});
    load(rangeQuery(range)).then((data) => live && setState({ data }), (error: Error) => live && setState({ error }));
    return () => { live = false; };
  }, [range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

/** What people did: runs and their spend, who was active, how often the agents called in; per member, the latest runs. */
function Plain({ r }: { r: WorkspaceReport }) {
  const w = r.words;
  return (
    <>
      <StatStrip quad className={STRIP} items={[
        { label: cap(plural(w.run)), value: num(r.runs.runs) },
        { label: 'Spend', value: usd(r.runs.cost_usd), hint: `Model use by ${plural(w.run)}` },
        { label: 'People active', value: num(r.totals.people), spark: r.active.daily_people,
          hint: `${num(r.active.wau)} in the last week` },
        { label: cap(plural(w.tool_call)), value: num(r.totals.calls), spark: r.active.daily_calls,
          hint: r.totals.errors ? `${num(r.totals.errors)} did not finish` : 'All finished' }
      ]} />
      <div className='border-l'>
        <Box title={`Per ${w.member}`} description={`${cap(plural(w.run))}, spend and ${plural(w.tool_call)} for each ${w.member}.`}>
          {r.members.length ? (
            <Table>
              <TableHeader><TableRow><TableHead>{cap(w.member)}</TableHead><TableHead className='text-right'>{cap(plural(w.run))}</TableHead>
                <TableHead className='text-right'>Spend</TableHead><TableHead className='text-right'>{cap(plural(w.tool_call))}</TableHead>
                <TableHead className='text-right'>Did not finish</TableHead></TableRow></TableHeader>
              <TableBody>{r.members.map((m, i) => (
                <TableRow key={i}><TableCell>{m.label}</TableCell><TableCell className={NUM}>{num(m.runs)}</TableCell>
                  <TableCell className={NUM}>{m.run_cost_usd == null ? '—' : usd(m.run_cost_usd)}</TableCell>
                  <TableCell className={NUM}>{num(m.calls)}</TableCell><TableCell className={NUM}>{num(m.errors)}</TableCell></TableRow>))}</TableBody>
            </Table>
          ) : <p className='text-muted-foreground py-10 text-center text-sm'>No one was active in this period.</p>}
        </Box>
        {r.runs.runs > 0 && (
          <Box title={`Recent ${plural(w.run)}`} description={`${num(r.runs.runs)} ${plural(w.run)}: ${usd(r.runs.cost_usd)} of model spend, ${num(r.runs.tool_calls)} ${plural(w.tool_call)}.`}>
            <RunTable rows={r.runs.recent} run={cap(w.run)} />
          </Box>
        )}
      </div>
    </>
  );
}

/** The technical figures (timings, failure kinds, who came back, which apps called), folded away in plain words. */
function Technical({ r }: { r: WorkspaceReport }) {
  const w = r.words;
  return (
    <details className='group [&_summary::-webkit-details-marker]:hidden' data-activity-technical=''>
      <summary className='text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center justify-between border-x border-b px-4 py-3 text-sm'>
        <span>Technical details</span>
        <Icons.chevronDown className='size-4 transition-transform group-open:rotate-180' aria-hidden='true' />
      </summary>
      <StatStrip quad className={`${STRIP} border-t-0!`} items={[
        { label: 'Usual reply time', value: took(r.totals.p50_ms), hint: 'Half of the calls were faster' },
        { label: 'Most done within', value: took(r.totals.p95_ms), hint: '19 in 20 calls were this fast or faster' },
        { label: 'Did not finish', value: `${Math.round(r.totals.error_rate * 100)}%`, hint: `${num(r.totals.errors)} of ${num(r.totals.calls)} ${plural(w.tool_call)}` },
        { label: 'Active per day', value: num(r.active.dau_avg), hint: 'People, on average' }
      ]} />
      <div className='border-l'>
        <div className='grid lg:grid-cols-2'>
          <Box title={`${cap(plural(w.tool_call))} by tool`} description='The most used tools, how often they did not finish and how long they took.'>
            {r.tools.length ? (
              <Table>
                <TableHeader><TableRow><TableHead>Tool</TableHead><TableHead className='text-right'>Calls</TableHead><TableHead className='text-right'>Did not finish</TableHead>
                  <TableHead className='text-right'>Usual time</TableHead><TableHead className='text-right'>Most within</TableHead></TableRow></TableHeader>
                <TableBody>{r.tools.slice(0, 15).map((t) => (
                  <TableRow key={t.name}><TableCell className='font-mono text-xs'>{t.name}</TableCell><TableCell className={NUM}>{num(t.calls)}</TableCell>
                    <TableCell className={NUM}>{num(t.errors)}</TableCell><TableCell className={NUM}>{took(t.p50_ms)}</TableCell>
                    <TableCell className={NUM}>{took(t.p95_ms)}</TableCell></TableRow>))}</TableBody>
              </Table>
            ) : <p className='text-muted-foreground py-10 text-center text-sm'>No {plural(w.tool_call)} in this period.</p>}
          </Box>
          <Box title='Why calls did not finish' description='The kind of problem, never what was asked.'>
            <RankBars data={r.errors_by_class.map((c) => ({ name: c.class, value: c.errors }))} label='Did not finish' color='var(--destructive)' format={num} mono empty='Every call finished in this period.' />
          </Box>
        </div>
        <div className='grid lg:grid-cols-2'>
          <Box title='People who came back' description={`Of the people active one week, the share active again the next (a ${w.member}, or a ${w.key} with no ${w.member}).`}>
            <RankBars data={r.retention.filter((x) => x.rate != null).map((x) => ({ name: `Week of ${x.week}`, value: Math.round((x.rate ?? 0) * 100) }))}
              label='Came back' color='var(--chart-2)' format={(v) => `${v}%`} empty='Not enough weeks of activity yet.' />
          </Box>
          <Box title='Agents used' description='Calls by the agent (and its version) that made them.'>
            <RankBars data={top(r.clients, (c) => c.calls).map((c) => ({ name: c.version ? `${c.name} ${c.version}` : c.name, value: c.calls }))} label='Calls' color='var(--chart-4)' format={num} mono empty='No calls in this period.' />
          </Box>
        </div>
      </div>
    </details>
  );
}

/** /app/activity: the workspace's runs, spend and people, then its technical details. */
export function WorkspaceActivityPage() {
  // mold_v0-260 (flag filters_in_address): the period kept in the address while it is on.
  const [range, setRange] = useDashboardRange();
  // mold_v0-298 (finding A4): the breadcrumb's last crumb says the page's own name, not the address's word.
  const label = activityLabel();
  useBreadcrumbTitle(label);
  const { data, error } = useReport((q) => apiClient<WorkspaceReport>(`/usage?${q}`), range);
  const w = data?.words;
  // mold_v0-298 (finding A2): nothing at all in the period is one empty state with its next step, not empty boxes.
  const nothing = !!data && data.totals.calls === 0 && data.runs.runs === 0 && data.members.length === 0;
  return (
    <PageContainer pageTitle={label}
      pageDescription={w ? `${cap(plural(w.run))}, spend and people in this ${w.workspace}, per ${w.member} and per ${w.run}.` : 'Runs, spend and people in this workspace.'}
      pageHeaderAction={featureOn('run_analytics') ? (
        // mold_v0-260 (flag run_analytics): the runs broken down, for the same period.
        <div className='flex flex-wrap items-center justify-end gap-2'>
          <Button variant='outline' size='sm' render={<Link href={`/app/run-analytics?${rangeQuery(range)}`} />}><Icons.chartBar /> Run analytics</Button>
          <DateRangePicker value={range} onChange={setRange} />
        </div>
      ) : <DateRangePicker value={range} onChange={setRange} />}>
      {/* mold_v0-298 (finding A5): the console's standard loading and error states. */}
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards /> : nothing ? (
        <EmptyState id='activity-empty' empty={{
          title: 'No activity in this period',
          text: `Activity shows here once an agent connects to this ${data.words.workspace} or someone starts a ${data.words.run}. Setup shows how to connect one; or pick a longer period above.`,
          cta: { label: 'Go to Setup', href: '/app' }
        }} />
      ) : (
        <div className='flex flex-col'>
          <Plain r={data} />
          <Technical r={data} />
        </div>
      )}
    </PageContainer>
  );
}
