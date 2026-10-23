'use client';
// Compute › Orchestrators (GET /compute/orchestrators, src/compute-records.ts): every orchestrator sandbox the
// autoscaler launched, by state chip, with boat's live state and TTL beside our row, and a peek with its boot
// timeline, the workers it runs now, its recent sessions, worker tokens, events and spend. "Unmatched on boat" swaps
// in boat's sandboxes that match nothing live of ours (leaked workers, rows that are gone, other deployments). Read
// only in v1: nothing here drains or deletes; the logs command is copied to run from a terminal.
import { useMemo, useState, type ReactNode } from 'react';
import { Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Icons } from '@/components/icons';
import { counted } from '@/lib/display-format';
import { cn } from '@/lib/utils';
import { useAdmin } from './lib';
import { copyText, ErrorBox, Mono, Notice, Section, StatusBadge, When, type Tone } from './ui';
import { AMBER, Chip, cents, dur, jobSessions, PeekSection, since, useComputeParams, useNow, nextPinned, useScrollTo } from './compute-common';
import { MiniTable } from './compute-sessions';

interface Limits { boot_minutes: number; stale_minutes: number; heartbeat_stale_s: number }
interface Boat { ok: boolean; stale: boolean; error: string | null }
export interface OrchRow {
  id: number; sandbox_id: string | null; orchestrator_id: string | null; job_id: string | null; state: string; boat_state: string | null; state_since: string | null;
  running_by_agent: Record<string, number>; running: number; pods: number; heartbeat_at: string | null; boot_ms: number | null; from_image: string | null;
  timings: Record<string, number> | null; ttl_left_s: number | null; code_hash: string | null; current_code: boolean; retiring_since: string | null;
  launch_step: string | null; launch_error: string | null; reap_reason: string | null; end_class: { key: string; label: string; routine: boolean } | null;
  created_at: string; ready_at: string | null; deleted_at: string | null; worker_id: string | null;
  spend: { orchestrator_model_usd: number; sandbox_est_usd: number };
}
interface Unmatched {
  sandbox_id: string; name: string | null; kind: 'worker_no_parent' | 'orch_no_row' | 'image_builder' | 'other_prefix';
  parent_orchestrator_id: string | null; created_at: string | null; boat_state: string; ttl_left_s: number | null;
}
interface OrchDetail {
  row: OrchRow; timings: Record<string, number>; boat: Boat; logs_command: string | null; limits: Limits;
  workers: { sandbox_id: string; name: string | null; agent_id: string | null; session_id: string | null; status: string | null; heartbeat_age_s: number | null; boat_state: string }[];
  sessions: { id: string; agent_id: string | null; status: string; queued_at: string; started_at: string | null; ended_at: string | null; error_message: string | null }[];
  tokens: { job_id: string; created_at: string; expires_at: string; revoked_at: string | null }[];
  events: { at: string; kind: string; sandbox_id: string | null; step: string | null; reason: string | null; actor: string | null }[];
  gateway: { provider: string; requests: number; errors: number; input_tokens: number; output_tokens: number; cost_usd: number }[];
}
interface Verdict { level: string; code: string; text: string }

const CHIPS: { id: string; label: string }[] = [
  { id: 'live', label: 'Live' }, { id: 'booting', label: 'Booting' }, { id: 'running', label: 'Running' }, { id: 'draining', label: 'Draining' },
  { id: 'stale', label: 'Stale' }, { id: 'failed_launch', label: 'Failed launches' }, { id: 'ended', label: 'Ended (24 h)' },
  { id: 'unmatched', label: 'Unmatched on boat' }, { id: 'all', label: 'All' }
];
const STATE_TONE: Record<string, Tone> = { booting: 'info', running: 'ok', draining: 'warn', deleted: 'neutral' };
const UNMATCHED_KIND: Record<Unmatched['kind'], string> = {
  worker_no_parent: 'Worker without a live orchestrator', orch_no_row: 'Orchestrator name with no row', image_builder: 'Image builder', other_prefix: 'Another deployment'
};
/** Boot phases in launch order, as launchOrchestrator marks them (ms since the create call). */
const PHASES: { key: string; label: string }[] = [
  { key: 'created', label: 'Create' }, { key: 'ready', label: 'Ready' }, { key: 'code', label: 'Code' },
  { key: 'configured', label: 'Configured' }, { key: 'preflight', label: 'Preflight' }, { key: 'started', label: 'Started' }
];
const LIMIT = 200;

