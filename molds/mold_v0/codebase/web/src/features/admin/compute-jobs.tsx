'use client';
// Compute › Jobs (GET /compute/jobs, src/compute-jobs.ts): every simulation and research job that is active or
// finished recently, waiting first, with why each one waits (from the autoscaler's last tick), its work, its
// orchestrator, pods and spend, and a peek with its sessions by agent (and whether each agent can run), its
// orchestrators and a spend breakdown. State, kind, range and "has failures" are asked of the server and kept in the
// URL (?section=jobs&jstate=waiting&job=sim_…), so the verdict, tiles and Health deep-link here. Read only.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { Button, buttonVariants } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { counted } from '@/lib/display-format';
import { cn } from '@/lib/utils';
import { useAdmin } from './lib';
import { W } from '@/lib/vocabulary';
import { copyText, ErrorBox, Mono, Notice, StatusBadge, When, type Tone } from './ui';
import { Chip, cents, dur, jobSessions, PeekSection, since, useComputeParams, useNow, nextPinned, useScrollTo } from './compute-common';
import { JobsStats } from './compute-stats';
import { MiniTable } from './compute-sessions';

type Kind = 'simulation' | 'research' | 'prospect';
type JobState = 'waiting' | 'queued' | 'booting' | 'running' | 'draining' | 'failed' | 'finished';
interface Sessions { queued: number; running: number; completed: number; failed: number; timeout: number; cancelled: number }
export interface JobRow {
  id: string; kind: Kind; name: string | null; status: string; org: { slug: string; name: string } | null; company: string | null;
  product: { id: number; name: string } | null; state: JobState; why_waiting: string | null; note: string | null;
  sessions: Sessions | null; research: { stage: string | null; attempts: number } | null;
  orchestrator: { id: number; orchestrator_id: string | null; state: string } | null; orchestrators_total: number; failed_launches: number;
  pods: { running: number; reserved: number }; created_at: string; finished_at: string | null; waiting_since: string | null; running_since: string | null;
  failures: { count: number; top_key: string | null; top_label: string | null };
  spend: { session_model_usd: number; orchestrator_model_usd: number; sandbox_est_usd: number; total_usd: number };
}
interface JobDetail {
  job: JobRow;
  why: { text: string; note: string | null; free: number | null; needed: number | null; cap: number | null } | null;
  agents: { agent_id: string | null; harness: string; queued: number; running: number; completed: number; failed: number; usd: number; runnable: { ok: boolean; reason: string } | null }[];
  orchestrators: { id: number; orchestrator_id: string | null; sandbox_id: string | null; state: string; created_at: string; boot_ms: number | null; lifetime_s: number;
    end_reason: { key: string; label: string; routine: boolean; message: string } | null }[];
  research: { status: string; stage: string | null; note: string | null; attempts: number; searches: number; heartbeat_at: string | null; error: string | null } | null;
}

const STATES: { id: string; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'active', label: 'Active' }, { id: 'waiting', label: 'Waiting' }, { id: 'booting', label: 'Booting' },
  { id: 'running', label: 'Running' }, { id: 'draining', label: 'Draining' }, { id: 'finished', label: 'Finished' }, { id: 'failed', label: 'Failed' }
];
const STATE_TONE: Record<JobState, Tone> = { waiting: 'warn', queued: 'info', booting: 'info', running: 'ok', draining: 'warn', failed: 'bad', finished: 'neutral' };
/** The session engine's job kinds (this table is its own: Health shows it only in a build with it, src/host-tables.ts). */
const KIND_LABEL: Record<Kind, string> = { simulation: W.Run, research: 'Research', prospect: 'Prospect research' };
const ORCH_TONE: Record<string, Tone> = { booting: 'info', running: 'ok', draining: 'warn', deleted: 'neutral' };
const RESEARCH_SPEND = 'Research spend is metered only through its orchestrator.';
/** Rows asked for at once; the table pages them 25 at a time. */
const LIMIT = 500;

