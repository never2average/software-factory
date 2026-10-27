'use client';
// The Compute page (/admin/compute: the on-call
// console over GET /compute/summary, src/compute.ts, with the capacity settings in its Limits table, its Orchestrators
// table in compute-orchestrators.tsx (Jobs and Sessions are tabs on Health), its Activity chart and Autoscaler
// decisions in compute-decisions.tsx). Each setting
// shows the value in force and where it comes from: set here, the server's environment, or the built-in default.
// Saving writes platform_settings (every server picks it up within 30s) and an audit log line. Model keys are the key
// vault's credentials: a key is typed once and never shown again, only its hint.
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Icons } from '@/components/icons';
import { List } from './account-peek';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adminApi } from '@/lib/api-client';
import { persistedKey } from '@/lib/env-names';
import { counted } from '@/lib/display-format';
import { cn } from '@/lib/utils';
import { post, useAdmin, useAdminAction } from './lib';
import { Gate, useAdminRole } from './role';
import { ErrorBox, FormRow, LoadingCards, Mono, Notice, Section, When } from './ui';
import { ActionsMenu, Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { ageOf, dur, SectionLink, UrlTabs, useComputeParams, useNow } from './compute-common';
import { StatStrip } from '@/components/layout/section';
import { ComputeOrchestrators } from './compute-orchestrators';
import { ComputeFailures, type Failures } from './compute-failures';
import { AdminEmails } from './emails';
import { ComputeDecisions, type Tick } from './compute-decisions';
import { ComputeRunners } from './compute-runners';
import { onPremRunners } from '@/config/pack-nav.generated';

interface Setting {
  key: string; group: string; label: string; help: string; kind: 'text' | 'int' | 'number' | 'choice'; default: string | number;
  options?: string[]; min?: number; max?: number; value: string | number; source: 'set' | 'env' | 'default';
  env: string | null; updated_at: string | null; updated_by: string | null;
}
type Level = 'red' | 'amber' | 'green';
interface Verdict { level: Level; code: string; text: string; href: string | null }
interface Knob { name: string; value: string; source: 'env' | 'default'; meaning: string }
interface Summary {
  at: string; runtime: 'vm' | 'vercel'; verdict: Verdict[];
  tick: { at: string | null; age_s: number | null; holder: string | null; enabled: boolean; kick_configured: boolean; note: string | null; error: string | null; tick_seconds: number; free: number | null };
  queue: { sessions: number; research: number; oldest_session_at: string | null; oldest_research_at: string | null; unclaimable: number; jobs_waiting: number };
  running: { sessions: number; research: number; orchestrators: { booting: number; running: number; draining: number }; pods_used: number; pods_reserved: number };
  wait_1h: { p50_s: number | null; p95_s: number | null; n: number };
  failures_24h: { sessions: number; launches: number; ended: number; rate: number; top: { key: string; label: string; count: number } | null };
  spend_today: { session_model_usd: number; orchestrator_model_usd: number; sandbox_est_usd: number; total_usd: number };
  limits: {
    ok: boolean; error: string | null; stale: boolean; plan: number | null; active_now: number | null; ours_orch: number; ours_workers: number; ours_images: number; others: number; other_prefixes: string[];
    our_starts: { minute: number; hour: number; day: number }; starts: { per_minute: number; per_hour: number; per_day: number } | null;
    job_orch_live: number; job_orch_draining: number; job_orch_cap: number; shared_orch_live: number; shared_orch_cap: number; per_job_mode: boolean;
    pods_max_reserved: number; pods_avg_running: number; pods_cap: number; available: number | null; per_orchestrator: number;
    sessions_per_day_ceiling: number | null; reason: string | null; binding: 'plan' | 'job_orch' | 'pods' | null; note: string | null; sandbox_prices: Record<string, number>;
  };
  settings: Setting[]; knobs: Knob[];
  provider: { name: string; api: string; namespace: string; ok: boolean; error: string | null; has_key: boolean; key_hint: string | null; key_label: string | null; uses: number; last_used_at: string | null };
  links: { newrelic: string | null };
}

const SUMMARY = '/compute/summary';
const LEVEL: Record<Level, { border: string; text: string }> = {
  red: { border: 'border-l-destructive', text: 'text-destructive' },
  amber: { border: 'border-l-amber-500', text: 'text-amber-700 dark:text-amber-400' },
  green: { border: 'border-l-emerald-500', text: 'text-emerald-700 dark:text-emerald-400' }
};

/**
 * Compute: is compute healthy, is work flowing, what is stuck, and why. A verdict worked out on the server, how fresh
 * the autoscaler's last tick is, the headline numbers, which limit binds (the capacity settings are edited on the row
 * of the limit they change) and the environment it runs with. Read only apart from those settings, "Run a tick now" and
 * cancelling a session (both behind a confirm, both in the admin log). Refreshes every
 * 15 s while the tab is visible; paused (with a Paused · Resume chip) while a setting has an unsaved edit or a record
 * peek is open.
 */
export function AdminCompute() {
  // useSearchParams (the tab, filters and open records) needs a Suspense boundary for the static render.
  return <Suspense fallback={<PageContainer><Skeleton className='h-72 rounded-lg' /></PageContainer>}><ComputePage /></Suspense>;
}

function ComputePage() {
  const qc = useQueryClient();
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [resumed, setResumed] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const editing = Object.values(dirty).some(Boolean);
  const paused = (editing || peeking) && !resumed;
  const { data, error, isLoading, refetch } = useAdmin<Summary>(SUMMARY, { refetchInterval: paused ? undefined : 15_000 });
  const [refreshing, setRefreshing] = useState(false);
  // Refresh asks boat again (past its 30 s listing cache): the same call as "Test connection".
  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(['admin', SUMMARY], await adminApi<Summary>('GET', `${SUMMARY}?fresh=1`));
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'admin' && /^\/compute\/(jobs|sessions|orchestrators|failures|ticks|activity)/.test(String(q.queryKey[1])) });
    }
    catch (e) { toast.error((e as Error).message); }
    finally { setRefreshing(false); }
  };
  // "Resume" lasts until the edits are saved or dropped and the peek is closed; the next edit or peek pauses again.
  const setEdit = (key: string, on: boolean) => {
    const next = { ...dirty, [key]: on };
    if (dirty[key] !== on) setDirty(next);
    if (!Object.values(next).some(Boolean) && !peeking) setResumed(false);
  };
  const setPeek = (on: boolean) => {
    setPeeking(on);
    if (!on && !editing) setResumed(false);
  };
  // ?section= picks the tab (orchestrators by default); each tab is its headline numbers and one table. The record
  // tables load and fail on their own, so they show even when the summary did not load.
  const section = useSearchParams().get('section');
  const tab = TABS.some(([id]) => id === section) ? section! : section === 'activity' ? 'decisions' : 'orchestrators';
  const s = data;
  return (
    <PageContainer>
      <div className='flex min-w-0 flex-col gap-3'>
        <UrlTabs tabs={TABS} tab={tab} base='/admin/compute' right={
          <div className='flex flex-wrap items-center justify-end gap-x-4 gap-y-2'>
            <div className='flex flex-wrap items-center gap-2'>
              {data && <Freshness s={data} />}
              {paused && <Button variant='outline' size='sm' onClick={() => setResumed(true)} title={editing ? 'Refresh is paused while a setting has an unsaved edit' : 'Refresh is paused while a record is open'}><Icons.clock /> Paused · Resume</Button>}
              <Button variant='outline' size='sm' disabled={refreshing} onClick={() => void refresh()} title='Ask boat.dev again and reload every figure'>{refreshing ? <Icons.spinner className='animate-spin' /> : <Icons.refresh />} Refresh</Button>
              {data && <RunTick s={data} />}
              {data?.links.newrelic && <ActionsMenu label='More' items={[{ label: 'Open in New Relic', icon: <Icons.externalLink />, onSelect: () => window.open(data.links.newrelic!, '_blank', 'noopener') }]} />}
            </div>
          </div>
        } />
        {error && !data && (
          <div role='alert' className='border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-3 rounded-lg border px-4 py-3 text-sm'>
            <span className='min-w-0 flex-1'>Could not load compute status: {error.message}</span>
            <Button variant='outline' size='xs' onClick={() => void refetch()}>Retry</Button>
          </div>
        )}
        <PeekWatch onChange={setPeek} />
        {tab === 'orchestrators' && <ComputeOrchestrators verdict={data?.verdict ?? []} summary={s && <OrchCards s={s} />} />}
        {tab === 'failures' && <ComputeFailures stats={(f, hours) => <FailureCards f={f} hours={hours} />} />}
        {tab === 'decisions' && <ComputeDecisions runtime={data?.runtime ?? null} stats={(rows) => <DecisionCards s={s} rows={rows} />} />}
        {tab === 'limits' && (isLoading ? <Skeleton className='h-72 rounded-lg' /> : s && <Limits s={s} onEditing={setEdit} />)}
        {tab === 'environment' && (isLoading ? <Skeleton className='h-72 rounded-lg' /> : s && <Environment s={s} onTest={() => void refresh()} testing={refreshing} />)}
        {tab === 'emails' && <AdminEmails embedded />}
        {tab === 'runners' && onPremRunners && <ComputeRunners />}
      </div>
    </PageContainer>
  );
}