const logsCommand = (id: string) => `npm run boat-orchestrators -- logs ${id}`;
const copyLogs = (id: string) => copyText(logsCommand(id), 'Logs command copied. Logs are lost when the sandbox is deleted.');
const hbAge = (o: OrchRow) => (o.state === 'deleted' ? null : since(o.heartbeat_at));
/** Why an ended row ended, as the Ended because cell words it: the failed launch step and error, else the reap reason. */
const endedText = (o: OrchRow) => (o.launch_step ? `${o.launch_step}: ${o.launch_error ?? ''}` : o.reap_reason ?? '');
const workersText = (o: OrchRow) => Object.entries(o.running_by_agent).map(([a, k]) => `${a} ${k}`).join(' · ');
/** Amber: booting past the boot limit, or a running one with no check-in for 90 s. */
const lateOf = (o: OrchRow, l: Limits) => (o.state === 'booting' && (since(o.created_at) ?? 0) > l.boot_minutes * 60)
  || (o.state === 'running' && (hbAge(o) ?? Infinity) > l.heartbeat_stale_s);

/** The Orchestrators section. `verdict` (from the summary) explains an empty Live list when the autoscaler is off. */
export function ComputeOrchestrators({ verdict, summary }: { verdict: Verdict[]; summary?: ReactNode }) {
  const url = useComputeParams();
  useNow(15_000);
  // Its own job filter (ojob): Sessions' job_id narrows Sessions only.
  const state = url.get('state') ?? 'live', job = url.get('ojob'), reason = url.get('oreason');
  const open = url.get('orch');
  const unmatched = state === 'unmatched';
  const qs = new URLSearchParams({ state, limit: String(LIMIT), ...(job && !unmatched ? { job_id: job } : {}), ...(reason && !unmatched ? { reason } : {}) });
  const [pinned, setPinned] = useState<string | null>(null);
  if (pinned) qs.set('include', pinned);
  const { data, error, isLoading, refetch } = useAdmin<{ total: number; boat: Boat; limits: Limits; facets?: Record<string, number>; rows: (OrchRow | Unmatched)[] }>(
    `/compute/orchestrators?${qs}`, { refetchInterval: open ? undefined : 30_000, keep: true });
  // `keep` shows the last chip's rows while the next loads: only use rows of the shape this chip asks for.
  const fits = !!data && (data.rows.length === 0 || ('kind' in data.rows[0]) === unmatched);
  const rows = useMemo(() => (fits ? data!.rows : []), [fits, data]);
  const pin = nextPinned(unmatched ? null : open, unmatched || !fits ? undefined : (data!.rows as OrchRow[]).map((r) => String(r.id)), pinned);
  if (pin !== pinned) setPinned(pin);
  useScrollTo('orchestrators', !!data);
  const limits: Limits = data?.limits ?? { boot_minutes: 10, stale_minutes: 5, heartbeat_stale_s: 90 };
  const setState = (id: string) => url.write({ state: id === 'live' ? null : id, orch: null, oreason: null });

  const off = verdict.find((v) => v.code === 'autoscale_off' || v.code === 'kick_unconfigured');
  const filtered = !unmatched && !!(job || reason);
  const empty = filtered ? 'No orchestrators match these filters.'
    : state === 'live' ? (off ? off.text : 'No orchestrators running. One launches when a job queues work.')
    : unmatched ? (data?.boat.ok === false ? `boat.dev did not answer: ${data.boat.error}` : 'Every sandbox on boat matches a live orchestrator of ours.')
    : 'No orchestrators in this state.';

  // State, and the job or reason a link narrowed to (shown only when set), sit on the search row.
  const filters = (
    <>
      <NativeSelect aria-label='Orchestrator state' value={state} onChange={(e) => setState(e.target.value)}>
        {CHIPS.map((c) => <NativeSelectOption key={c.id} value={c.id}>{counted(c.label, data?.facets ? data.facets[c.id] ?? 0 : undefined)}</NativeSelectOption>)}
      </NativeSelect>
      {job && !unmatched && <Button variant='outline' onClick={() => url.write({ ojob: null })} title='Show every job'><Mono>{job}</Mono><Icons.close /></Button>}
      {reason && !unmatched && <Button variant='outline' onClick={() => url.write({ oreason: null })} title='Show every reason'>{reason.replace(/^(launch|reap):/, '$1: ').replace(/_/g, ' ')}<Icons.close /></Button>}
      {data && (!data.boat.ok || data.boat.stale) && (
        <span className={cn('text-xs', AMBER)} title={data.boat.error ?? undefined}>{data.boat.ok ? 'boat.dev is slow: last answer shown' : 'boat.dev did not answer'}</span>
      )}
    </>
  );
  return (
    <div id='compute-orchestrators-anchor' className='flex min-w-0 flex-col gap-3'>
      {error && !data && (
        <div role='alert' className='border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-3 rounded-lg border px-4 py-3 text-sm'>
          <span className='min-w-0 flex-1'>Could not load orchestrators: {error.message}</span>
          <Button variant='outline' size='xs' onClick={() => void refetch()}>Retry</Button>
        </div>
      )}
      {unmatched
        ? <UnmatchedTable rows={rows as Unmatched[]} loading={isLoading || !fits} empty={empty} filters={filters} summary={summary} />
        : <OrchTable rows={rows as OrchRow[]} loading={(isLoading && !data) || !fits} limits={limits} boat={data?.boat ?? null} empty={empty} filters={filters} summary={summary}
            open={open} onOpen={(k) => url.write({ orch: k, ...(k ? {} : { back: null }) })} onJob={(j) => url.write({ ...jobSessions(j), orch: null })} />}
    </div>
  );
}