const accountOf = (j: JobRow) => j.org?.name ?? j.company ?? '—';
const jobHref = (j: JobRow) => (j.org ? `/admin/accounts/${encodeURIComponent(j.org.slug)}` : j.kind === 'prospect' ? '/admin/requests' : null);
const done = (s: Sessions) => s.completed + s.cancelled;
const failedOf = (s: Sessions) => s.failed + s.timeout;
const total = (s: Sessions) => s.queued + s.running + done(s) + failedOf(s);
/** Failed sessions plus failed orchestrator launches, as the server's "has failures" filter counts them. */
const failuresOf = (j: JobRow) => j.failures.count + j.failed_launches;
/** Waiting since (queued work), else running for (the orchestrator's ready time). */
const clockOf = (j: JobRow) => (j.state === 'finished' || j.state === 'failed' ? null : j.waiting_since && j.state !== 'running' ? since(j.waiting_since) : since(j.running_since));

/** The Jobs section: filters in the URL, a peek per job (?job=<id>). */
export function ComputeJobs() {
  const url = useComputeParams();
  const router = useRouter();
  useNow(15_000);
  const state = url.get('jstate') ?? 'all', kind = url.get('jkind'), range = url.get('jsince') ?? '1h', failures = url.get('jfail') === '1';
  const sort = url.get('jsort');
  const open = url.get('job');
  const qs = new URLSearchParams({ limit: String(LIMIT), since: range, state, ...(kind ? { kind } : {}), ...(failures ? { has_failures: '1' } : {}), ...(sort === 'spend' ? { sort } : {}) });
  const [pinned, setPinned] = useState<string | null>(null);
  if (pinned) qs.set('include', pinned);
  // Refresh every 30 s, paused while a record is open (and, as every query, while the tab is hidden).
  const { data, error, isLoading, refetch } = useAdmin<{ total: number; facets?: Record<'state' | 'kind' | 'has_failures', Record<string, number>>; rows: JobRow[] }>(`/compute/jobs?${qs}`, { refetchInterval: open ? undefined : 30_000, keep: true });
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const pin = nextPinned(open, data?.rows.map((r) => r.id), pinned);
  if (pin !== pinned) setPinned(pin);
  useScrollTo('jobs', !!data);

  const set = (patch: Record<string, string | null>) => url.write({ ...patch, job: null });
  // Jobs each choice matches under the other filters (the server's facets); "" is the dropdown's "every".
  const fc = (k: 'state' | 'kind' | 'has_failures', v: string) => (data?.facets ? data.facets[k][v] ?? 0 : undefined);
  const showSessions = (id: string) => url.write({ ...jobSessions(id), job: null });
  // Opens the orchestrator's peek in its table (the job peek closes; its "Back to job" link returns here).
  const showOrch = (orch: number, job: string) => url.write({ section: 'orchestrators', orch: String(orch), back: job, job: null });

  const cols: RecordCol<JobRow>[] = [
    { key: 'job', label: 'Job', title: true, keep: true, type: 'text', value: (j) => j.id, render: (j) => (
      <span className='flex min-w-0 flex-col gap-1'>
        <span className='flex items-center gap-1.5'><Mono>{j.id}</Mono><Chip>{KIND_LABEL[j.kind]}</Chip></span>
        <span className='text-muted-foreground truncate text-xs'>{accountOf(j)}{j.product && ` · ${j.product.name}`}</span>
      </span>
    ) },
    { key: 'state', label: 'State', keep: true, type: 'select', value: (j) => j.state, render: (j) => {
      const c = clockOf(j), waiting = !!j.waiting_since && j.state !== 'running';
      return (
        <span className='flex min-w-0 flex-col gap-1'>
          <span><StatusBadge tone={STATE_TONE[j.state]}>{j.state}</StatusBadge></span>
          {c != null ? <span className='text-muted-foreground text-xs tabular-nums' title={waiting ? 'Oldest queued work' : 'Since its orchestrator was ready'}>{waiting ? 'waiting ' : 'running '}{dur(c)}</span>
            : j.finished_at && <span className='text-muted-foreground text-xs'>ended {dur(since(j.finished_at))} ago</span>}
          {(j.state === 'waiting' || j.state === 'queued') && j.why_waiting && (
            <span className='text-muted-foreground line-clamp-2 max-w-72 text-xs' title={j.note ? `${j.why_waiting}\n${j.note}` : j.why_waiting}>{j.why_waiting}</span>
          )}
        </span>
      );
    } },
    { key: 'work', label: 'Work', type: 'number', value: (j) => (j.sessions ? total(j.sessions) : null), render: (j) => <Work j={j} /> },
    { key: 'orch', label: 'Orchestrator', type: 'text', value: (j) => j.orchestrator?.orchestrator_id ?? '', render: (j) => (
      j.orchestrator ? (
        <span className='flex flex-col gap-1'>
          <span className='flex items-center gap-1.5'><Mono>{j.orchestrator.orchestrator_id ?? `row ${j.orchestrator.id}`}</Mono>
            <StatusBadge tone={ORCH_TONE[j.orchestrator.state]}>{j.orchestrator.state === 'deleted' ? 'ended' : j.orchestrator.state}</StatusBadge></span>
          {j.orchestrators_total > 1 && <span className='text-muted-foreground text-xs'>{j.orchestrators_total} in all</span>}
        </span>
      ) : <span className='text-muted-foreground'>—</span>
    ) },
    // Folded into State's second line; kept hidden for its sort.
    { key: 'clock', label: 'Waiting since / running for', className: 'text-right', type: 'number', hidden: true, value: clockOf, render: (j) => {
      const c = clockOf(j);
      if (c == null) return j.finished_at ? <span className='text-muted-foreground text-xs'>ended {dur(since(j.finished_at))} ago</span> : <span className='text-muted-foreground'>—</span>;
      const waiting = !!j.waiting_since && j.state !== 'running';
      return <span className='tabular-nums' title={waiting ? 'Oldest queued work' : 'Since its orchestrator was ready'}>{waiting ? 'waiting ' : 'running '}{dur(c)}</span>;
    } },
    // Failed sessions plus failed orchestrator launches: the server's "has failures" filter counts both (okFail).
    { key: 'failures', label: 'Failures', type: 'number', value: failuresOf, render: (j) => (
      failuresOf(j) ? (
        <span className='flex flex-col gap-1'>
          {j.failures.count > 0 && <span className='flex flex-wrap items-center gap-1.5'><span className='text-destructive tabular-nums'>{j.failures.count}</span>
            {j.failures.top_label && <Chip tone='bad' title='Most common failure class'>{j.failures.top_label}</Chip>}</span>}
          {j.failed_launches > 0 && <span className='text-destructive text-xs tabular-nums'>{j.failed_launches} failed launch{j.failed_launches > 1 ? 'es' : ''}</span>}
        </span>
      ) : <span className='text-muted-foreground'>0</span>
    ) },
    // Metered model spend only (sessions and orchestrators through the gateway), not the sandbox price-table estimate.
    { key: 'spend', label: 'Model spend', className: 'text-right', type: 'number', value: (j) => j.spend.session_model_usd + j.spend.orchestrator_model_usd, render: (j) => (
      <span className='tabular-nums' title={j.kind === 'simulation' ? undefined : RESEARCH_SPEND}>{cents(j.spend.session_model_usd + j.spend.orchestrator_model_usd)}</span>
    ) }
  ];

  const filters = (
    <>
      <NativeSelect aria-label='State' value={state} onChange={(e) => set({ jstate: e.target.value === 'all' ? null : e.target.value })}>
        {STATES.map((c) => <NativeSelectOption key={c.id} value={c.id}>{counted(c.id === 'all' ? 'Every state' : c.label, fc('state', c.id))}</NativeSelectOption>)}
      </NativeSelect>
      <NativeSelect aria-label='Kind' value={kind ?? ''} onChange={(e) => set({ jkind: e.target.value || null })}>
        <NativeSelectOption value=''>{counted('Every kind', fc('kind', ''))}</NativeSelectOption>
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <NativeSelectOption key={k} value={k}>{counted(KIND_LABEL[k], fc('kind', k))}</NativeSelectOption>)}
      </NativeSelect>
      <NativeSelect aria-label='Finished within' value={range} onChange={(e) => set({ jsince: e.target.value === '1h' ? null : e.target.value })}>
        <NativeSelectOption value='1h'>Finished in the last hour</NativeSelectOption>
        <NativeSelectOption value='24h'>Finished in 24 h</NativeSelectOption>
        <NativeSelectOption value='7d'>Finished in 7 days</NativeSelectOption>
      </NativeSelect>
      <NativeSelect aria-label='Failures' value={failures ? '1' : ''} onChange={(e) => set({ jfail: e.target.value || null })}
        title='Jobs with failed sessions or failed orchestrator launches'>
        <NativeSelectOption value=''>{counted('With or without failures', fc('has_failures', ''))}</NativeSelectOption>
        <NativeSelectOption value='1'>{counted('Has failures', fc('has_failures', '1'))}</NativeSelectOption>
      </NativeSelect>
      <NativeSelect aria-label='Order' value={sort ?? ''} onChange={(e) => set({ jsort: e.target.value || null })}>
        <NativeSelectOption value=''>Most urgent first</NativeSelectOption>
        <NativeSelectOption value='spend'>Most spend first</NativeSelectOption>
      </NativeSelect>
    </>
  );

  return (
    <div id='compute-jobs-anchor' className='flex min-w-0 flex-col gap-3'>
      {error && !data && (
        <div role='alert' className='border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-3 rounded-lg border px-4 py-3 text-sm'>
          <span className='min-w-0 flex-1'>Could not load jobs: {error.message}</span>
          <Button variant='outline' size='xs' onClick={() => void refetch()}>Retry</Button>
        </div>
      )}
      <RecordView id='compute-jobs' summary={<JobsStats rows={rows} />} rows={rows} loading={isLoading && !data} rowKey={(j) => j.id} cols={cols} noun='jobs' initialSize={25}
        searchText={(j) => `${j.id} ${j.name ?? ''} ${j.org?.name ?? ''} ${j.org?.slug ?? ''} ${j.company ?? ''} ${j.product?.name ?? ''} ${j.state} ${KIND_LABEL[j.kind]} ${j.why_waiting ?? ''} ${j.orchestrator?.orchestrator_id ?? ''}`}
        searchPlaceholder='Search jobs, accounts, products' filters={filters} exportName='compute-jobs'
        openKey={open} onOpenChange={(k) => url.write({ job: k })}
        actions={(j) => [
          ...(jobHref(j) ? [{ label: j.org ? 'Open account' : 'Open access requests', icon: <Icons.externalLink />, onSelect: () => router.push(jobHref(j)!) }] : []),
          ...(j.kind === 'simulation' ? [{ label: 'Show sessions', icon: <Icons.search />, onSelect: () => showSessions(j.id) }] : []),
          ...(j.orchestrator ? [{ label: 'Show orchestrator', icon: <Icons.route />, onSelect: () => showOrch(j.orchestrator!.id, j.id) }] : []),
          { label: 'Copy id', icon: <Icons.page />, onSelect: () => copyText(j.id, 'Job id copied') }
        ]}
        detailTitle={(j) => <span className='flex items-center gap-2'><Mono>{j.id}</Mono><StatusBadge tone={STATE_TONE[j.state]}>{j.state}</StatusBadge></span>}
        detail={(j) => <JobPeek id={j.id} onSessions={() => showSessions(j.id)} onOrch={(o) => showOrch(o, j.id)} />}
        empty={state === 'all' && !kind && !failures ? `No jobs active or finished in the last ${range === '1h' ? 'hour' : range === '24h' ? '24 hours' : '7 days'}.` : 'No jobs match these filters.'} compact />
    </div>
  );
}

