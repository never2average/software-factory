'use client';
// A session's trace (mold_v0-287; src/harness-trace.ts, src/harness-sessions.ts sessionTrace, /:id/trace/stream): the
// session's primary view. Everything it does, in order and live as a stream: its sandbox coming up, each wake, each
// model call, each tool call and command, approvals, budget changes, and the conversation itself (your messages and the
// agent's answers are entries of the same stream, in order). A row opens in place onto its detail; a tool's whole
// arguments and result are read then, masked. Rows scan as icons and sentences, runs of the same tool condense, a
// sub-agent's steps nest under the call that started them. The stream follows the newest step while the reader is at the
// live edge, and lets go the moment they scroll up.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { Markdown } from '@/components/markdown';
import { cn } from '@/lib/utils';
import { When } from '@/features/portal/shared';

export type TraceKind = 'sandbox' | 'wake' | 'model' | 'tool' | 'command' | 'approval' | 'budget' | 'note' | 'message';
export interface TraceStep {
  id: string; at: string; kind: TraceKind; status: 'ok' | 'error' | 'running' | 'waiting'; title: string; detail?: string | null;
  run_id?: string | null; wake?: number | null;
  model?: string; input_tokens?: number; cached_tokens?: number; output_tokens?: number; cost_usd?: number; http_status?: number;
  tool?: string; preview?: string | null; result_preview?: string | null; duration_ms?: number;
  role?: 'person' | 'agent' | 'system'; body?: string; by?: string | null; message_status?: string | null; parent?: string | null;
  error?: string | null; fields?: Record<string, unknown>; more?: boolean;
  /** A condensed run of the same tool: its members, so the condensing hides nothing. */
  members?: TraceStep[];
  /** Sub-agent steps nested under the call that started them. */
  children?: TraceStep[];
}
export interface TraceAnswer { steps: TraceStep[]; marks: TraceStep[]; cursor: string; more: boolean; waiting_on: string | null; phase: string; spent_usd: number; budget_usd: number }
type Call = <T>(method: string, path?: string, body?: unknown) => Promise<T>;

/** How a streamed line becomes an answer; a malformed line is dropped, the next reconnect picks up from the last cursor. */
const parseData = (chunk: string): TraceAnswer | null => {
  if (!chunk.startsWith('data:')) return null;
  try { return JSON.parse(chunk.slice(5).trim()) as TraceAnswer; } catch { return null; }
};

/**
 * The session's stream of steps: read from `url` as server-sent events, reconnected from the last cursor when it ends (a
 * hosted function's limit, a dropped connection), merging each step by its id (a tool's result updates its call's row, a
 * message's status updates in place). Falls back to reading GET /trace with `call` while the stream will not open.
 */
export function useTrace(call: Call, url: string, sessionId: string, onChanged: () => void) {
  const [steps, setSteps] = useState<Map<string, TraceStep>>(new Map());
  const [marks, setMarks] = useState<TraceStep[]>([]);
  const [waitingOn, setWaitingOn] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const cursor = useRef('');
  const seen = useRef('');
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const apply = useCallback((r: TraceAnswer) => {
    cursor.current = r.cursor;
    setMarks(r.marks);
    setWaitingOn(r.waiting_on);
    if (r.steps.length) setSteps((m) => {
      const next = new Map(m);
      for (const s of r.steps) { const had = next.get(s.id); next.set(s.id, had ? { ...had, ...s, at: had.at, preview: had.preview ?? s.preview } : s); }
      return next;
    });
    const state = `${r.phase}|${r.spent_usd}|${r.budget_usd}`;
    if (state !== seen.current) { seen.current = state; changed.current(); }
  }, []);
  useEffect(() => {
    const ctl = new AbortController();
    let alive = true, failures = 0;
    cursor.current = ''; seen.current = '';
    setSteps(new Map()); setMarks([]); setWaitingOn(null);
    const fallback = async () => {
      const r = await call<TraceAnswer>('GET', `/${sessionId}/trace?after=${encodeURIComponent(cursor.current)}`).catch(() => null);
      if (r) apply(r);
    };
    const run = async () => {
      while (alive) {
        try {
          const res = await fetch(`${url}?after=${encodeURIComponent(cursor.current)}`, { credentials: 'same-origin', signal: ctl.signal, headers: { accept: 'text/event-stream' } });
          if (res.status === 401 && typeof window !== 'undefined') { window.location.href = `/auth/sign-in?redirect_url=${encodeURIComponent(window.location.pathname + window.location.search)}`; return; }
          if (!res.ok || !res.body) throw new Error(String(res.status));
          setConnected(true); failures = 0;
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += value;
            const parts = buf.split('\n\n');
            buf = parts.pop() ?? '';
            for (const p of parts) { const a = parseData(p); if (a) apply(a); }
          }
        } catch { /* reconnects below */ }
        setConnected(false);
        if (!alive) return;
        failures++;
        if (failures > 3) { await fallback(); await new Promise((r) => setTimeout(r, 3000)); } else await new Promise((r) => setTimeout(r, 1000));
      }
    };
    void run();
    return () => { alive = false; ctl.abort(); };
  }, [apply, call, sessionId, url]);
  const all = useMemo(() => [...marks, ...steps.values()].sort((a, b) => a.at.localeCompare(b.at)), [marks, steps]);
  return { steps: all, waitingOn, connected };
}

