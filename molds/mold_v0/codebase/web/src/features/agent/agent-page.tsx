'use client';
// The workspace agent (mold_v0-243; src/agent-routes.ts at /api/agent, staff /api/admin/onboarding/agent): its sessions
// as the standard list, full page (four cards, the search row with Start a session, the table), and a session opened as
// the list's full card in the same place: what the agent said and did, the composer to guide it mid-run (or wake it),
// what it asks for (Approve or Decline, and Raise budget), Pause, Resume and Stop, and how it runs (what it reaches of
// the workspace: its tools, which ask first, the context it was given; mold_v0-250). The top bar's agent icon opens this
// page, and a session is ?session=<id> on it. One exception to the console's full-card rule, the operator's (mold_v0-249):
// Start a session opens as a modal dialog (the first message, the model, the budget, Start), then the new session's
// full card. Nothing else here is a dialog or a side sheet. mold_v0-261: the dialog offers the agent profiles this person
// may start (src/agent-profiles.ts; staff set them up in Admin › Agent profiles), each with its model and budget; a list's
// start_agent action opens it with its profile and first message (?start=<profile>&message=...), and a session's card says
// which profile and version it runs with, and the record it was started from.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { featureOn } from '@/config/features';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { ErrorState, FormRow, LoadingCards, When, fail } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { ToolbarAction } from '@/features/tabs/tab-action';

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
  /** mold_v0-261: the agent profile and the version it froze, and the record it was started from. */
  profile?: { id: string; name: string; version: number } | null;
  record?: { area: string; key: string } | null;
}
interface Detail extends Session {
  messages: { id: number; role: 'person' | 'agent' | 'system'; body: string; status: string | null; by: string | null; cost_usd: number | null; at: string; run_id: string | null }[];
  requests: Request[]; grants: { id: string; from_usd: number; to_usd: number; reason: string; by: string; at: string }[];
  wakes_list: { run_id: string; status: string; started_at: string | null; ended_at: string | null; cost_usd: number; end_reason: string | null; error: string | null }[];
  hooks: { event: string; source: string; text: string | null }[];
  policy: { max_turns: number; wake_max_minutes: number; park_after_minutes: number; web_tools: string; web_hosts: string[]; web_calls_max: number; tools: string[]; auto_resume: boolean; crash_resumes: number;
    files?: string[]; hidden_tools?: string[]; credentials?: string[] };
  reach: Reach | null;
}
interface Reach {
  acts_as: { kind: 'person' | 'key'; name: string | null; role: string | null }; free: string; named: string[];
  tools: { name: string; title: string | null; read: boolean; asks: boolean }[];
  context: { max_chars: number; parts: { part: string; label: string; chars: number; kept: number }[] };
}
interface Offer {
  harness: string; model: string; steerable: boolean; budget_usd: number; ceiling_usd: number; web_tools: string; park_after_minutes: number; workspace_tools?: string;
  budget?: { default_usd: number; max_usd: number; ceiling_usd: number };
}
/** An agent profile this person may start (mold_v0-261), with its model and their budget range under it. */
interface StartProfile { id: string; name: string; description: string; version: number; is_default: boolean; model: string; budget: { default_usd: number; max_usd: number; ceiling_usd: number }; tools: string; web: string; files: number }
interface ListAnswer { sessions: Session[]; can_start?: boolean; offer: Offer; profiles?: StartProfile[] }

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
/** What a workspace tool call wanted to send, as indented JSON when it is JSON. */
const prettyInput = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };
/** A workspace tool's own name (mcp__app__<tool>), or null. */
const toolOf = (subject: string) => (subject.startsWith('mcp__app__') ? subject.slice('mcp__app__'.length) : null);
const askWords = (r: Request) => r.kind === 'web' ? `Reach ${r.subject}` : r.kind === 'tool' ? `Use ${toolOf(r.subject) ?? r.subject}` : `More budget (at ${r.subject})`;

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
  // A list's start_agent action (mold_v0-261) opens the dialog with its profile and first message: ?start=<profile>&message=.
  const [starting, setStarting] = useState(!!params.get('start'));
  const [preset] = useState(() => ({ profile: params.get('start'), message: params.get('message') }));
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
      {area === 'app' && data && <StartDialog open={starting} offer={data.offer} profiles={data.profiles ?? []} preset={preset} call={call} onOpenChange={(o) => {
        setStarting(o);
        if (!o && (params.get('start') || params.get('message'))) { const u = new URL(window.location.href); u.searchParams.delete('start'); u.searchParams.delete('message'); window.history.replaceState(null, '', u.toString()); }
      }}
        onStarted={(id) => { setStarting(false); void load().then(() => setOpen(id)); }} />}
    </PageContainer>
  );
}