function OrchTable({ rows, loading, limits, boat, empty, open, onOpen, onJob, filters, summary }: {
  rows: OrchRow[]; loading: boolean; limits: Limits; boat: Boat | null; empty: string; open: string | null; onOpen: (k: string | null) => void; onJob: (job: string) => void;
  filters: ReactNode; summary?: ReactNode;
}) {
  const boatNA = (v: ReactNode) => (boat && !boat.ok ? <span className='text-muted-foreground' title={`boat.dev did not answer: ${boat.error}`}>—</span> : v);
  const cols: RecordCol<OrchRow>[] = [
    { key: 'orch', label: 'Orchestrator', title: true, keep: true, type: 'text', value: (o) => o.orchestrator_id ?? `row ${o.id}`,
      // The sandbox id moves to a tooltip once there is an orchestrator id; rows without one (failed launches, 'row N') keep it as a line.
      render: (o) => (
        <span className='flex min-w-0 flex-col gap-1'>
          <span className='truncate font-medium' title={o.orchestrator_id && o.sandbox_id ? `Sandbox ${o.sandbox_id}` : undefined}>{o.orchestrator_id ?? `row ${o.id}`}</span>
          {!o.orchestrator_id && o.sandbox_id && <Mono>{o.sandbox_id}</Mono>}
        </span>
      ) },
    { key: 'state', label: 'State', className: 'max-w-72', keep: true, type: 'select', value: (o) => o.state, render: (o) => {
      const late = lateOf(o, limits), ended = o.state === 'deleted', why = endedText(o);
      const at = o.state_since ? new Date(o.state_since).toLocaleString() : undefined;
      return (
        <span className='flex min-w-0 flex-col gap-1'>
          <span className='flex items-center gap-1.5'><StatusBadge tone={o.state === 'deleted' && o.launch_step ? 'bad' : STATE_TONE[o.state]}>{o.state === 'deleted' ? 'ended' : o.state}</StatusBadge>
            {o.boat_state && o.state !== 'deleted' && <span className='text-muted-foreground text-xs' title='State on boat'>boat: {o.boat_state}</span>}</span>
          <span className={cn('truncate text-xs', late ? AMBER : 'text-muted-foreground')} title={ended && why ? [at, why].filter(Boolean).join(' · ') : at}>
            {ended ? 'ended ' : 'for '}{dur(since(o.state_since))}{ended ? ' ago' : ''}
            {ended && why && <> · <span className={cn(o.launch_step && 'text-destructive')}>{why}</span></>}
          </span>
        </span>
      );
    } },
    { key: 'job', label: 'Job', type: 'text', value: (o) => o.job_id ?? 'shared', render: (o) => (o.job_id ? <Mono>{o.job_id}</Mono> : <span className='text-muted-foreground'>shared</span>) },
    // Off by default (the reason is State's second line); kept for its end-reason filter.
    { key: 'ended', label: 'Ended because', hidden: true, className: 'max-w-72', type: 'text', value: (o) => o.end_class?.label ?? '', render: (o) => <EndedBecause o={o} /> },
    { key: 'pods', label: 'Pods', className: 'text-right', type: 'number', value: (o) => o.running, render: (o) => (
      <span className='flex flex-col items-end gap-1' title='Pods used / reserved, then workers by agent'>
        <span className='tabular-nums'>{o.running} <span className='text-muted-foreground'>/ {o.pods}</span></span>
        {o.running > 0 && <span className='text-muted-foreground text-xs'>{workersText(o)}</span>}
      </span>
    ) },
    { key: 'heartbeat', label: 'Heartbeat', type: 'number', value: (o) => hbAge(o), render: (o) => {
      const age = hbAge(o);
      if (o.state === 'deleted') return <span className='text-muted-foreground'>—</span>;
      return <span className={cn('tabular-nums', age == null ? 'text-muted-foreground' : age > limits.stale_minutes * 60 ? 'text-destructive' : age > limits.heartbeat_stale_s ? AMBER : undefined)}
        title={o.heartbeat_at ? new Date(o.heartbeat_at).toLocaleString() : 'Has not checked in'}>{age == null ? 'never' : `${dur(age)} ago`}</span>;
    } },
    { key: 'boot', label: 'Boot', className: 'text-right', type: 'number', hidden: true, value: (o) => o.boot_ms, render: (o) => (
      <span className='inline-flex items-center justify-end gap-1.5 tabular-nums' title={phasesText(o.timings)}>
        {o.from_image && <Chip title={o.from_image}>image</Chip>}{o.boot_ms == null ? <span className='text-muted-foreground'>—</span> : dur(o.boot_ms / 1000)}
      </span>
    ) },
    { key: 'spend', label: 'Model spend', className: 'text-right', type: 'number', hidden: true, value: (o) => o.spend.orchestrator_model_usd, render: (o) => (
      <span className='tabular-nums' title='Orchestrator model spend through the gateway (its lifetime)'>{cents(o.spend.orchestrator_model_usd)}</span>
    ) }
  ];
  return (
    <RecordView id='compute-orchestrators' rows={rows} loading={loading} rowKey={(o) => String(o.id)} cols={cols} noun='orchestrators' initialSize={25}
      searchText={(o) => `${o.orchestrator_id ?? ''} ${o.sandbox_id ?? ''} ${o.job_id ?? 'shared'} ${o.state} ${workersText(o)} ${o.end_class?.label ?? ''} ${endedText(o)} ${o.code_hash ?? ''}`}
      searchPlaceholder='Search orchestrators, sandboxes, jobs, reasons' exportName='compute-orchestrators' filters={filters} summary={summary} compact
      openKey={open} onOpenChange={onOpen}
      actions={(o) => [
        ...(o.sandbox_id ? [{ label: 'Copy logs command', icon: <Icons.code />, onSelect: () => copyLogs(o.sandbox_id!) }] : []),
        ...(o.sandbox_id ? [{ label: 'Copy sandbox id', icon: <Icons.page />, onSelect: () => copyText(o.sandbox_id!, 'Sandbox id copied') }] : []),
        ...(o.job_id ? [{ label: "Show this job's sessions", icon: <Icons.search />, onSelect: () => onJob(o.job_id!) }] : []),
        { label: 'Copy id', icon: <Icons.page />, onSelect: () => copyText(o.orchestrator_id ?? o.sandbox_id ?? String(o.id), 'Id copied') }
      ]}
      detailTitle={(o) => <span className='flex items-center gap-2'>{o.orchestrator_id ?? `row ${o.id}`}<StatusBadge tone={STATE_TONE[o.state]}>{o.state === 'deleted' ? 'ended' : o.state}</StatusBadge></span>}
      detail={(o) => <OrchPeek id={o.id} onJob={onJob} />}
      empty={empty} />
  );
}