/** Bulk expand and collapse, broadcast to every row: each row obeys the newest toggle, then keeps its own state. */
const ExpansionContext = createContext<{ gen: number; open: boolean }>({ gen: 0, open: false });
function useDisclosure(initial: boolean): [boolean, () => void] {
  const { gen, open: bulk } = useContext(ExpansionContext);
  const [state, setState] = useState({ open: initial, gen });
  const open = state.gen === gen ? state.open : bulk;
  const toggle = useCallback(() => setState({ open: !open, gen }), [gen, open]);
  return [open, toggle];
}

const ICONS: Record<TraceKind, ReactNode> = {
  sandbox: <Icons.cpu className='size-3.5' />, wake: <Icons.sparkles className='size-3.5' />, model: <Icons.sparkles className='size-3.5' />, tool: <Icons.tool className='size-3.5' />,
  command: <Icons.terminal className='size-3.5' />, approval: <Icons.alertCircle className='size-3.5' />, budget: <Icons.coin className='size-3.5' />, note: <Icons.info className='size-3.5' />, message: <Icons.info className='size-3.5' />,
};
const ACCENT: Record<TraceKind, string> = { sandbox: 'text-cyan-600 dark:text-cyan-400', wake: 'text-muted-foreground', model: 'text-violet-500 dark:text-violet-400', tool: 'text-orange-500 dark:text-orange-400', command: 'text-sky-600 dark:text-sky-400', approval: 'text-amber-500 dark:text-amber-400', budget: 'text-emerald-600 dark:text-emerald-400', note: 'text-muted-foreground', message: 'text-muted-foreground' };

export const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const dollars = (n: number) => `$${n.toFixed(n !== 0 && n < 0.01 ? 4 : 2)}`;
const formatDuration = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);

/** A step in words: a sentence, and the one identifying detail (the command, the file, the model) as a chip. */
function present(s: TraceStep): { title: string; chip: string | null } {
  if (s.members?.length) return { title: `Used ${s.title || 'a tool'} ${s.members.length} times`, chip: null };
  if (s.kind === 'model') return { title: s.status === 'error' ? (s.title === s.model ? 'A model call failed' : s.title) : 'Called the model', chip: s.model ?? null };
  if (s.kind === 'command') return { title: s.status === 'running' ? 'Running a command' : s.status === 'error' ? 'A command failed' : 'Ran a command', chip: s.preview ?? null };
  if (s.kind === 'tool') return { title: s.status === 'running' ? `Using ${s.title}` : s.status === 'error' ? `${s.title} failed` : `Used ${s.title}`, chip: s.preview ?? null };
  return { title: s.title, chip: null };
}

/**
 * The stream's shape for reading: a sub-agent's steps under the call that started them, and each run of three or more of
 * the same tool, all finished cleanly, as one row that opens onto its members. A failed or running step keeps its own row.
 */
