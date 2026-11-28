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
// which profile and version it runs with, and the record it was started from. mold_v0-303 (flag nested_runs): Run a
// program beside it, a modal too: the programs this person may start (GET /api/agent/programs, src/program-start.ts),
// the chosen one's inputs as a form (its inputs schema), Run, then the session that runs it.
import { RUN_STATUSES, RUN_STATUS_WORDS, runStatusOf, STATUS_TONE } from '@/lib/run-status';
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { tokens, TraceStream, useTrace } from './session-trace';
import { AgentComposer } from './composer/agent-composer';
import { AgentWelcome, openedFromWords, quickCommandsOn, useAgentCommands, usePromptContext } from './agent-welcome';
import { openedFromParams, type OpenedFrom } from './composer/quick-commands';
import { useAgentDock, type DockCheckpoint } from './dock/right-dock';
import { setBreadcrumbLeaf, useBreadcrumbParents } from '@/lib/breadcrumb-leaf';
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
import { EmptyState } from '@/features/tabs/empty';

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
  budget_change: { allowed: boolean; why: string | null; floor_usd: number; /** mold_v0-298: why not, as a code (an older server: absent). */ why_code?: 'ended' | 'child' | 'role' | null };
  /** mold_v0-261: the agent profile and the version it froze, and the record it was started from. */
  profile?: { id: string; name: string; version: number } | null;
  record?: { area: string; key: string } | null;
}
interface Detail extends Session {
  /** mold_v0-316: the console page it was opened from (its examples and quick commands; null: the Agents page). */
  opened_from?: OpenedFrom | null;
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
interface StartProfile { id: string; name: string; description: string; version: number; is_default: boolean; model: string; budget: { default_usd: number; max_usd: number; ceiling_usd: number }; harness?: string; keys?: number; uploads: number; governance?: string;
  /** mold_v0-338: false: builds, improvements, programs or schedules start it, not a person (left out of the task picker; an older server: absent). */
  in_chat?: boolean }
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

// mold_v0-334: a session's phase in the one run vocabulary (web/src/lib/run-status.ts): its turn waiting on you or a
// decision it asks for is "Needs you", parked or paused "Paused", starting "Waiting to start", waking "Working".
export const PHASE_WORDS: Record<Phase, string> = Object.fromEntries(
  (['starting', 'working', 'waiting', 'parked', 'waking', 'paused', 'awaiting_approval', 'stopped', 'failed', 'archived'] as Phase[]).map((p) => [p, RUN_STATUS_WORDS[runStatusOf(p)]])) as Record<Phase, string>;
const LIVE: Phase[] = ['starting', 'working', 'waiting', 'waking'];
const usd = (n: number) => `$${n.toFixed(2)}`;
/** What a workspace tool call wanted to send, as indented JSON when it is JSON. */
const prettyInput = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };
// mold_v0-338: a tool request reads as what it does ("Add an environment"): the tool's title, else the request's own, else
// its name in words (src/harness-sessions.ts requestTitle), never "Use create_environment".
const askWords = (r: Request) => r.kind === 'web' ? `Reach ${r.subject}` : r.kind === 'tool' ? r.subject_title : `More budget (at ${r.subject})`;
/** A title in the middle of a sentence ("It asks to add an environment"): its first letter lowercase unless it starts an acronym. */
export const midSentence = (t: string) => (/^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);