function EndedBecause({ o }: { o: OrchRow }) {
  if (o.launch_step) return <span className='text-destructive line-clamp-2 text-xs' title={o.launch_error ?? undefined}>{o.launch_step}: {o.launch_error}</span>;
  if (o.reap_reason) return <span className={cn('line-clamp-2 text-xs', o.end_class?.routine && 'text-muted-foreground')} title={o.reap_reason}>{o.reap_reason}</span>;
  return null;
}

const phasesText = (t: Record<string, number> | null) =>
  t ? PHASES.filter((p) => t[p.key] != null).map((p) => `${p.label} ${dur(t[p.key] / 1000)}`).join(' → ') : undefined;

/** Unmatched on boat: boat's live sandboxes that match no live orchestrator row of ours. Read only. */
function UnmatchedTable({ rows, loading, empty, filters, summary }: { rows: Unmatched[]; loading: boolean; empty: string; filters: ReactNode; summary?: ReactNode }) {
  const cols: RecordCol<Unmatched>[] = [
    { key: 'name', label: 'Name', title: true, keep: true, type: 'text', value: (u) => u.name ?? '',
      render: (u) => <span className='flex min-w-0 flex-col gap-1'><span className='truncate'>{u.name ?? <span className='text-muted-foreground'>(unnamed)</span>}</span><Mono>{u.sandbox_id}</Mono></span> },
    { key: 'kind', label: 'Kind', keep: true, type: 'select', value: (u) => UNMATCHED_KIND[u.kind],
      render: (u) => <span className='flex min-w-0 flex-col gap-1'><span>{UNMATCHED_KIND[u.kind]}</span>{u.parent_orchestrator_id && <span className='text-muted-foreground text-xs'><Mono>{u.parent_orchestrator_id}</Mono></span>}</span> },
    // Off by default (Kind's second line, set only for workers with no parent); kept for its filter.
    { key: 'parent', label: 'Parent orchestrator', hidden: true, type: 'text', value: (u) => u.parent_orchestrator_id ?? '', render: (u) => (u.parent_orchestrator_id ? <Mono>{u.parent_orchestrator_id}</Mono> : <span className='text-muted-foreground'>—</span>) },
    { key: 'age', label: 'Age', className: 'text-right', type: 'number', value: (u) => since(u.created_at), render: (u) => (
      <span className='flex flex-col items-end gap-1'>
        <span className='tabular-nums'>{dur(since(u.created_at))}</span>
        <span className='text-muted-foreground text-xs tabular-nums'>{dur(u.ttl_left_s)} left</span>
      </span>
    ) },
    // Off by default; kept for filtering and grouping by boat's state.
    { key: 'boat', label: 'boat state', hidden: true, type: 'select', value: (u) => u.boat_state, render: (u) => u.boat_state },
    // Off by default (Age's second line); kept for sorting by time left.
    { key: 'ttl', label: 'TTL left', hidden: true, className: 'text-right', type: 'number', value: (u) => u.ttl_left_s, render: (u) => <span className='tabular-nums'>{dur(u.ttl_left_s)}</span> }
  ];
  return (
    <RecordView id='compute-unmatched' rows={rows} loading={loading} rowKey={(u) => u.sandbox_id} cols={cols} noun='sandboxes' initialSize={25}
      searchText={(u) => `${u.name ?? ''} ${u.sandbox_id} ${UNMATCHED_KIND[u.kind]} ${u.parent_orchestrator_id ?? ''}`} searchPlaceholder='Search sandboxes on boat'
      actions={(u) => [{ label: 'Copy id', icon: <Icons.page />, onSelect: () => copyText(u.sandbox_id, 'Sandbox id copied') }]}
      exportName='compute-unmatched' empty={empty} filters={filters} summary={summary} compact />
  );
}