export function shapeSteps(input: TraceStep[]): TraceStep[] {
  const byId = new Map(input.map((s) => [s.id, s]));
  const roots: TraceStep[] = [];
  for (const raw of input) {
    const s: TraceStep = { ...raw };
    byId.set(s.id, s);
    const parent = s.parent ? byId.get(`tool:${s.parent}`) : null;
    if (parent) (parent.children ??= []).push(s); else roots.push(s);
  }
  const out: TraceStep[] = [];
  let run: TraceStep[] = [];
  const groupable = (s: TraceStep) => (s.kind === 'tool' || s.kind === 'command') && !!s.tool && s.status === 'ok' && !s.children?.length;
  const flush = () => {
    if (run.length >= 3) out.push({ ...run[0], id: `run:${run[0].id}`, members: run, duration_ms: run.reduce((t, s) => t + (s.duration_ms ?? 0), 0) });
    else out.push(...run);
    run = [];
  };
  for (const s of roots) {
    if (groupable(s) && (!run.length || run[0].tool === s.tool)) run.push(s);
    else { flush(); if (groupable(s)) run.push(s); else out.push(s); }
  }
  flush();
  return out;
}

/** A model call straight after a failed one of the same wake is a retry: numbered so its attempts read as such. */
function retryNumbers(steps: TraceStep[]): Map<string, number> {
  const out = new Map<string, number>();
  let fails = 0, wake: number | null | undefined;
  for (const s of steps) {
    if (s.kind !== 'model' || s.http_status === undefined) continue;
    if (s.wake !== wake) { wake = s.wake; fails = 0; }
    if (fails) out.set(s.id, fails);
    fails = s.status === 'error' ? fails + 1 : 0;
  }
  return out;
}

const STATUS_WORDS: Record<string, string> = { pending: 'Waiting to be delivered', delivered: 'Delivered', answered: 'Answered', discarded: 'Carried to the next wake' };

function MessageEntry({ s }: { s: TraceStep }) {
  if (s.role === 'system') return <p className='text-muted-foreground px-2 py-1 text-center text-xs' data-trace-message='system'>{s.body} · <When d={s.at} /></p>;
  if (s.role === 'person') return (
    <div className='flex flex-col items-end gap-1 px-1 py-2' data-trace-message='person'>
      <Bubble variant='default' align='end'><BubbleContent className='text-sm whitespace-pre-wrap'>{s.body}</BubbleContent></Bubble>
      {s.message_status === 'pending' && <span className='text-muted-foreground text-xs'>{STATUS_WORDS.pending}</span>}
    </div>
  );
  return (
    <div className='flex flex-col gap-1 px-1.5 py-2' data-trace-message='agent'>
      <div className='text-sm'><Markdown>{s.body ?? ''}</Markdown></div>
    </div>
  );
}