function PhaseBadge({ s }: { s: Pick<Session, 'phase' | 'pause_requested' | 'stop_requested'> }) {
  const words = s.stop_requested && LIVE.includes(s.phase) ? 'Stopping' : s.pause_requested && LIVE.includes(s.phase) ? 'Pausing' : PHASE_WORDS[s.phase];
  const status = runStatusOf(s.phase);
  return <Badge variant='outline' className={cn('gap-1.5 font-normal', STATUS_TONE[status])} data-phase={s.phase} data-run-status={status}>
    {status === 'running' && <span className='size-1.5 motion-safe:animate-pulse rounded-full bg-current' aria-hidden />}{words}
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
  // mold_v0-316 (flag agent_quick_commands): ?new=1 is a new chat, its blank screen, opened from the page in ?from= and
  // ?record= (the top bar's agent button on a tab's page); the session it starts keeps that page.
  const freshOf = (q: URLSearchParams | { get(n: string): string | null }) => area === 'app' && quickCommandsOn() && q.get('new') === '1' && !q.get('session');
  const [fresh, setFresh] = useState(() => freshOf(params));
  const [from, setFrom] = useState<OpenedFrom>(() => openedFromParams(params));
  const load = useCallback(() => call<ListAnswer>('GET').then((d) => { setData(d); setError(null); }, (e: Error) => setError(e)), [call]);
  useEffect(() => { void load(); }, [load]);
  const live = !!data?.sessions.some((s) => LIVE.includes(s.phase));
  useEffect(() => { const t = setInterval(() => void load(), live ? 3000 : 15000); return () => clearInterval(t); }, [load, live]);
  const setOpen = (k: string | null) => {
    setOpenState(k);
    const u = new URL(window.location.href);
    if (k) u.searchParams.set('session', k); else u.searchParams.delete('session');
    u.searchParams.delete('section'); // mold_v0-296: a dock section open in one session is not opened in another
    for (const x of ['new', 'from', 'record']) u.searchParams.delete(x); // mold_v0-316: the session keeps where it was opened from
    setFresh(false);
    window.history.pushState(null, '', u.toString());
  };
  // The Agents crumb and a link keep the address's word (mold_v0-290: the breadcrumb is the way back to the list).
  useEffect(() => { setOpenState(params.get('session')); setFresh(freshOf(params)); setFrom(openedFromParams(params)); }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const h = () => { const q = new URLSearchParams(window.location.search); setOpenState(q.get('session')); setFresh(freshOf(q)); setFrom(openedFromParams(q)); };
    window.addEventListener('popstate', h);
    return () => window.removeEventListener('popstate', h);
  }, []);
  const budget = useBudgetDialogs(call, load);
  // mold_v0-303: the programs this person may start (none, or the flag off: no Run a program button).
  const [programs, setPrograms] = useState<StartableProgram[]>([]);
  const [running, setRunning] = useState(false);
  const mayRun = area === 'app' && featureOn('nested_runs') && !!data?.can_start;
  useEffect(() => { if (mayRun) void call<{ programs: StartableProgram[] }>('GET', '/programs').then((d) => setPrograms(d.programs ?? []), () => setPrograms([])); }, [mayRun, call]);
  if (error) return <PageContainer><ErrorState error={error} /></PageContainer>;
  // mold_v0-287: an open session is the whole content area: no list beside it (the operator's exception to the side panel).
  if (open) return (<PageContainer>
    <SessionFull key={open} area={area} id={open} call={call} onChange={load} onOpenSession={setOpen} budget={budget} />
    {budget.dialogs}
  </PageContainer>);
  // mold_v0-316: a new chat, for someone who may start a session (anyone else: the list, as before).
  if (fresh && data?.can_start) return (<PageContainer>
    <NewChat key={`${from.tab}/${from.record?.area}/${from.record?.key}`} from={from} profiles={(data.profiles ?? []).filter((p) => p.in_chat !== false)} call={call}
      onStarted={(sid) => void load().then(() => setOpen(sid))} onLeave={() => setOpen(null)} />
  </PageContainer>);
  const rows = data?.sessions ?? [];
  const cols: RecordCol<Session>[] = [
    // mold_v0-298: on a phone the list shows the session, its status and its last activity (max-sm:hidden on the rest), so
    // nothing is cut.
    // mold_v0-338: the short number is the title's muted prefix ("AGI-012 · Cut our build costs"), no column of its own (still searched).
    { key: 'title', label: 'Session', title: true, type: 'text', className: 'min-w-40 sm:min-w-56', value: (s) => s.title,
      render: (s) => <span className='leading-snug'><span className='text-muted-foreground font-mono text-xs whitespace-nowrap' data-agent-ref=''>{s.ref}</span><span className='text-muted-foreground' aria-hidden> · </span><span className='font-medium'>{s.title}</span></span> },
    // mold_v0-334: filtered by the one status (each word once), drawn with the session's own phase (Stopping, Pausing).
    { key: 'phase', label: 'Status', type: 'select', options: RUN_STATUSES.map((value) => ({ value, label: RUN_STATUS_WORDS[value] })), value: (s) => runStatusOf(s.phase), render: (s) => <PhaseBadge s={s} /> },
    ...(area === 'admin' ? [{ key: 'workspace', label: 'Workspace', type: 'text' as const, className: 'max-sm:hidden', value: (s: Session) => s.workspace?.slug ?? '', render: (s: Session) => <span className='font-mono text-xs'>{s.workspace?.slug}</span> }] : []),
    { key: 'started_by', label: 'Started by', type: 'text', className: 'max-sm:hidden', value: (s) => s.started_by ?? '', render: (s) => <span className='block max-w-40 truncate' title={s.mine ? undefined : s.started_by ?? undefined}>{s.mine ? 'You' : s.started_by}</span> },
    { key: 'waiting_on', label: 'Waiting on', type: 'text', className: 'max-sm:hidden', value: (s) => (s.pending_request ? askWords(s.pending_request) : ''),
      render: (s) => (s.pending_request ? <span className='text-amber-700 dark:text-amber-300'>{askWords(s.pending_request)}</span> : '') },
    { key: 'spent', label: 'Spent', type: 'number', className: 'max-sm:hidden', value: (s) => s.spent_usd, render: (s) => <span className='tabular-nums whitespace-nowrap'>{usd(s.spent_usd)} <span className='text-muted-foreground'>of {usd(s.budget_usd)}</span></span> },
    { key: 'activity', label: 'Last activity', type: 'date', value: (s) => s.last_activity_at, render: (s) => <When d={s.last_activity_at} /> },
    // mold_v0-338: the times the agent woke up are its turns ("a run" is a session handing work to other agents: Active runs).
    { key: 'wakes', label: 'Turns', type: 'number', className: 'max-sm:hidden', value: (s) => s.wakes, render: (s) => String(s.wakes) }
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
          { label: 'Working now', value: n(['working', 'waking']), said: `${n(['working', 'waking'])} sessions working now` },
          { label: 'Need you', value: n(['waiting', 'awaiting_approval']), said: `${n(['waiting', 'awaiting_approval'])} sessions need you` },
          { label: 'Paused', value: n(['parked', 'paused']), said: `${n(['parked', 'paused'])} sessions paused` },
          { label: 'Spent', value: usd(spent), said: `${usd(spent)} spent by these sessions` }
        ]} />}
        searchText={(s) => `${s.ref} ${s.title} ${PHASE_WORDS[s.phase]} ${s.started_by ?? ''} ${s.workspace?.slug ?? ''} ${s.pending_request ? askWords(s.pending_request) : ''}`}
        searchPlaceholder='Search sessions'
        toolbarAction={area === 'app' && data?.can_start ? <div className='ml-auto flex shrink-0 gap-2'>
          {mayRun && programs.length > 0 && <Button type='button' variant='outline' onClick={() => setRunning(true)} aria-label='Run a program' title='Run a program' data-agent-run-program=''>
            <Icons.sparkles /><span className='sm:hidden'>Run</span><span className='hidden sm:inline'>Run a program</span></Button>}
          <StartButton onClick={() => setStarting(true)} /></div> : undefined}
        // mold_v0-298: the shell's empty state (a title, a sentence). The toolbar's Start a session is the way to start one
        // (mold_v0-328: never a second button for the same thing inside the empty state).
        empty={<EmptyState id={`${area}-agent-empty`} empty={{ title: 'No sessions yet', cta: null,
            text: area === 'app' ? (data?.can_start ? 'A session is the agent working on one task you give it.' : 'A session is the agent working on one task. A member of this workspace who may use the agent can start one.')
              : 'Sessions show here once someone in a workspace starts one.' }} />}
        detail={() => null}
        actions={(s) => budget.items(s)}
      />
      {budget.dialogs}
      {area === 'app' && data && <StartDialog open={starting} offer={data.offer} profiles={data.profiles ?? []} preset={preset} call={call} onOpenChange={(o) => {
        setStarting(o);
        if (!o && (params.get('start') || params.get('message'))) { const u = new URL(window.location.href); u.searchParams.delete('start'); u.searchParams.delete('message'); window.history.replaceState(null, '', u.toString()); }
      }}
        onStarted={(id) => { setStarting(false); void load().then(() => setOpen(id)); }} />}
      {mayRun && running && <RunProgramDialog programs={programs} call={call} onOpenChange={setRunning}
        onStarted={(id) => { setRunning(false); void load().then(() => setOpen(id)); }} />}
    </PageContainer>
  );
}

