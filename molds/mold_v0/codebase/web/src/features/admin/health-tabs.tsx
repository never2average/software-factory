'use client';
// Health's tabs beside Errors in a build without the session engine (mold_v0-204; GET /api/admin/onboarding/health/*,
// src/health-tabs.ts): Runs, Scheduled work, Email Delivery (only when the app sends company email or has a developer
// surface; emails only), Webhook Delivery (mold_v0-215: only with a developer surface) and Status. The list tabs show
// their four cards, then the search and the tab's own picker and filters, then one table (RecordView). Status is a grid
// of graphs (mold_v0-210).
// Staff only, read only; nothing here shows an address, a subject or a key.
import { useState, type ReactNode } from 'react';
import PageContainer from '@/components/layout/page-container';
import { StatStrip } from '@/components/layout/section';
import { RecordView, type RecordCol, type RecordViewDef } from '@/components/layout/record-view';
import { DateRangePicker, last30, rangeQuery, type DateRange } from '@/components/layout/date-range-picker';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Box } from '@/components/layout/chart-grid';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts';
import { developerConsole, emailPortalNav } from '@/config/pack-nav.generated';
import { W } from '@/lib/vocabulary';
import { num, usd } from '@/lib/display-format';
import { useAdmin } from './lib';
import { Chip, dur, PeekSection, UrlTabs } from './compute-common';
import { ErrorBox, Mono, StatusBadge, When, type Tone } from './ui';

/** Email Delivery is a tab only when the app sends mail of a workspace's own or has a developer surface (the server's deliveriesOn). */
export const deliveriesTab = (): boolean => emailPortalNav.length > 0 || developerConsole.on;
/** Webhook Delivery is a tab only when the app has a developer surface: its declared events go out as webhooks (the server's webhooksOn). */
export const webhooksTab = (): boolean => developerConsole.on;

/** Health's tabs in a build without the session engine, in order (Errors first: the page's default). */
export const healthTabsShell = (): readonly (readonly [string, string])[] => [
  ['errors', 'Errors'], ['runs', W.Runs], ['scheduled', 'Scheduled work'], ...(deliveriesTab() ? [['deliveries', 'Email Delivery'] as const] : []),
  ...(webhooksTab() ? [['webhooks', 'Webhook Delivery'] as const] : []), ['status', 'Status']
];

const dash = <span className='text-muted-foreground'>—</span>;
const pctOf = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—');
const ERROR_KIND: Record<string, string> = {
  infrastructure: 'Infrastructure', run: 'Run', validation: 'Validation', timeout: 'Timeout', cancelled: 'Cancelled', output_missing: 'Output missing', unknown: 'Unknown'
};
const kindWord = (k: string | null) => (k ? ERROR_KIND[k] ?? k : '—');

/** The tab strip and the tab under it, in the page's frame (no title above the strip). */
export function HealthTab({ tabs, tab }: { tabs: readonly (readonly [string, string])[]; tab: string }) {
  return (
    <PageContainer>
      <div className='flex min-w-0 flex-col gap-3'>
        <UrlTabs tabs={tabs} tab={tab} base='/admin/health' />
        {tab === 'runs' && <RunsTab />}
        {tab === 'scheduled' && <ScheduledTab />}
        {tab === 'deliveries' && <DeliveriesTab />}
        {tab === 'webhooks' && <WebhooksTab />}
        {tab === 'status' && <StatusTab />}
      </div>
    </PageContainer>
  );
}

/** The picker on a tab's toolbar that chooses which of its lists the table shows. */
function Picker<V extends string>({ label, value, onChange, options }: { label: string; value: V; onChange: (v: V) => void; options: readonly (readonly [V, string])[] }) {
  return (
    <NativeSelect aria-label={label} value={value} onChange={(e) => onChange(e.target.value as V)}>
      {options.map(([v, l]) => <NativeSelectOption key={v} value={v}>{l}</NativeSelectOption>)}
    </NativeSelect>
  );
}

// ---------------------------------------------------------------- Runs

interface KindRow { pack: string; kind: string; label: string; agent: boolean; total: number; succeeded: number; failed: number; cancelled: number; open: number; accounts: number; usd: number;
  p50_seconds: number | null; p95_seconds: number | null; failures: Record<string, number> }
interface FailedRun { id: string; pack: string; kind: string; label: string; agent: boolean; error_kind: string | null; error: string | null; attempt: number; max_attempts: number;
  created_at: string | null; ended_at: string | null; seconds: number | null; usd: number; account: string; refused_retry: boolean }
interface RunsData {
  range: { from: string; to: string; days: number };
  totals: { runs: number; failed: number; failure_pct: number; usd: number; p50_seconds: number | null; refused_retried: number; refused_then_succeeded: number; refused_then_failed: number };
  by_error_kind: Record<string, number>;
  kinds: KindRow[];
  daily: { day: string; total: number; failed: number; usd: number; p50_seconds: number }[];
  recent_failed: FailedRun[];
}
interface RunEvents { run: { id: string; label: string; status: string; error_kind: string | null; attempt: number; account: string }; events: { id: number; attempt: number; type: string; at: string | null; data: Record<string, string | number | boolean> }[] }

