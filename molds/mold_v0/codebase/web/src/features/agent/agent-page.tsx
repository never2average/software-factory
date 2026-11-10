'use client';
// The workspace agent (mold_v0-243; src/agent-routes.ts at /api/agent, staff /api/admin/onboarding/agent): its sessions
// as the standard list, full page (four cards, the search row with Start a session, the table), and a session opened as
// the whole content area (mold_v0-287, the operator's exception to the row-click side panel: no list beside it, Back to
// sessions, ?session=<id> kept): the trace of everything it does, streamed live and full screen, with the conversation as
// entries of the same stream and a composer pinned over its bottom edge to steer it (session-trace.tsx; the layout the
// reference product's agent screens use). What it asks for (Approve or Decline, and Raise budget), Pause,
// Resume and Stop, its budget (Add $5, Add $10, Set budget…, Spending by wake) and How this session runs (what it reaches of
// the workspace: its tools, which ask first, the context it was given; mold_v0-250, behind a menu item since mold_v0-287)
// are the session's ⋯ menu and the row's. The top bar's agent icon opens this page, and a session is ?session=<id> on it.
// One exception to the console's full-card rule, the operator's (mold_v0-249): Start a session opens as a modal dialog
// (the first message, the model, the budget, Start), then the new session. mold_v0-261: the dialog offers the agent profiles this person
// may start (src/agent-profiles.ts; staff set them up in Admin › Agent profiles), each with its model and budget; a list's
// start_agent action opens it with its profile and first message (?start=<profile>&message=...), and a session's card says
// which profile and version it runs with, and the record it was started from.
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { tokens, TraceStream, useTrace } from './session-trace';
import { AgentComposer } from './composer/agent-composer';
import { useAgentDock, type DockCheckpoint } from './dock/right-dock';
import { setBreadcrumbLeaf } from '@/lib/breadcrumb-leaf';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { featureOn } from '@/config/features';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { RecordView, type RecordCol, type RowAction } from '@/components/layout/record-view';
import { PanelMenu } from '@/components/layout/detail-panel';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { StatStrip } from '@/components/layout/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { ErrorState, FormRow, LoadingCards, When, fail } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { ToolbarAction } from '@/features/tabs/tab-action';