/** One orchestrator's peek: summary, boot timeline, workers now, recent sessions, tokens, events, spend, links. */
function OrchPeek({ id, onJob }: { id: number; onJob: (job: string) => void }) {
  const url = useComputeParams();
  const { data, error, isLoading } = useAdmin<OrchDetail>(`/compute/orchestrators/${id}`);
  if (isLoading) return <div className='grid gap-3'><Skeleton className='h-24' /><Skeleton className='h-40' /></div>;
  if (!data) return <ErrorBox error={error} />;
  const o = data.row;
  const openSession = (sid: string) => url.write({ section: 'sessions', session: sid, orch: null });
  // Opened from a job's peek: back returns to it.
  const back = url.get('back');
  return (
    <div className='grid gap-6'>
      {back && <Button variant='ghost' size='xs' className='justify-self-start' onClick={() => url.write({ section: 'jobs', job: back, orch: null, back: null })}>← Back to <Mono>{back}</Mono></Button>}
      <PeekSection title='Summary'>
        <dl>
          <Field label='State'>{o.state === 'deleted' ? 'ended' : o.state}{o.boat_state && <span className='text-muted-foreground'> · boat: {o.boat_state}</span>}</Field>
          <Field label='Job'>{o.job_id ? <Mono>{o.job_id}</Mono> : <span className='text-muted-foreground'>shared</span>}</Field>
          <Field label='Sandbox'>{o.sandbox_id ? <Mono>{o.sandbox_id}</Mono> : <span className='text-muted-foreground'>never created</span>}</Field>
          <Field label='Created'><When d={o.created_at} /></Field>
          <Field label='Ready'>{o.ready_at ? <When d={o.ready_at} /> : <span className='text-muted-foreground'>—</span>}</Field>
          <Field label='Last seen'><When d={o.heartbeat_at} /></Field>
          {o.deleted_at && <Field label='Ended'><When d={o.deleted_at} /></Field>}
          <Field label='TTL left'>{o.state === 'deleted' ? 'n/a' : data.boat.ok ? dur(o.ttl_left_s) : <span className='text-muted-foreground' title={`boat.dev did not answer: ${data.boat.error}`}>—</span>}</Field>
          <Field label='Code'>{o.code_hash ? <Mono>{o.code_hash.slice(0, 12)}</Mono> : '—'} {o.current_code ? <span className='text-muted-foreground'>· current</span> : o.code_hash && <span className='text-muted-foreground'>· older than this server&apos;s</span>}
            {o.retiring_since && <span className={AMBER}> · retiring since <When d={o.retiring_since} /></span>}</Field>
          <Field label='From image'>{o.from_image ? <Mono>{o.from_image}</Mono> : <span className='text-muted-foreground'>no (code upload)</span>}</Field>
          {(o.launch_step || o.reap_reason) && <Field label='Ended because'><EndedBecause o={o} /></Field>}
        </dl>
      </PeekSection>

      <PeekSection title='Boot'>
        <BootTimeline o={o} timings={data.timings} />
      </PeekSection>

      <PeekSection title={`Workers now (${data.workers.length})`}>
        {!data.boat.ok ? <p className='text-muted-foreground text-sm'>boat.dev did not answer: {data.boat.error}</p>
          : data.workers.length ? (
            <MiniTable head={['Agent', 'Session', 'Status', 'Heartbeat', 'boat']} rows={data.workers.map((w) => [
              w.agent_id ?? '—',
              w.session_id ? <button key='s' type='button' className='hover:underline' onClick={() => openSession(w.session_id!)}><Mono>{w.session_id}</Mono></button> : <span key='s' className='text-muted-foreground'>idle</span>,
              w.status ?? '—', w.heartbeat_age_s == null ? '—' : `${dur(w.heartbeat_age_s)} ago`, w.boat_state])} />
          ) : <p className='text-muted-foreground text-sm'>No worker sandboxes on boat for it.</p>}
      </PeekSection>

      <PeekSection title='Recent sessions on it'>
        {data.sessions.length ? (
          <MiniTable head={['Session', 'Agent', 'Status', 'Started', 'Error']} rows={data.sessions.map((s) => [
            <button key='s' type='button' className='hover:underline' onClick={() => openSession(s.id)}><Mono>{s.id}</Mono></button>,
            s.agent_id ?? '—', s.status, <When key='t' d={s.started_at} />, <span key='e' className='text-muted-foreground line-clamp-1' title={s.error_message ?? undefined}>{s.error_message ?? ''}</span>])} />
        ) : <p className='text-muted-foreground text-sm'>No sessions.</p>}
      </PeekSection>

      {data.tokens.length > 0 && (
        <PeekSection title='Worker tokens'>
          <MiniTable head={['Job', 'Issued', 'Expires', 'Revoked']} rows={data.tokens.map((t) => [
            <Mono key='j'>{t.job_id}</Mono>, <When key='c' d={t.created_at} />, <When key='x' d={t.expires_at} />,
            t.revoked_at ? <When key='r' d={t.revoked_at} /> : <span key='r' className='text-muted-foreground'>not revoked</span>])} />
        </PeekSection>
      )}

      <PeekSection title='Events'>
        {data.events.length ? (
          <MiniTable head={['When', 'What', 'Detail']} rows={data.events.map((e) => [
            <When key='a' d={e.at} />, e.kind.replace(/_/g, ' '), <span key='d' className='text-muted-foreground'>{[e.step, e.reason, e.actor && `by ${e.actor}`].filter(Boolean).join(' · ')}</span>])} />
        ) : <p className='text-muted-foreground text-sm'>No events recorded.</p>}
      </PeekSection>

      <PeekSection title='Spend'>
        <dl>
          <Field label='Orchestrator model'>{cents(o.spend.orchestrator_model_usd)}</Field>
        </dl>
        {data.gateway.length > 0 && (
          <MiniTable head={['Provider', 'Requests', 'Errors', 'Tokens in / out', 'Cost']} rows={data.gateway.map((g) => [
            <Mono key='p'>{g.provider}</Mono>, g.requests, g.errors ? <span key='e' className='text-destructive'>{g.errors}</span> : 0,
            `${g.input_tokens.toLocaleString()} / ${g.output_tokens.toLocaleString()}`, cents(g.cost_usd)])} />
        )}
      </PeekSection>

      <PeekSection title='Links'>
        <div className='flex flex-wrap gap-2'>
          {o.job_id && <Button variant='outline' size='sm' onClick={() => onJob(o.job_id!)}><Icons.search /> This job&apos;s sessions</Button>}
          {data.logs_command && <Button variant='outline' size='sm' onClick={() => copyLogs(o.sandbox_id!)}><Icons.code /> Copy logs command</Button>}
        </div>
        {data.logs_command && <p className='text-muted-foreground text-xs'><Mono>{data.logs_command}</Mono> · logs are lost when the sandbox is deleted.</p>}
      </PeekSection>
    </div>
  );
}