/** Simulation: sessions done / failed / running / queued as a small stacked bar. Research: its stage and attempt. */
function Work({ j }: { j: JobRow }) {
  if (j.research) return <span className='text-xs'>{j.research.stage ?? j.status}{j.research.attempts > 0 && <span className='text-muted-foreground'> · attempt {j.research.attempts + 1}</span>}</span>;
  const s = j.sessions!, all = total(s);
  if (!all) return <span className='text-muted-foreground'>no sessions</span>;
  const parts = [
    { n: done(s), c: 'bg-emerald-500', l: 'done' }, { n: failedOf(s), c: 'bg-destructive', l: 'failed' },
    { n: s.running, c: 'bg-sky-500', l: 'running' }, { n: s.queued, c: 'bg-muted-foreground/30', l: 'queued' }
  ];
  const label = parts.filter((p) => p.n).map((p) => `${p.n} ${p.l}`).join(' · ');
  return (
    <span className='flex min-w-28 flex-col gap-1' title={label}>
      <span className='bg-muted flex h-1.5 w-full overflow-hidden rounded-full'>
        {parts.map((p) => (p.n ? <span key={p.l} className={p.c} style={{ width: `${(p.n / all) * 100}%` }} /> : null))}
      </span>
      <span className='text-muted-foreground text-xs tabular-nums'>{done(s)}/{all} done{failedOf(s) ? ` · ${failedOf(s)} failed` : ''}{s.queued ? ` · ${s.queued} queued` : ''}</span>
    </span>
  );
}