type Call = ReturnType<typeof api>;

/**
 * Start a session, the list's primary button (mold_v0-298): the search row's toolbar action (data-toolbar-action, the
 * label its accessible name and title), with a short word beside the icon on a phone ("Start") instead of a bare +.
 */
function StartButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type='button' onClick={onClick} aria-label='Start a session' title='Start a session' data-toolbar-action='' className='ml-auto shrink-0'>
      <Icons.add /><span className='sm:hidden'>Start</span><span className='hidden sm:inline'>Start a session</span>
    </Button>
  );
}

/** Why this person may not change a session's budget, in a few words (mold_v0-298: from the server's code, never its sentence). */
function budgetBlocked(c: Session['budget_change']): string | undefined {
  if (c.allowed) return undefined;
  // An older server sends no code: a neutral word rather than a guess.
  const code = c.why_code;
  return code === 'role' ? 'Owner or billing only' : code === 'child' ? 'Set on the main session' : code === 'ended' ? 'Session ended' : 'Not allowed';
}

/**
 * Start a session: the console's one modal dialog (mold_v0-249, the operator's exception to the full-card rule). The
 * first message, the model (shown; staff choose it), the budget (this person's range), then Start; the new session then
 * opens as its full card. Focus stays inside while it is open, Esc closes it, and its title names it.
 */
type ComposerSend = import('./composer/agent-composer').ComposerSend;