type Call = ReturnType<typeof api>;

/**
 * Start a session: the console's one modal dialog (mold_v0-249, the operator's exception to the full-card rule). The
 * first message, the model (shown; staff choose it), the budget (this person's range), then Start; the new session then
 * opens as its full card. Focus stays inside while it is open, Esc closes it, and its title names it.
 */
function StartDialog({ open, offer, profiles, preset, call, onOpenChange, onStarted }: {
  open: boolean; offer: Offer; profiles: StartProfile[]; preset: { profile: string | null; message: string | null }; call: Call; onOpenChange: (o: boolean) => void; onStarted: (id: string) => void;
}) {
  // mold_v0-261: the profile chosen (the preset's when it is one this person may start, else the first: the Default).
  const first = profiles.find((p) => p.id === preset.profile) ?? profiles[0] ?? null;
  const [profileId, setProfileId] = useState<string | null>(first?.id ?? null);
  const profile = profiles.find((p) => p.id === profileId) ?? null;
  const range = profile?.budget ?? offer.budget ?? { default_usd: offer.budget_usd, max_usd: offer.budget_usd, ceiling_usd: offer.ceiling_usd };
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'conversation' | 'task'>('conversation');
  const [budget, setBudget] = useState(String(range.default_usd));
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setMessage(preset.message ?? ''); setTitle(''); setMode('conversation'); setProfileId(first?.id ?? null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) setBudget(String(range.default_usd)); }, [open, profileId, range.default_usd]);
  const b = Number(budget);
  const budgetWrong = !Number.isFinite(b) || b < 0.1 || b > range.max_usd + 1e-9;
  const submit = async () => {
    if (!message.trim()) { toast.error('Say what the agent should do'); return; }
    if (budgetWrong) { toast.error(`The budget is between $0.10 and ${usd(range.max_usd)}`); return; }
    setBusy(true);
    try {
      const r = await call<{ session: Session }>('POST', '', { message, title: title || undefined, mode, ...(profile ? { profile: profile.id } : {}), ...(b !== range.default_usd ? { budget_usd: b } : {}) });
      toast.success('Started'); onStarted(r.session.id);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  // Tab wraps from the last control to the first (Shift+Tab the other way): focus never leaves the dialog for the page
  // behind it, whatever the library's own focus guards do (measured on the lane: they let it out after the last one).
  const keepTabInside = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")]
      .filter((x) => x.getClientRects().length > 0);
    if (!items.length) return;
    const first = items[0]!, last = items[items.length - 1]!, at = document.activeElement;
    if (e.shiftKey ? at === first || !e.currentTarget.contains(at) : at === last) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  };
  const tools = offer.workspace_tools === 'all' ? 'uses every tool you may use without asking' : offer.workspace_tools === 'reads_and_named' ? 'reads without asking, uses a few named tools, and asks you before any other change' : 'reads without asking and asks you before it changes anything';
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl' data-agent-start-dialog='' onKeyDown={keepTabInside}
        finalFocus={() => document.querySelector<HTMLElement>("[data-toolbar-action][aria-label='Start a session']")}>
        <form className='grid gap-4' onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <DialogHeader>
            <DialogTitle>Start a session</DialogTitle>
            <DialogDescription>
              {offer.harness} works in its own workspace and reaches this workspace&apos;s records as you, with your role: it {tools}.{offer.steerable ? ' You can guide it while it works.' : ''}
            </DialogDescription>
          </DialogHeader>
          <FormRow label='What should the agent do?' htmlFor='agent-start-message' hint='Its first message.'>
            <Textarea id='agent-start-message' rows={5} autoFocus value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Summarise this workspace's records and say what needs attention first." />
          </FormRow>
          <dl className='grid gap-x-4 gap-y-3 rounded-lg border p-3 text-sm sm:grid-cols-[auto_1fr]' data-agent-start-terms=''>
            {profiles.length > 0 && <>
              <dt className='text-muted-foreground'><label htmlFor='agent-start-profile'>Profile</label></dt>
              <dd className='grid gap-1' data-agent-start-profile=''>
                <NativeSelect id='agent-start-profile' value={profileId ?? ''} onChange={(e) => setProfileId(e.target.value)} aria-describedby='agent-start-profile-hint'>
                  {profiles.map((p) => <NativeSelectOption key={p.id} value={p.id}>{p.name}</NativeSelectOption>)}
                </NativeSelect>
                <span id='agent-start-profile-hint' className='text-muted-foreground text-xs'>{profile?.description || 'Its instructions, model, budget and tools, as the platform’s staff set them up.'}{profile && profile.files > 0 ? ` It starts with ${profile.files} file${profile.files === 1 ? '' : 's'} in its workspace.` : ''}</span>
              </dd>
            </>}
            <dt className='text-muted-foreground'>Model</dt>
            <dd><span className='font-mono text-xs'>{profile?.model ?? offer.model}</span><span className='text-muted-foreground block text-xs'>Set by the platform&apos;s staff{profiles.length > 1 ? ' for this profile' : ' for every new session'}.</span></dd>
            <dt className='text-muted-foreground'><label htmlFor='agent-start-budget'>Budget (USD)</label></dt>
            <dd className='grid gap-1'>
              <Input id='agent-start-budget' className='w-32' type='number' inputMode='decimal' min={0.1} max={range.max_usd} step='0.01' value={budget}
                aria-invalid={budgetWrong || undefined} aria-describedby='agent-start-budget-hint' onChange={(e) => setBudget(e.target.value)} />
              <span id='agent-start-budget-hint' className='text-muted-foreground text-xs'>
                {range.max_usd > range.default_usd ? `${usd(range.default_usd)} unless you change it; you can give it up to ${usd(range.max_usd)}.` : `At most ${usd(range.max_usd)}; lower it if you like.`} When it is spent the session stops and asks{range.max_usd > range.default_usd ? '' : ' a billing manager or an owner'} to raise it, up to {usd(range.ceiling_usd)}.
              </span>
            </dd>
            <dt className='text-muted-foreground'><label htmlFor='agent-start-mode'>Kind</label></dt>
            <dd>
              <NativeSelect id='agent-start-mode' value={mode} onChange={(e) => setMode(e.target.value as 'conversation' | 'task')}>
                <NativeSelectOption value='conversation'>Conversation: waits for your next message, parks when quiet</NativeSelectOption>
                <NativeSelectOption value='task'>Task: ends once its work is answered</NativeSelectOption>
              </NativeSelect>
            </dd>
            <dt className='text-muted-foreground'><label htmlFor='agent-start-title'>Title</label></dt>
            <dd><Input id='agent-start-title' value={title} placeholder='Optional: else its first words' onChange={(e) => setTitle(e.target.value)} /></dd>
          </dl>
          <DialogFooter>
            <Button type='button' variant='outline' disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type='submit' disabled={busy || !message.trim() || budgetWrong}>{busy ? 'Starting…' : 'Start'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
        {d.profile && <span className='text-muted-foreground' data-agent-profile=''>Profile {d.profile.name} <span className='text-xs'>(version {d.profile.version})</span></span>}
        <span className='text-muted-foreground'>{d.mode === 'task' ? 'Task' : 'Conversation'}</span>
        {area === 'admin' && d.workspace?.slug && <span className='text-muted-foreground'>Workspace <span className='font-mono text-xs'>{d.workspace.slug}</span></span>}
        <span className='text-muted-foreground'>Started by {d.mine ? 'you' : d.started_by}</span>
      </div>
      <div className='flex flex-wrap items-center gap-3 text-sm' aria-label={`Spent ${usd(d.spent_usd)} of ${usd(d.budget_usd)}`}>
        <div className='bg-muted h-2 w-48 overflow-hidden rounded-full' aria-hidden><div className={cn('h-full rounded-full', pct >= 100 ? 'bg-destructive' : 'bg-primary')} style={{ width: `${pct}%` }} /></div>
        <span className='tabular-nums'>{usd(d.spent_usd)} of {usd(d.budget_usd)}</span>
        <span className='text-muted-foreground tabular-nums'>{usd(d.remaining_usd)} left · {d.wakes} wake{d.wakes === 1 ? '' : 's'}{d.crashes ? ` · ${d.crashes} crash${d.crashes === 1 ? '' : 'es'} in a row` : ''}</span>
      </div>
      {/* While it waits for a decision the request's own card says what it asked for (the reason is its raw subject). */}
      {d.reason && !d.pending_request && d.phase !== 'awaiting_approval' && !['paused', 'withdrawn', 'budget'].includes(d.reason) && <p className='text-muted-foreground text-sm' data-agent-reason>{reasonWords(d.reason)}</p>}
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
  const own = r.kind === 'tool' ? toolOf(r.subject) : null;
  return (
    <Card className='border-amber-500/40 gap-3 py-4' data-approval-card='' role='region' aria-label='The agent is asking'>
      <CardHeader className='px-4'>
        <CardDescription className='flex items-center gap-1.5 text-amber-700 dark:text-amber-300'>{icon}The agent is waiting for a decision</CardDescription>
        <CardTitle className='text-base'>{r.kind === 'web' ? <>It asks to read <span className='font-mono'>{r.subject}</span></> : r.kind === 'tool' ? <>It asks to use {own ? 'the workspace tool ' : ''}<span className='font-mono'>{own ?? r.subject}</span></> : <>It reached its {usd(d.budget_usd)} budget</>}</CardTitle>
      </CardHeader>
      <CardContent className='flex flex-col gap-3 px-4'>
        <p className='text-muted-foreground text-sm'>
          {r.kind === 'web' ? <>Approve lets this session read <span className='font-mono'>{r.subject}</span>, and nothing else new. {typeof r.detail.url === 'string' ? <>It wanted <span className='font-mono break-all'>{r.detail.url}</span>. </> : null}What it reads is treated as untrusted. Decline tells it no; it parks and is told at the next message.</>
            : r.kind === 'tool' && own ? <>It changes this workspace&apos;s records, as {d.reach?.acts_as.kind === 'person' ? (d.mine ? 'you' : (d.reach.acts_as.name ?? 'the person who started it')) : 'the account'}. Approve lets this session use <span className='font-mono'>{own}</span> from now on, and it continues; Decline tells it no, and it parks and is told at the next message.</>
            : r.kind === 'tool' ? <>Approve lets this session use {r.subject} from now on. Decline tells it no; it parks and is told at the next message.</>
              : <>It spent {usd(d.spent_usd)}. Raise its budget to let it continue where it stopped (up to {usd(d.ceiling_usd)}).</>}
          {r.expires_at ? <> Unanswered, the request expires <When d={r.expires_at} />.</> : null}
        </p>
        {own && typeof r.detail.input === 'string' && r.detail.input !== '{}' && (
          <div className='grid gap-1'><span className='text-muted-foreground text-xs'>What it wanted to send</span>
            <pre className='bg-muted/40 max-h-40 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap break-all' data-agent-request-input=''>{prettyInput(r.detail.input)}</pre></div>
        )}
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
  const r = d.reach;
  const free = r?.tools.filter((t) => !t.asks) ?? [], asks = r?.tools.filter((t) => t.asks) ?? [];
  const toolName = (t: Reach['tools'][number]) => <span key={t.name} className='inline-flex items-center gap-1'><span className='font-mono text-xs'>{t.name}</span>{t.title && t.title !== t.name ? <span className='text-muted-foreground'>({t.title})</span> : null}</span>;
  const list = (ts: Reach['tools']) => ts.length ? <span className='flex flex-wrap gap-x-3 gap-y-1'>{ts.map(toolName)}</span> : <span className='text-muted-foreground'>None</span>;
  const chars = (n: number) => `${n.toLocaleString('en')} character${n === 1 ? '' : 's'}`;
  return (
    <details className='rounded-lg border px-3 py-2 text-sm' data-agent-details=''>
      <summary className='cursor-pointer font-medium'>How this session runs</summary>
      <dl className='mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]' data-agent-profile-terms=''>
        <dt className='text-muted-foreground'>Profile</dt>
        <dd data-agent-profile-name=''>{d.profile ? <>{d.profile.name}, version {d.profile.version}<span className='text-muted-foreground block text-xs'>Fixed when it started: a later change to the profile applies to new sessions.</span></> : <span className='text-muted-foreground'>None: it started before profiles, with the platform settings of the time</span>}</dd>
        {d.record && <><dt className='text-muted-foreground'>Started from</dt><dd data-agent-record=''>{d.workspace ? <span className='font-mono text-xs'>{d.record.key}</span> : <a className='underline-offset-4 hover:underline' href={`/app/records/${encodeURIComponent(d.record.area)}/${encodeURIComponent(d.record.key)}`}>{d.record.key}</a>} <span className='text-muted-foreground text-xs'>({d.record.area})</span></dd></>}
        {(d.policy.credentials?.length ?? 0) > 0 && <><dt className='text-muted-foreground'>Credentials it receives</dt><dd data-agent-credentials=''><span className='flex flex-wrap gap-x-3 gap-y-1'>{d.policy.credentials!.map((c) => <span key={c} className='font-mono text-xs'>{c.split('/')[1] ?? c}</span>)}</span><span className='text-muted-foreground block text-xs'>Given to each wake from the workspace&apos;s credentials, hidden from what it writes.</span></dd></>}
        {(d.policy.files?.length ?? 0) > 0 && <><dt className='text-muted-foreground'>Files it was given</dt><dd data-agent-files=''><span className='flex flex-wrap gap-x-3 gap-y-1'>{d.policy.files!.map((f) => <span key={f} className='font-mono text-xs'>{f}</span>)}</span></dd></>}
        {(d.policy.hidden_tools?.length ?? 0) > 0 && <><dt className='text-muted-foreground'>Hidden from it</dt><dd data-agent-tools-hidden=''><span className='flex flex-wrap gap-x-3 gap-y-1'>{d.policy.hidden_tools!.map((t) => <span key={t} className='font-mono text-xs'>{t}</span>)}</span></dd></>}
      </dl>
      <h3 className='mt-4 font-medium'>What it reaches of this workspace</h3>
      {r ? (
        <dl className='mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]' data-agent-reach=''>
          <dt className='text-muted-foreground'>Acts as</dt>
          <dd>{r.acts_as.kind === 'person' ? <>{d.mine ? 'You' : (r.acts_as.name ?? 'The person who started it')}{r.acts_as.role ? `, with the ${r.acts_as.role} role` : ''}: it sees only this workspace, and only what that person may (their role is checked again on every call)</> : "The workspace's account key: it sees only this workspace"}</dd>
          <dt className='text-muted-foreground'>Uses without asking</dt><dd data-agent-tools-free=''>{list(free)}</dd>
          <dt className='text-muted-foreground'>Asks first</dt><dd data-agent-tools-ask=''>{list(asks)}{asks.length > 0 && <span className='text-muted-foreground mt-1 block text-xs'>Calling one stops the session until you approve or decline it.</span>}</dd>
          <dt className='text-muted-foreground'>Context it was given</dt>
          <dd data-agent-context=''>
            <ul className='flex flex-col gap-1'>
              {r.context.parts.map((p) => <li key={p.part}>{p.label}: {p.chars === 0 ? 'none' : p.kept < p.chars ? `${chars(p.kept)} of ${chars(p.chars)} (shortened)` : chars(p.chars)}</li>)}
            </ul>
            <span className='text-muted-foreground mt-1 block text-xs'>At most {chars(r.context.max_chars)} in all, fixed when it started. It can search memory with its tools for more.</span>
          </dd>
        </dl>
      ) : <p className='text-muted-foreground mt-1'>Nothing: it started before sessions could reach the workspace, and works in its own directory only.</p>}
      <h3 className='mt-4 font-medium'>Its own limits</h3>
      <dl className='mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]'>
        <dt className='text-muted-foreground'>Turns per wake</dt><dd>{d.policy.max_turns}</dd>
        <dt className='text-muted-foreground'>Longest wake</dt><dd>{d.policy.wake_max_minutes} minutes</dd>
        <dt className='text-muted-foreground'>Parks after</dt><dd>{d.policy.park_after_minutes} quiet minutes</dd>
        <dt className='text-muted-foreground'>Web</dt><dd>{d.policy.web_tools === 'off' ? 'Off' : `${d.policy.web_tools === 'search' ? 'Search and read' : 'Read'}: ${d.policy.web_hosts.join(', ') || 'asks for each host'} (${d.web_calls} of ${d.policy.web_calls_max} calls)`}</dd>
        <dt className='text-muted-foreground'>Its own tools</dt><dd>{d.policy.tools.join(', ')}</dd>
        <dt className='text-muted-foreground'>After a crash</dt><dd>{d.policy.auto_resume ? 'Continues by itself' : 'Continues at the next message'} (at most {d.policy.crash_resumes} in a row)</dd>
        <dt className='text-muted-foreground'>Instructions</dt><dd>{d.hooks.map((h) => `${h.event === 'on_start' ? 'On start' : h.event === 'on_resume' ? 'On resume' : 'Standing'}: ${h.source === 'unset' ? 'none' : h.source === 'harness' ? "the harness's own" : h.source === 'profile' ? "its profile's" : "this session's"}`).join(' · ')}{r ? ', and the workspace context above' : ''}</dd>
      </dl>
      {d.grants.length > 0 && <div className='mt-3'><p className='font-medium'>Budget raises</p><ul className='mt-1 flex flex-col gap-1'>{d.grants.map((g) => <li key={g.id}>{usd(g.from_usd)} to {usd(g.to_usd)} by {g.by}, <When d={g.at} />: {g.reason}</li>)}</ul></div>}
      {d.wakes_list.length > 0 && <div className='mt-3'><p className='font-medium'>Wakes</p><ul className='mt-1 flex flex-col gap-1'>{d.wakes_list.map((w, i) => <li key={w.run_id} className='flex flex-wrap gap-x-2'>{featureOn('record_pages') ? <Link href={`/app/runs/${encodeURIComponent(w.run_id)}`} className='underline-offset-4 hover:underline' data-wake-run={w.run_id}>Wake {i + 1}</Link> : <span>Wake {i + 1}</span>}<span>{w.status}</span>{w.end_reason && <span className='text-muted-foreground'>{w.end_reason}</span>}<span className='tabular-nums'>{usd(w.cost_usd)}</span></li>)}</ul></div>}
      {d.requests.filter((r) => r.status !== 'pending').length > 0 && <div className='mt-3'><p className='font-medium'>Decisions</p><ul className='mt-1 flex flex-col gap-1'>{d.requests.filter((r) => r.status !== 'pending').map((r) => <li key={r.id}>{askWords(r)}: {r.status}{r.decided_by ? ` by ${r.decided_by}` : ''}{r.reason ? ` (${r.reason})` : ''}</li>)}</ul></div>}
    </details>
  );
}