function RunsTab() {
  const [range, setRange] = useState<DateRange>(last30);
  const [show, setShow] = useState<'failed' | 'kinds'>('failed');
  const { data, error, isLoading } = useAdmin<RunsData>(`/health/runs?${rangeQuery(range)}`, { keep: true });
  const t = data?.totals;
  const summary = (
    <StatStrip quad items={[
      { label: `${W.Runs}, period`, value: t ? num(t.runs) : '—', spark: data?.daily.map((d) => d.total),
        hint: t && t.refused_retried ? `${t.refused_retried} refused and retried (${t.refused_then_succeeded} then succeeded)` : undefined },
      { label: 'Failure rate', value: t ? `${t.failure_pct}%` : '—', spark: data?.daily.map((d) => (d.total ? (d.failed / d.total) * 100 : 0)),
        hint: t && t.failed ? Object.entries(data!.by_error_kind).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${v} ${kindWord(k).toLowerCase()}`).join(', ') : undefined },
      { label: 'Cost', value: t ? usd(t.usd) : '—', spark: data?.daily.map((d) => d.usd) },
      { label: 'Median duration', value: t ? dur(t.p50_seconds) : '—', spark: data?.daily.map((d) => d.p50_seconds) }
    ]} />
  );
  const filters = (
    <>
      <Picker label='Show' value={show} onChange={setShow} options={[['failed', `Failed ${W.runs}`], ['kinds', 'By kind']]} />
      <DateRangePicker value={range} onChange={setRange} />
    </>
  );
  return (
    <>
      <ErrorBox error={error} />
      {show === 'failed'
        ? <FailedRuns rows={data?.recent_failed ?? []} loading={isLoading || !data} summary={summary} filters={filters} />
        : <KindsTable rows={data?.kinds ?? []} loading={isLoading || !data} summary={summary} filters={filters} />}
    </>
  );
}

const FAILED_VIEWS: RecordViewDef<FailedRun>[] = [
  { id: 'all', label: 'All' },
  { id: 'agent', label: 'Agent', match: (r) => r.agent },
  { id: 'job', label: 'Job', match: (r) => !r.agent },
  { id: 'output_missing', label: 'Output missing', match: (r) => r.error_kind === 'output_missing' },
  { id: 'refused', label: 'Refused and retried', match: (r) => r.refused_retry }
];

function FailedRuns({ rows, loading, summary, filters }: { rows: FailedRun[]; loading: boolean; summary: ReactNode; filters: ReactNode }) {
  const cols: RecordCol<FailedRun>[] = [
    { key: 'ended_at', label: 'Ended', type: 'date', className: 'w-32', keep: true, value: (r) => r.ended_at ?? r.created_at, render: (r) => <When d={r.ended_at ?? r.created_at} className='text-muted-foreground text-xs leading-none' /> },
    { key: 'label', label: 'Kind', type: 'text', title: true, keep: true, value: (r) => r.label, render: (r) => (
      <span className='flex items-center gap-1.5'><span className='font-medium'>{r.label}</span>{r.agent && <Chip>agent</Chip>}{r.refused_retry && <Chip tone='warn' title='The model API refused the first attempt before any token was spent: queued once more'>refused, retried</Chip>}</span>
    ) },
    { key: 'error_kind', label: 'Error kind', type: 'select', className: 'w-36', keep: true, value: (r) => r.error_kind ?? 'unknown',
      options: Object.entries(ERROR_KIND).map(([value, label]) => ({ value, label })), render: (r) => <StatusBadge tone={r.error_kind === 'infrastructure' ? 'warn' : 'bad'}>{kindWord(r.error_kind)}</StatusBadge> },
    { key: 'error', label: 'Error', type: 'text', value: (r) => r.error, render: (r) => (r.error ? <span className='line-clamp-2 max-w-md text-sm whitespace-normal' title={r.error}>{r.error}</span> : dash) },
    { key: 'account', label: 'Account', type: 'text', className: 'w-44', value: (r) => r.account, render: (r) => r.account },
    { key: 'seconds', label: 'Duration', type: 'number', className: 'w-24 text-right', value: (r) => r.seconds, render: (r) => dur(r.seconds) },
    { key: 'usd', label: 'Cost', type: 'number', className: 'w-20 text-right', value: (r) => r.usd, render: (r) => usd(r.usd) },
    { key: 'attempt', label: 'Attempt', type: 'number', hidden: true, value: (r) => r.attempt, render: (r) => `${r.attempt} of ${r.max_attempts}` },
    { key: 'id', label: 'Run id', type: 'text', hidden: true, value: (r) => r.id, render: (r) => <Mono>{r.id}</Mono> }
  ];
  return (
    <RecordView<FailedRun>
      id='admin-health-failed-runs' noun={`failed ${W.runs}`} exportName='health-failed-runs' views={FAILED_VIEWS} compact defaultSort={[{ key: 'ended_at', dir: 'desc' }]}
      rows={rows} rowKey={(r) => r.id} cols={cols} loading={loading} summary={summary} filters={filters}
      searchText={(r) => `${r.label} ${r.kind} ${r.account} ${r.error ?? ''} ${kindWord(r.error_kind)} ${r.id}`} searchPlaceholder={`Search failed ${W.runs} by kind, account or error`}
      empty={`No failed ${W.runs} in this period.`}
      detailTitle={(r) => `${r.label} · ${r.id}`}
      detail={(r) => <RunEventsPeek id={r.id} />}
    />
  );
}

/** A failed run's events (types, attempts and the shell's own figures; never who asked or a value). */
function RunEventsPeek({ id }: { id: string }) {
  const { data, error } = useAdmin<RunEvents>(`/health/runs/${encodeURIComponent(id)}/events`);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Skeleton className='h-40 rounded-lg' />;
  return (
    <div className='flex flex-col gap-4 text-sm'>
      <PeekSection title='Run'>
        <p>{data.run.account} · {data.run.status}{data.run.error_kind ? ` (${kindWord(data.run.error_kind).toLowerCase()})` : ''} · attempt {data.run.attempt}</p>
      </PeekSection>
      <PeekSection title={`Events (${data.events.length})`}>
        <ol className='flex flex-col gap-2' data-run-events>
          {data.events.map((e) => (
            <li key={e.id} className='border-l-2 pl-3'>
              <div className='flex items-center gap-2'><span className='font-medium'>{e.type}</span><span className='text-muted-foreground text-xs'>attempt {e.attempt}</span><When d={e.at} className='text-muted-foreground ml-auto text-xs' /></div>
              {Object.keys(e.data).length > 0 && <p className='text-muted-foreground mt-0.5 text-xs break-words'>{Object.entries(e.data).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</p>}
            </li>
          ))}
        </ol>
      </PeekSection>
    </div>
  );
}

function KindsTable({ rows, loading, summary, filters }: { rows: KindRow[]; loading: boolean; summary: ReactNode; filters: ReactNode }) {
  const errorKinds = [...new Set(rows.flatMap((r) => Object.keys(r.failures)))];
  const cols: RecordCol<KindRow>[] = [
    { key: 'label', label: 'Kind', type: 'text', title: true, keep: true, value: (r) => r.label, render: (r) => <span className='flex items-center gap-1.5'><span className='font-medium'>{r.label}</span>{r.agent && <Chip>agent</Chip>}</span> },
    { key: 'type', label: 'Type', type: 'select', className: 'w-24', hidden: true, value: (r) => (r.agent ? 'agent' : 'job'), options: [{ value: 'agent', label: 'Agent' }, { value: 'job', label: 'Job' }], render: (r) => (r.agent ? 'Agent' : 'Job') },
    { key: 'total', label: W.Runs, type: 'number', className: 'w-20 text-right', keep: true, value: (r) => r.total, render: (r) => num(r.total) },
    { key: 'failed', label: 'Failed', type: 'number', className: 'w-24 text-right', keep: true, value: (r) => r.failed, render: (r) => (r.failed ? <span className='text-destructive'>{num(r.failed)} <span className='text-muted-foreground text-xs'>{pctOf(r.failed, r.total)}</span></span> : '0') },
    ...errorKinds.map((k): RecordCol<KindRow> => ({ key: `fail_${k}`, label: kindWord(k), type: 'number', className: 'w-28 text-right', value: (r) => r.failures[k] ?? 0, render: (r) => num(r.failures[k] ?? 0) })),
    { key: 'p50', label: 'Median', type: 'number', className: 'w-24 text-right', value: (r) => r.p50_seconds, render: (r) => dur(r.p50_seconds) },
    { key: 'p95', label: 'p95', type: 'number', className: 'w-24 text-right', value: (r) => r.p95_seconds, render: (r) => dur(r.p95_seconds) },
    { key: 'usd', label: 'Cost', type: 'number', className: 'w-24 text-right', value: (r) => r.usd, render: (r) => usd(r.usd) },
    { key: 'accounts', label: 'Accounts', type: 'number', className: 'w-24 text-right', hidden: true, value: (r) => r.accounts, render: (r) => num(r.accounts) }
  ];
  return (
    <RecordView<KindRow>
      id='admin-health-run-kinds' noun='kinds' exportName='health-run-kinds' compact defaultSort={[{ key: 'total', dir: 'desc' }]}
      rows={rows} rowKey={(r) => `${r.pack}/${r.kind}`} cols={cols} loading={loading} summary={summary} filters={filters}
      searchText={(r) => `${r.label} ${r.kind} ${r.pack}`} searchPlaceholder='Search kinds'
      empty={`This app has no ${W.run} kinds.`}
    />
  );
}

// ---------------------------------------------------------------- Scheduled work

interface Job { id: string; label: string; about: string; every_seconds: number; state: 'ok' | 'late' | 'failing' | 'never'; lag_seconds: number | null; last_run_at: string | null;
  last_ok_at: string | null; last_error_at: string | null; last_error: string | null; last_ms: number | null; runs: number; failures: number }
const JOB_TONE: Record<Job['state'], Tone> = { ok: 'ok', late: 'warn', failing: 'bad', never: 'neutral' };
const JOB_WORD: Record<Job['state'], string> = { ok: 'On time', late: 'Late', failing: 'Failing', never: 'Not run yet' };
const every = (s: number) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);

function ScheduledTab() {
  const { data, error, isLoading } = useAdmin<{ runtime: string; jobs: Job[] }>('/health/scheduled', { refetchInterval: 30_000 });
  const jobs = data?.jobs ?? [];
  const cols: RecordCol<Job>[] = [
    { key: 'label', label: 'Job', type: 'text', title: true, keep: true, value: (j) => j.label, render: (j) => (<>
      <span className='block font-medium'>{j.label}</span><span className='text-muted-foreground block max-w-md truncate text-xs' title={j.about}>{j.about}</span>
    </>) },
    { key: 'state', label: 'State', type: 'select', className: 'w-32', keep: true, value: (j) => j.state, options: (Object.keys(JOB_WORD) as Job['state'][]).map((v) => ({ value: v, label: JOB_WORD[v] })),
      render: (j) => <StatusBadge tone={JOB_TONE[j.state]}>{JOB_WORD[j.state]}</StatusBadge> },
    { key: 'every', label: 'Every', type: 'number', className: 'w-20', value: (j) => j.every_seconds, render: (j) => every(j.every_seconds) },
    { key: 'last_run_at', label: 'Last run', type: 'date', className: 'w-28', value: (j) => j.last_run_at, render: (j) => <When d={j.last_run_at} className='text-sm' /> },
    { key: 'last_ok_at', label: 'Last success', type: 'date', className: 'w-28', value: (j) => j.last_ok_at, render: (j) => <When d={j.last_ok_at} className='text-sm' /> },
    { key: 'lag', label: 'Lag', type: 'number', className: 'w-20 text-right', value: (j) => j.lag_seconds, render: (j) => (j.lag_seconds == null ? dash : j.lag_seconds ? dur(j.lag_seconds) : '0') },
    { key: 'last_error', label: 'Last error', type: 'text', value: (j) => j.last_error, render: (j) => (j.last_error ? <span className='line-clamp-2 max-w-sm text-sm whitespace-normal' title={j.last_error}>{j.last_error} <When d={j.last_error_at} className='text-muted-foreground text-xs' /></span> : dash) },
    { key: 'last_ms', label: 'Took', type: 'number', className: 'w-20 text-right', hidden: true, value: (j) => j.last_ms, render: (j) => (j.last_ms == null ? dash : `${num(j.last_ms)} ms`) },
    { key: 'runs', label: 'Runs', type: 'number', className: 'w-20 text-right', hidden: true, value: (j) => j.runs, render: (j) => num(j.runs) },
    { key: 'failures', label: 'Failures', type: 'number', className: 'w-24 text-right', hidden: true, value: (j) => j.failures, render: (j) => num(j.failures) }
  ];
  const count = (s: Job['state']) => jobs.filter((j) => j.state === s).length;
  return (
    <>
      <ErrorBox error={error} />
      <RecordView<Job>
        id='admin-health-scheduled' noun='jobs' exportName='health-scheduled-work' compact defaultSort={[{ key: 'label', dir: 'asc' }]}
        rows={jobs} rowKey={(j) => j.id} cols={cols} loading={isLoading || !data}
        searchText={(j) => `${j.label} ${j.about} ${j.last_error ?? ''} ${JOB_WORD[j.state]}`} searchPlaceholder='Search scheduled work'
        summary={<StatStrip quad items={[
          { label: 'Jobs this app runs', value: data ? num(jobs.length) : '—', hint: data ? (data.runtime === 'vercel' ? 'ticked by the cron entry every 5 min' : "this server's own loops") : undefined },
          { label: 'Failing', value: data ? num(count('failing')) : '—' },
          { label: 'Late', value: data ? num(count('late')) : '—' },
          { label: 'Not run yet', value: data ? num(count('never')) : '—' }
        ]} />}
        empty='This app runs no scheduled work of its own.'
        detailTitle={(j) => j.label}
        detail={(j) => (
          <div className='flex flex-col gap-3 text-sm'>
            <p>{j.about}</p>
            <p className='text-muted-foreground'>Runs every {every(j.every_seconds)}. {num(j.runs)} run{j.runs === 1 ? '' : 's'} recorded, {num(j.failures)} failed.</p>
            {j.last_error && <PeekSection title='Last error'><p className='break-words'>{j.last_error}</p><When d={j.last_error_at} className='text-muted-foreground text-xs' /></PeekSection>}
          </div>
        )}
      />
    </>
  );
}

// ---------------------------------------------------------------- Email Delivery (?section=deliveries)

interface EmailRow { kind: string; total: number; sent: number; failed: number; skipped: number; sending: number; last_at: string | null; last_failed_at: string | null }
interface DeliveriesData { email: boolean; emails: EmailRow[];
  totals: { tried: number; sent: number; failed: number; skipped: number; sending: number; kinds: number; failure_pct: number };
  daily: { day: string; sent: number; failed: number; skipped: number }[] }
const EMAIL_KIND: Record<string, string> = {
  request_received: 'Request received', request_alert: 'Request alert', request_declined: 'Request declined', request_approved: 'Welcome',
  submission_alert: 'Submission alert', submission_accepted: 'Submission accepted', submission_declined: 'Submission declined',
  budget_80: 'Budget 80%', budget_100: 'Budget 100%', due_soon: 'Due soon', test: 'Test', sign_in_code: 'Sign-in code', invitation: 'Invitation'
};
const emailKind = (k: string) => EMAIL_KIND[k] ?? k;

/** Emails only (mold_v0-215: webhooks have their own tab): sent, failed, not sent (skipped) and the kinds, then one table. */
function DeliveriesTab() {
  const [range, setRange] = useState<DateRange>(last30);
  const { data, error, isLoading } = useAdmin<DeliveriesData>(`/health/deliveries?${rangeQuery(range)}`, { keep: true });
  const t = data?.totals;
  const line = (k: 'sent' | 'failed' | 'skipped') => data?.daily.map((d) => d[k]);
  const top = data?.emails[0];
  const summary = (
    <StatStrip quad items={[
      { label: 'Emails sent', value: t ? num(t.sent) : '—', spark: line('sent'), hint: t && t.sending ? `${num(t.sending)} sending` : undefined },
      { label: 'Emails failed', value: t ? num(t.failed) : '—', spark: line('failed'), hint: t && t.failed ? `${t.failure_pct}% of those settled` : undefined },
      { label: 'Not sent', value: t ? num(t.skipped) : '—', spark: line('skipped'), hint: t && t.skipped ? 'Refused before sending: emails off, no sender or no address' : undefined },
      { label: 'Email kinds', value: t ? num(t.kinds) : '—', hint: top ? `Most: ${emailKind(top.kind)} (${num(top.total)})` : undefined }
    ]} />
  );
  const filters = <DateRangePicker value={range} onChange={setRange} />;
  return (
    <>
      <ErrorBox error={error} />
      <RecordView<EmailRow>
        id='admin-health-emails' noun='kinds' exportName='health-emails' compact defaultSort={[{ key: 'total', dir: 'desc' }]}
        rows={data?.emails ?? []} rowKey={(r) => r.kind} loading={isLoading || !data} summary={summary} filters={filters}
        cols={[
          { key: 'kind', label: 'Kind', type: 'text', title: true, keep: true, value: (r) => emailKind(r.kind), render: (r) => <span className='font-medium'>{emailKind(r.kind)}</span> },
          { key: 'total', label: 'Tried', type: 'number', className: 'w-20 text-right', keep: true, value: (r) => r.total, render: (r) => num(r.total) },
          { key: 'sent', label: 'Sent', type: 'number', className: 'w-20 text-right', value: (r) => r.sent, render: (r) => num(r.sent) },
          { key: 'failed', label: 'Failed', type: 'number', className: 'w-20 text-right', keep: true, value: (r) => r.failed, render: (r) => (r.failed ? <span className='text-destructive'>{num(r.failed)}</span> : '0') },
          { key: 'skipped', label: 'Not sent', type: 'number', className: 'w-20 text-right', value: (r) => r.skipped, render: (r) => num(r.skipped) },
          { key: 'last_at', label: 'Last', type: 'date', className: 'w-28', value: (r) => r.last_at, render: (r) => <When d={r.last_at} className='text-sm' /> },
          { key: 'last_failed_at', label: 'Last failure', type: 'date', className: 'w-28', value: (r) => r.last_failed_at, render: (r) => <When d={r.last_failed_at} className='text-sm' /> }
        ]}
        searchText={(r) => `${emailKind(r.kind)} ${r.kind}`} searchPlaceholder='Search email kinds' empty='No emails in this period.'
      />
    </>
  );
}

// ---------------------------------------------------------------- Webhook Delivery (?section=webhooks)

interface HookRow { event: string; total: number; succeeded: number; failed: number; pending: number; retrying: number; attempts: number; last_at: string | null }
interface Endpoint { id: string; account: string; events: number; reason: string | null; failure_streak: number; first_failure_at: string | null; disabled_at: string | null }
interface WebhooksData { webhooks: boolean; deliveries: HookRow[]; disabled_endpoints: Endpoint[];
  totals: { total: number; succeeded: number; failed: number; pending: number; retrying: number; attempts: number; events: number; endpoints_off: number; failure_pct: number };
  daily: { day: string; succeeded: number; failed: number; pending: number }[] }

/** Webhooks out (mold_v0-215): delivered, failed, pending or retrying, endpoints switched off; the Show picker chooses the table. */
function WebhooksTab() {
  const [range, setRange] = useState<DateRange>(last30);
  const { data, error, isLoading } = useAdmin<WebhooksData>(`/health/webhooks?${rangeQuery(range)}`, { keep: true });
  const [pick, setPick] = useState<'webhooks' | 'endpoints'>('webhooks');
  const t = data?.totals;
  const line = (k: 'succeeded' | 'failed' | 'pending') => data?.daily.map((d) => d[k]);
  const summary = (
    <StatStrip quad items={[
      { label: 'Webhooks delivered', value: t ? num(t.succeeded) : '—', spark: line('succeeded'), hint: t && t.events ? `${plural(t.events, 'event type')}` : undefined },
      { label: 'Webhooks failed', value: t ? num(t.failed) : '—', spark: line('failed'), hint: t && t.failed ? `${t.failure_pct}% of those settled` : undefined },
      { label: 'Pending or retrying', value: t ? num(t.pending) : '—', spark: line('pending'), hint: t && t.pending ? `${num(t.retrying)} retrying with a backoff` : undefined },
      { label: 'Endpoints switched off', value: t ? num(t.endpoints_off) : '—', hint: t && t.endpoints_off ? 'After repeated failures; the workspace turns them back on' : undefined }
    ]} />
  );
  const filters = <><Picker label='Show' value={pick} onChange={setPick} options={[['webhooks', 'Webhook deliveries'], ['endpoints', 'Endpoints switched off']]} /><DateRangePicker value={range} onChange={setRange} /></>;
  const loading = isLoading || !data;
  return (
    <>
      <ErrorBox error={error} />
      {pick === 'webhooks' && (
        <RecordView<HookRow>
          id='admin-health-webhooks' noun='events' exportName='health-webhook-deliveries' compact defaultSort={[{ key: 'total', dir: 'desc' }]}
          rows={data?.deliveries ?? []} rowKey={(r) => r.event} loading={loading} summary={summary} filters={filters}
          cols={[
            { key: 'event', label: 'Event', type: 'text', title: true, keep: true, value: (r) => r.event, render: (r) => <Mono>{r.event}</Mono> },
            { key: 'total', label: 'Deliveries', type: 'number', className: 'w-24 text-right', keep: true, value: (r) => r.total, render: (r) => num(r.total) },
            { key: 'succeeded', label: 'Delivered', type: 'number', className: 'w-24 text-right', value: (r) => r.succeeded, render: (r) => num(r.succeeded) },
            { key: 'failed', label: 'Failed', type: 'number', className: 'w-20 text-right', keep: true, value: (r) => r.failed, render: (r) => (r.failed ? <span className='text-destructive'>{num(r.failed)}</span> : '0') },
            { key: 'pending', label: 'Pending', type: 'number', className: 'w-20 text-right', value: (r) => r.pending, render: (r) => num(r.pending) },
            { key: 'retrying', label: 'Retrying', type: 'number', className: 'w-20 text-right', value: (r) => r.retrying, render: (r) => (r.retrying ? <span className='text-amber-600 dark:text-amber-400'>{num(r.retrying)}</span> : '0') },
            { key: 'attempts', label: 'Attempts', type: 'number', className: 'w-24 text-right', value: (r) => r.attempts, render: (r) => num(r.attempts) },
            { key: 'last_at', label: 'Last', type: 'date', className: 'w-28', value: (r) => r.last_at, render: (r) => <When d={r.last_at} className='text-sm' /> }
          ]}
          searchText={(r) => r.event} searchPlaceholder='Search events' empty='No webhook deliveries in this period.'
        />
      )}
      {pick === 'endpoints' && (
        <RecordView<Endpoint>
          id='admin-health-endpoints' noun='endpoints' exportName='health-endpoints-off' compact defaultSort={[{ key: 'disabled_at', dir: 'desc' }]}
          rows={data?.disabled_endpoints ?? []} rowKey={(r) => r.id} loading={loading} summary={summary} filters={filters}
          cols={[
            { key: 'account', label: 'Account', type: 'text', title: true, keep: true, value: (r) => r.account, render: (r) => <span className='font-medium'>{r.account}</span> },
            { key: 'id', label: 'Endpoint', type: 'text', className: 'w-44', value: (r) => r.id, render: (r) => <Mono>{r.id}</Mono> },
            { key: 'reason', label: 'Why', type: 'text', keep: true, value: (r) => r.reason, render: (r) => (r.reason ? <span className='line-clamp-2 max-w-sm text-sm whitespace-normal' title={r.reason}>{r.reason}</span> : dash) },
            { key: 'failure_streak', label: 'Failures in a row', type: 'number', className: 'w-32 text-right', value: (r) => r.failure_streak, render: (r) => num(r.failure_streak) },
            { key: 'events', label: 'Events', type: 'number', className: 'w-20 text-right', hidden: true, value: (r) => r.events, render: (r) => (r.events ? num(r.events) : 'all') },
            { key: 'disabled_at', label: 'Switched off', type: 'date', className: 'w-28', value: (r) => r.disabled_at, render: (r) => <When d={r.disabled_at} className='text-sm' /> }
          ]}
          searchText={(r) => `${r.account} ${r.id} ${r.reason ?? ''}`} searchPlaceholder='Search endpoints by account or reason' empty='No endpoint is switched off.'
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- Status

// A grid of graphs (mold_v0-210; GET /health/status, the live checks, and /health/history, the samples the scheduler
// keeps every few minutes for 35 days, src/health-samples.ts): one per signal, its current state as its headline, one
// 24 hours / 7 days / 30 days switch for the whole grid; the last deploy and the mold version as a line above it.
// Numbers and states only: no address, no key, no person.

interface Check { id: string; label: string; state: 'ok' | 'warn' | 'bad' | 'off'; value: string; detail: string | null }
interface Provider { slug: string; name: string; set: 'yes' | 'no' }
interface StatusData {
  checks: Check[]; providers: Provider[];
  release: { runtime: string; commit: string | null; instance_started_at: string; last_migration: { version: number; name: string; applied_at: string | null } | null; mold: { schema: string | null; package: string | null } };
}
interface Sample { at: string; up: boolean; db_ms: number | null; api_p50_ms: number | null; api_p95_ms: number | null; rls: string; storage: string; vault_set: number; vault_missing: number; scheduler_lag_s: number | null }
export interface HistoryBucket {
  at: string; samples: number; up_pct: number | null; db_ms: number | null; api_p50_ms: number | null; api_p95_ms: number | null; rls_ok: number | null; storage_ok: number | null;
  vault_set: number | null; vault_missing: number | null; claude_errors: number; claude_refusals: number; claude_requests: number; scheduler_lag_s: number | null;
  runs_ended: number; runs_failed: number; run_failure_pct: number | null; deliveries_total: number; deliveries_failed: number; delivery_failure_pct: number | null;
  webhooks_total: number; webhooks_failed: number; webhook_failure_pct: number | null;
}
interface History {
  range: HistoryRange; bucket_seconds: number; every_seconds: number; retention_days: number; deliveries: boolean; webhooks: boolean; samples: number; latest: Sample | null;
  totals: { up_pct: number | null; claude_errors: number; claude_refusals: number; claude_requests: number; runs_ended: number; runs_failed: number; deliveries_total: number; deliveries_failed: number; webhooks_total: number; webhooks_failed: number };
  buckets: HistoryBucket[];
}
type HistoryRange = '24h' | '7d' | '30d';
const RANGES: readonly (readonly [HistoryRange, string])[] = [['24h', '24h'], ['7d', '7d'], ['30d', '30d']];
const RANGE_WORD: Record<HistoryRange, string> = { '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days' };
const CHECK_TONE: Record<Check['state'], Tone> = { ok: 'ok', warn: 'warn', bad: 'bad', off: 'neutral' };
const OK = 'var(--chart-1)', WARN = 'var(--chart-4)', BAD = 'var(--destructive)', NONE = 'var(--muted)';
const ms = (v: number | null | undefined) => (v == null ? '—' : `${num(v)} ms`);
const pct1 = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 10) / 10}%`);
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

function StatusTab() {
  const [range, setRange] = useState<HistoryRange>('24h');
  const live = useAdmin<StatusData>('/health/status', { refetchInterval: 60_000 });
  const hist = useAdmin<History>(`/health/history?range=${range}`, { refetchInterval: 60_000, keep: true });
  const h = hist.data, d = live.data;
  const check = (id: string) => d?.checks.find((c) => c.id === id);
  const lastAt = h?.latest?.at;
  const tick = (iso: string) => new Date(iso).toLocaleString(undefined, range === '24h' ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' });
  const label = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const b = h?.buckets ?? [];
  const t = h?.totals;
  const db = check('database'), rls = check('rls'), store = check('object_storage'), vault = check('vault'), claude = check('claude');
  const set = d ? d.providers.filter((p) => p.set === 'yes').length : h?.latest?.vault_set ?? null;
  const missing = d ? d.providers.length - (set ?? 0) : h?.latest?.vault_missing ?? null;
  const loading = !h || !d;
  const props = { buckets: b, tick, label, loading };
  return (
    <div className='flex flex-col gap-3' data-health-status>
      <ErrorBox error={live.error ?? hist.error} />
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <ReleaseLine r={d?.release} />
        <ToggleGroup aria-label='Period' variant='outline' size='sm' spacing={0} value={[range]} onValueChange={(v: unknown[]) => { if (v[0]) setRange(v[0] as HistoryRange); }}>
          {RANGES.map(([v, l]) => <ToggleGroupItem key={v} value={v} aria-label={RANGE_WORD[v]} className='px-3'>{l}</ToggleGroupItem>)}
        </ToggleGroup>
      </div>
      {h && !h.samples && (
        <p className='text-muted-foreground text-sm'>No samples in {RANGE_WORD[range]} yet: the scheduler takes one every {Math.round(h.every_seconds / 60)} minutes and keeps them {h.retention_days} days. The headlines are live.</p>
      )}
      <div className='grid border-t border-l md:grid-cols-2 xl:grid-cols-3'>
        <SignalBox title='Database latency' tone={db ? CHECK_TONE[db.state] : undefined}
          headline={db ? `${db.state === 'bad' ? 'Down' : 'Up'} · ${db.value.replace(/^answered in /, '')}` : '—'} sub={db?.detail}>
          <Lines {...props} series={[{ key: 'db_ms', label: 'Answer time', color: 'var(--chart-2)' }]} format={ms} />
        </SignalBox>
        <SignalBox title='API latency' headline={h?.latest ? `p50 ${ms(h.latest.api_p50_ms)} · p95 ${ms(h.latest.api_p95_ms)}` : '—'} sub='Requests in the window before each sample; the slowest bucket’s p95.'>
          <Lines {...props} series={[{ key: 'api_p50_ms', label: 'p50', color: 'var(--chart-2)' }, { key: 'api_p95_ms', label: 'p95', color: 'var(--chart-3)' }]} format={ms} />
        </SignalBox>
        <SignalBox title='Health check' tone={db ? (db.state === 'bad' ? 'bad' : 'ok') : undefined}
          headline={db ? `${db.state === 'bad' ? 'Down' : 'Up'}${t?.up_pct != null ? ` · ${pct1(t.up_pct)} over ${range}` : ''}` : '—'} sub='Share of samples with the database answering; a gap is no sample (the app was not running).'>
          <Band {...props} k='up_pct' what='Up' />
        </SignalBox>
        <SignalBox title='Row-level security probe' tone={rls ? CHECK_TONE[rls.state] : undefined} headline={rls ? cap(rls.value) : '—'} sub={rls?.detail}>
          <Band {...props} k='rls_ok' what='Probe passing' />
        </SignalBox>
        <SignalBox title='Object storage' tone={store ? CHECK_TONE[store.state] : undefined} headline={store ? cap(store.value) : '—'} sub='Share of samples with a store set.'>
          <Band {...props} k='storage_ok' what='Set' />
        </SignalBox>
        <SignalBox title='Key vault providers' tone={vault ? CHECK_TONE[vault.state] : undefined}
          headline={set == null ? '—' : `${num(set)} set · ${num(missing ?? 0)} missing`} sub={vault ? `${cap(vault.value)}.` : undefined}
          action={<a href='/admin/keys' className='text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline'>Key vault</a>}>
          <Stacked {...props} series={[{ key: 'vault_set', label: 'Set', color: OK }, { key: 'vault_missing', label: 'Missing', color: WARN }]} />
        </SignalBox>
        <SignalBox title='Claude provider' tone={claude ? CHECK_TONE[claude.state] : undefined}
          headline={claude ? `${cap(claude.value)}${t ? ` · ${plural(t.claude_errors, 'error')}, ${plural(t.claude_refusals, 'refusal')}` : ''}` : '—'}
          sub={t ? `${plural(t.claude_requests, 'request')} in ${RANGE_WORD[range]}.` : undefined}>
          <Bars {...props} series={[{ key: 'claude_errors', label: 'Errors', color: BAD }, { key: 'claude_refusals', label: 'Refusals', color: WARN }]} />
        </SignalBox>
        <SignalBox title='Scheduler lag' tone={h?.latest?.scheduler_lag_s ? (h.latest.scheduler_lag_s > 600 ? 'bad' : 'warn') : h?.latest ? 'ok' : undefined}
          headline={h?.latest ? (h.latest.scheduler_lag_s == null ? 'No job has run' : h.latest.scheduler_lag_s ? `Late · ${dur(h.latest.scheduler_lag_s)}` : 'On time · 0 s') : '—'}
          sub='The most any scheduled job is behind its cadence.' action={<a href='/admin/health?section=scheduled' className='text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline'>Scheduled work</a>}>
          <Lines {...props} series={[{ key: 'scheduler_lag_s', label: 'Lag', color: 'var(--chart-4)' }]} format={(v) => dur(v)} area />
        </SignalBox>
        <SignalBox title={`${W.Run} failure rate`} tone={t ? (t.runs_failed ? 'warn' : 'ok') : undefined}
          headline={t ? (t.runs_ended ? `${pct1((t.runs_failed / t.runs_ended) * 100)} · ${num(t.runs_failed)} of ${num(t.runs_ended)}` : `No ${W.runs} ended`) : '—'} sub={`${W.Runs} that ended in ${RANGE_WORD[range]}.`}>
          <Bars {...props} series={[{ key: 'run_failure_pct', label: 'Failed', color: BAD }]} format={pct1} />
        </SignalBox>
        {(h?.deliveries ?? deliveriesTab()) && (
          <SignalBox title='Email failure rate' tone={t ? (t.deliveries_failed ? 'warn' : 'ok') : undefined}
            headline={t ? (t.deliveries_total ? `${pct1((t.deliveries_failed / t.deliveries_total) * 100)} · ${num(t.deliveries_failed)} of ${num(t.deliveries_total)}` : 'Nothing sent') : '—'}
            sub={`Emails sent or failed in ${RANGE_WORD[range]}.`}
            action={<a href='/admin/health?section=deliveries' className='text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline'>Email Delivery</a>}>
            <Bars {...props} series={[{ key: 'delivery_failure_pct', label: 'Failed', color: BAD }]} format={pct1} />
          </SignalBox>
        )}
        {(h?.webhooks ?? webhooksTab()) && (
          <SignalBox title='Webhook failure rate' tone={t ? (t.webhooks_failed ? 'warn' : 'ok') : undefined}
            headline={t ? (t.webhooks_total ? `${pct1((t.webhooks_failed / t.webhooks_total) * 100)} · ${num(t.webhooks_failed)} of ${num(t.webhooks_total)}` : 'Nothing delivered') : '—'}
            sub={`Webhook deliveries that succeeded or failed in ${RANGE_WORD[range]}.`}
            action={<a href='/admin/health?section=webhooks' className='text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline'>Webhook Delivery</a>}>
            <Bars {...props} series={[{ key: 'webhook_failure_pct', label: 'Failed', color: BAD }]} format={pct1} />
          </SignalBox>
        )}
      </div>
      {lastAt && <p className='text-muted-foreground text-xs'>Last sample <When d={lastAt} className='inline' />; one every {Math.round((h?.every_seconds ?? 300) / 60)} minutes, kept {h?.retention_days} days.</p>}
    </div>
  );
}

const cap = (s: string) => (s === 'ok' ? 'OK' : s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The last deploy and the mold version: a small line, not a chart. */
function ReleaseLine({ r }: { r: StatusData['release'] | undefined }) {
  if (!r) return <Skeleton className='h-4 w-80' />;
  return (
    <p className='text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs' data-release>
      <span>Last deploy</span>{r.last_migration?.applied_at ? <When d={r.last_migration.applied_at} className='text-foreground inline' /> : <span>—</span>}
      {r.commit && <><span aria-hidden>·</span><span>commit <Mono>{r.commit}</Mono></span></>}
      <span aria-hidden>·</span><span>mold <Mono>{r.mold.schema ?? '—'}</Mono>{r.mold.package ? ` (package ${r.mold.package})` : ''}</span>
      <span aria-hidden>·</span><span>instance up since {new Date(r.instance_started_at).toLocaleString()}</span>
    </p>
  );
}

/** One cell of the grid: the signal's name, its current state as the headline, then its graph. */
function SignalBox({ title, headline, sub, tone, action, children }: { title: string; headline: ReactNode; sub?: ReactNode; tone?: Tone; action?: ReactNode; children: ReactNode }) {
  const dot = tone === 'ok' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-amber-500' : tone === 'bad' ? 'bg-destructive' : 'bg-muted-foreground/40';
  return (
    <Box title={title} action={action} className='gap-2'>
      <div className='-mt-1 flex min-w-0 items-center gap-2' data-headline>
        <span className={`size-2 shrink-0 rounded-full ${dot}`} aria-hidden />
        <span className='truncate text-lg font-semibold tabular-nums'>{headline}</span>
      </div>
      {sub && <p className='text-muted-foreground -mt-1 line-clamp-1 text-xs' title={typeof sub === 'string' ? sub : undefined}>{sub}</p>}
      {children}
    </Box>
  );
}

type Key = keyof HistoryBucket;
interface GraphProps { buckets: HistoryBucket[]; tick: (iso: string) => string; label: (iso: string) => string; loading: boolean }
const H = 'aspect-auto h-[140px] w-full';
const axis = (tick: (iso: string) => string) => <XAxis dataKey='at' tickLine={false} axisLine={false} tickMargin={6} minTickGap={32} tickFormatter={tick} fontSize={11} />;
const empty = (b: HistoryBucket[]) => !b.some((x) => x.samples);
const NoData = () => <div className='text-muted-foreground flex h-[140px] items-center justify-center text-xs'>No samples yet</div>;

function Lines({ buckets, tick, label, loading, series, format, area }: GraphProps & { series: { key: Key; label: string; color: string }[]; format: (v: number) => string; area?: boolean }) {
  if (loading) return <Skeleton className='h-[140px]' />;
  if (empty(buckets)) return <NoData />;
  const config = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }])) satisfies ChartConfig;
  return (
    <ChartContainer config={config} className={H}>
      <AreaChart data={buckets} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        {axis(tick)}
        <YAxis width={44} tickLine={false} axisLine={false} fontSize={11} tickFormatter={(v: number) => format(v)} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(_, p) => label(String(p?.[0]?.payload?.at ?? ''))} formatter={(v, n) => `${config[n as string]?.label ?? n} ${format(Number(v))}`} indicator='dot' />} />
        {series.map((s) => <Area key={s.key} dataKey={s.key} type='monotone' connectNulls={false} stroke={s.color} strokeWidth={1.75} fill={s.color} fillOpacity={area ? 0.25 : 0.08} isAnimationActive={false} />)}
      </AreaChart>
    </ChartContainer>
  );
}