function Step({ s, retries, call, sessionId, depth = 0 }: { s: TraceStep; retries: Map<string, number>; call: Call; sessionId: string; depth?: number }) {
  const [open, toggle] = useDisclosure(false);
  const p = present(s);
  const hasBody = !!(s.members?.length || s.children?.length || s.more || s.error || (s.fields && Object.keys(s.fields).length) || s.detail || s.input_tokens !== undefined);
  const icon = cn('shrink-0', s.status === 'error' ? 'text-destructive' : s.status === 'waiting' ? 'text-amber-600 dark:text-amber-400' : ACCENT[s.kind]);
  if (s.kind === 'message') return <li><MessageEntry s={s} /></li>;
  return (
    <li className='min-w-0' data-trace-step={s.kind} data-trace-status={s.status}>
      <div className='group/row flex min-w-0 items-start gap-2 rounded-md px-1 py-1'>
        {hasBody
          ? <Button variant='ghost' size='icon-xs' onClick={toggle} aria-expanded={open} aria-label={`${open ? 'Close' : 'Open'}: ${p.title}`} className='mt-px'>
            <span className={cn('group-hover/row:hidden group-focus-within/row:hidden', icon, open && 'hidden')} aria-hidden>{ICONS[s.kind]}</span>
            <Icons.chevronDown aria-hidden className={cn('text-muted-foreground size-3.5 hidden group-hover/row:block group-focus-within/row:block', open ? 'block' : '-rotate-90')} />
          </Button>
          : <span className={cn('mt-1 flex size-6 items-center justify-center', icon)} aria-hidden>{ICONS[s.kind]}</span>}
        <span className='flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5 leading-5'>
          <span className={cn('text-[13px] font-medium', s.status === 'error' && 'text-destructive', s.status === 'running' && 'shimmer')}>{p.title}</span>
          {s.status === 'waiting' && <span className='text-amber-700 dark:text-amber-300 text-xs'>Waiting</span>}
          {s.error && <span className='text-destructive basis-full text-xs break-words'>{s.error}</span>}
        </span>
      </div>
      {open && hasBody && (s.members?.length
        ? <ol className='border-muted mb-2 ml-3 flex flex-col gap-0.5 border-l pl-3'>{s.members.map((m) => <Step key={m.id} s={m} retries={retries} call={call} sessionId={sessionId} depth={depth + 1} />)}</ol>
        : s.children?.length
          ? <ol className='border-muted mb-2 ml-3 flex flex-col gap-0.5 border-l pl-3'>{s.children.map((m) => <Step key={m.id} s={m} retries={retries} call={call} sessionId={sessionId} depth={depth + 1} />)}</ol>
          : <StepDetails s={s} call={call} sessionId={sessionId} />)}
    </li>
  );
}

/** One block of a step's input or output, with a Copy button; what was cut is said, never implied. */
function Block({ heading, text, truncated }: { heading: string; text: string; truncated?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); };
  return (
    <div className='grid gap-1'>
      <div className='flex items-center gap-2'>
        <span className='text-muted-foreground text-xs'>{heading}</span>
        {truncated && <span className='text-muted-foreground text-xs'>(shortened)</span>}
        <Button type='button' variant='outline' size='xs' className='ml-auto' onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <pre className='bg-muted/40 max-h-80 overflow-auto rounded-md border p-2 font-mono text-xs break-all whitespace-pre-wrap' data-trace-full={heading}>{text}</pre>
    </div>
  );
}

function pretty(v: unknown): string {
  if (typeof v === 'string') { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } }
  return JSON.stringify(v ?? null, null, 2);
}

/** A step's own detail, in place: a sentence of its facts, its input and result; what is absent is said in words. */
function StepDetails({ s, call, sessionId }: { s: TraceStep; call: Call; sessionId: string }) {
  const [data, setData] = useState<Record<string, { input?: unknown; result?: unknown; preview?: unknown; truncated?: boolean }> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!s.more) return;
    call<{ step: { data: typeof data } }>('GET', `/${sessionId}/trace/${encodeURIComponent(s.id)}`).then((r) => setData(r.step.data), () => setFailed(true));
  }, [call, s.id, s.more, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const fact = [s.wake ? `Run ${s.wake}` : null, new Date(s.at).toLocaleString(), s.duration_ms !== undefined ? `took ${formatDuration(s.duration_ms)}` : null, s.http_status !== undefined ? `status ${s.http_status}` : null].filter(Boolean).join(' · ');
  const call_ = data?.agent_tool_call, result = data?.agent_tool_result;
  return (
    <div className='border-muted mb-2 ml-3 flex flex-col gap-2 border-l pb-1 pl-4 text-xs' data-trace-detail=''>
      <p className='text-muted-foreground'>{fact}</p>
      {s.kind === 'model' && s.input_tokens !== undefined && <p className='tabular-nums'>{s.input_tokens.toLocaleString('en')} tokens in ({(s.cached_tokens ?? 0).toLocaleString('en')} cached), {(s.output_tokens ?? 0).toLocaleString('en')} out{s.cost_usd !== undefined ? ` · ${dollars(s.cost_usd)}` : ''}</p>}
      {s.error && <pre className='bg-muted/40 text-destructive max-h-60 overflow-auto rounded-md border p-2 font-mono break-all whitespace-pre-wrap'>{s.error}</pre>}
      {s.detail && <p className='break-words font-mono'>{s.detail}</p>}
      {s.more && !data && !failed && <p className='text-muted-foreground'>Reading its full detail…</p>}
      {failed && <p className='text-destructive'>Its detail could not be read.</p>}
      {data && (call_ ? <Block heading={s.tool === 'Bash' ? 'Command' : 'Arguments'} text={s.tool === 'Bash' && typeof call_.preview === 'string' ? call_.preview : pretty(call_.input)} truncated={call_.truncated} /> : <p className='text-muted-foreground'>This step has no recorded input.</p>)}
      {data && (result ? <Block heading='Result' text={typeof result.result === 'string' ? result.result : pretty(result.result)} truncated={result.truncated} /> : <p className='text-muted-foreground'>{s.status === 'running' ? 'It is still running: its result appears here when it finishes.' : 'Its record holds no result.'}</p>)}
      {!s.more && s.fields && Object.keys(s.fields).length > 0 && <pre className='bg-muted/40 max-h-48 overflow-auto rounded-md border p-2 font-mono break-all whitespace-pre-wrap' data-trace-fields=''>{pretty(s.fields)}</pre>}
    </div>
  );
}

