'use client';
// The workspace agent (mold_v0-243; src/agent-routes.ts at /api/agent, staff /api/admin/onboarding/agent): its sessions
// as the standard list, full page (four cards, the search row with Start a session, the table), and a session opened as
// the list's full card in the same place: what the agent said and did, the composer to guide it mid-run (or wake it),
// what it asks for (Approve or Decline, and Raise budget), Pause, Resume and Stop. No dialog and no side sheet: the
// top bar's agent icon opens this page, and a session is ?session=<id> on it.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { ErrorState, FormRow, LoadingCards, When, fail } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { ActionCard, CardForm, ToolbarAction } from '@/features/tabs/tab-action';

export type Area = 'app' | 'admin';
type Phase = 'starting' | 'working' | 'waiting' | 'parked' | 'waking' | 'paused' | 'awaiting_approval' | 'stopped' | 'failed' | 'archived';
interface Request { id: string; kind: 'web' | 'tool' | 'budget'; subject: string; detail: Record<string, unknown>; status: string; decided_by: string | null; decided_at: string | null; reason: string | null; created_at: string; expires_at: string | null }
interface Session {
  id: string; title: string; phase: Phase; reason: string | null; mode: 'conversation' | 'task'; started_by: string | null; mine: boolean;
  workspace?: { id: number; slug: string | null };
  harness: { flavour: string; label: string; model: string; provider: string; steerable: boolean };
  budget_usd: number; spent_usd: number; remaining_usd: number; ceiling_usd: number; reserve_usd: number; wakes: number; crashes: number; web_calls: number;
  pause_requested: boolean; stop_requested: boolean; pending_request: Request | null; created_at: string; last_activity_at: string; ended_at: string | null;
  archived_at: string | null; pruned: boolean; can: { message: boolean; pause: boolean; resume: boolean; stop: boolean; decide: boolean; raise: boolean };
}
interface Detail extends Session {
  messages: { id: number; role: 'person' | 'agent' | 'system'; body: string; status: string | null; by: string | null; cost_usd: number | null; at: string; run_id: string | null }[];
  requests: Request[]; grants: { id: string; from_usd: number; to_usd: number; reason: string; by: string; at: string }[];
  wakes_list: { run_id: string; status: string; started_at: string | null; ended_at: string | null; cost_usd: number; end_reason: string | null; error: string | null }[];
  hooks: { event: string; source: string; text: string | null }[];
  policy: { max_turns: number; wake_max_minutes: number; park_after_minutes: number; web_tools: string; web_hosts: string[]; web_calls_max: number; tools: string[]; auto_resume: boolean; crash_resumes: number };
}
interface Offer { harness: string; model: string; steerable: boolean; budget_usd: number; ceiling_usd: number; web_tools: string; park_after_minutes: number }
interface ListAnswer { sessions: Session[]; can_start?: boolean; offer: Offer }

