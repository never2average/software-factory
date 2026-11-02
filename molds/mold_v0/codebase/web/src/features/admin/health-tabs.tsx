'use client';
// Health's tabs beside Errors in a build without the session engine (mold_v0-204; GET /api/admin/onboarding/health/*,
// src/health-tabs.ts): Runs, Scheduled work, Deliveries (only when the app sends company email or webhooks) and Status.
// Each is a list tab: the toolbar (search, the tab's own picker, filters), its four cards under it, then one table
// (RecordView). Staff only, read only; nothing here shows an address, a subject or a key.
import { useState, type ReactNode } from 'react';
import PageContainer from '@/components/layout/page-container';
import { StatStrip } from '@/components/layout/section';
import { RecordView, type RecordCol, type RecordViewDef } from '@/components/layout/record-view';
import { DateRangePicker, last30, rangeQuery, type DateRange } from '@/components/layout/date-range-picker';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { developerConsole, emailPortalNav } from '@/config/pack-nav.generated';
import { W } from '@/lib/vocabulary';
import { num, usd } from '@/lib/display-format';
import { useAdmin } from './lib';
import { Chip, dur, PeekSection, UrlTabs } from './compute-common';
import { ErrorBox, Mono, StatusBadge, When, type Tone } from './ui';

/** Deliveries is a tab only when the app sends mail of a workspace's own or webhooks (the server's deliveriesOn). */
export const deliveriesTab = (): boolean => emailPortalNav.length > 0 || developerConsole.on;