export type Area = 'app' | 'admin';
type Phase = 'starting' | 'working' | 'waiting' | 'parked' | 'waking' | 'paused' | 'awaiting_approval' | 'stopped' | 'failed' | 'archived';
interface Request { id: string; kind: 'web' | 'tool' | 'budget'; subject: string; subject_title: string; detail: Record<string, unknown>; status: string; decided_by: string | null; decided_at: string | null; reason: string | null; created_at: string; expires_at: string | null }
interface Session {
  id: string; /** mold_v0-290: its short number in its workspace (AGI-001). */ ref: string; title: string; phase: Phase; reason: string | null; mode: 'conversation' | 'task'; started_by: string | null; mine: boolean;
  workspace?: { id: number; slug: string | null };
  harness: { flavour: string; label: string; model: string; provider: string; steerable: boolean };
  budget_usd: number; spent_usd: number; remaining_usd: number; ceiling_usd: number; reserve_usd: number; wakes: number; crashes: number; web_calls: number;
  pause_requested: boolean; stop_requested: boolean; pending_request: Request | null; created_at: string; last_activity_at: string; ended_at: string | null;
  archived_at: string | null; pruned: boolean; can: { message: boolean; pause: boolean; resume: boolean; stop: boolean; decide: boolean; raise: boolean };
  /** mold_v0-287: whether this person may change its budget (and why not), and the least it may be set to. */
  budget_change: { allowed: boolean; why: string | null; floor_usd: number };
  /** mold_v0-261: the agent profile and the version it froze, and the record it was started from. */
  profile?: { id: string; name: string; version: number } | null;
  record?: { area: string; key: string } | null;
}
interface Detail extends Session {
  messages: { id: number; role: 'person' | 'agent' | 'system'; body: string; status: string | null; by: string | null; cost_usd: number | null; at: string; run_id: string | null }[];
  requests: Request[]; grants: { id: string; from_usd: number; to_usd: number; reason: string; by: string; at: string }[];
  wakes_list: { run_id: string; status: string; started_at: string | null; ended_at: string | null; cost_usd: number; end_reason: string | null; error: string | null; input_tokens: number; output_tokens: number }[];
  hooks: { event: string; source: string; text: string | null }[];
  policy: { max_turns: number; wake_max_minutes: number; park_after_minutes: number; web_tools: string; web_hosts: string[]; web_calls_max: number; tools: string[]; auto_resume: boolean; crash_resumes: number;
    files?: string[]; hidden_tools?: string[]; credentials?: string[]; executables?: string[]; governance?: string | null;
    /** mold_v0-271: the workspace recipes it started with, at their frozen versions. */
    recipes?: { id: string; name: string; version: number }[] };
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
interface StartProfile { id: string; name: string; description: string; version: number; is_default: boolean; model: string; budget: { default_usd: number; max_usd: number; ceiling_usd: number }; harness?: string; keys?: number; uploads: number; governance?: string }
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
const askWords = (r: Request) => r.kind === 'web' ? `Reach ${r.subject}` : r.kind === 'tool' ? `Use ${r.subject_title}` : `More budget (at ${r.subject})`;

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
    window.history.pushState(null, '', u.toString());
  };
  // The Agents crumb and a link keep the address's word (mold_v0-290: the breadcrumb is the way back to the list).
  useEffect(() => { setOpenState(params.get('session')); }, [params]);
  useEffect(() => {
    const h = () => setOpenState(new URLSearchParams(window.location.search).get('session'));
    window.addEventListener('popstate', h);
    return () => window.removeEventListener('popstate', h);
  }, []);
  const budget = useBudgetDialogs(call, load);
  if (error) return <PageContainer><ErrorState error={error} /></PageContainer>;
  // mold_v0-287: an open session is the whole content area: no list beside it (the operator's exception to the side panel).
  if (open) return (<PageContainer>
    <SessionFull key={open} area={area} id={open} call={call} onChange={load} onOpenSession={setOpen} budget={budget} />
    {budget.dialogs}
  </PageContainer>);
  const rows = data?.sessions ?? [];
  const cols: RecordCol<Session>[] = [
    { key: 'ref', label: 'Number', type: 'text', keep: true, value: (s) => s.ref, render: (s) => <span className='font-mono text-xs whitespace-nowrap' data-agent-ref=''>{s.ref}</span> },
    { key: 'title', label: 'Session', title: true, keep: true, type: 'text', className: 'min-w-56', value: (s) => s.title,
      render: (s) => <span className='leading-snug font-medium'>{s.title}</span> },
    { key: 'phase', label: 'Status', type: 'select', keep: true, options: Object.entries(PHASE_WORDS).map(([value, label]) => ({ value, label })), value: (s) => s.phase, render: (s) => <PhaseBadge s={s} /> },
    ...(area === 'admin' ? [{ key: 'workspace', label: 'Workspace', type: 'text' as const, value: (s: Session) => s.workspace?.slug ?? '', render: (s: Session) => <span className='font-mono text-xs'>{s.workspace?.slug}</span> }] : []),
    { key: 'started_by', label: 'Started by', type: 'text', value: (s) => s.started_by ?? '', render: (s) => <span className='break-all'>{s.mine ? 'You' : s.started_by}</span> },
    { key: 'waiting_on', label: 'Waiting on', type: 'text', value: (s) => (s.pending_request ? askWords(s.pending_request) : ''),
      render: (s) => (s.pending_request ? <span className='text-amber-700 dark:text-amber-300'>{askWords(s.pending_request)}</span> : '') },
    { key: 'spent', label: 'Spent', type: 'number', value: (s) => s.spent_usd, render: (s) => <span className='tabular-nums'>{usd(s.spent_usd)} <span className='text-muted-foreground'>of {usd(s.budget_usd)}</span></span> },
    { key: 'activity', label: 'Last activity', type: 'date', keep: true, value: (s) => s.last_activity_at, render: (s) => <When d={s.last_activity_at} /> },
    { key: 'wakes', label: 'Runs', type: 'number', value: (s) => s.wakes, render: (s) => String(s.wakes) }
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
        searchText={(s) => `${s.ref} ${s.title} ${PHASE_WORDS[s.phase]} ${s.started_by ?? ''} ${s.workspace?.slug ?? ''} ${s.pending_request ? askWords(s.pending_request) : ''}`}
        searchPlaceholder='Search sessions'
        toolbarAction={area === 'app' && data?.can_start ? <div className='ml-auto flex shrink-0 gap-2'><ToolbarAction label='Start a session' icon={<Icons.add />} onClick={() => setStarting(true)} /></div> : undefined}
        empty={<p className='text-muted-foreground text-sm'>{area === 'app' ? (data?.can_start ? 'No sessions yet: Start a session gives the agent its first message.' : 'No sessions yet. A member of this workspace can start one.') : 'No workspace has started a session yet.'}</p>}
        detail={() => null}
        actions={(s) => budget.items(s)}
      />
      {budget.dialogs}
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
type ComposerSend = import('./composer/agent-composer').ComposerSend;

function StartDialog({ open, profiles, preset, call, onOpenChange, onStarted }: {
  open: boolean; offer: Offer; profiles: StartProfile[]; preset: { profile: string | null; message: string | null }; call: Call; onOpenChange: (o: boolean) => void; onStarted: (id: string) => void;
}) {
  // mold_v0-261: the profile chosen (the preset's when it is one this person may start, else the first: the Default).
  const first = profiles.find((p) => p.id === preset.profile) ?? profiles[0] ?? null;
  const [profileId, setProfileId] = useState<string | null>(first?.id ?? null);
  const profile = profiles.find((p) => p.id === profileId) ?? null;
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setMessage(preset.message ?? ''); setProfileId(first?.id ?? null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async (c: ComposerSend): Promise<boolean> => {
    setBusy(true);
    try {
      // Operator, 2026-11-09: the popup is the task and the message; the rest keep their defaults (the profile's default budget, a
      // conversation, a title from its first words). mold_v0-290: and what the composer carries.
      const r = await call<{ session: Session }>('POST', '', { message: c.message, mode: 'conversation', files: c.files, repositories: c.repositories, ...(profile ? { profile: profile.id } : {}) });
      toast.success('Started'); onStarted(r.session.id);
      return true;
    } catch (e) { fail(e); return false; } finally { setBusy(false); }
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
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl' data-agent-start-dialog='' onKeyDown={keepTabInside}
        finalFocus={() => document.querySelector<HTMLElement>("[data-toolbar-action][aria-label='Start a session']")}>
        <div className='grid gap-4'>
          <DialogHeader>
            <DialogTitle>Start a session</DialogTitle>
            <DialogDescription className='sr-only'>Choose the task and say what the agent should do. The round button starts it.</DialogDescription>
          </DialogHeader>
          {profiles.length > 0 && (
            <FormRow label='Task' htmlFor='agent-start-profile'>
              <NativeSelect id='agent-start-profile' className='w-full' value={profileId ?? ''} onChange={(e) => setProfileId(e.target.value)} data-agent-start-profile=''>
                {profiles.map((p) => <NativeSelectOption key={p.id} value={p.id}>{p.name}</NativeSelectOption>)}
              </NativeSelect>
            </FormRow>
          )}
          <FormRow label='What should the agent do?' htmlFor='agent-start-message'>
            <AgentComposer id='agent-start-message' label='What should the agent do?' value={message} onChange={setMessage} autoFocus session={null} busy={busy} disabledReason={null} sendLabel='Start'
              placeholder="Summarise this workspace's records and say what needs attention first." onSend={submit} />
          </FormRow>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The session's ⋯ menu (mold_v0-278): Pause, Resume, Stop (asked first), then its budget actions and How this session runs. */
function Controls({ area, s, call, onChange, budget, extra = [] }: { area: Area; s: Session; call: Call; onChange: () => unknown; budget: BudgetDialogs; extra?: RowAction[] }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = (what: 'pause' | 'resume' | 'stop') => async () => {
    setBusy(true);
    try { await call('POST', `/${s.id}/${what}`); toast.success(what === 'pause' ? 'Pausing' : what === 'resume' ? 'Resuming' : 'Stopping'); setConfirm(false); await onChange(); window.dispatchEvent(new Event('agent-session-changed')); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  const items: RowAction[] = [
    ...(s.can.pause ? [{ label: 'Pause', icon: <Icons.pause />, disabled: busy, onSelect: () => void act('pause')() }] : []),
    ...(area === 'app' && s.can.resume ? [{ label: 'Resume', icon: <Icons.play />, disabled: busy, onSelect: () => void act('resume')() }] : []),
    ...(s.can.stop ? [{ label: 'Stop', icon: <Icons.stop />, destructive: true, disabled: busy, onSelect: () => setConfirm(true) }] : []),
  ];
  const budgetItems = budget.items(s).map((a, i) => (i === 0 && items.length ? { ...a, separator: true } : a));
  return (<>
    <PanelMenu name={s.title} items={[...items, ...budgetItems, ...extra.map((a, i) => (i === 0 ? { ...a, separator: true } : a))]} />
    <AlertDialog open={confirm} onOpenChange={setConfirm}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop this session for good?</AlertDialogTitle>
          <AlertDialogDescription>It finishes its step and becomes read only.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant='destructive' disabled={busy} onClick={() => void act('stop')()}>Stop session</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>);
}

/** The budget actions shared by the session's ⋯ menu and the row's (mold_v0-287). */
interface BudgetDialogs { items: (s: Session) => RowAction[]; dialogs: ReactNode }

function useBudgetDialogs(call: Call, onChange: () => unknown): BudgetDialogs {
  const [dialog, setDialog] = useState<{ kind: 'set' | 'spending'; s: Session } | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = async () => { await onChange(); window.dispatchEvent(new Event('agent-session-changed')); };
  const add = async (s: Session, n: number) => {
    setBusy(true);
    try { await call('POST', `/${s.id}/budget`, { by_usd: n, reason: `Added $${n} from the session's menu` }); toast.success(`Added $${n}`); await changed(); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  const hint = (s: Session, n: number) => !s.budget_change.allowed ? (s.budget_change.why?.startsWith('Needs') ? 'Owner or billing only' : 'Session ended') : s.budget_usd + n > s.ceiling_usd + 1e-9 ? `Limit is ${usd(s.ceiling_usd)}` : undefined;
  const items = (s: Session): RowAction[] => [
    { label: 'Add $5', icon: <Icons.coin />, disabled: busy || !!hint(s, 5), hint: hint(s, 5), onSelect: () => void add(s, 5) },
    { label: 'Add $10', icon: <Icons.coin />, disabled: busy || !!hint(s, 10), hint: hint(s, 10), onSelect: () => void add(s, 10) },
    { label: 'Set budget…', icon: <Icons.coin />, disabled: !s.budget_change.allowed, hint: !s.budget_change.allowed ? (s.budget_change.why?.startsWith('Needs') ? 'Owner or billing only' : 'Session ended') : undefined, onSelect: () => setDialog({ kind: 'set', s }) },
    { label: 'Spending by run', icon: <Icons.history />, onSelect: () => setDialog({ kind: 'spending', s }) },
  ];
  const close = (o: boolean) => { if (!o) setDialog(null); };
  const dialogs = dialog && (dialog.kind === 'set'
    ? <SetBudgetDialog key={dialog.s.id} s={dialog.s} call={call} onChanged={changed} onOpenChange={close} />
    : <SpendingDialog key={dialog.s.id} id={dialog.s.id} title={dialog.s.title} call={call} onOpenChange={close} />);
  return { items, dialogs };
}

/** Set budget…: an amount and a reason; never above the session's ceiling, never below what it has spent. */
function SetBudgetDialog({ s, call, onChanged, onOpenChange }: { s: Session; call: Call; onChanged: () => unknown; onOpenChange: (o: boolean) => void }) {
  const [amount, setAmount] = useState(String(s.budget_usd));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const to = Number(amount);
  const floor = s.budget_change.floor_usd;
  const problem = !amount.trim() || !Number.isFinite(to) ? 'Enter an amount in dollars'
    : to < floor ? `Not below what it has spent (${usd(floor)})`
      : to > Math.max(s.budget_usd, s.ceiling_usd) + 1e-9 ? `At most ${usd(s.ceiling_usd)} for this session`
        : Math.abs(to - s.budget_usd) < 0.005 ? 'That is its budget now'
          : !reason.trim() ? 'Say why (it is kept with the change)' : null;
  const submit = async () => {
    if (problem) return;
    setBusy(true);
    try { await call('POST', `/${s.id}/budget`, { to_usd: to, reason }); toast.success(to > s.budget_usd ? 'Budget raised' : 'Budget lowered'); await onChanged(); onOpenChange(false); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className='sm:max-w-md' data-agent-set-budget=''>
        <form className='grid gap-4' onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <DialogHeader>
            <DialogTitle>Set budget</DialogTitle>
            <DialogDescription>{usd(s.spent_usd)} spent of {usd(s.budget_usd)}. Between {usd(floor)} and {usd(s.ceiling_usd)}.</DialogDescription>
          </DialogHeader>
          <FormRow label='Budget (USD)' htmlFor='agent-set-budget-amount'>
            <Input id='agent-set-budget-amount' type='number' min={floor} max={s.ceiling_usd} step='0.5' value={amount} autoFocus onChange={(e) => setAmount(e.target.value)} className='w-40' />
          </FormRow>
          <FormRow label='Why (kept with the change)' htmlFor='agent-set-budget-reason'>
            <Input id='agent-set-budget-reason' value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormRow>
          {problem && amount.trim() && <p className='text-muted-foreground text-sm' role='status'>{problem}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type='submit' disabled={busy || !!problem}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Spending by run: what each wake (run) cost and how many tokens it used. */
function SpendingDialog({ id, title, call, onOpenChange }: { id: string; title: string; call: Call; onOpenChange: (o: boolean) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  useEffect(() => { void call<{ session: Detail }>('GET', `/${id}`).then((r) => setD(r.session), fail); }, [call, id]);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg' data-agent-spending=''>
        <DialogHeader>
          <DialogTitle>Spending by run</DialogTitle>
          <DialogDescription>{title}</DialogDescription>
        </DialogHeader>
        {!d ? <p className='text-muted-foreground text-sm'>Reading…</p> : d.wakes_list.length === 0 ? <p className='text-muted-foreground text-sm'>It has not run yet.</p> : (
          <div className='max-h-[60vh] overflow-y-auto'>
            <table className='w-full text-sm tabular-nums'>
              <thead><tr className='text-muted-foreground border-b text-left text-xs'><th className='py-1 font-medium'>Run</th><th className='py-1 font-medium'>Status</th><th className='py-1 text-right font-medium'>Tokens in</th><th className='py-1 text-right font-medium'>Tokens out</th><th className='py-1 text-right font-medium'>Cost</th></tr></thead>
              <tbody>{d.wakes_list.map((w, i) => (
                <tr key={w.run_id} className='border-b last:border-b-0' data-wake-spend={w.run_id}>
                  <td className='py-1.5'>Run {i + 1}</td>
                  <td className='py-1.5'>{w.status}{w.end_reason ? <span className='text-muted-foreground'> ({w.end_reason})</span> : null}</td>
                  <td className='py-1.5 text-right'>{tokens(w.input_tokens)}</td>
                  <td className='py-1.5 text-right'>{tokens(w.output_tokens)}</td>
                  <td className='py-1.5 text-right'>{usd(w.cost_usd)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <DialogFooter><Button variant='outline' onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One session, as the whole content area (mold_v0-287; mold_v0-290: reached and left by the top bar's breadcrumb): its state and spend, then the trace, the session's
 * primary view (session-trace.tsx: streamed, the conversation in it), and the composer pinned over its bottom edge.
 */
function SessionFull({ area, id, call, onChange, onOpenSession, budget }: { area: Area; id: string; call: Call; onChange: () => unknown; onOpenSession: (id: string) => void; budget: BudgetDialogs }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [howOpen, setHowOpen] = useState(false);
  const load = useCallback(() => call<{ session: Detail }>('GET', `/${id}`).then((r) => { setD(r.session); setError(null); }, (e: Error) => setError(e)), [call, id]);
  useEffect(() => { void load(); const h = () => void load(); window.addEventListener('agent-session-changed', h); return () => window.removeEventListener('agent-session-changed', h); }, [load]);
  // The stream tells it when the phase or spend moved (the trace itself comes down the stream); this catches anything else.
  useEffect(() => { const t = setInterval(() => void load(), 15000); return () => clearInterval(t); }, [load]);
  const streamUrl = area === 'admin' ? `/api/admin/onboarding/agent/${id}/trace/stream` : `/api/agent/${id}/trace/stream`;
  const trace = useTrace(call, streamUrl, id, () => void load());
  const live = !!d && LIVE.includes(d.phase);
  const [dockH, setDockH] = useState(0);
  const dockRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = dockRef.current;
    if (!el) { setDockH(0); return; }
    setDockH(el.offsetHeight);
    const ro = new ResizeObserver(() => setDockH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [d?.id]);
  const changed = async () => { await load(); await onChange(); };
  // mold_v0-292 (flag nested_runs): the right dock beside the conversation; the chat bar is in the conversation's own column.
  const [prefill, setPrefill] = useState<{ text: string; at: number } | null>(null);
  const checkpoints = useMemo<DockCheckpoint[]>(() => (d?.messages ?? []).filter((m) => m.role !== 'system').map((m) => ({ id: m.id, role: m.role as DockCheckpoint['role'], label: m.body.replace(/\s+/g, ' ').slice(0, 120) })).reverse(), [d?.messages]);
  const dock = useAgentDock({ enabled: area === 'app' && featureOn('nested_runs'), call, sessionId: id, checkpoints, onAsk: (text) => setPrefill({ text, at: Date.now() }), onOpenSession });
  // mold_v0-290: the session is a level of the top bar's breadcrumb (Account / Agents / AGI-001): that is the way back.
  const ref = d?.ref ?? null;
  useEffect(() => { setBreadcrumbLeaf(ref); return () => setBreadcrumbLeaf(null); }, [ref]);
  if (error) return <ErrorState error={error} />;
  if (!d) return <LoadingCards count={2} />;
  // The last model call failed and nothing has answered since: say so where the person is looking.
  const lastModel = [...trace.steps].reverse().find((s) => s.kind === 'model' && s.http_status !== undefined);
  const failing = live && lastModel?.status === 'error' ? (lastModel.error ?? 'The last model call failed.') : null;
  return (
    <div className='flex h-[calc(100svh-5.5rem)] min-h-[24rem]' data-agent-session-page=''>
    <div className='flex min-w-0 flex-1 flex-col gap-2' data-agent-session={d.id} data-phase={d.phase}>
      <div className='flex items-center gap-2 sm:gap-3' data-agent-session-bar=''>
        <h1 className='min-w-0 flex-1 truncate text-base font-medium' title={d.title}>{d.title}</h1>
        {dock.phoneButton}
        <Controls area={area} s={d} call={call} onChange={changed} budget={budget}
          extra={[{ label: 'How this session runs', icon: <Icons.settings />, onSelect: () => setHowOpen(true) }]} />
      </div>
      {d.reason && !d.pending_request && d.phase !== 'awaiting_approval' && !['idle', 'paused', 'withdrawn', 'budget', 'continued'].includes(d.reason) && <p className='text-muted-foreground text-sm' data-agent-reason>{reasonWords(d.reason)}</p>}
      <TraceStream sessionId={d.id} call={call} steps={trace.steps} waitingOn={trace.waitingOn} connected={trace.connected} live={live} pruned={d.pruned} dockHeight={dockH}
        dock={<div ref={dockRef} className='bg-background/80 absolute inset-x-0 bottom-0 z-20 px-1 pt-2 pb-1 backdrop-blur-sm' data-agent-dock=''>
          <div className='mx-auto flex w-full max-w-4xl flex-col gap-2'>
            {d.pending_request && <RequestBar d={d} r={d.pending_request} call={call} onDone={changed} />}
            <Composer area={area} d={d} call={call} onSent={changed} onOpenSession={onOpenSession} waitingOn={trace.waitingOn} failing={failing} prefill={prefill} />
          </div>
        </div>} />
      <Dialog open={howOpen} onOpenChange={setHowOpen}>
        <DialogContent className='max-h-[85dvh] overflow-y-auto sm:max-w-2xl' data-agent-how=''>
          <DialogHeader>
            <DialogTitle>How this session runs</DialogTitle>
            <DialogDescription className='sr-only'>What it reaches, its limits, its wakes and its decisions.</DialogDescription>
          </DialogHeader>
          <Details d={d} />
        </DialogContent>
      </Dialog>
    </div>
    {dock.column}
    </div>
  );
}

const REASON_WORDS: Record<string, string> = {
  parked: 'It went quiet and parked. A message wakes it.', paused: 'It is paused. A message wakes it.', stopped: 'This session was stopped.', done: 'It finished its work.', failed: 'It failed.',
  'web calls used up': 'It used up its web calls.', 'budget raised': 'Its budget was raised.', policy: 'Its governance policy refused a call.',
};
/** What ended or parked a session, in one plain sentence (never the bare state word). */
const reasonWords = (r: string) => REASON_WORDS[r] ?? (r.startsWith('crashed: ') ? `It stopped unexpectedly: ${r.slice(9)}.` : r.startsWith('declined: ') ? `Declined: ${r.slice(10)}.`
  : r.startsWith('approved: ') ? `Approved: ${r.slice(10)}.` : r.startsWith('expired: ') ? `Nobody answered in time: ${r.slice(9)}.`
    : r.startsWith('egress_approval_denied: ') ? `It was not allowed to reach ${r.slice(24)}, so it ended.` : r.startsWith('approval_timeout: ') ? `Nobody answered in time about ${r.slice(18)}, so it ended.`
      : r.startsWith('policy: ') ? `Its governance policy refused a call: ${r.slice(8)}.` : `${r.charAt(0).toUpperCase()}${r.slice(1)}${/[.!?]$/.test(r) ? '' : '.'}`);

/**
 * What the agent asked for, pinned just above the chat bar (never in a scrolled card; phone too): one sentence and its
 * buttons always in view, Details opening what it wanted, the reason and the budget form in a capped area of their own.
 */
function RequestBar({ d, r, call, onDone }: { d: Detail; r: Request; call: Call; onDone: () => unknown }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const decide = (decision: 'approve' | 'decline') => async () => {
    setBusy(true);
    try { await call('POST', `/${d.id}/requests/${r.id}`, { decision, reason: reason || undefined }); toast.success(decision === 'approve' ? 'Approved: it continues' : 'Declined'); await onDone(); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  const icon = r.kind === 'web' ? <Icons.world /> : r.kind === 'tool' ? <Icons.tool /> : <Icons.coin />;
  const what = r.kind === 'web' ? <>It asks to read <span className='font-mono'>{r.subject}</span></> : r.kind === 'tool' ? <>It asks to use {r.subject_title}</> : <>It reached its {usd(d.budget_usd)} budget</>;
  const who = r.kind === 'budget' ? (d.can.raise ? null : 'A billing manager or an owner of the workspace can raise it.') : d.can.decide ? null : 'The person who started this session or an owner decides.';
  const hasInput = r.kind === 'tool' && typeof r.detail.input === 'string' && r.detail.input !== '{}';
  return (
    <div className='bg-background flex flex-col gap-2 rounded-xl border border-amber-500/50 p-2.5 shadow-sm' data-approval-card='' role='region' aria-label='The agent is asking'>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
        <span className='flex min-w-0 flex-[1_1_10rem] items-start gap-2 text-sm font-medium'>
          <span className='mt-0.5 shrink-0 text-amber-600 dark:text-amber-400 [&_svg]:size-4' aria-hidden>{icon}</span>
          <span className='min-w-0 break-words'>{what}</span>
        </span>
        <div className='flex shrink-0 flex-wrap items-center gap-2 max-sm:w-full' data-approval-buttons=''>
          <Button size='sm' variant='outline' aria-expanded={open} className='max-sm:mr-auto' onClick={() => setOpen((o) => !o)}>Details</Button>
          {r.kind === 'budget'
            ? d.can.raise && <Button size='sm' onClick={() => setOpen(true)}><Icons.coin />Raise budget</Button>
            : d.can.decide && <>
              <Button size='sm' variant='outline' disabled={busy} onClick={decide('decline')}>Decline</Button>
              <Button size='sm' disabled={busy} onClick={decide('approve')}>Approve</Button>
            </>}
        </div>
      </div>
      {who && <p className='text-muted-foreground text-xs'>{who}</p>}
      {open && (
        <div className='flex max-h-[38dvh] flex-col gap-3 overflow-y-auto border-t pt-2.5 text-sm' data-approval-details=''>
          <p className='text-muted-foreground'>
            {r.kind === 'web' ? <>Approve lets this session read <span className='font-mono'>{r.subject}</span>, and nothing else new. {typeof r.detail.url === 'string' ? <>It wanted <span className='font-mono break-all'>{r.detail.url}</span>. </> : null}What it reads is treated as untrusted. Decline tells it no; it parks and is told at the next message.</>
              : r.kind === 'tool' ? <>Approve lets this session use {r.subject_title} from now on, and it continues, {d.reach?.acts_as.kind === 'person' ? (d.mine ? 'acting as you' : `acting as ${d.reach.acts_as.name ?? 'the person who started it'}`) : 'acting as the account'}. Decline tells it no; it parks and is told at the next message.</>
                : <>It spent {usd(d.spent_usd)}. Raise its budget to let it continue where it stopped (up to {usd(d.ceiling_usd)}).</>}
            {r.expires_at ? <> Unanswered, the request expires <When d={r.expires_at} />.</> : null}
          </p>
          {hasInput && (
            <div className='grid gap-1'><span className='text-muted-foreground text-xs'>What it wanted to send</span>
              <pre className='bg-muted/40 max-h-40 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap break-all' data-agent-request-input=''>{prettyInput(r.detail.input as string)}</pre></div>
          )}
          {r.kind === 'budget' ? (d.can.raise && <RaiseBudget d={d} call={call} onDone={onDone} />)
            : d.can.decide && (
              <FormRow label='Reason (optional; the agent is told it with a decline)' htmlFor={`agent-reason-${r.id}`}>
                <Input id={`agent-reason-${r.id}`} value={reason} onChange={(e) => setReason(e.target.value)} className='max-w-xl' />
              </FormRow>
            )}
        </div>
      )}
    </div>
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

/**
 * The chat bar, pinned over the trace's bottom edge (mold_v0-289: the person who started the session can always send): it
 * steers a working session, wakes a parked one, waits for a pending decision, continues an ended one. Someone else's
 * session and staff keep it visible and disabled, the reason as its placeholder: the agent acts as the person who started it.
 */
function Composer({ area, d, call, onSent, onOpenSession, waitingOn, failing, prefill }: { area: Area; d: Detail; call: Call; onSent: () => unknown; onOpenSession: (id: string) => void; waitingOn: string | null; failing: string | null; prefill?: { text: string; at: number } | null }) {
  const [text, setText] = useState('');
  // mold_v0-292: the dock's Ask about this: it puts words in the chat bar, and the person sends them.
  useEffect(() => { if (prefill) setText(prefill.text); }, [prefill]);
  const [busy, setBusy] = useState(false);
  const ended = ['stopped', 'failed', 'archived'].includes(d.phase);
  const why = d.can.message ? null
    : area === 'admin' ? 'Staff cannot message a session: the agent acts as the person who started it.'
      : !d.mine ? 'Only the person who started this session can message it.' : 'Your role cannot continue a session that has ended.';
  const send = async (c: ComposerSend): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await call<{ status: 'queued' | 'waking' | 'continued' | 'follow_on'; phase: Phase; session_id?: string }>('POST', `/${d.id}/messages`, { message: c.message, files: c.files, repositories: c.repositories });
      if (r.status === 'follow_on' && r.session_id) { toast.success('It could not be resumed, so a new session continues from here'); onOpenSession(r.session_id); return true; }
      toast.success(r.status === 'continued' ? 'Sent: this session is continuing' : r.status === 'waking' ? 'Sent: it is waking up to answer'
        : r.phase === 'awaiting_approval' ? 'Queued: it reads this once the decision is made'
          : d.phase === 'working' && d.harness.steerable ? 'Sent: it takes it at its next step' : r.phase === 'working' || r.phase === 'waiting' ? 'Sent' : 'Queued: it reads this when it next runs');
      await onSent();
      return true;
    } catch (e) { fail(e); return false; } finally { setBusy(false); }
  };
  const working = d.phase === 'working' || d.phase === 'starting' || d.phase === 'waking';
  const placeholder = d.phase === 'awaiting_approval' ? 'Type a message: it is read once the decision is made'
    : ended ? 'Send a message to continue this session'
      : d.phase === 'working' ? (d.harness.steerable ? 'Guide the agent while it works' : 'Type a message: it is read at its next run')
        : d.phase === 'parked' || d.phase === 'paused' ? 'Send a message to wake it' : 'Message the agent';
  return (
    <AgentComposer id={`agent-msg-${d.id}`} label='Message the agent' value={text} onChange={setText} placeholder={placeholder} sendLabel='Send' disabledReason={why} busy={busy} session={d.can.message ? d.id : null} onSend={send}
      above={(working || failing) && (
        <p className={cn('flex items-center gap-2 px-1 text-xs', failing ? 'text-destructive' : 'text-muted-foreground')} aria-live='polite' data-agent-working=''>
          {!failing && <span className='size-1.5 rounded-full bg-current motion-safe:animate-pulse' aria-hidden />}
          {failing ?? (waitingOn ?? (d.phase === 'working' ? 'The agent is working' : d.phase === 'waking' ? 'Waking up' : 'Starting'))}
        </p>
      )} />
  );
}

function Details({ d }: { d: Detail }) {
  const r = d.reach;
  const free = r?.tools.filter((t) => !t.asks) ?? [], asks = r?.tools.filter((t) => t.asks) ?? [];
  const toolName = (t: Reach['tools'][number]) => <span key={t.name} title={t.name}>{t.title?.trim() || t.name.replaceAll('_', ' ')}</span>;
  const list = (ts: Reach['tools']) => ts.length ? <span className='flex flex-wrap gap-x-3 gap-y-1'>{ts.map(toolName)}</span> : <span className='text-muted-foreground'>None</span>;
  const chars = (n: number) => `${n.toLocaleString('en')} character${n === 1 ? '' : 's'}`;
  return (
    <div className='text-sm' data-agent-details=''>
      <dl className=' grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]' data-agent-profile-terms=''>
        <dt className='text-muted-foreground'>Profile</dt>
        <dd data-agent-profile-name=''>{d.profile ? <>{d.profile.name}, version {d.profile.version}<span className='text-muted-foreground block text-xs'>Fixed when it started: a later change to the profile applies to new sessions.</span></> : <span className='text-muted-foreground'>None: it started before profiles, with the platform settings of the time</span>}</dd>
        {d.record && <><dt className='text-muted-foreground'>Started from</dt><dd data-agent-record=''>{d.workspace ? <span className='font-mono text-xs'>{d.record.key}</span> : <a className='underline-offset-4 hover:underline' href={`/app/records/${encodeURIComponent(d.record.area)}/${encodeURIComponent(d.record.key)}`}>{d.record.key}</a>} <span className='text-muted-foreground text-xs'>({d.record.area})</span></dd></>}
        {(d.policy.credentials?.length ?? 0) > 0 && <><dt className='text-muted-foreground'>Keys it receives</dt><dd data-agent-credentials=''><span className='flex flex-wrap gap-x-3 gap-y-1'>{d.policy.credentials!.map((c) => <span key={c} className='font-mono text-xs'>{c.split('/')[1] ?? c}</span>)}</span><span className='text-muted-foreground block text-xs'>Given to each wake from the key vault, hidden from what it writes.</span></dd></>}
        {(d.policy.files?.length ?? 0) > 0 && <><dt className='text-muted-foreground'>Files it was given</dt><dd data-agent-files=''><span className='flex flex-wrap gap-x-3 gap-y-1'>{d.policy.files!.map((f) => <span key={f} className='font-mono text-xs'>{f}</span>)}</span></dd></>}
        {(d.policy.recipes?.length ?? 0) > 0 && <><dt className='text-muted-foreground'>Recipes</dt><dd data-agent-recipes=''>{d.policy.recipes!.map((r) => `${r.name} (version ${r.version})`).join(', ')}<span className='text-muted-foreground block text-xs'>Their files are among those it was given; the versions are fixed when it started.</span></dd></>}
        {d.policy.governance && <><dt className='text-muted-foreground'>Governance policy</dt><dd data-agent-governance=''>{d.policy.governance}<span className='text-muted-foreground block text-xs'>Its profile&apos;s, fixed when it started: a call it refuses ends the session.</span></dd></>}
        {(d.policy.hidden_tools?.length ?? 0) > 0 && <><dt className='text-muted-foreground'>Hidden from it</dt><dd data-agent-tools-hidden=''><span className='flex flex-wrap gap-x-3 gap-y-1'>{d.policy.hidden_tools!.map((t) => <span key={t}>{t.replaceAll('_', ' ')}</span>)}</span></dd></>}
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
        <dt className='text-muted-foreground'>Turns per run</dt><dd>{d.policy.max_turns}</dd>
        <dt className='text-muted-foreground'>Longest run</dt><dd>{d.policy.wake_max_minutes} minutes</dd>
        <dt className='text-muted-foreground'>Parks after</dt><dd>{d.policy.park_after_minutes} quiet minutes</dd>
        <dt className='text-muted-foreground'>Web</dt><dd>{d.policy.web_tools === 'off' ? 'Off' : `${d.policy.web_tools === 'search' ? 'Search and read' : 'Read'}: ${d.policy.web_hosts.join(', ') || 'asks for each host'} (${d.web_calls} of ${d.policy.web_calls_max} calls)`}</dd>
        <dt className='text-muted-foreground'>Its own tools</dt><dd>{d.policy.tools.join(', ')}</dd>
        <dt className='text-muted-foreground'>After a crash</dt><dd>{d.policy.auto_resume ? 'Continues by itself' : 'Continues at the next message'} (at most {d.policy.crash_resumes} in a row)</dd>
        <dt className='text-muted-foreground'>Instructions</dt><dd>{d.hooks.map((h) => `${h.event === 'on_start' ? 'On start' : h.event === 'on_resume' ? 'On resume' : 'Standing'}: ${h.source === 'unset' ? 'none' : h.source === 'harness' ? "the harness's own" : h.source === 'profile' ? "its profile's" : "this session's"}`).join(' · ')}{r ? ', and the workspace context above' : ''}</dd>
      </dl>
      {d.grants.length > 0 && <div className='mt-3'><p className='font-medium'>Budget raises</p><ul className='mt-1 flex flex-col gap-1'>{d.grants.map((g) => <li key={g.id}>{usd(g.from_usd)} to {usd(g.to_usd)} by {g.by}, <When d={g.at} />: {g.reason}</li>)}</ul></div>}
      {d.wakes_list.length > 0 && <div className='mt-3'><p className='font-medium'>Runs</p><ul className='mt-1 flex flex-col gap-1'>{d.wakes_list.map((w, i) => <li key={w.run_id} className='flex flex-wrap gap-x-2'>{featureOn('record_pages') ? <Link href={`/app/runs/${encodeURIComponent(w.run_id)}`} className='underline-offset-4 hover:underline' data-wake-run={w.run_id}>Run {i + 1}</Link> : <span>Run {i + 1}</span>}<span>{w.status}</span>{w.end_reason && <span className='text-muted-foreground'>{w.end_reason}</span>}<span className='tabular-nums'>{usd(w.cost_usd)}</span></li>)}</ul></div>}
      {d.requests.filter((r) => r.status !== 'pending').length > 0 && <div className='mt-3'><p className='font-medium'>Decisions</p><ul className='mt-1 flex flex-col gap-1'>{d.requests.filter((r) => r.status !== 'pending').map((r) => <li key={r.id}>{askWords(r)}: {r.status}{r.decided_by ? ` by ${r.decided_by}` : ''}{r.reason ? ` (${r.reason})` : ''}</li>)}</ul></div>}
    </div>
  );
}