/** Whether the reader is at the live edge: the stream follows it there, and lets go when they scroll up. */
function useFollow(dependency: unknown) {
  const box = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const onScroll = () => { const b = box.current; if (b) setFollowing(b.scrollHeight - b.scrollTop - b.clientHeight < 96); };
  const toEnd = (behavior: ScrollBehavior = 'auto') => { const b = box.current; if (b) b.scrollTo({ top: b.scrollHeight, behavior }); };
  useEffect(() => { if (following) toEnd(); }, [dependency]); // eslint-disable-line react-hooks/exhaustive-deps
  return { box, following, onScroll, toEnd };
}

/** The stream. `dock` (the composer) floats over its bottom edge; the rows carry padding so nothing lives under it for good. */
export function TraceStream({ sessionId, call, steps, waitingOn, pruned, dock, dockHeight }: {
  sessionId: string; call: Call; steps: TraceStep[]; waitingOn: string | null; connected: boolean; live: boolean; pruned: boolean; dock: ReactNode; dockHeight: number;
}) {
  const shaped = useMemo(() => shapeSteps(steps), [steps]);
  const retries = useMemo(() => retryNumbers(steps), [steps]);
  const expansion = useMemo(() => ({ gen: 0, open: false }), []);
  const { box, following, onScroll, toEnd } = useFollow(steps.length + (waitingOn ?? '').length + (steps.at(-1)?.status ?? ''));
  const rows: ReactNode[] = [];
  for (const s of shaped) {
    rows.push(<Step key={s.id} s={s} retries={retries} call={call} sessionId={sessionId} />);
  }
  return (
    <div className='relative flex min-h-0 flex-1 flex-col' data-agent-trace=''>
      <ExpansionContext.Provider value={expansion}>
        <div ref={box} onScroll={onScroll} className='min-h-0 flex-1 overflow-y-auto overscroll-contain' style={{ paddingBottom: dockHeight + 24 }} role='log' aria-live='polite' aria-label='Trace' data-agent-transcript=''>
          {pruned && <p className='text-muted-foreground p-3 text-sm'>This session&apos;s conversation and trace were removed after their retention period; its spend and budget changes are kept.</p>}
          {!pruned && steps.length === 0
            ? <p className='text-muted-foreground p-3 text-sm' data-agent-waiting=''>{waitingOn ?? 'Nothing recorded yet: it appears here as the session works.'}</p>
            : <ol className='mx-auto flex w-full max-w-4xl flex-col gap-0.5'>{rows}</ol>}
        </div>
      </ExpansionContext.Provider>
      {!following && (
        <div className='pointer-events-none absolute inset-x-0 z-10 flex justify-center' style={{ bottom: dockHeight + 12 }}>
          <Button variant='outline' size='sm' className='bg-background pointer-events-auto rounded-full shadow-sm' onClick={() => toEnd('smooth')}>Jump to latest</Button>
        </div>
      )}
      {dock}
    </div>
  );
}