function StartDialog({ open, profiles, preset, call, onOpenChange, onStarted }: {
  open: boolean; offer: Offer; profiles: StartProfile[]; preset: { profile: string | null; message: string | null }; call: Call; onOpenChange: (o: boolean) => void; onStarted: (id: string) => void;
}) {
  // mold_v0-338: the picker lists what a person starts; a start_agent action's own profile stays when it names one of the others.
  const listed = profiles.filter((p) => p.in_chat !== false || p.id === preset.profile);
  // mold_v0-261: the profile chosen (the preset's when it is one this person may start, else the first: the Default).
  const first = profiles.find((p) => p.id === preset.profile) ?? profiles.find((p) => p.in_chat !== false) ?? null;
  const [profileId, setProfileId] = useState<string | null>(first?.id ?? null);
  const profile = profiles.find((p) => p.id === profileId) ?? null;
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  // mold_v0-316: the Agents page has no tab: the app's global quick commands only.
  const commands = useAgentCommands(null), ctx = usePromptContext(null);
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
            <DialogDescription className='sr-only'>Choose the task and say what the agent should do.</DialogDescription>
          </DialogHeader>
          {listed.length > 0 && (
            <FormRow label='Task' htmlFor='agent-start-profile'>
              <NativeSelect id='agent-start-profile' className='w-full' value={profileId ?? ''} onChange={(e) => setProfileId(e.target.value)} data-agent-start-profile=''>
                {listed.map((p) => <NativeSelectOption key={p.id} value={p.id}>{p.name}</NativeSelectOption>)}
              </NativeSelect>
            </FormRow>
          )}
          {/* mold_v0-338: the box's one label, shown (no second label around it). */}
          <div className='grid gap-2'>
            <AgentComposer id='agent-start-message' label='What should the agent do?' showLabel value={message} onChange={setMessage} autoFocus session={null} busy={busy} disabledReason={null} sendLabel='Start'
              placeholder="Summarise this workspace's records and say what needs attention first." onSend={submit} commands={commands} context={ctx} menuInline />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A new chat (mold_v0-316, flag agent_quick_commands): the session page before its session exists. The blank screen
 * (agent-welcome.tsx: the greeting, the page it was opened from, the example prompts) over the composer with its "/"
 * menu of that page's quick commands. Sending starts the session with the first message, the chosen task (else the
 * Default) and the page it was opened from, then opens it.
 */
function NewChat({ from, profiles, call, onStarted, onLeave }: { from: OpenedFrom; profiles: StartProfile[]; call: Call; onStarted: (id: string) => void; onLeave: () => void }) {
  const ctx = usePromptContext(from);
  const commands = useAgentCommands(from);
  const [text, setText] = useState('');
  const [cursor, setCursor] = useState<{ at: number; select: [number, number] | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(profiles[0]?.id ?? null);
  useEffect(() => { setBreadcrumbLeaf('New chat'); return () => setBreadcrumbLeaf(null); }, []);
  const send = async (c: ComposerSend): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await call<{ session: Session }>('POST', '', { message: c.message, mode: 'conversation', files: c.files, repositories: c.repositories,
        ...(profileId ? { profile: profileId } : {}), ...(from.tab || from.record ? { opened_from: from } : {}) });
      onStarted(r.session.id);
      return true;
    } catch (e) { fail(e); return false; } finally { setBusy(false); }
  };
  const where = openedFromWords(ctx);
  return (
    <div className='flex h-[calc(100svh-5.5rem)] min-h-[24rem] flex-col gap-2' data-agent-new-chat='' data-opened-from={from.tab ?? ''}>
      <div className='flex min-w-0 items-center gap-2 sm:gap-3' data-agent-session-bar=''>
        {/* mold_v0-338: the breadcrumb's last crumb says "New chat": the heading is for screen readers only. */}
        <h1 className='sr-only'>New chat</h1><span className='min-w-0 flex-1' aria-hidden />
        {profiles.length > 1 && <NativeSelect aria-label='Task' className='w-44 max-sm:w-36' value={profileId ?? ''} onChange={(e) => setProfileId(e.target.value)} data-agent-start-profile=''>
          {profiles.map((p) => <NativeSelectOption key={p.id} value={p.id}>{p.name}</NativeSelectOption>)}
        </NativeSelect>}
        <Button type='button' variant='outline' size='sm' onClick={onLeave} data-agent-all-sessions=''><Icons.history /><span className='max-sm:sr-only'>All sessions</span></Button>
      </div>
      <div className='flex min-h-0 flex-1 flex-col overflow-y-auto' data-agent-transcript=''>
        <AgentWelcome className='my-auto' from={from} ctx={ctx} onPick={(t, select) => { setText(t); setCursor({ at: Date.now(), select }); }} />
      </div>
      <div className='mx-auto w-full max-w-4xl px-1 pb-1' data-agent-dock=''>
        <AgentComposer id='agent-new-message' label='Message the agent' value={text} onChange={setText} autoFocus session={null} busy={busy} disabledReason={null} sendLabel='Send'
          placeholder={where ? `Ask about ${where}, or type / for quick commands` : 'Ask the agent, or type / for quick commands'} onSend={send} commands={commands} context={ctx} cursor={cursor} />
      </div>
    </div>
  );
}