/** One sentence on where the job is: "Running 38 of 40 pods on orch-212. 12 sessions queued; the oldest has waited 3 min." */
function statusSentence(j: JobRow, why: JobDetail['why']): string {
  const orch = j.orchestrator?.orchestrator_id ?? (j.orchestrator ? `row ${j.orchestrator.id}` : null);
  const queued = j.sessions?.queued ?? 0;
  const wait = queued && j.waiting_since ? ` ${queued} session${queued > 1 ? 's' : ''} queued; the oldest has waited ${dur(since(j.waiting_since))}.` : '';
  switch (j.state) {
    case 'finished': return `Finished ${dur(since(j.finished_at ?? j.created_at))} ago.`;
    case 'failed': return `Failed ${j.finished_at ? `${dur(since(j.finished_at))} ago` : ''}.`.replace(' .', '.');
    case 'waiting': case 'queued': return `${j.state === 'waiting' ? 'Waiting' : 'Queued'}${why ? `: ${why.text}` : ''}.${wait}`;
    case 'booting': return `Its orchestrator ${orch ?? ''} is booting.${wait}`.replace('  ', ' ');
    case 'draining': return `Its orchestrator ${orch ?? ''} is draining: it finishes what it runs and takes nothing new.${wait}`.replace('  ', ' ');
    default: return j.sessions
      ? `Running ${j.pods.running} of ${j.pods.reserved} pods${orch ? ` on ${orch}` : ''}.${wait}`
      : `Research is running${j.research?.stage ? ` (${j.research.stage})` : ''}${orch ? ` on ${orch}` : ''}.`;
  }
}