function api(area: Area) {
  return async <T,>(method: string, path = '', body?: unknown): Promise<T> => {
    if (area === 'admin') return adminApi<T>(method, `/agent${path}`, body);
    const res = await fetch(`/api/agent${path}`, {
      method, credentials: 'same-origin',
      headers: { accept: 'application/json', ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-pack-request': '1' } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {})
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw httpError(res.status, json);
    return json;
  };
}

export const PHASE_WORDS: Record<Phase, string> = {
  starting: 'Starting', working: 'Working', waiting: 'Waiting for you', parked: 'Parked', waking: 'Waking up', paused: 'Paused',
  awaiting_approval: 'Needs a decision', stopped: 'Stopped', failed: 'Failed', archived: 'Archived'
};
const LIVE: Phase[] = ['starting', 'working', 'waiting', 'waking'];
const usd = (n: number) => `$${n.toFixed(2)}`;
const askWords = (r: Request) => r.kind === 'web' ? `Reach ${r.subject}` : r.kind === 'tool' ? `Use ${r.subject}` : `More budget (at ${r.subject})`;

function PhaseBadge({ s }: { s: Pick<Session, 'phase' | 'pause_requested' | 'stop_requested'> }) {
  const words = s.stop_requested && LIVE.includes(s.phase) ? 'Stopping' : s.pause_requested && LIVE.includes(s.phase) ? 'Pausing' : PHASE_WORDS[s.phase];
  const tone = s.phase === 'awaiting_approval' ? 'border-amber-500/50 text-amber-700 dark:text-amber-300' : s.phase === 'failed' ? 'border-destructive/50 text-destructive'
    : s.phase === 'working' || s.phase === 'waking' || s.phase === 'starting' ? 'border-emerald-500/50 text-emerald-700 dark:text-emerald-300' : '';
  return <Badge variant='outline' className={cn('gap-1.5 font-normal', tone)} data-phase={s.phase}>
    {(s.phase === 'working' || s.phase === 'waking' || s.phase === 'starting') && <span className='size-1.5 motion-safe:animate-pulse rounded-full bg-current' aria-hidden />}{words}
  </Badge>;
}

/** The agent's page: the list, and a session as the list's full card (?session=<id>). */
export function AgentPage({ area }: { area: Area }) {
  return <Suspense fallback={<PageContainer><LoadingCards count={4} /></PageContainer>}><AgentList area={area} /></Suspense>;
}

function AgentList({ area }: { area: Area }) {
  const call = useMemo(() => api(area), [area]);
  const params = useSearchParams();
  const [open, setOpenState] = useState<string | null>(params.get('session'));
  const [data, setData] = useState<ListAnswer | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [starting, setStarting] = useState(false);
  const load = useCallback(() => call<ListAnswer>('GET').then((d) => { setData(d); setError(null); }, (e: Error) => setError(e)), [call]);
  useEffect(() => { void load(); }, [load]);
  const live = !!data?.sessions.some((s) => LIVE.includes(s.phase));
  useEffect(() => { const t = setInterval(() => void load(), live ? 3000 : 15000); return () => clearInterval(t); }, [load, live]);
  const setOpen = (k: string | null) => {
    setOpenState(k);
    const u = new URL(window.location.href);
    if (k) u.searchParams.set('session', k); else u.searchParams.delete('session');
    window.history.replaceState(null, '', u.toString());
  };
  if (error) return <PageContainer><ErrorState error={error} /></PageContainer>;
  if (starting && data) return (
    <PageContainer>
      <ActionCard open onOpenChange={(o) => { if (!o) setStarting(false); }} title='Start a session'
        description={`${data.offer.harness} (${data.offer.model}) works in its own workspace from a ${usd(data.offer.budget_usd)} budget${data.offer.web_tools === 'off' ? ', without the web' : ''}. ${data.offer.steerable ? 'You can guide it while it works.' : ''}`}>
        <StartForm call={call} onStarted={(id) => { setStarting(false); void load().then(() => setOpen(id)); }} />
      </ActionCard>
    </PageContainer>
  );
  const rows = data?.sessions ?? [];
  const cols: RecordCol<Session>[] = [
    { key: 'title', label: 'Session', title: true, keep: true, type: 'text', className: 'min-w-56', value: (s) => s.title,
      render: (s) => <span className='flex min-w-0 flex-col gap-1'><span className='leading-snug font-medium'>{s.title}</span><span className='text-muted-foreground font-mono text-xs leading-none'>{s.id}</span></span> },
    { key: 'phase', label: 'Phase', type: 'select', keep: true, options: Object.entries(PHASE_WORDS).map(([value, label]) => ({ value, label })), value: (s) => s.phase, render: (s) => <PhaseBadge s={s} /> },
    ...(area === 'admin' ? [{ key: 'workspace', label: 'Workspace', type: 'text' as const, value: (s: Session) => s.workspace?.slug ?? '', render: (s: Session) => <span className='font-mono text-xs'>{s.workspace?.slug}</span> }] : []),
    { key: 'started_by', label: 'Started by', type: 'text', value: (s) => s.started_by ?? '', render: (s) => <span className='break-all'>{s.mine ? 'You' : s.started_by}</span> },
    { key: 'waiting_on', label: 'Waiting on', type: 'text', value: (s) => (s.pending_request ? askWords(s.pending_request) : ''),
      render: (s) => (s.pending_request ? <span className='text-amber-700 dark:text-amber-300'>{askWords(s.pending_request)}</span> : '') },
    { key: 'spent', label: 'Spent', type: 'number', value: (s) => s.spent_usd, render: (s) => <span className='tabular-nums'>{usd(s.spent_usd)} <span className='text-muted-foreground'>of {usd(s.budget_usd)}</span></span> },
    { key: 'activity', label: 'Last activity', type: 'date', keep: true, value: (s) => s.last_activity_at, render: (s) => <When d={s.last_activity_at} /> },
    { key: 'wakes', label: 'Wakes', type: 'number', value: (s) => s.wakes, render: (s) => String(s.wakes) }
  ];
  const n = (ps: Phase[]) => rows.filter((s) => ps.includes(s.phase)).length;
  const spent = rows.reduce((t, s) => t + s.spent_usd, 0);
  return (
    <PageContainer>
      <RecordView<Session>
        id={`${area}-agent`} compact noun={rows.length === 1 ? 'session' : 'sessions'} loading={!data}
        rows={rows} rowKey={(s) => s.id} cols={cols} openKey={open} onOpenChange={setOpen}
        defaultSort={[{ key: 'activity', dir: 'desc' }]}
        summary={<StatStrip quad items={[
          { label: 'Working now', value: n(['starting', 'working', 'waiting', 'waking']), said: `${n(['starting', 'working', 'waiting', 'waking'])} sessions working now` },
          { label: 'Need a decision', value: n(['awaiting_approval']), said: `${n(['awaiting_approval'])} sessions need a decision` },
          { label: 'Parked or paused', value: n(['parked', 'paused']), said: `${n(['parked', 'paused'])} sessions parked or paused` },
          { label: 'Spent', value: usd(spent), said: `${usd(spent)} spent by these sessions` }
        ]} />}
        searchText={(s) => `${s.title} ${s.id} ${PHASE_WORDS[s.phase]} ${s.started_by ?? ''} ${s.workspace?.slug ?? ''} ${s.pending_request ? askWords(s.pending_request) : ''}`}
        searchPlaceholder='Search sessions'
        toolbarAction={area === 'app' && data?.can_start ? <div className='ml-auto flex shrink-0 gap-2'><ToolbarAction label='Start a session' icon={<Icons.add />} onClick={() => setStarting(true)} /></div> : undefined}
        empty={<p className='text-muted-foreground text-sm'>{area === 'app' ? (data?.can_start ? 'No sessions yet: Start a session gives the agent its first message.' : 'No sessions yet. A member of this workspace can start one.') : 'No workspace has started a session yet.'}</p>}
        detailTitle={(s) => s.title}
        detailActions={(s) => <Controls area={area} s={s} call={call} onChange={load} />}
        detail={(s) => <SessionCard key={s.id} area={area} id={s.id} call={call} onChange={load} />}
      />
    </PageContainer>
  );
}

type Call = ReturnType<typeof api>;

function StartForm({ call, onStarted }: { call: Call; onStarted: (id: string) => void }) {
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'conversation' | 'task'>('conversation');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!message.trim()) { toast.error('Say what the agent should do'); return; }
    setBusy(true);
    try { const r = await call<{ session: Session }>('POST', '', { message, title: title || undefined, mode }); toast.success('Started'); onStarted(r.session.id); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <CardForm onSubmit={submit} submit={<Button type='submit' disabled={busy}>Start</Button>}>
      <div className='grid max-w-2xl gap-3'>
        <FormRow label='What should the agent do?' htmlFor='agent-start-message' hint='Its first message. You can guide it while it works.'>
          <Textarea id='agent-start-message' rows={5} value={message} onChange={(e) => setMessage(e.target.value)} placeholder='Look through the workspace and write a short summary of what changed this week.' />
        </FormRow>
        <FormRow label='Title' htmlFor='agent-start-title' hint='Optional: how the list names it (else its first words)'>
          <Input id='agent-start-title' value={title} onChange={(e) => setTitle(e.target.value)} />
        </FormRow>
        <FormRow label='Kind' htmlFor='agent-start-mode'>
          <NativeSelect id='agent-start-mode' value={mode} onChange={(e) => setMode(e.target.value as 'conversation' | 'task')}>
            <NativeSelectOption value='conversation'>Conversation: waits for your next message, parks when quiet</NativeSelectOption>
            <NativeSelectOption value='task'>Task: ends once its work is answered</NativeSelectOption>
          </NativeSelect>
        </FormRow>
      </div>
    </CardForm>
  );
}

/** Pause, Resume, Stop: on the card's top line. Stop asks once more in place (no dialog). */
function Controls({ area, s, call, onChange }: { area: Area; s: Session; call: Call; onChange: () => unknown }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = (what: 'pause' | 'resume' | 'stop') => async () => {
    setBusy(true);
    try { await call('POST', `/${s.id}/${what}`); toast.success(what === 'pause' ? 'Pausing' : what === 'resume' ? 'Resuming' : 'Stopping'); setConfirm(false); await onChange(); window.dispatchEvent(new Event('agent-session-changed')); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  if (confirm) return (
    <div className='flex flex-wrap items-center gap-2' role='group' aria-label='Stop this session'>
      <span className='text-sm'>Stop for good? It finishes its step and becomes read only.</span>
      <Button size='sm' variant='destructive' disabled={busy} onClick={act('stop')}>Stop session</Button>
      <Button size='sm' variant='ghost' onClick={() => setConfirm(false)}>Keep it</Button>
    </div>
  );
  return (
    <div className='flex flex-wrap items-center gap-1'>
      {s.can.pause && <Button size='sm' variant='outline' disabled={busy} onClick={act('pause')}><Icons.pause />Pause</Button>}
      {area === 'app' && s.can.resume && <Button size='sm' variant='outline' disabled={busy} onClick={act('resume')}><Icons.play />Resume</Button>}
      {s.can.stop && <Button size='sm' variant='outline' disabled={busy} onClick={() => setConfirm(true)}><Icons.stop />Stop</Button>}
    </div>
  );
}

/** One session, full card: its state and spend, what it asks for, the transcript, the composer, its details. */
function SessionCard({ area, id, call, onChange }: { area: Area; id: string; call: Call; onChange: () => unknown }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const load = useCallback(() => call<{ session: Detail }>('GET', `/${id}`).then((r) => { setD(r.session); setError(null); }, (e: Error) => setError(e)), [call, id]);
  useEffect(() => { void load(); const h = () => void load(); window.addEventListener('agent-session-changed', h); return () => window.removeEventListener('agent-session-changed', h); }, [load]);
  const live = !!d && LIVE.includes(d.phase);
  useEffect(() => { const t = setInterval(() => void load(), live ? 1500 : 8000); return () => clearInterval(t); }, [load, live]);
  const changed = async () => { await load(); await onChange(); };
  if (error) return <ErrorState error={error} />;
  if (!d) return <LoadingCards count={2} />;
  return (
    <div className='flex flex-col gap-4' data-agent-session={d.id} data-phase={d.phase}>
      <StateLine d={d} area={area} />
      {d.pending_request && <RequestCard d={d} r={d.pending_request} call={call} onDone={changed} />}
      <Transcript d={d} />
      {area === 'app' && <Composer d={d} call={call} onSent={changed} />}
      {!d.pending_request && d.can.raise && <RaiseBudget d={d} call={call} onDone={changed} compact />}
      <Details d={d} />
    </div>
  );
}

function StateLine({ d, area }: { d: Detail; area: Area }) {
  const pct = d.budget_usd > 0 ? Math.min(100, Math.round((d.spent_usd / d.budget_usd) * 100)) : 0;
  return (
    <div className='flex flex-col gap-2'>
      <div className='flex flex-wrap items-center gap-x-4 gap-y-2 text-sm'>
        <PhaseBadge s={d} />
        <span className='text-muted-foreground'>{d.harness.label} · <span className='font-mono text-xs'>{d.harness.model}</span></span>
        <span className='text-muted-foreground'>{d.mode === 'task' ? 'Task' : 'Conversation'}</span>
        {area === 'admin' && d.workspace?.slug && <span className='text-muted-foreground'>Workspace <span className='font-mono text-xs'>{d.workspace.slug}</span></span>}
        <span className='text-muted-foreground'>Started by {d.mine ? 'you' : d.started_by}</span>
      </div>
      <div className='flex flex-wrap items-center gap-3 text-sm' aria-label={`Spent ${usd(d.spent_usd)} of ${usd(d.budget_usd)}`}>
        <div className='bg-muted h-2 w-48 overflow-hidden rounded-full' aria-hidden><div className={cn('h-full rounded-full', pct >= 100 ? 'bg-destructive' : 'bg-primary')} style={{ width: `${pct}%` }} /></div>
        <span className='tabular-nums'>{usd(d.spent_usd)} of {usd(d.budget_usd)}</span>
        <span className='text-muted-foreground tabular-nums'>{usd(d.remaining_usd)} left · {d.wakes} wake{d.wakes === 1 ? '' : 's'}{d.crashes ? ` · ${d.crashes} crash${d.crashes === 1 ? '' : 'es'} in a row` : ''}</span>
      </div>
      {d.reason && !['paused', 'withdrawn', 'budget'].includes(d.reason) && <p className='text-muted-foreground text-sm'>{reasonWords(d.reason)}</p>}
    </div>
  );
}
const reasonWords = (r: string) => r.startsWith('crashed: ') ? `It stopped unexpectedly: ${r.slice(9)}.` : r.startsWith('declined: ') ? `Declined: ${r.slice(10)}.`
  : r.startsWith('approved: ') ? `Approved: ${r.slice(10)}.` : r.startsWith('expired: ') ? `Nobody answered in time: ${r.slice(9)}.` : r === 'done' ? 'It finished its work.' : r;

/** What the agent asked for: Approve or Decline (a web host, a tool), or Raise budget. A full card in the session's flow. */
function RequestCard({ d, r, call, onDone }: { d: Detail; r: Request; call: Call; onDone: () => unknown }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = (decision: 'approve' | 'decline') => async () => {
    setBusy(true);
    try { await call('POST', `/${d.id}/requests/${r.id}`, { decision, reason: reason || undefined }); toast.success(decision === 'approve' ? 'Approved: it continues' : 'Declined'); await onDone(); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  const icon = r.kind === 'web' ? <Icons.world /> : r.kind === 'tool' ? <Icons.tool /> : <Icons.coin />;
  return (
    <Card className='border-amber-500/40 gap-3 py-4' data-approval-card='' role='region' aria-label='The agent is asking'>
      <CardHeader className='px-4'>
        <CardDescription className='flex items-center gap-1.5 text-amber-700 dark:text-amber-300'>{icon}The agent is waiting for a decision</CardDescription>
        <CardTitle className='text-base'>{r.kind === 'web' ? <>It asks to read <span className='font-mono'>{r.subject}</span></> : r.kind === 'tool' ? <>It asks to use <span className='font-mono'>{r.subject}</span></> : <>It reached its {usd(d.budget_usd)} budget</>}</CardTitle>
      </CardHeader>
      <CardContent className='flex flex-col gap-3 px-4'>
        <p className='text-muted-foreground text-sm'>
          {r.kind === 'web' ? <>Approve lets this session read <span className='font-mono'>{r.subject}</span>, and nothing else new. {typeof r.detail.url === 'string' ? <>It wanted <span className='font-mono break-all'>{r.detail.url}</span>. </> : null}What it reads is treated as untrusted. Decline tells it no; it parks and is told at the next message.</>
            : r.kind === 'tool' ? <>Approve lets this session use {r.subject} from now on. Decline tells it no; it parks and is told at the next message.</>
              : <>It spent {usd(d.spent_usd)}. Raise its budget to let it continue where it stopped (up to {usd(d.ceiling_usd)}).</>}
          {r.expires_at ? <> Unanswered, the request expires <When d={r.expires_at} />.</> : null}
        </p>
        {r.kind === 'budget' ? (d.can.raise ? <RaiseBudget d={d} call={call} onDone={onDone} /> : <p className='text-sm'>A billing manager or an owner of the workspace can raise it.</p>)
          : d.can.decide ? (
            <div className='flex flex-col gap-2'>
              <FormRow label='Reason (optional; the agent is told it with a decline)' htmlFor={`agent-reason-${r.id}`}>
                <Input id={`agent-reason-${r.id}`} value={reason} onChange={(e) => setReason(e.target.value)} className='max-w-xl' />
              </FormRow>
              <div className='flex flex-wrap gap-2'>
                <Button size='sm' disabled={busy} onClick={decide('approve')}>Approve</Button>
                <Button size='sm' variant='outline' disabled={busy} onClick={decide('decline')}>Decline</Button>
              </div>
            </div>
          ) : <p className='text-sm'>The person who started this session or an owner decides.</p>}
      </CardContent>
    </Card>
  );
}

function RaiseBudget({ d, call, onDone, compact }: { d: Detail; call: Call; onDone: () => unknown; compact?: boolean }) {
  const suggested = Math.min(d.ceiling_usd, Math.max(d.budget_usd * 2, d.spent_usd + 1));
  const [to, setTo] = useState(String(Math.round(suggested * 100) / 100));
  const [reason, setReason] = useState('');
  const [openForm, setOpenForm] = useState(!compact);
  const [busy, setBusy] = useState(false);
  if (d.budget_usd >= d.ceiling_usd) return compact ? null : <p className='text-sm'>Its budget is already at the most a session may have ({usd(d.ceiling_usd)}).</p>;
  if (!openForm) return <div><Button size='sm' variant='ghost' onClick={() => setOpenForm(true)}><Icons.coin />Raise budget</Button></div>;
  const submit = async () => {
    setBusy(true);
    try { await call('POST', `/${d.id}/budget`, { to_usd: Number(to), reason }); toast.success('Budget raised'); setOpenForm(!compact); await onDone(); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <form className='flex flex-col gap-2' onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label='Raise budget'>
      <div className='flex flex-wrap items-end gap-3'>
        <FormRow label={`Raise to (USD, at most ${usd(d.ceiling_usd)})`} htmlFor={`agent-raise-${d.id}`}>
          <Input id={`agent-raise-${d.id}`} className='w-32' type='number' min={d.budget_usd} max={d.ceiling_usd} step='0.5' value={to} onChange={(e) => setTo(e.target.value)} />
        </FormRow>
        <FormRow label='Why (kept with the raise)' htmlFor={`agent-raise-why-${d.id}`}>
          <Input id={`agent-raise-why-${d.id}`} className='w-72 max-w-full' value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormRow>
      </div>
      <div className='flex gap-2'>
        <Button size='sm' type='submit' disabled={busy || !reason.trim()}>Raise budget</Button>
        {compact && <Button size='sm' type='button' variant='ghost' onClick={() => setOpenForm(false)}>Cancel</Button>}
      </div>
    </form>
  );
}

const STATUS_WORDS: Record<string, string> = { pending: 'Waiting to be delivered', delivered: 'Delivered', answered: 'Answered', discarded: 'Carried to the next wake' };

function Transcript({ d }: { d: Detail }) {
  const end = useRef<HTMLDivElement>(null);
  const count = d.messages.length;
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [count]);
  if (d.pruned) return <p className='text-muted-foreground text-sm'>This conversation was removed after its retention period; its spend and budget raises are kept below.</p>;
  return (
    <div className='bg-muted/30 flex max-h-[28rem] min-h-40 flex-col gap-3 overflow-y-auto rounded-lg border p-3' role='log' aria-live='polite' aria-label='Conversation' data-agent-transcript=''>
      {d.messages.map((m) => m.role === 'system' ? (
        <p key={m.id} className='text-muted-foreground self-center text-center text-xs'>{m.body} · <When d={m.at} /></p>
      ) : (
        <div key={m.id} className={cn('flex flex-col gap-1', m.role === 'person' ? 'items-end' : 'items-start')} data-message-role={m.role}>
          <span className='text-muted-foreground text-xs'>{m.role === 'person' ? (m.by ?? 'Person') : 'Agent'} · <When d={m.at} /></span>
          <Bubble variant={m.role === 'person' ? 'default' : 'outline'} align={m.role === 'person' ? 'end' : 'start'}>
            <BubbleContent className='text-sm whitespace-pre-wrap'>{m.body}</BubbleContent>
          </Bubble>
          {m.role === 'person' && m.status && <span className='text-muted-foreground text-xs'>{STATUS_WORDS[m.status] ?? m.status}</span>}
        </div>
      ))}
      {(d.phase === 'working' || d.phase === 'starting' || d.phase === 'waking') && (
        <div className='text-muted-foreground flex items-center gap-2 text-xs' aria-live='polite'><span className='size-1.5 motion-safe:animate-pulse rounded-full bg-current' aria-hidden />{d.phase === 'working' ? 'The agent is working' : d.phase === 'waking' ? 'Waking up' : 'Starting'}</div>
      )}
      <div ref={end} />
    </div>
  );
}

function Composer({ d, call, onSent }: { d: Detail; call: Call; onSent: () => unknown }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const why: ReactNode = d.can.message ? null
    : !d.mine ? 'Only the person who started this session can message it.'
      : d.phase === 'awaiting_approval' ? 'It waits for a decision on what it asked for first.'
        : ['stopped', 'failed', 'archived'].includes(d.phase) ? 'This session has ended.' : `${d.harness.label} reads its instructions once: it cannot be guided while it works.`;
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await call<{ status: string }>('POST', `/${d.id}/messages`, { message: text });
      setText(''); toast.success(r.status === 'waking' ? 'Sent: it is waking up to answer' : d.phase === 'working' ? 'Sent: it takes it at its next step' : 'Sent');
      await onSent();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const placeholder = d.phase === 'working' ? 'Guide the agent while it works' : d.phase === 'parked' || d.phase === 'paused' ? 'Send a message to wake it' : 'Message the agent';
  return (
    <form className='flex flex-col gap-2' onSubmit={(e) => { e.preventDefault(); void send(); }} aria-label='Message the agent' data-agent-composer=''>
      <label htmlFor={`agent-msg-${d.id}`} className='sr-only'>Message the agent</label>
      <div className='flex items-end gap-2'>
        <Textarea id={`agent-msg-${d.id}`} rows={2} value={text} disabled={!d.can.message || busy} placeholder={why ? undefined : placeholder} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} className='min-h-11' />
        <Button type='submit' disabled={!d.can.message || busy || !text.trim()} aria-label='Send' className='h-11 min-w-11'><Icons.send /><span className='hidden sm:inline'>Send</span></Button>
      </div>
      {why && <p className='text-muted-foreground text-xs'>{why}</p>}
    </form>
  );
}

function Details({ d }: { d: Detail }) {
  return (
    <details className='rounded-lg border px-3 py-2 text-sm'>
      <summary className='cursor-pointer font-medium'>How this session runs</summary>
      <dl className='mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]'>
        <dt className='text-muted-foreground'>Turns per wake</dt><dd>{d.policy.max_turns}</dd>
        <dt className='text-muted-foreground'>Longest wake</dt><dd>{d.policy.wake_max_minutes} minutes</dd>
        <dt className='text-muted-foreground'>Parks after</dt><dd>{d.policy.park_after_minutes} quiet minutes</dd>
        <dt className='text-muted-foreground'>Web</dt><dd>{d.policy.web_tools === 'off' ? 'Off' : `${d.policy.web_tools === 'search' ? 'Search and read' : 'Read'}: ${d.policy.web_hosts.join(', ') || 'asks for each host'} (${d.web_calls} of ${d.policy.web_calls_max} calls)`}</dd>
        <dt className='text-muted-foreground'>Tools</dt><dd>{d.policy.tools.join(', ')}</dd>
        <dt className='text-muted-foreground'>After a crash</dt><dd>{d.policy.auto_resume ? 'Continues by itself' : 'Continues at the next message'} (at most {d.policy.crash_resumes} in a row)</dd>
        <dt className='text-muted-foreground'>Instructions</dt><dd>{d.hooks.map((h) => `${h.event === 'on_start' ? 'On start' : h.event === 'on_resume' ? 'On resume' : 'Standing'}: ${h.source === 'unset' ? 'none' : h.source === 'harness' ? "the harness's own" : "this session's"}`).join(' · ')}</dd>
      </dl>
      {d.grants.length > 0 && <div className='mt-3'><p className='font-medium'>Budget raises</p><ul className='mt-1 flex flex-col gap-1'>{d.grants.map((g) => <li key={g.id}>{usd(g.from_usd)} to {usd(g.to_usd)} by {g.by}, <When d={g.at} />: {g.reason}</li>)}</ul></div>}
      {d.wakes_list.length > 0 && <div className='mt-3'><p className='font-medium'>Wakes</p><ul className='mt-1 flex flex-col gap-1'>{d.wakes_list.map((w) => <li key={w.run_id} className='flex flex-wrap gap-x-2'><span className='font-mono text-xs'>{w.run_id}</span><span>{w.status}</span>{w.end_reason && <span className='text-muted-foreground'>{w.end_reason}</span>}<span className='tabular-nums'>{usd(w.cost_usd)}</span></li>)}</ul></div>}
      {d.requests.filter((r) => r.status !== 'pending').length > 0 && <div className='mt-3'><p className='font-medium'>Decisions</p><ul className='mt-1 flex flex-col gap-1'>{d.requests.filter((r) => r.status !== 'pending').map((r) => <li key={r.id}>{askWords(r)}: {r.status}{r.decided_by ? ` by ${r.decided_by}` : ''}{r.reason ? ` (${r.reason})` : ''}</li>)}</ul></div>}
    </details>
  );
}
