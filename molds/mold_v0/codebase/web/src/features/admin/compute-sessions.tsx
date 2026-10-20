'use client';
// Compute › Sessions (GET /compute/sessions, src/compute-records.ts): every agent session across accounts, with why
// it failed (src/error-classes.ts) and a peek with its timing, run, infrastructure, spend, the fix for its failure
// class and the last transcript events. Status, range, failure class, job and "heartbeat older than 5 min" are asked
// of the server (and kept in the URL, so Health and the verdict deep-link here); the rest filter the rows shown.
// Read only apart from Cancel (a row action and a peek button, behind a confirm): POST /compute/sessions/:id/cancel,
// in the admin log. A running session's sandbox stops when its orchestrator next heartbeats.
import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MultiSelectFilter } from '@/components/layout/multi-select-filter';
import { Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { Button, buttonVariants } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { counted } from '@/lib/octillion-format';
import { cn } from '@/lib/utils';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { post, useAdmin, useAdminAction } from './lib';
import { Gate, useAdminRole } from './role';
import { copyText, ErrorBox, Mono, Notice, StatusBadge, When, type Tone } from './ui';
import { AMBER, Chip, cents, dur, jobSessions, PeekSection, SectionLink, since, useComputeParams, useNow, nextPinned, useScrollTo } from './compute-common';
import { SessionsStats } from './compute-stats';

export interface SessionRow {
  id: string; simulation_id: string; org: { slug: string; name: string }; agent_id: string | null; harness: string; model: string; status: string;
  attempt: number; infra_retries: number; queued_at: string; started_at: string | null; heartbeat_at: string | null; ended_at: string | null;
  completed_reason: string | null; error_class: string | null; error_label: string | null; error_message: string | null;
  worker_id: string | null; sandbox_id: string | null; cost_usd: number; sandbox_est_usd: number | null;
}
export interface Runnable { agent_id: string; harness: string; has_setup_script: boolean; missing_env: string[]; runnable: boolean; reason: string }
interface SessionDetail {
  session: SessionRow & { tokens_in: number; tokens_out: number };
  metadata: Record<string, unknown>;
  gateway: { provider: string; requests: number; errors: number; input_tokens: number; output_tokens: number; cost_usd: number; last_at: string | null }[];
  hint: { text: string; href: string } | null;
  runnable: Runnable | null;
  transcript: { seq: number; ts: string; type: string; text: string }[];
  orchestrator: { id: number; orchestrator_id: string | null } | null;
}

const DEFAULT_STATUS = ['queued', 'running', 'failed', 'timeout'];
/** Statuses a session can be cancelled from. */
const OPEN = ['queued', 'running'];
const STATUS_OPTS = ['queued', 'running', 'completed', 'failed', 'timeout', 'cancelled'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));
const STATUS_TONE: Record<string, Tone> = { queued: 'info', running: 'ok', completed: 'neutral', failed: 'bad', timeout: 'warn', cancelled: 'neutral' };
const CLASSES: { key: string; label: string }[] = [
  { key: 'unclaimable', label: 'Agent not scheduled' }, { key: 'credentials', label: 'Missing provider key' }, { key: 'harness_install', label: 'Harness install failed' },
  { key: 'gateway_token', label: 'Gateway token expired' }, { key: 'boat_permission', label: 'boat key not allowed' }, { key: 'boat_capacity', label: 'boat rate limit or capacity' },
  { key: 'sandbox_boot', label: 'Sandbox not ready' }, { key: 'sandbox_prepare', label: 'Sandbox setup failed' }, { key: 'heartbeat', label: 'Lost heartbeat' },
  { key: 'time_cap', label: 'Hit time limit' }, { key: 'shutdown', label: 'Worker shut down' }, { key: 'agent', label: 'Agent stopped' }, { key: 'other', label: 'Other' }
];
const SORT_LABEL: Record<string, string> = { recent: 'Latest activity', queued_at: 'Waiting longest', wait: 'Longest wait', ended_at: 'Ended last' };
/** Rows asked for at once; the table pages them 50 at a time. */
const LIMIT = 500;
const HEARTBEAT_AMBER_S = 5 * 60;

const waitOf = (s: SessionRow) => since(s.queued_at, s.started_at);
const runOf = (s: SessionRow) => (s.started_at ? since(s.started_at, s.ended_at) : null);
const outcomeOf = (s: SessionRow) => s.error_label ?? s.completed_reason?.replace(/_/g, ' ') ?? '';
const firstLine = (t: string | null) => (t ?? '').split('\n')[0];