/** One job's peek: status, why it waits, sessions by agent, its orchestrators, research details, spend, links. */
function JobPeek({ id, onSessions, onOrch }: { id: string; onSessions: () => void; onOrch: (orch: number) => void }) {
  const { data, error, isLoading } = useAdmin<JobDetail>(`/compute/jobs/${encodeURIComponent(id)}`);
  if (isLoading) return <div className='grid gap-3'><Skeleton className='h-16' /><Skeleton className='h-40' /></div>;
  if (!data) return <ErrorBox error={error} />;
  const j = data.job, w = data.why, r = data.research;
  const href = jobHref(j);
  return (
    <div className='grid gap-6'>
      <PeekSection title='Status'>
        <p className='text-sm'>{statusSentence(j, w)}</p>
        <p className='text-muted-foreground text-xs'>{KIND_LABEL[j.kind]}{j.name && ` "${j.name}"`} for {accountOf(j)}{j.product && ` · ${j.product.name}`} · created <When d={j.created_at} /></p>
      </PeekSection>

      {w && (
        <PeekSection title='Why it is waiting'>
          <p className='text-sm'>{w.text}.</p>
          <dl className='grid grid-cols-3 gap-2 text-sm'>
            <div><dt className='text-muted-foreground text-xs'>Free on boat</dt><dd className='tabular-nums'>{w.free ?? '—'}</dd></div>
            <div><dt className='text-muted-foreground text-xs'>Needs (1 + pods)</dt><dd className='tabular-nums'>{w.needed ?? '—'}</dd></div>
            <div><dt className='text-muted-foreground text-xs'>Orchestrator limit</dt><dd className='tabular-nums'>{w.cap ?? '—'}</dd></div>
          </dl>
          {w.note && <p className='text-muted-foreground text-xs'>Autoscaler note: <Mono>{w.note}</Mono></p>}
        </PeekSection>
      )}

      {data.agents.length > 0 && (
        <PeekSection title='Sessions by agent' action={<Button variant='ghost' size='xs' onClick={onSessions}>Show sessions</Button>}>
          <MiniTable head={['Agent', 'Queued', 'Running', 'Done', 'Failed', '$']} rows={data.agents.map((a) => [
            <span key='a' className='flex flex-col gap-0.5'>
              <span>{a.agent_id ?? a.harness}</span>
              {a.runnable && !a.runnable.ok && <Link href={/not in the harness mix/i.test(a.runnable.reason) ? '/admin/agents' : '/admin/keys'} className='text-destructive hover:underline'>{a.runnable.reason}</Link>}
            </span>,
            a.queued, a.running, a.completed, a.failed ? <span key='f' className='text-destructive'>{a.failed}</span> : 0, cents(a.usd)])} />
        </PeekSection>
      )}

      <PeekSection title='Orchestrators for this job'>
        {data.orchestrators.length ? (
          <ul className='divide-y border-y'>
            {data.orchestrators.map((o) => (
              <li key={o.id}>
                <button type='button' onClick={() => onOrch(o.id)} className='hover:bg-muted/50 grid w-full grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 px-2 py-1.5 text-left text-xs'>
                  <span className='flex items-center gap-1.5'><Mono>{o.orchestrator_id ?? `row ${o.id}`}</Mono><StatusBadge tone={ORCH_TONE[o.state]}>{o.state === 'deleted' ? 'ended' : o.state}</StatusBadge></span>
                  <span className='text-muted-foreground tabular-nums'>boot {o.boot_ms == null ? '—' : dur(o.boot_ms / 1000)} · lived {dur(o.lifetime_s)}</span>
                  {o.end_reason && <span className={cn('col-span-2 line-clamp-1', o.end_reason.key.startsWith('launch:') ? 'text-destructive' : 'text-muted-foreground')} title={o.end_reason.message}>
                    {o.end_reason.label}: {o.end_reason.message}</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : <p className='text-muted-foreground text-sm'>No orchestrator has been launched for it.</p>}
      </PeekSection>

      {r && (
        <PeekSection title='Research'>
          <dl className='grid grid-cols-2 gap-2 text-sm'>
            <div><dt className='text-muted-foreground text-xs'>Stage</dt><dd>{r.stage ?? r.status}</dd></div>
            <div><dt className='text-muted-foreground text-xs'>Attempts rejected</dt><dd className='tabular-nums'>{r.attempts}</dd></div>
            <div><dt className='text-muted-foreground text-xs'>Searches</dt><dd className='tabular-nums'>{r.searches}</dd></div>
            <div><dt className='text-muted-foreground text-xs'>Last heartbeat</dt><dd><When d={r.heartbeat_at} /></dd></div>
          </dl>
          {r.note && <p className='text-muted-foreground text-xs'>{r.note}</p>}
          {r.error && <pre className='bg-muted/50 max-h-48 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap'>{r.error}</pre>}
        </PeekSection>
      )}

      <PeekSection title='Spend'>
        <dl className='grid gap-1 text-sm'>
          <SpendLine label='Session models (finished sessions)' v={j.spend.session_model_usd} />
          <SpendLine label='Orchestrator model (through the gateway)' v={j.spend.orchestrator_model_usd} />
          <SpendLine label='Total' v={j.spend.session_model_usd + j.spend.orchestrator_model_usd} strong />
        </dl>
        {j.kind !== 'simulation' && <Notice tone='info'>{RESEARCH_SPEND}</Notice>}
      </PeekSection>

      <PeekSection title='Links'>
        <div className='flex flex-wrap gap-2'>
          {href && <Link href={href} className={buttonVariants({ variant: 'outline', size: 'sm' })}><Icons.account /> {j.org ? j.org.name : 'Access requests'}</Link>}
          {j.kind === 'simulation' && <Button variant='outline' size='sm' onClick={onSessions}><Icons.search /> Sessions</Button>}
          <Button variant='ghost' size='sm' onClick={() => copyText(j.id, 'Job id copied')}>Copy id</Button>
        </div>
      </PeekSection>
    </div>
  );
}

function SpendLine({ label, v, title, strong }: { label: string; v: number; title?: string; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-3', strong && 'border-t pt-1 font-medium')} title={title}>
      <dt className={strong ? undefined : 'text-muted-foreground'}>{label}</dt><dd className='tabular-nums'>{cents(v)}</dd>
    </div>
  );
}