// On-premises runners (mold_v0-036): a tab only in a build where a kind may need a workspace's private network.
const TABS: readonly (readonly [string, string])[] = [['orchestrators', 'Orchestrators'], ['failures', 'Failures'], ['decisions', 'Autoscaler decisions'], ['limits', 'Limits'], ['environment', 'Environment'], ['emails', 'Emails'],
  ...(onPremRunners ? [['runners', 'On-premises runners'] as const] : [])];

/** Tells the page whether a record peek is open (?session, ?orch, ?job or ?tick), so the summary stops refreshing. */
function PeekWatch({ onChange }: { onChange: (open: boolean) => void }) {
  const url = useComputeParams();
  const open = ['session', 'orch', 'job', 'tick'].some((k) => url.has(k));
  useEffect(() => { onChange(open); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

interface TickResult { leader: boolean; launched: number; reaped: number; note: string | null; error: string | null; message: string }

/** "Run a tick now" (POST /compute/tick, audited): one autoscaler tick at once, behind a confirm. Hidden when
 * autoscaling is off; disabled on a Vercel deployment that cannot trigger the autoscaler. */
function RunTick({ s }: { s: Summary }) {
  const [asking, setAsking] = useState(false);
  const tick = useAdminAction(() => post<TickResult>('/compute/tick'));
  if (!s.tick.enabled) return null;
  const blocked = s.runtime === 'vercel' && !s.tick.kick_configured;
  const run = () => tick.mutate(undefined, { onSuccess: (r) => (r.error ? toast.error(r.message) : r.leader ? toast.success(r.message) : toast.info(r.message)) });
  return (
    <>
      <Gate need='compute'><Button variant='outline' size='sm' disabled={tick.isPending || blocked} onClick={() => setAsking(true)}
        title={blocked ? 'This deployment cannot trigger the autoscaler: PUBLIC_URL is not HTTPS or the worker token is unset' : 'Run one autoscaler tick now instead of waiting for the next one'}>
        {tick.isPending ? <Icons.spinner className='animate-spin' /> : <Icons.play />} Run a tick
      </Button></Gate>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run an autoscaler tick now?</AlertDialogTitle>
            <AlertDialogDescription>
              It does what the next scheduled tick would: it may start orchestrators for queued work and stop idle or broken ones. Your name goes in the admin log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setAsking(false); run(); }}>Run a tick</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** "Ticked 12 s ago": amber past 3 ticks, red past 10 minutes; the runtime, the leader and the data's time on hover. */
function Freshness({ s }: { s: Summary }) {
  useNow();
  const age = ageOf(s.tick.at);
  const tone = age == null || age > 600 ? 'red' : age > 3 * s.tick.tick_seconds ? 'amber' : null;
  const runtime = s.runtime === 'vercel' ? 'Vercel' : 'VM';
  const text = age == null ? 'Not ticked yet' : `Ticked ${dur(age)} ago`;
  const title = [s.tick.at && `Last autoscaler tick ${new Date(s.tick.at).toLocaleString()}${s.tick.holder ? ` by ${s.tick.holder}` : ''}`,
    tone === 'red' && s.runtime === 'vercel' && 'On Vercel, ticks only happen when something happens; queued work may wait for the next 5-minute cron.',
    `Runtime ${runtime} · data as of ${new Date(s.at).toLocaleTimeString()}`].filter(Boolean).join('\n');
  return <span id='tick' className={cn('text-muted-foreground text-xs whitespace-nowrap tabular-nums', tone && LEVEL[tone].text)} title={title}>{text}</span>;
}


type Card = { label: ReactNode; value: ReactNode; spark?: number[] };
/** One row of the tab's four headline numbers, as on Health, each with its last 24 hours (or week) as a sparkline. */
function Cards({ items }: { items: Card[] }) {
  return <StatStrip items={items} />;
}
/** The last 24 hours (or 168), hour by hour (GET /compute/trends, src/compute-trends.ts): every card's sparkline. */
function useTrend(hours: 24 | 168 = 24) {
  const t = useAdmin<{ series: Record<string, number[]> }>(`/compute/trends${hours === 168 ? '?hours=168' : ''}`, { refetchInterval: 60_000, keep: true }).data?.series;
  return (k: string) => t?.[k];
}
const total = (xs: number[] | undefined) => (xs ? xs.reduce((a, b) => a + b, 0) : null);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function OrchCards({ s }: { s: Summary }) {
  useNow();
  const t = useTrend();
  const o = s.running.orchestrators, l = s.limits;
  return <Cards items={[
      { label: 'Orchestrators live', spark: t('orchestrators'), value: o.booting + o.running + o.draining },
      { label: 'Worker pods used / reserved', spark: t('running'), value: `${s.running.pods_used} / ${s.running.pods_reserved}` },
      { label: 'Failed launches, 24 h', spark: t('launches_failed'), value: s.failures_24h.launches },
      { label: 'Room for more', spark: t('free'), value: l.available ?? '—' }
    ]} />;
}

function FailureCards({ f, hours }: { f: Failures | undefined; hours: number }) {
  const sum = (xs: { count: number }[] | undefined) => (xs ?? []).reduce((t, x) => t + x.count, 0);
  const sessions = sum(f?.sessions), top = f?.sessions.slice().sort((x, y) => y.count - x.count)[0];
  const w = hours === 24 ? '24 h' : '7 d';
  const t = useTrend(hours === 168 ? 168 : 24);
  return <Cards items={[
      { label: `Session failures, ${w}`, spark: t('failed'), value: f ? sessions : '—' },
      { label: 'Top session failure', spark: t('top_failure'), value: top ? <span className='text-base'>{top.label} · {top.count}</span> : 'None' },
      { label: `Failed launches, ${w}`, spark: t('launches_failed'), value: f ? sum(f.launches) : '—' },
      { label: `Unexpected reaps, ${w}`, spark: t('reaps'), value: f ? sum(f.reaps.filter((r) => !r.routine)) : '—' }
    ]} />;
}

function DecisionCards({ s, rows }: { s: Summary | undefined; rows: Tick[] }) {
  useNow();
  const age = ageOf(s?.tick.at);
  const t = useTrend();
  return <Cards items={[
      { label: 'Last tick', spark: t('ticks'), value: age == null ? '—' : `${dur(age)} ago` },
      { label: 'Orchestrators launched', spark: t('launched'), value: rows.reduce((n, r) => n + r.launched.length, 0) },
      { label: 'Orchestrators reaped', spark: t('reaped'), value: rows.reduce((n, r) => n + r.reaped.length, 0) },
      { label: 'Ticks with an error', spark: t('tick_errors'), value: rows.filter((r) => r.error).length }
    ]} />;
}

type Status = 'ok' | 'near' | 'binding';
interface LimitRow {
  key: string; label: string; help?: string;
  used: number | null; limit: number | null; sub?: ReactNode;
  /** Stacked meter parts (boat sandboxes): label, count, colour class. */
  parts?: { label: string; n: number; className: string }[];
  status: Status | null; source: ReactNode; setting?: Setting; fixed?: string; unavailable?: string | null; noBinding?: boolean;
}

const statusOf = (used: number | null, limit: number | null, binding: boolean, canBind = true): Status | null =>
  used == null || !limit ? (binding ? 'binding' : null) : binding && canBind ? 'binding' : used / limit >= 0.85 ? 'near' : 'ok';
const STATUS: Record<Status, ReactNode> = {
  ok: <span className='text-muted-foreground'>OK</span>,
  near: <span className='text-amber-700 dark:text-amber-400'>Near</span>,
  binding: <span className='text-destructive font-medium'>Binding</span>
};

/** Used against limit as a bar: one fill, or stacked parts (ours, others, free) when given. */
function Meter({ used, limit, parts, status }: { used: number; limit: number; parts?: LimitRow['parts']; status: Status | null }) {
  const w = (x: number) => `${Math.min(100, Math.max(0, (x / limit) * 100))}%`;
  const fill = status === 'binding' ? 'bg-destructive' : status === 'near' ? 'bg-amber-500' : 'bg-primary';
  return (
    <div className='bg-muted flex h-1.5 w-full overflow-hidden rounded-full' role='meter' aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
      {parts ? parts.map((p) => <div key={p.label} className={p.className} style={{ width: w(p.n) }} title={`${p.label}: ${p.n}`} />)
        : <div className={fill} style={{ width: w(used) }} />}
    </div>
  );
}

/** Where a setting's value comes from: set here (by whom, when), the environment, or the default. */
function SourceOf({ s }: { s: Setting }) {
  if (s.source === 'set') return <span>set{s.updated_by && ` by ${s.updated_by}`}{s.updated_at && <span className='text-muted-foreground'>, <When d={s.updated_at} /></span>}</span>;
  return <span className='text-muted-foreground'>{s.source === 'env' ? 'env' : 'default'}</span>;
}

/**
 * Which ceiling binds, one row per limit, with the capacity settings edited on the row they change (saved through
 * PUT /compute/settings, so the audit log is the same). boat's figures show "—" when boat did not answer.
 */
function Limits({ s, onEditing }: { s: Summary; onEditing: (key: string, on: boolean) => void }) {
  const save = useAdminAction((v: Record<string, string | null>) => adminApi('PUT', '/compute/settings', { values: v }), { success: 'Setting saved' });
  const l = s.limits;
  const t = useTrend();
  // A rejected save (say, over the setting's max) puts the field back to the saved value: its key changes.
  const [rejected, setRejected] = useState(0);
  const set = (k: string) => s.settings.find((x) => x.key === k);
  const boatDown = l.plan == null ? `boat.dev did not answer: ${l.error ?? 'no answer'}` : null;
  const startsNote = 'boat does not report used starts; other deployments\' starts are not counted.';
  const free = l.plan == null || l.active_now == null ? 0 : Math.max(0, l.plan - l.ours_orch - l.ours_workers - l.ours_images - l.others);
  const size = set('BOAT_SANDBOX_SIZE');
  const rows: LimitRow[] = [
    { key: 'plan', label: 'boat sandboxes at once', used: l.active_now, limit: l.plan, unavailable: boatDown,
      sub: l.plan != null && <>ours {l.ours_orch} orchestrators · {l.ours_workers} workers{l.ours_images > 0 && <> · image builder {l.ours_images}</>} · other deployments {l.others} · free {free}</>,
      parts: [
        { label: 'Our orchestrators', n: l.ours_orch, className: 'bg-primary' },
        { label: 'Our workers', n: l.ours_workers, className: 'bg-primary/55' },
        { label: 'Our image builder and images', n: l.ours_images, className: 'bg-primary/30' },
        { label: 'Other deployments', n: l.others, className: 'bg-amber-500/70' }
      ],
      status: statusOf(l.active_now, l.plan, l.binding === 'plan'), source: <span className='text-muted-foreground'>boat plan</span> },
    ...(['minute', 'hour', 'day'] as const).map((w): LimitRow => {
      const limit = l.starts ? l.starts[w === 'minute' ? 'per_minute' : w === 'hour' ? 'per_hour' : 'per_day'] : null;
      return { key: `starts-${w}`, label: `Our starts: per ${w}`, help: startsNote, used: l.our_starts[w], limit, unavailable: limit == null ? boatDown : null,
        sub: w === 'day' && l.sessions_per_day_ceiling != null && <>sessions a day, at most {l.sessions_per_day_ceiling}{l.reason && <> · {l.reason}</>}</>,
        status: statusOf(l.our_starts[w], limit, false, false), source: <span className='text-muted-foreground'>boat plan · database</span>, noBinding: true };
    }),
    ...(l.per_job_mode ? [
      { key: 'job_orch', label: 'Job orchestrators', used: l.job_orch_live, limit: l.job_orch_cap, setting: set(persistedKey('MAX_JOB_ORCHESTRATORS')),
        sub: l.job_orch_draining > 0 && <>booting or running · {l.job_orch_draining} draining, not counted</>,
        status: statusOf(l.job_orch_live, l.job_orch_cap, l.binding === 'job_orch'), source: null },
      { key: 'pods', label: 'Worker pods per job orchestrator', used: l.pods_max_reserved, limit: l.pods_cap, setting: set(persistedKey('JOB_POD_CAPACITY')),
        sub: <>most reserved by one · avg running {l.pods_avg_running}</>, status: statusOf(l.pods_max_reserved, l.pods_cap, l.binding === 'pods'), source: null }
    ] : [
      { key: 'shared', label: 'Shared orchestrators', used: l.shared_orch_live, limit: l.shared_orch_cap, setting: set(persistedKey('MAX_ORCHESTRATORS')),
        status: statusOf(l.shared_orch_live, l.shared_orch_cap, false), source: null }
    ]),
    { key: 'size', label: 'Worker sandbox size', used: null, limit: null, setting: size, status: null, source: null }
  ];
  const cols: RecordCol<LimitRow>[] = [
    { key: 'limit', label: 'Limit', title: true, keep: true, type: 'text', value: (r) => r.label, render: (r) => (
      <span className='flex flex-col gap-1'>
        <span className='leading-none font-medium' title={r.help ?? r.setting?.help}>{r.label}</span>
        {r.sub && <span className='text-muted-foreground text-xs'>{r.sub}</span>}
      </span>
    ) },
    { key: 'used', label: 'Used / Limit', className: 'w-64', type: 'number', value: (r) => (r.limit ? (r.used ?? 0) / r.limit : null), render: (r) => (
      r.unavailable ? <span className='text-muted-foreground' title={r.unavailable}>—</span>
        : r.limit != null && r.used != null ? (
          <span className='flex flex-col gap-1.5'>
            <span className='text-sm tabular-nums'>{r.used} <span className='text-muted-foreground'>of {r.limit}</span></span>
            <Meter used={r.used} limit={r.limit} parts={r.parts} status={r.status} />
          </span>
        ) : r.setting ? <Mono>{String(r.setting.value)}</Mono> : <span className='text-muted-foreground'>—</span>
    ) },
    { key: 'status', label: 'Status', type: 'select', value: (r) => (r.unavailable || !r.status ? '' : r.status), render: (r) => (
      <span title={r.noBinding ? 'Never marked binding on its own: other deployments share the account\'s starts.' : undefined}>
        {r.unavailable || !r.status ? <span className='text-muted-foreground'>—</span> : STATUS[r.status]}
      </span>
    ) },
    // Off by default (Change's second line, or its text on fixed rows); kept for its filter.
    { key: 'source', label: 'Source', hidden: true, type: 'text', value: (r) => r.setting?.source ?? '', render: (r) => (r.setting ? <SourceOf s={r.setting} /> : r.source) },
    { key: 'change', label: 'Change', className: 'w-64', render: (r) => (
      r.setting ? (
        <span className='flex flex-col gap-1' onClick={(e) => e.stopPropagation()}>
          <span className='flex items-center gap-1'>
            <Gate need='compute'><LimitInput key={`${String(r.setting.value)}:${rejected}`} s={r.setting} disabled={save.isPending} onDirty={(on) => onEditing(r.setting!.key, on)}
              onSave={(v) => save.mutate({ [r.setting!.key]: v }, { onError: () => setRejected((k) => k + 1), onSettled: () => onEditing(r.setting!.key, false) })} /></Gate>
            {r.setting.source === 'set' && (
              <Gate need='compute'><Button variant='ghost' size='xs' className='text-muted-foreground hover:text-foreground' disabled={save.isPending}
                title={`Back to ${r.setting.env != null ? `the environment (${r.setting.env})` : `the default (${r.setting.default})`}`}
                onClick={() => save.mutate({ [r.setting!.key]: null })}>Reset</Button></Gate>
            )}
          </span>
          <span className='text-muted-foreground text-xs'><SourceOf s={r.setting} /></span>
        </span>
      ) : <span className='text-muted-foreground text-xs'>{r.fixed ?? r.source ?? '—'}</span>
    ) }
  ];
  // The fixed facts live in the table: the boat plan and other deployments on its first row, the session-a-day
  // ceiling under "Our starts: per day", and which limit binds in the Status column.
  const cards = <Cards items={[
      { label: 'Our sandboxes in use', spark: t('in_use'), value: l.ok ? l.ours_orch + l.ours_workers + l.ours_images : '—' },
      { label: 'Room for more', spark: t('free'), value: l.available ?? '—' },
      { label: 'Starts, last hour', spark: t('starts'), value: l.our_starts.hour },
      { label: 'Orchestrators of cap', spark: t('orchestrators'),
        value: l.per_job_mode ? `${l.job_orch_live} / ${l.job_orch_cap}` : `${l.shared_orch_live} / ${l.shared_orch_cap}` }
    ]} />;
  return (
    <RecordView id='compute-limits' rows={rows} rowKey={(r) => r.key} cols={cols} noun='limits' initialSize={25} compact summary={cards}
      searchText={(r) => `${r.label} ${r.setting?.key ?? ''} ${r.help ?? ''}`} searchPlaceholder='Search limits'
      empty='No limits.' />
  );
}

/** A capacity setting in its Limits row: saves on Enter, on leaving the field, or on choosing an option. */
function LimitInput({ s, onSave, onDirty, disabled }: { s: Setting; onSave: (v: string) => void; onDirty: (on: boolean) => void; disabled?: boolean }) {
  const [v, setV] = useState(String(s.value));
  const change = (x: string) => { setV(x); onDirty(x !== String(s.value)); };
  const commit = (x: string) => { if (x.trim() !== '' && x !== String(s.value)) onSave(x); else { setV(String(s.value)); onDirty(false); } };
  return s.kind === 'choice' ? (
    <NativeSelect aria-label={s.label} value={v} disabled={disabled} onChange={(e) => { change(e.target.value); commit(e.target.value); }} className='w-36'>
      {s.options!.map((o) => <NativeSelectOption key={o} value={o}>{o}</NativeSelectOption>)}
    </NativeSelect>
  ) : (
    <Input aria-label={s.label} value={v} disabled={disabled} onChange={(e) => change(e.target.value)} onBlur={() => commit(v)}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(String(s.value)); onDirty(false); } }}
      className='h-8 w-24 tabular-nums' type='number' min={s.min} max={s.max} step={s.kind === 'number' ? 'any' : 1} />
  );
}