/** The Sessions section: filters in the URL, a peek per session (?session=<id>). */
export function ComputeSessions() {
  const { lock } = useAdminRole();
  const url = useComputeParams();
  const router = useRouter();
  useNow(15_000);
  const status = url.has('status') ? (url.get('status') ?? '').split(',').filter(Boolean) : DEFAULT_STATUS;
  const range = url.get('since') ?? '24h', cls = url.get('class'), job = url.get('job_id'), stale = url.get('stale') === '1';
  const sort = url.get('sort') ?? 'recent';
  const open = url.get('session');
  const qs = new URLSearchParams({ limit: String(LIMIT), since: range, sort, ...(status.length ? { status: status.join(',') } : {}),
    ...(cls ? { class: cls } : {}), ...(job ? { job_id: job } : {}), ...(stale ? { stale_heartbeat: '1' } : {}) });
  const [pinned, setPinned] = useState<string | null>(null);
  if (pinned) qs.set('include', pinned);
  // Refresh every 30 s, paused while a record is open (and, as every query, while the tab is hidden).
  const { data: shown, error, isLoading, refetch } = useAdmin<{ total: number; facets?: Record<'status' | 'class' | 'stale', Record<string, number>>; rows: SessionRow[] }>(`/compute/sessions?${qs}`, { refetchInterval: open ? undefined : 30_000, keep: true });
  const rows = useMemo(() => shown?.rows ?? [], [shown]);
  const pin = nextPinned(open, shown?.rows.map((r) => r.id), pinned);
  if (pin !== pinned) setPinned(pin);
  useScrollTo('sessions', !!shown);
  const [cancelling, setCancelling] = useState<SessionRow | null>(null);
  const cancel = useAdminAction((id: string) => post<{ message: string }>(`/compute/sessions/${encodeURIComponent(id)}/cancel`), { success: (r) => r.message });

  const cols: RecordCol<SessionRow>[] = [
    { key: 'id', label: 'Session', title: true, keep: true, type: 'text', value: (s) => s.id, render: (s) => <Mono>{s.id}</Mono> },
    { key: 'job', label: 'Job', type: 'text', value: (s) => s.simulation_id,
      render: (s) => <span className='flex min-w-0 flex-col gap-1'><Mono>{s.simulation_id}</Mono><span className='text-muted-foreground truncate text-xs'>{s.org.name}</span></span> },
    { key: 'agent', label: 'Agent', type: 'select', value: (s) => s.agent_id ?? '',
      render: (s) => <span className='flex min-w-0 flex-col gap-1'><span className='truncate'>{s.agent_id ?? '—'}</span><span className='text-muted-foreground text-xs'>{s.harness}</span></span> },
    { key: 'status', label: 'Status', keep: true, type: 'select', value: (s) => s.status, options: STATUS_OPTS,
      render: (s) => (
        <span className='flex flex-wrap items-center gap-1.5'>
          <StatusBadge tone={STATUS_TONE[s.status]}>{s.status}</StatusBadge>
          {s.attempt > 1 && <span className='text-muted-foreground text-xs' title='Repeat number within the run'>attempt {s.attempt}</span>}
          {s.infra_retries > 0 && <Chip tone='warn' title={`Queued again ${s.infra_retries}× after an infrastructure failure`}>infra retry</Chip>}
        </span>
      ) },
    // Off by default (Time's second line, or its first while queued); the server's "Longest wait" order sorts by it.
    { key: 'wait', label: 'Wait', hidden: true, className: 'text-right', type: 'number', value: (s) => waitOf(s),
      render: (s) => <span className='tabular-nums' title={`Queued ${new Date(s.queued_at).toLocaleString()}`}>{dur(waitOf(s))}</span> },
    { key: 'run', label: 'Time', className: 'text-right', type: 'number', value: (s) => runOf(s), render: (s) => <RunTime s={s} /> },
    { key: 'outcome', label: 'Outcome', type: 'select', value: outcomeOf, render: (s) => (
      <span className='flex min-w-0 flex-col items-start gap-1'>
        {s.error_label ? <StatusBadge tone={s.error_class === 'unclaimable' ? 'warn' : 'bad'}>{s.error_label}</StatusBadge>
          : s.completed_reason ? <span>{s.completed_reason.replace(/_/g, ' ')}</span> : <span className='text-muted-foreground'>—</span>}
        {s.error_message && <span className='text-muted-foreground line-clamp-1 text-xs' title={s.error_message}>{firstLine(s.error_message)}</span>}
      </span>
    ) },
    // Off by default (Outcome's second line); turn it on to export the error message.
    { key: 'error', label: 'Error', hidden: true, className: 'max-w-80', type: 'text', value: (s) => s.error_message ?? '',
      render: (s) => s.error_message ? <span className='text-muted-foreground line-clamp-1 text-xs' title={s.error_message}>{firstLine(s.error_message)}</span> : null },
    { key: 'cost', label: 'Model cost', className: 'text-right', type: 'number', value: (s) => s.cost_usd, render: (s) => <span className='tabular-nums'>{cents(s.cost_usd)}</span> }
  ];

  const set = (patch: Record<string, string | null>) => url.write({ ...patch, session: null });
  // Sessions each choice matches under the other filters (the server's facets); "" is the dropdown's "any".
  const fc = (k: 'status' | 'class' | 'stale', v: string) => (shown?.facets ? shown.facets[k][v] ?? 0 : undefined);
  const filters = (
    <>
      <MultiSelectFilter noun='statuses' options={STATUS_OPTS.map((o) => ({ ...o, count: fc('status', o.value) }))} value={status} onChange={(v) => set({ status: v.length ? v.join(',') : '' })} />
      <NativeSelect aria-label='Range' value={range} onChange={(e) => set({ since: e.target.value === '24h' ? null : e.target.value })}>
        <NativeSelectOption value='1h'>Last hour</NativeSelectOption>
        <NativeSelectOption value='24h'>Last 24 h</NativeSelectOption>
        <NativeSelectOption value='7d'>Last 7 days</NativeSelectOption>
      </NativeSelect>
      <NativeSelect aria-label='Failure class' value={cls ?? ''} onChange={(e) => set({ class: e.target.value || null })}>
        <NativeSelectOption value=''>{counted('Any failure class', fc('class', ''))}</NativeSelectOption>
        {CLASSES.map((c) => <NativeSelectOption key={c.key} value={c.key}>{counted(c.label, fc('class', c.key))}</NativeSelectOption>)}
      </NativeSelect>
      <NativeSelect aria-label='Order' value={sort} onChange={(e) => set({ sort: e.target.value === 'recent' ? null : e.target.value })}>
        {Object.entries(SORT_LABEL).map(([k, v]) => <NativeSelectOption key={k} value={k}>{v}</NativeSelectOption>)}
      </NativeSelect>
      <NativeSelect aria-label='Heartbeat' value={stale ? '1' : ''} onChange={(e) => set({ stale: e.target.value || null })} title='Running sessions with no heartbeat for 5 minutes'>
        <NativeSelectOption value=''>{counted('Any heartbeat', fc('stale', ''))}</NativeSelectOption>
        <NativeSelectOption value='1'>{counted('No heartbeat for 5 min', fc('stale', '1'))}</NativeSelectOption>
      </NativeSelect>
      {job && <Button variant='outline' onClick={() => set({ job_id: null })} title='Show every job'><Mono>{job}</Mono><Icons.close /></Button>}
    </>
  );

  return (
    <div id='compute-sessions-anchor' className='flex min-w-0 flex-col gap-3'>
      {error && !shown && (
        <div role='alert' className='border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-3 rounded-lg border px-4 py-3 text-sm'>
          <span className='min-w-0 flex-1'>Could not load sessions: {error.message}</span>
          <Button variant='outline' size='xs' onClick={() => void refetch()}>Retry</Button>
        </div>
      )}
      <RecordView id='compute-sessions' summary={<SessionsStats />} rows={rows} loading={isLoading && !shown} rowKey={(s) => s.id} cols={cols} noun='sessions' initialSize={50}
        searchText={(s) => `${s.id} ${s.simulation_id} ${s.org.name} ${s.org.slug} ${s.agent_id ?? ''} ${s.harness} ${s.model} ${s.status} ${outcomeOf(s)} ${s.error_message ?? ''} ${s.worker_id ?? ''} ${s.sandbox_id ?? ''}`}
        searchPlaceholder='Search sessions, jobs, agents, errors' filters={filters} exportName='compute-sessions'
        openKey={open} onOpenChange={(k) => url.write({ session: k })}
        actions={(s) => [
          ...(OPEN.includes(s.status) ? [lock({ label: 'Cancel session', icon: <Icons.close />, onSelect: () => setCancelling(s) }, 'compute')] : []),
          { label: 'Copy id', icon: <Icons.page />, onSelect: () => copyText(s.id, 'Session id copied') },
          { label: "Show this job's sessions", icon: <Icons.search />, onSelect: () => url.write(jobSessions(s.simulation_id)) },
          { label: 'Open account', icon: <Icons.externalLink />, onSelect: () => router.push(`/admin/accounts/${encodeURIComponent(s.org.slug)}`) }
        ]}
        detailTitle={(s) => <span className='flex items-center gap-2'><Mono>{s.id}</Mono><StatusBadge tone={STATUS_TONE[s.status]}>{s.status}</StatusBadge></span>}
        detail={(s) => <SessionPeek id={s.id} onJob={() => url.write(jobSessions(s.simulation_id))} onCancel={(x) => setCancelling(x)} cancelling={cancel.isPending} />}
        empty={shown && shown.total > rows.length ? `No match among the ${rows.length} most relevant of ${shown.total} sessions; narrow the filters.` : 'No sessions match these filters.'} compact />
      <AlertDialog open={!!cancelling} onOpenChange={(o) => !o && setCancelling(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel session {cancelling?.id}?</AlertDialogTitle>
            <AlertDialogDescription>
              Stops this session. A running sandbox is killed when its orchestrator next heartbeats. The rest of the job carries on. Your name goes in the admin log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={() => { if (cancelling) cancel.mutate(cancelling.id); setCancelling(null); }}>Cancel session</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Time: ended − started, and how long it waited to start; while queued, the wait so far (amber); while running, the
 * elapsed time and the heartbeat's age (amber past 5 min).
 */
function RunTime({ s }: { s: SessionRow }) {
  const run = runOf(s);
  if (run == null) return s.status === 'queued'
    ? <span className={cn('tabular-nums', AMBER)} title={`Queued ${new Date(s.queued_at).toLocaleString()}`}>queued {dur(waitOf(s))}</span>
    : <span className='text-muted-foreground'>—</span>;
  if (s.status !== 'running') return (
    <span className='flex flex-col items-end gap-1 tabular-nums'>
      <span>{dur(run)}</span>
      <span className='text-muted-foreground text-xs' title={`Queued ${new Date(s.queued_at).toLocaleString()}`}>waited {dur(waitOf(s))}</span>
    </span>
  );
  const hb = since(s.heartbeat_at ?? s.started_at);
  return (
    <span className='flex flex-col items-end gap-1 tabular-nums'>
      <span>{dur(run)}</span>
      <span className={cn('text-xs', hb != null && hb > HEARTBEAT_AMBER_S ? AMBER : 'text-muted-foreground')} title='Time since the last heartbeat'>♥ {dur(hb)} ago</span>
    </span>
  );
}

const META_LABEL: Record<string, string> = {
  harness_runs: 'Harness runs', simulated_user_turns: 'Simulated developer turns', developer_nudges: 'Nudges to finish', done_reason: 'Done because',
  changed_files: 'Changed files', exit_code: 'Exit code', exit_signal: 'Exit signal'
};

/** One session's peek: status and the full error, timing, run, infrastructure, spend, runnability, the last events, links. */
function SessionPeek({ id, onJob, onCancel, cancelling }: { id: string; onJob: () => void; onCancel: (s: SessionRow) => void; cancelling: boolean }) {
  const { data, error, isLoading } = useAdmin<SessionDetail>(`/compute/sessions/${encodeURIComponent(id)}`);
  if (isLoading) return <div className='grid gap-3'><Skeleton className='h-16' /><Skeleton className='h-40' /></div>;
  if (!data) return <ErrorBox error={error} />;
  const s = data.session, m = data.metadata;
  const v = (k: string): ReactNode => (m[k] == null || m[k] === '' ? <span className='text-muted-foreground'>—</span> : String(m[k]));
  const wall = typeof m.wall_ms === 'number' ? dur(m.wall_ms / 1000) : null;
  return (
    <div className='grid gap-6'>
      <PeekSection title='Status'>
        <p className='text-sm'>{statusSentence(s, m)}</p>
        {s.error_message && <pre className='bg-muted/50 max-h-48 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap'>{s.error_message}</pre>}
        {typeof m.infra_error === 'string' && m.infra_error !== s.error_message && (
          <p className='text-muted-foreground text-xs'>Last infrastructure error (it was queued again): <Mono>{m.infra_error}</Mono></p>
        )}
        {data.hint && <Notice><SectionLink href={data.hint.href} className='hover:underline'>{data.hint.text}</SectionLink></Notice>}
      </PeekSection>

      <PeekSection title='Timing'>
        <dl>
          <Field label='Queued'><When d={s.queued_at} /></Field>
          <Field label='Started'>{s.started_at ? <><When d={s.started_at} /> <span className='text-muted-foreground'>· waited {dur(waitOf(s))}</span></> : <span className='text-muted-foreground'>not yet · waiting {dur(waitOf(s))}</span>}</Field>
          <Field label='Last heartbeat'><When d={s.heartbeat_at} /></Field>
          <Field label='Ended'>{s.ended_at ? <><When d={s.ended_at} /> <span className='text-muted-foreground'>· ran {dur(runOf(s))}</span></> : <span className='text-muted-foreground'>—</span>}</Field>
          {wall && <Field label='Wall time (orchestrator)'>{wall}</Field>}
        </dl>
      </PeekSection>

      <PeekSection title='Run'>
        <dl>
          <Field label='Agent'>{s.agent_id ?? '—'} <span className='text-muted-foreground'>· {s.harness} · <Mono>{s.model}</Mono></span></Field>
          <Field label='Agent turns'>{m.agent_turns != null ? <>{String(m.agent_turns)}{m.max_agent_turns != null && <span className='text-muted-foreground'> of {String(m.max_agent_turns)}</span>}</> : <span className='text-muted-foreground'>—</span>}</Field>
          {Object.entries(META_LABEL).map(([k, label]) => <Field key={k} label={label}>{v(k)}</Field>)}
          <Field label='Outcome'>{s.completed_reason?.replace(/_/g, ' ') ?? <span className='text-muted-foreground'>—</span>}</Field>
        </dl>
      </PeekSection>

      <PeekSection title='Infrastructure'>
        <dl>
          <Field label='Infra retries'>{s.infra_retries}</Field>
          <Field label='Orchestrator'>{data.orchestrator
            ? <SectionLink href={`/admin/compute?section=orchestrators&state=all&orch=${data.orchestrator.id}`} className='hover:underline'><Mono>{data.orchestrator.orchestrator_id ?? `row ${data.orchestrator.id}`}</Mono></SectionLink>
            : <Mono>{s.worker_id ?? '—'}</Mono>}</Field>
          <Field label='boat sandbox'>{s.sandbox_id ? <><Mono>{s.sandbox_id}</Mono> <span className='text-muted-foreground'>· {String(m.boat_sandbox_type ?? 'default')}</span></> : <span className='text-muted-foreground'>—</span>}</Field>
          <Field label='Sandbox time'>{typeof m.boat_sandbox_seconds === 'number' ? dur(m.boat_sandbox_seconds) : <span className='text-muted-foreground'>—</span>}</Field>
        </dl>
      </PeekSection>

      <PeekSection title='Spend'>
        <dl>
          <Field label='Tokens in / out'><span className='tabular-nums'>{s.tokens_in.toLocaleString()} / {s.tokens_out.toLocaleString()}</span></Field>
          <Field label='Model'>{cents(s.cost_usd)}</Field>
        </dl>
        {data.gateway.length > 0 && (
          <div className='grid gap-1'>
            <p className='text-muted-foreground text-xs'>Gateway calls (detail only: already counted in the model cost above).</p>
            <MiniTable head={['Provider', 'Requests', 'Errors', 'Tokens in / out', 'Cost']} rows={data.gateway.map((g) => [
              <Mono key='p'>{g.provider}</Mono>, g.requests, g.errors ? <span key='e' className='text-destructive'>{g.errors}</span> : 0,
              `${g.input_tokens.toLocaleString()} / ${g.output_tokens.toLocaleString()}`, cents(g.cost_usd)])} />
          </div>
        )}
      </PeekSection>

      {data.runnable && (
        <PeekSection title='Can this agent run?'>
          <RunnableLine r={data.runnable} />
        </PeekSection>
      )}

      <PeekSection title={`Transcript (last ${data.transcript.length} events)`}>
        {data.transcript.length ? (
          <ol className='grid gap-1.5'>
            {data.transcript.map((e) => (
              <li key={e.seq} className='grid grid-cols-[3rem_6rem_1fr] gap-2 text-xs'>
                <span className='text-muted-foreground tabular-nums'>#{e.seq}</span>
                <span className='text-muted-foreground truncate' title={new Date(e.ts).toLocaleString()}>{e.type}</span>
                <span className='min-w-0 break-words whitespace-pre-wrap'>{e.text}</span>
              </li>
            ))}
          </ol>
        ) : <p className='text-muted-foreground text-sm'>No transcript events.</p>}
      </PeekSection>

      <PeekSection title='Links'>
        <div className='flex flex-wrap gap-2'>
          <Link href={`/admin/accounts/${encodeURIComponent(s.org.slug)}`} className={buttonVariants({ variant: 'outline', size: 'sm' })}><Icons.account /> {s.org.name}</Link>
          <Button variant='outline' size='sm' onClick={onJob}><Icons.search /> This job&apos;s sessions</Button>
          {data.orchestrator && <SectionLink href={`/admin/compute?section=orchestrators&state=all&orch=${data.orchestrator.id}`} className={buttonVariants({ variant: 'outline', size: 'sm' })}><Icons.route /> Orchestrator</SectionLink>}
          <Button variant='ghost' size='sm' onClick={() => copyText(s.id, 'Session id copied')}>Copy id</Button>
          {OPEN.includes(s.status) && <Gate need='compute'><Button variant='outline' size='sm' className='text-destructive ml-auto' disabled={cancelling} onClick={() => onCancel(s)}><Icons.close /> Cancel session</Button></Gate>}
        </div>
      </PeekSection>
    </div>
  );
}

function statusSentence(s: SessionRow, m: Record<string, unknown> = {}): string {
  const agent = s.agent_id ?? s.harness;
  switch (s.status) {
    case 'queued': return `Waiting ${dur(waitOf(s))} for an orchestrator to claim it${s.error_class === 'unclaimable' ? ', but its agent is not scheduled, so none will' : ''}.`;
    case 'running': return `Running ${agent} for ${dur(runOf(s))}; last heartbeat ${dur(since(s.heartbeat_at ?? s.started_at))} ago.`;
    case 'completed': return `Finished after ${dur(runOf(s))}${s.completed_reason ? ` (${s.completed_reason.replace(/_/g, ' ')})` : ''}.`;
    case 'cancelled': return typeof m.cancelled_by === 'string'
      ? `Cancelled by ${m.cancelled_by} on the Compute page${typeof m.cancelled_at === 'string' ? ` at ${new Date(m.cancelled_at).toLocaleString()}` : ''}${m.cancelled_from === 'running' ? ', while it was running' : ''}.`
      : 'Cancelled.';
    default: return `${s.status === 'timeout' ? 'Timed out' : 'Failed'} after ${dur(runOf(s))}${s.error_label ? `: ${s.error_label}` : ''}.`;
  }
}

/** Whether an agent can run, and why not: missing vault keys (with the fix), or no setup script. */
export function RunnableLine({ r }: { r: Runnable }) {
  return (
    <p className='text-sm'>
      <span className={cn('font-medium', r.runnable ? (r.has_setup_script ? 'text-emerald-700 dark:text-emerald-400' : AMBER) : 'text-destructive')}>
        {r.runnable ? (r.has_setup_script ? 'Can run.' : 'May run.') : 'Cannot run.'}
      </span>{' '}
      {r.reason}
      {!r.runnable && <> <Link href='/admin/keys' className='hover:underline'>Open Key vault</Link></>}
    </p>
  );
}

/** A compact table inside a peek. */
export function MiniTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className='overflow-x-auto border'>
      <Table>
        <TableHeader>
          <TableRow className='hover:bg-transparent'>{head.map((h) => <TableHead key={h} className='text-muted-foreground h-7 px-2 text-xs font-normal'>{h}</TableHead>)}</TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => <TableRow key={i} className='hover:bg-transparent'>{r.map((c, j) => <TableCell key={j} className='px-2 py-1.5 text-xs'>{c}</TableCell>)}</TableRow>)}
        </TableBody>
      </Table>
    </div>
  );
}