function Bars({ buckets, tick, label, loading, series, format = (v) => num(v) }: GraphProps & { series: { key: Key; label: string; color: string }[]; format?: (v: number) => string }) {
  if (loading) return <Skeleton className='h-[140px]' />;
  if (empty(buckets)) return <NoData />;
  const config = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }])) satisfies ChartConfig;
  return (
    <ChartContainer config={config} className={H}>
      <BarChart data={buckets} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        {axis(tick)}
        <YAxis width={44} tickLine={false} axisLine={false} fontSize={11} allowDecimals={false} tickFormatter={(v: number) => format(v)} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(_, p) => label(String(p?.[0]?.payload?.at ?? ''))} formatter={(v, n) => `${config[n as string]?.label ?? n} ${format(Number(v))}`} indicator='dashed' />} />
        {series.map((s) => <Bar key={s.key} dataKey={s.key} stackId='a' fill={s.color} isAnimationActive={false} />)}
      </BarChart>
    </ChartContainer>
  );
}

function Stacked(p: GraphProps & { series: { key: Key; label: string; color: string }[] }) {
  return <Bars {...p} />;
}

/** An uptime band: one bar per bucket, full height, coloured by the share of samples that passed (grey: no sample). */
function Band({ buckets, tick, label, loading, k, what }: GraphProps & { k: Key; what: string }) {
  if (loading) return <Skeleton className='h-[140px]' />;
  if (empty(buckets)) return <NoData />;
  const data = buckets.map((x) => ({ at: x.at, v: 1, pct: x[k] as number | null }));
  const color = (v: number | null) => (v == null ? NONE : v >= 99.9 ? OK : v >= 90 ? WARN : BAD);
  return (
    <div className='flex h-[140px] flex-col justify-center gap-2'>
      <ChartContainer config={{ v: { label: what, color: OK } }} className='aspect-auto h-[64px] w-full'>
        <BarChart data={data} margin={{ left: 0, right: 0, top: 0, bottom: 0 }} barCategoryGap={1}>
          {axis(tick)}
          <YAxis hide domain={[0, 1]} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideIndicator labelFormatter={(_, p) => label(String(p?.[0]?.payload?.at ?? ''))}
            formatter={(_, __, item) => { const v = (item?.payload as { pct: number | null } | undefined)?.pct; return v == null ? 'No sample' : `${what} ${pct1(v)} of samples`; }} />} />
          <Bar dataKey='v' radius={2} isAnimationActive={false}>
            {data.map((x) => <Cell key={x.at} fill={color(x.pct)} />)}
          </Bar>
        </BarChart>
      </ChartContainer>
      <div className='text-muted-foreground flex items-center gap-3 text-[11px]'>
        <span className='flex items-center gap-1'><span className='size-2 rounded-sm' style={{ background: OK }} />all</span>
        <span className='flex items-center gap-1'><span className='size-2 rounded-sm' style={{ background: WARN }} />some</span>
        <span className='flex items-center gap-1'><span className='size-2 rounded-sm' style={{ background: BAD }} />under 90%</span>
        <span className='flex items-center gap-1'><span className='bg-muted size-2 rounded-sm' />no sample</span>
      </div>
    </div>
  );
}