/** Settings that shape compute but are changed elsewhere: shown read only, with a link to their page. */
const RELATED: { key: string; page: string; href: string }[] = [
  { key: 'ORCHESTRATOR_MODEL', page: 'Agent configuration', href: '/admin/configuration' },
  { key: persistedKey('MAX_SESSIONS_PER_RUN'), page: 'Agent configuration', href: '/admin/configuration' },
  { key: 'RESEARCH_MAX_COST_USD', page: 'Agent configuration', href: '/admin/configuration' }
];

/** The environment the autoscaler runs with (read only), settings changed elsewhere, and the boat account in the cards. */
interface EnvRow { name: string; value: string; source: ReactNode; sourceText: string; meaning: ReactNode; meaningText: string }
function Environment({ s, onTest, testing }: { s: Summary; onTest: () => void; testing: boolean }) {
  const p = s.provider;
  const t = useTrend();
  // The boat account's facts are rows here (the runtime and APP_AUTOSCALE are knobs); the cards are what the
  // environment did in the last 24 hours.
  const boatRows: EnvRow[] = [
    { name: 'boat.dev', value: p.ok ? 'Connected' : 'Not connected', source: <span className='text-xs'>boat API</span>, sourceText: 'boat API',
      meaningText: p.ok ? `${p.api} answers with this key` : p.error ?? 'No answer', meaning: p.ok ? <>{p.api} answers with this key</> : <span className='text-destructive'>{p.error ?? 'No answer'}</span> },
    { name: 'boat key', value: p.has_key ? p.key_hint ?? 'set' : 'None', source: <span className='text-xs'>key vault</span>, sourceText: 'key vault',
      meaningText: p.has_key ? `${p.key_label ?? 'default'} · used ${p.uses} times${p.last_used_at ? `, last ${new Date(p.last_used_at).toLocaleString()}` : ''}` : 'Add a boat key in the key vault',
      meaning: p.has_key ? <>{p.key_label ?? 'default'} · used {p.uses} times{p.last_used_at && <>, last <When d={p.last_used_at} /></>}</> : <Link href='/admin/keys' className='text-foreground hover:underline'>Add a boat key in the key vault</Link> }
  ];
  const rows: EnvRow[] = [
    ...boatRows,
    ...s.knobs.map((k) => ({ name: k.name, value: k.value, source: k.source, sourceText: k.source, meaning: k.meaning, meaningText: k.meaning })),
    ...RELATED.map((r) => ({ ...r, s: s.settings.find((x) => x.key === r.key) })).filter((r) => r.s).map((r) => ({
      name: r.key, value: String(r.s!.value), source: <SourceOf s={r.s!} />, sourceText: r.s!.source, meaningText: `${r.s!.label}. Change it in ${r.page}`,
      meaning: <>{r.s!.label}. <Link href={r.href} className='text-foreground hover:underline'>Change it in {r.page}</Link></>
    }))
  ];
  const cols: RecordCol<EnvRow>[] = [
    { key: 'name', label: 'Name', title: true, keep: true, type: 'text', value: (r) => r.name, render: (r) => <Mono>{r.name}</Mono> },
    { key: 'value', label: 'Value', type: 'text', value: (r) => r.value, render: (r) => <Mono>{r.value}</Mono> },
    { key: 'source', label: 'Source', type: 'select', value: (r) => r.sourceText, render: (r) => <span className='text-xs'>{r.source}</span> },
    { key: 'meaning', label: 'Meaning', className: 'min-w-80', type: 'text', value: (r) => r.meaningText, render: (r) => <span className='text-muted-foreground text-xs whitespace-normal'>{r.meaning}</span> }
  ];
  const cards = <Cards items={[
      { label: 'Autoscaler ticks, 24 h', spark: t('ticks'), value: total(t('ticks')) ?? '—' },
      { label: 'Ticks with an error, 24 h', spark: t('tick_errors'), value: total(t('tick_errors')) ?? '—' },
      { label: 'Orchestrators started, 24 h', spark: t('launches'), value: total(t('launches')) ?? '—' },
      { label: 'Sandboxes deleted, 24 h', spark: t('deletes'), value: total(t('deletes')) ?? '—' }
    ]} />;
  return (
    <RecordView id='compute-environment' rows={rows} rowKey={(r) => r.name} cols={cols} noun='settings' initialSize={50} compact summary={cards}
      searchText={(r) => `${r.name} ${r.value} ${r.sourceText} ${r.meaningText}`} searchPlaceholder='Search settings'
      filters={<Button variant='outline' disabled={testing} onClick={onTest}>{testing ? <Icons.spinner className='animate-spin' /> : <Icons.plug />} Test connection</Button>}
      empty='No settings.' />
  );
}