/** A program this person may start (src/program-start.ts StartableProgram). */
interface StartableProgram { id: string; name: string; description: string; icon: string; version: number; inputs: Record<string, unknown>; via: 'session' | 'runner'; profile: string }
type InputProp = { type?: string; title?: string; description?: string; enum?: unknown[] };
/** mold_v0-309: an input's label: its schema title, else its name in words ("target_url" reads "Target url"). */
export const inputLabel = (name: string, prop: InputProp) => (prop.title?.trim() || name.replace(/[_-]+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase()));
/** The inputs a form can ask one by one (each a string, number, integer or boolean), or null: the JSON box instead. */
function simpleInputs(schema: Record<string, unknown>): { name: string; prop: InputProp; required: boolean }[] | null {
  const props = (schema.properties ?? {}) as Record<string, InputProp>;
  const required = new Set((schema.required ?? []) as string[]);
  const list = Object.entries(props).map(([name, prop]) => ({ name, prop, required: required.has(name) }));
  return list.every((x) => ['string', 'number', 'integer', 'boolean'].includes(String(x.prop.type))) ? list : null;
}

/**
 * Run a program (mold_v0-303): a modal like Start a session. The program (each one this person may start), its inputs (a
 * field each, or one JSON box for inputs a field cannot hold), Run; the server checks them against the program's schema.
 */