/** Health's tabs in a build without the session engine, in order (Errors first: the page's default). */
export const healthTabsShell = (): readonly (readonly [string, string])[] => [
  ['errors', 'Errors'], ['runs', W.Runs], ['scheduled', 'Scheduled work'], ...(deliveriesTab() ? [['deliveries', 'Deliveries'] as const] : []), ['status', 'Status']
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

// ---------------------------------------------------------------- Deliveries

interface EmailRow { kind: string; total: number; sent: number; failed: number; skipped: number; sending: number; last_at: string | null; last_failed_at: string | null }
interface HookRow { event: string; total: number; succeeded: number; failed: number; pending: number; attempts: number; last_at: string | null }
interface Endpoint { id: string; account: string; events: number; reason: string | null; failure_streak: number; first_failure_at: string | null; disabled_at: string | null }
interface DeliveriesData { email: boolean; webhooks: boolean; emails: EmailRow[]; deliveries: HookRow[]; disabled_endpoints: Endpoint[];
  daily: { day: string; emails_sent: number; emails_failed: number; hooks_succeeded: number; hooks_failed: number }[] }
const EMAIL_KIND: Record<string, string> = {
  request_received: 'Request received', request_alert: 'Request alert', request_declined: 'Request declined', request_approved: 'Welcome',
  submission_alert: 'Submission alert', submission_accepted: 'Submission accepted', submission_declined: 'Submission declined',
  budget_80: 'Budget 80%', budget_100: 'Budget 100%', due_soon: 'Due soon', test: 'Test', sign_in_code: 'Sign-in code', invitation: 'Invitation'
};

function DeliveriesTab() {
  const [range, setRange] = useState<DateRange>(last30);
  const { data, error, isLoading } = useAdmin<DeliveriesData>(`/health/deliveries?${rangeQuery(range)}`, { keep: true });
  const [pick, setPick] = useState<'emails' | 'webhooks' | 'endpoints'>(developerConsole.on && !emailPortalNav.length ? 'webhooks' : 'emails');
  const sum = (k: keyof DeliveriesData['daily'][number]) => (data ? data.daily.reduce((a, d) => a + Number(d[k]), 0) : null);
  const line = (k: keyof DeliveriesData['daily'][number]) => data?.daily.map((d) => Number(d[k]));
  const hooks = developerConsole.on;
  const summary = (
    <StatStrip quad items={[
      { label: 'Emails sent', value: sum('emails_sent') == null ? '—' : num(sum('emails_sent')), spark: line('emails_sent') },
      { label: 'Emails failed', value: sum('emails_failed') == null ? '—' : num(sum('emails_failed')), spark: line('emails_failed') },
      ...(hooks ? [
        { label: 'Webhooks delivered', value: sum('hooks_succeeded') == null ? '—' : num(sum('hooks_succeeded')), spark: line('hooks_succeeded') },
        { label: 'Endpoints switched off', value: data ? num(data.disabled_endpoints.length) : '—', spark: line('hooks_failed'), hint: data ? `${num(sum('hooks_failed'))} deliveries failed` : undefined }
      ] : [
        { label: 'Email kinds', value: data ? num(data.emails.length) : '—' },
        { label: 'Emails skipped', value: data ? num(data.emails.reduce((a, e) => a + e.skipped, 0)) : '—' }
      ])
    ]} />
  );
  const options: (readonly ['emails' | 'webhooks' | 'endpoints', string])[] = [['emails', 'Emails by kind'], ...(hooks ? [['webhooks', 'Webhook deliveries'] as const, ['endpoints', 'Endpoints switched off'] as const] : [])];
  const filters = <><Picker label='Show' value={pick} onChange={setPick} options={options} /><DateRangePicker value={range} onChange={setRange} /></>;
  const loading = isLoading || !data;
  return (
    <>
      <ErrorBox error={error} />
      {pick === 'emails' && (
        <RecordView<EmailRow>
          id='admin-health-emails' noun='kinds' exportName='health-emails' compact defaultSort={[{ key: 'total', dir: 'desc' }]}
          rows={data?.emails ?? []} rowKey={(r) => r.kind} loading={loading} summary={summary} filters={filters}
          cols={[
            { key: 'kind', label: 'Kind', type: 'text', title: true, keep: true, value: (r) => EMAIL_KIND[r.kind] ?? r.kind, render: (r) => <span className='font-medium'>{EMAIL_KIND[r.kind] ?? r.kind}</span> },
            { key: 'total', label: 'Tried', type: 'number', className: 'w-20 text-right', keep: true, value: (r) => r.total, render: (r) => num(r.total) },
            { key: 'sent', label: 'Sent', type: 'number', className: 'w-20 text-right', value: (r) => r.sent, render: (r) => num(r.sent) },
            { key: 'failed', label: 'Failed', type: 'number', className: 'w-20 text-right', keep: true, value: (r) => r.failed, render: (r) => (r.failed ? <span className='text-destructive'>{num(r.failed)}</span> : '0') },
            { key: 'skipped', label: 'Skipped', type: 'number', className: 'w-20 text-right', value: (r) => r.skipped, render: (r) => num(r.skipped) },
            { key: 'last_at', label: 'Last', type: 'date', className: 'w-28', value: (r) => r.last_at, render: (r) => <When d={r.last_at} className='text-sm' /> },
            { key: 'last_failed_at', label: 'Last failure', type: 'date', className: 'w-28', value: (r) => r.last_failed_at, render: (r) => <When d={r.last_failed_at} className='text-sm' /> }
          ]}
          searchText={(r) => `${EMAIL_KIND[r.kind] ?? r.kind} ${r.kind}`} searchPlaceholder='Search email kinds' empty='No emails in this period.'
        />
      )}
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

interface Check { id: string; label: string; state: 'ok' | 'warn' | 'bad' | 'off'; value: string; detail: string | null }
interface Provider { slug: string; name: string; category: string; set: 'yes' | 'no'; enabled: boolean; backend: string; note: string | null; keys: number; last_changed_at: string | null; last_used_at: string | null }
interface StatusData {
  checks: Check[]; providers: Provider[];
  release: { runtime: string; commit: string | null; instance_started_at: string; last_migration: { version: number; name: string; applied_at: string | null } | null; mold: { schema: string | null; package: string | null } };
}
const CHECK_TONE: Record<Check['state'], Tone> = { ok: 'ok', warn: 'warn', bad: 'bad', off: 'neutral' };
const CHECK_WORD: Record<Check['state'], string> = { ok: 'OK', warn: 'Attention', bad: 'Failing', off: 'Not used' };

function StatusTab() {
  const { data, error, isLoading } = useAdmin<StatusData>('/health/status', { refetchInterval: 60_000 });
  const [pick, setPick] = useState<'checks' | 'providers'>('checks');
  const r = data?.release;
  const set = data?.providers.filter((p) => p.set === 'yes').length ?? 0;
  const summary = (
    <StatStrip quad items={[
      { label: 'Checks passing', value: data ? `${data.checks.filter((c) => c.state === 'ok').length} of ${data.checks.filter((c) => c.state !== 'off').length}` : '—' },
      { label: 'Keys set', value: data ? `${set} of ${data.providers.length}` : '—', href: '/admin/keys' },
      { label: 'Last deploy', value: r?.last_migration?.applied_at ? <When d={r.last_migration.applied_at} /> : '—',
        hint: r ? [r.commit && `commit ${r.commit}`, `instance up since ${new Date(r.instance_started_at).toLocaleString()}`].filter(Boolean).join(' · ') : undefined },
      { label: 'Mold version', value: r?.mold.schema ? r.mold.schema.slice(0, 4) : '—', hint: r ? [r.mold.schema, r.mold.package && `package ${r.mold.package}`].filter(Boolean).join(' · ') : undefined }
    ]} />
  );
  const filters = <Picker label='Show' value={pick} onChange={setPick} options={[['checks', 'Live checks'], ['providers', 'Key vault providers']]} />;
  const loading = isLoading || !data;
  return (
    <>
      <ErrorBox error={error} />
      {pick === 'checks' ? (
        <RecordView<Check>
          id='admin-health-status' noun='checks' compact rows={data?.checks ?? []} rowKey={(c) => c.id} loading={loading} summary={summary} filters={filters}
          cols={[
            { key: 'label', label: 'Check', type: 'text', title: true, keep: true, value: (c) => c.label, render: (c) => <span className='font-medium'>{c.label}</span> },
            { key: 'state', label: 'State', type: 'select', className: 'w-32', keep: true, value: (c) => c.state, options: (Object.keys(CHECK_WORD) as Check['state'][]).map((v) => ({ value: v, label: CHECK_WORD[v] })),
              render: (c) => <StatusBadge tone={CHECK_TONE[c.state]}>{CHECK_WORD[c.state]}</StatusBadge> },
            { key: 'value', label: 'Now', type: 'text', keep: true, value: (c) => c.value, render: (c) => c.value },
            { key: 'detail', label: 'Detail', type: 'text', value: (c) => c.detail, render: (c) => (c.detail ? <span className='text-muted-foreground line-clamp-2 max-w-md text-sm whitespace-normal' title={c.detail}>{c.detail}</span> : dash) }
          ]}
          searchText={(c) => `${c.label} ${c.value} ${c.detail ?? ''}`} searchPlaceholder='Search checks' empty='No checks.'
        />
      ) : (
        <RecordView<Provider>
          id='admin-health-providers' noun='providers' compact rows={data?.providers ?? []} rowKey={(p) => p.slug} loading={loading} summary={summary} filters={filters}
          cols={[
            { key: 'name', label: 'Provider', type: 'text', title: true, keep: true, value: (p) => p.name, render: (p) => <span className='font-medium'>{p.name}</span> },
            { key: 'category', label: 'Category', type: 'select', className: 'w-36', value: (p) => p.category, render: (p) => p.category },
            { key: 'set', label: 'Key', type: 'select', className: 'w-28', keep: true, value: (p) => p.set, options: [{ value: 'yes', label: 'Set' }, { value: 'no', label: 'Missing' }],
              render: (p) => <StatusBadge tone={p.set === 'yes' ? 'ok' : 'warn'}>{p.set === 'yes' ? 'Set' : 'Missing'}</StatusBadge> },
            { key: 'note', label: 'Note', type: 'text', value: (p) => p.note, render: (p) => (p.note ? <span className='text-muted-foreground text-sm'>{p.note}</span> : dash) },
            { key: 'last_used_at', label: 'Last used', type: 'date', className: 'w-28', value: (p) => p.last_used_at, render: (p) => <When d={p.last_used_at} className='text-sm' /> },
            { key: 'last_changed_at', label: 'Last changed', type: 'date', className: 'w-28', hidden: true, value: (p) => p.last_changed_at, render: (p) => <When d={p.last_changed_at} className='text-sm' /> }
          ]}
          searchText={(p) => `${p.name} ${p.category} ${p.note ?? ''}`} searchPlaceholder='Search providers' empty='No provider in this build.'
        />
      )}
    </>
  );
}