/** create → ready → code → configured → preflight → started, each bar its share of the boot; a failed launch is one red bar. */
function BootTimeline({ o, timings }: { o: OrchRow; timings: Record<string, number> }) {
  if (o.launch_step) {
    const lasted = since(o.created_at, o.deleted_at);
    return (
      <div className='grid gap-1.5'>
        <div className='bg-destructive h-2 rounded-full' />
        <p className='text-destructive text-sm'>Failed at {o.launch_step}{lasted != null ? ` after ${dur(lasted)}` : ''}: {o.launch_error}</p>
      </div>
    );
  }
  const marks = PHASES.filter((p) => timings[p.key] != null).map((p) => ({ ...p, at: timings[p.key] }));
  if (!marks.length) return <p className='text-muted-foreground text-sm'>{o.state === 'booting' ? `Booting for ${dur(since(o.created_at))}.` : 'No boot timings recorded.'}</p>;
  const total = marks.at(-1)!.at || 1;
  const parts = marks.map((m, i) => ({ ...m, ms: m.at - (i ? marks[i - 1].at : 0) }));
  return (
    <div className='grid gap-2'>
      <div className='bg-muted flex h-2 overflow-hidden rounded-full'>
        {parts.map((p, i) => <div key={p.key} className={cn(i % 2 ? 'bg-primary/55' : 'bg-primary')} style={{ width: `${(p.ms / total) * 100}%` }} title={`${p.label}: ${dur(p.ms / 1000)}`} />)}
      </div>
      <ol className='text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs'>
        {parts.map((p) => <li key={p.key}><span className='text-foreground'>{p.label}</span> {dur(p.ms / 1000)}</li>)}
        <li>Total {dur(total / 1000)}{o.from_image ? ' (from image)' : ''}</li>
      </ol>
      {o.state === 'booting' && <Notice tone='info'>Still booting.</Notice>}
    </div>
  );
}