function RunProgramDialog({ programs, call, onOpenChange, onStarted }: { programs: StartableProgram[]; call: Call; onOpenChange: (o: boolean) => void; onStarted: (id: string) => void }) {
  const [id, setId] = useState(programs[0]?.id ?? '');
  const p = programs.find((x) => x.id === id) ?? null;
  const fields = p ? simpleInputs(p.inputs) : null;
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [json, setJson] = useState('{}');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setValues({}); setJson('{}'); }, [id]);
  const inputsOf = (): Record<string, unknown> => {
    if (!fields) { const v = JSON.parse(json || '{}') as unknown; if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('The inputs are one JSON object.'); return v as Record<string, unknown>; }
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const v = values[f.name];
      if (v === undefined || v === '') continue;
      out[f.name] = f.prop.type === 'boolean' ? v === true : f.prop.type === 'number' || f.prop.type === 'integer' ? Number(v) : v;
    }
    return out;
  };
  const submit = async () => {
    if (!p) return;
    setBusy(true);
    try {
      const r = await call<{ session: Session }>('POST', `/programs/${encodeURIComponent(p.id)}/start`, { inputs: inputsOf() });
      toast.success(`${p.name} started`); onStarted(r.session.id);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl' data-agent-run-program-dialog=''
        finalFocus={() => document.querySelector<HTMLElement>('[data-agent-run-program]')}>
        <form className='grid gap-4' onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <DialogHeader>
            <DialogTitle>Run a program</DialogTitle>
            <DialogDescription>{p?.description || 'Choose a program and give it what it needs. It runs as a session you can follow.'}</DialogDescription>
          </DialogHeader>
          <FormRow label='Program' htmlFor='agent-run-program'>
            <NativeSelect id='agent-run-program' className='w-full' value={id} onChange={(e) => setId(e.target.value)} data-agent-run-program-select=''>
              {programs.map((x) => <NativeSelectOption key={x.id} value={x.id}>{x.name}</NativeSelectOption>)}
            </NativeSelect>
          </FormRow>
          {fields ? fields.map((f) => (
            // mold_v0-309: each input by its schema title (else its name in words), its description as the hint under it.
            <FormRow key={f.name} label={`${inputLabel(f.name, f.prop)}${f.required ? '' : ' (optional)'}`} htmlFor={`agent-run-input-${f.name}`} hint={f.prop.description || undefined}>
              {f.prop.type === 'boolean'
                ? <input id={`agent-run-input-${f.name}`} type='checkbox' className='size-4' checked={values[f.name] === true} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.checked }))} />
                : Array.isArray(f.prop.enum)
                  ? <NativeSelect id={`agent-run-input-${f.name}`} className='w-full' value={String(values[f.name] ?? '')} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}>
                      <NativeSelectOption value=''>Choose</NativeSelectOption>
                      {f.prop.enum.map((o) => <NativeSelectOption key={String(o)} value={String(o)}>{String(o)}</NativeSelectOption>)}
                    </NativeSelect>
                  : <Input id={`agent-run-input-${f.name}`} type={f.prop.type === 'string' ? 'text' : 'number'} required={f.required} value={String(values[f.name] ?? '')}
                      onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} />}
            </FormRow>
          )) : p && (
            <FormRow label='Inputs (JSON)' htmlFor='agent-run-inputs'>
              <textarea id='agent-run-inputs' className='border-input min-h-32 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs' value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
            </FormRow>
          )}
          <DialogFooter>
            <Button type='button' variant='outline' disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type='submit' disabled={busy || !p} data-agent-run-program-start=''>{busy ? 'Starting…' : 'Run'}</Button>
          </DialogFooter>
        </form>
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
  const hint = (s: Session, n: number) => !s.budget_change.allowed ? budgetBlocked(s.budget_change) : s.budget_usd + n > s.ceiling_usd + 1e-9 ? `Limit is ${usd(s.ceiling_usd)}` : undefined;
  const items = (s: Session): RowAction[] => [
    { label: 'Add $5', icon: <Icons.coin />, disabled: busy || !!hint(s, 5), hint: hint(s, 5), onSelect: () => void add(s, 5) },
    { label: 'Add $10', icon: <Icons.coin />, disabled: busy || !!hint(s, 10), hint: hint(s, 10), onSelect: () => void add(s, 10) },
    { label: 'Set budget…', icon: <Icons.coin />, disabled: !s.budget_change.allowed, hint: budgetBlocked(s.budget_change), onSelect: () => setDialog({ kind: 'set', s }) },
    { label: 'Spending by turn', icon: <Icons.history />, onSelect: () => setDialog({ kind: 'spending', s }) },
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

/** Spending by turn: what each wake (turn) cost and how many tokens it used. */
function SpendingDialog({ id, title, call, onOpenChange }: { id: string; title: string; call: Call; onOpenChange: (o: boolean) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  useEffect(() => { void call<{ session: Detail }>('GET', `/${id}`).then((r) => setD(r.session), fail); }, [call, id]);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg' data-agent-spending=''>
        <DialogHeader>
          <DialogTitle>Spending by turn</DialogTitle>
          <DialogDescription>{title}</DialogDescription>
        </DialogHeader>
        {!d ? <p className='text-muted-foreground text-sm'>Reading…</p> : d.wakes_list.length === 0 ? <p className='text-muted-foreground text-sm'>It has not run yet.</p> : (
          <div className='max-h-[60vh] overflow-y-auto'>
            <table className='w-full text-sm tabular-nums'>
              <thead><tr className='text-muted-foreground border-b text-left text-xs'><th className='py-1 font-medium'>Turn</th><th className='py-1 font-medium'>Status</th><th className='py-1 text-right font-medium'>Tokens in</th><th className='py-1 text-right font-medium'>Tokens out</th><th className='py-1 text-right font-medium'>Cost</th></tr></thead>
              <tbody>{d.wakes_list.map((w, i) => (
                <tr key={w.run_id} className='border-b last:border-b-0' data-wake-spend={w.run_id}>
                  <td className='py-1.5'>Turn {i + 1}</td>
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
  const [recordsOpen, setRecordsOpen] = useState(false);
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
  // mold_v0-292 (flag nested_runs): the dock, its sections as grouped tabs in this bar (mold_v0-295) and, while one is open, a
  // large modal over the conversation (mold_v0-296; the conversation stays full width behind it).
  const [prefill, setPrefill] = useState<{ text: string; at: number; select?: [number, number] | null } | null>(null);
  // mold_v0-316: a session nobody has written in yet (none of its messages a person's) shows the blank screen in its trace.
  const blank = area === 'app' && quickCommandsOn() && !!d && d.can.message && !d.messages.some((m) => m.role === 'person');
  const checkpoints = useMemo<DockCheckpoint[]>(() => (d?.messages ?? []).filter((m) => m.role !== 'system').map((m) => ({ id: m.id, role: m.role as DockCheckpoint['role'], label: m.body.replace(/\s+/g, ' ').slice(0, 120) })).reverse(), [d?.messages]);
  const dock = useAgentDock({ enabled: area === 'app' && featureOn('nested_runs'), call, sessionId: id, checkpoints, onAsk: (text) => setPrefill({ text, at: Date.now() }), onOpenSession });
  // mold_v0-296: the title keeps its room in the bar (its whole width up to half the bar), the groups take what is left and
  // spill into their »; a longer title is cut, the whole of it on hover.
  const barRef = useRef<HTMLDivElement | null>(null), titleRef = useRef<HTMLHeadingElement | null>(null);
  const [titleRoom, setTitleRoom] = useState(0);
  useLayoutEffect(() => {
    const b = barRef.current, t = titleRef.current;
    if (!b || !t) return;
    const m = () => setTitleRoom(Math.min(t.scrollWidth, Math.round(b.clientWidth / 2), 360));
    m();
    const ro = new ResizeObserver(m);
    ro.observe(b);
    return () => ro.disconnect();
  }, [d?.title]);
  // mold_v0-290: the session is a level of the top bar's breadcrumb (Account / Agents / AGI-001): that is the way back.
  const ref = d?.ref ?? null;
  useEffect(() => { setBreadcrumbLeaf(ref); return () => setBreadcrumbLeaf(null); }, [ref]);
  // mold_v0-348: a session started from a record (Start build on an application) crumbs through that record, the way
  // back to where it was started (Applications / example-app / AGI-001), never only the agents' list.
  useBreadcrumbParents(d?.record && !d.workspace ? [{ area: d.record.area, key: d.record.key, title: null }] : null);
  if (error) return <ErrorState error={error} />;
  if (!d) return <LoadingCards count={2} />;
  // The last model call failed and nothing has answered since: say so where the person is looking.
  const lastModel = [...trace.steps].reverse().find((s) => s.kind === 'model' && s.http_status !== undefined);
  const failing = live && lastModel?.status === 'error' ? (lastModel.error ?? 'The last model call failed.') : null;
  // mold_v0-338: what it asks is said once: the bar above the chat box, not also the trace's own line for it.
  const pendingAsk = d.pending_request ? `rq:${d.pending_request.id}:0` : null;
  return (
    <div className='flex h-[calc(100svh-5.5rem)] min-h-[24rem]' data-agent-session-page=''>
    <div className='flex min-w-0 flex-1 flex-col gap-2' data-agent-session={d.id} data-phase={d.phase}>
      <div ref={barRef} className='flex min-w-0 items-center gap-2 sm:gap-3' data-agent-session-bar=''>
        <h1 ref={titleRef} className='min-w-0 flex-1 truncate text-base font-medium' style={{ minWidth: titleRoom }} title={d.title} data-agent-session-title=''>{d.title}</h1>
        {dock.bar}
        <Controls area={area} s={d} call={call} onChange={changed} budget={budget}
          extra={[{ label: 'How this session runs', icon: <Icons.settings />, onSelect: () => setHowOpen(true) },
            // mold_v0-310: the records it wrote (a workspace's own session page only).
            ...(area === 'app' ? [{ label: 'Records it wrote', icon: <Icons.table />, onSelect: () => setRecordsOpen(true) }] : [])]} />
      </div>
      {d.reason && !d.pending_request && d.phase !== 'awaiting_approval' && !['idle', 'paused', 'withdrawn', 'budget', 'continued'].includes(d.reason) && <p className='text-muted-foreground text-sm' data-agent-reason>{reasonWords(d.reason)}</p>}
      <TraceStream empty={blank ? <SessionWelcome from={d.opened_from ?? null} onPick={(t, select) => setPrefill({ text: t, at: Date.now(), select })} /> : undefined}
        ended={['stopped', 'failed', 'archived'].includes(d.phase)}
        sessionId={d.id} call={call} steps={pendingAsk ? trace.steps.filter((x) => x.id !== pendingAsk) : trace.steps} waitingOn={trace.waitingOn} connected={trace.connected} live={live} pruned={d.pruned} dockHeight={dockH}
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
      {recordsOpen && <WroteDialog id={d.id} call={call} onOpenChange={setRecordsOpen} />}
    </div>
    {dock.modal}
    </div>
  );
}

/** mold_v0-316: the blank screen inside a session that has no message of a person's yet. */
function SessionWelcome({ from, onPick }: { from: OpenedFrom | null; onPick: (text: string, select: [number, number] | null) => void }) {
  const ctx = usePromptContext(from);
  return <AgentWelcome from={from} ctx={ctx} onPick={onPick} />;
}

/** A record a session wrote (GET /api/agent/<id>/records, src/record-runs.ts): only those this person may read. */
interface WroteRecord { area: string; key: string; title: string | null; label: string; how: ('Created' | 'Changed')[]; at: string }
/** mold_v0-310: the records this session wrote (its tool calls, its programs' results), each linked to its page. */
function WroteDialog({ id, call, onOpenChange }: { id: string; call: Call; onOpenChange: (o: boolean) => void }) {
  const [got, setGot] = useState<{ records: WroteRecord[]; total: number } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => { call<{ records: WroteRecord[]; total: number }>('GET', `/${id}/records`).then(setGot, (e: Error) => setError(e)); }, [call, id]);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[85dvh] overflow-y-auto sm:max-w-xl' data-agent-records=''>
        <DialogHeader>
          <DialogTitle>Records it wrote</DialogTitle>
          <DialogDescription>The records this session added or changed, and those its programs kept. Only the ones you may open are listed.</DialogDescription>
        </DialogHeader>
        {error ? <ErrorState error={error} /> : !got ? <LoadingCards count={1} /> : !got.records.length ? <p className='text-muted-foreground text-sm'>None yet.</p> : (
          <ul className='divide-y text-sm' data-agent-records-list=''>
            {got.records.map((x) => (
              <li key={`${x.area}/${x.key}`} className='flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5' data-agent-record={x.key}>
                <span className='flex min-w-0 flex-col'>
                  <Link href={`/app/records/${encodeURIComponent(x.area)}/${encodeURIComponent(x.key)}`} className='font-medium break-words underline-offset-4 hover:underline'>{x.title || x.key}</Link>
                  <span className='text-muted-foreground text-xs'>{x.label} · <When d={x.at} /></span>
                </span>
                <span className='flex gap-1.5'>{x.how.map((w) => <Badge key={w} variant='outline' className='font-normal'>{w}</Badge>)}</span>
              </li>
            ))}
            {got.total > got.records.length && <li className='text-muted-foreground py-2.5 text-xs'>The newest {got.records.length} of {got.total}.</li>}
          </ul>
        )}
      </DialogContent>
    </Dialog>
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
  const what = r.kind === 'web' ? <>It asks to read <span className='font-mono'>{r.subject}</span></> : r.kind === 'tool' ? <>It asks to {midSentence(r.subject_title)}</> : <>It reached its {usd(d.budget_usd)} budget</>;
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
              : r.kind === 'tool' ? <>Approve lets this session {midSentence(r.subject_title)}, and use that tool from now on without asking; it continues, {d.reach?.acts_as.kind === 'person' ? (d.mine ? 'acting as you' : `acting as ${d.reach.acts_as.name ?? 'the person who started it'}`) : 'acting as the account'}. Decline tells it no; it parks and is told at the next message.</>
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
function Composer({ area, d, call, onSent, onOpenSession, waitingOn, failing, prefill }: { area: Area; d: Detail; call: Call; onSent: () => unknown; onOpenSession: (id: string) => void; waitingOn: string | null; failing: string | null; prefill?: { text: string; at: number; select?: [number, number] | null } | null }) {
  const [text, setText] = useState('');
  // mold_v0-292: the dock's Ask about this: it puts words in the chat bar, and the person sends them.
  // mold_v0-316: an example prompt does the same, the cursor on its first blank.
  const [cursor, setCursor] = useState<{ at: number; select: [number, number] | null } | null>(null);
  useEffect(() => { if (prefill) { setText(prefill.text); setCursor({ at: prefill.at, select: prefill.select ?? null }); } }, [prefill]);
  // mold_v0-316: the quick commands of the page it was opened from (a staff view: none, it cannot send).
  const from = area === 'app' ? d.opened_from ?? null : null;
  const commands = useAgentCommands(from), ctx = usePromptContext(from);
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
      commands={area === 'app' ? commands : null} context={ctx} cursor={cursor}
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
        <dt className='text-muted-foreground'>Steps per turn</dt><dd>{d.policy.max_turns}</dd>
        <dt className='text-muted-foreground'>Longest turn</dt><dd>{d.policy.wake_max_minutes} minutes</dd>
        <dt className='text-muted-foreground'>Parks after</dt><dd>{d.policy.park_after_minutes} quiet minutes</dd>
        <dt className='text-muted-foreground'>Web</dt><dd>{d.policy.web_tools === 'off' ? 'Off' : `${d.policy.web_tools === 'search' ? 'Search and read' : 'Read'}: ${d.policy.web_hosts.join(', ') || 'asks for each host'} (${d.web_calls} of ${d.policy.web_calls_max} calls)`}</dd>
        <dt className='text-muted-foreground'>Its own tools</dt><dd>{d.policy.tools.join(', ')}</dd>
        <dt className='text-muted-foreground'>After a crash</dt><dd>{d.policy.auto_resume ? 'Continues by itself' : 'Continues at the next message'} (at most {d.policy.crash_resumes} in a row)</dd>
        <dt className='text-muted-foreground'>Instructions</dt><dd>{d.hooks.map((h) => `${h.event === 'on_start' ? 'On start' : h.event === 'on_resume' ? 'On resume' : 'Standing'}: ${h.source === 'unset' ? 'none' : h.source === 'harness' ? "the harness's own" : h.source === 'profile' ? "its profile's" : "this session's"}`).join(' · ')}{r ? ', and the workspace context above' : ''}</dd>
      </dl>
      {d.grants.length > 0 && <div className='mt-3'><p className='font-medium'>Budget raises</p><ul className='mt-1 flex flex-col gap-1'>{d.grants.map((g) => <li key={g.id}>{usd(g.from_usd)} to {usd(g.to_usd)} by {g.by}, <When d={g.at} />: {g.reason}</li>)}</ul></div>}
      {d.wakes_list.length > 0 && <div className='mt-3'><p className='font-medium'>Turns</p><ul className='mt-1 flex flex-col gap-1'>{d.wakes_list.map((w, i) => <li key={w.run_id} className='flex flex-wrap gap-x-2'>{featureOn('record_pages') ? <Link href={`/app/runs/${encodeURIComponent(w.run_id)}`} className='underline-offset-4 hover:underline' data-wake-run={w.run_id}>Turn {i + 1}</Link> : <span>Turn {i + 1}</span>}<span>{w.status}</span>{w.end_reason && <span className='text-muted-foreground'>{w.end_reason}</span>}<span className='tabular-nums'>{usd(w.cost_usd)}</span></li>)}</ul></div>}
      {d.requests.filter((r) => r.status !== 'pending').length > 0 && <div className='mt-3'><p className='font-medium'>Decisions</p><ul className='mt-1 flex flex-col gap-1'>{d.requests.filter((r) => r.status !== 'pending').map((r) => <li key={r.id}>{askWords(r)}: {r.status}{r.decided_by ? ` by ${r.decided_by}` : ''}{r.reason ? ` (${r.reason})` : ''}</li>)}</ul></div>}
    </div>
  );
}
