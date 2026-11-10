'use client';
// The agent page's right dock (mold_v0-292, flag nested_runs; src/agent-dock.ts): one icon per section of the work this
// workspace is doing, each with its live count. Opening a section replaces the rail with its panel, and a breadcrumb is the only
// way in and out of a detail. Every panel has the same two controls: find something in it, or fork a second agent from a point
// in the conversation. On a phone the rail is one button in the session's bar, opening the same content as a sheet. The
// sections' words are the app's (each program's dock); the chat bar stays in view beside it, whatever is open.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { When, fail } from '@/features/portal/shared';
import { AgentComposer, type ComposerSend } from '../composer/agent-composer';
import { TraceStream, useTrace } from '../session-trace';
import { Climb, RunView, StatusBadge, type ClimbTarget, type DockCall } from './run-view';

export interface DockCheckpoint { id: number; label: string; role: 'person' | 'agent' }
interface Section { id: string; label: string; sub: string; icon: string; kind: 'items' | 'changes' | 'climb'; count: number; live: boolean; attention: boolean; programs: { id: string; name: string; description: string }[] }
interface Item { id: string; title: string; meta: string[]; status: string; at: string; program: string | null; handle: string | null; session_id: string | null; root_id: string | null; ref: string | null; error: string | null; fields: Record<string, unknown> }
type Detail = { title: string; node: ReactNode; fill?: boolean };

const iconOf = (name: string) => (Icons as unknown as Record<string, typeof Icons.sparkles>)[name] ?? Icons.sparkles;

function useWide() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const m = window.matchMedia('(min-width: 1024px)');
    const on = () => setWide(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

const hit = (q: string, ...parts: (string | null | undefined)[]) => !q.trim() || parts.some((p) => (p ?? '').toLowerCase().includes(q.trim().toLowerCase()));
const words = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(', ') : JSON.stringify(v));
const label = (k: string) => { const t = k.replaceAll('_', ' '); return `${t.charAt(0).toUpperCase()}${t.slice(1)}`; };

function Row({ title, facts, status, onOpen, live }: { title: string; facts: (string | null | false | undefined)[]; status?: string; onOpen?: () => void; live?: boolean }) {
  const line = facts.filter(Boolean).join(' · ');
  return (
    <Button variant='outline' disabled={!onOpen} onClick={onOpen} title={title} data-dock-row=''
      className={cn('flex h-auto w-full shrink-0 flex-col items-stretch gap-1 px-3 py-2.5 text-left font-normal whitespace-normal', live && 'border-primary/40')}>
      <span className='flex w-full min-w-0 items-center gap-2'>
        <span className='min-w-0 flex-1 truncate text-sm font-medium'>{title}</span>
        {status && <StatusBadge status={status} />}
        {onOpen && <Icons.chevronRight className='text-muted-foreground size-3.5 shrink-0' />}
      </span>
      {line && <span className='text-muted-foreground block w-full truncate text-xs'>{line}</span>}
    </Button>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs'>{rows.map(([k, v]) => <div key={k} className='contents'><dt className='text-muted-foreground'>{k}</dt><dd className='min-w-0 break-words'>{v}</dd></div>)}</dl>;
}

/** A child's own trace, read only (its parent's chat bar is the one that speaks). */
function ChildTrace({ id, call }: { id: string; call: DockCall }) {
  const trace = useTrace(call, `/api/agent/${id}/trace/stream`, id, () => {});
  return <TraceStream sessionId={id} call={call} steps={trace.steps} waitingOn={trace.waitingOn} connected={trace.connected} live={false} pruned={false} dock={null} dockHeight={0} />;
}

function ItemView({ item, call, onAsk, open }: { item: Item; call: DockCall; onAsk: (t: string) => void; open: (d: Detail) => void }) {
  return (
    <div className='flex flex-col gap-4' data-dock-detail={item.id}>
      <Facts rows={[...(item.ref ? [['From', item.ref] as [string, ReactNode]] : []), ...(item.program ? [['Program', item.program] as [string, ReactNode]] : []), ['When', <When key='when' d={item.at} />]]} />
      {Object.keys(item.fields).length > 0 && <Facts rows={Object.entries(item.fields).map(([k, v]) => [label(k), words(v)] as [string, ReactNode])} />}
      {item.error && <p className='text-destructive text-xs'>{item.error}</p>}
      <div className='flex flex-wrap gap-2'>
        {item.session_id && <Button size='sm' variant='outline' onClick={() => open({ title: 'What it did', fill: true, node: <ChildTrace id={item.session_id!} call={call} /> })}>What it did</Button>}
        {item.root_id && <Button size='sm' variant='outline' onClick={() => open({ title: 'Its run', node: <RunView id={item.root_id!} call={call} onAsk={onAsk} onOpenChild={(sid, name) => open({ title: name, fill: true, node: <ChildTrace id={sid} call={call} /> })} /> })}>Its run</Button>}
        <Button size='sm' variant='outline' onClick={() => onAsk(`About "${item.title}": `)}>Ask about this</Button>
      </div>
    </div>
  );
}

/** A section with nothing in it yet: what it is for, and a way to start each of its programs from the conversation. */
function EmptySection({ section, text, onAsk }: { section: Section; text: string; onAsk: (t: string) => void }) {
  return (
    <div className='flex flex-col items-start gap-2' data-dock-empty={section.id}>
      <p className='text-muted-foreground text-sm'>{text}</p>
      <div className='flex flex-wrap gap-2'>{section.programs.map((p) => <Button key={p.id} size='sm' variant='outline' data-dock-start={p.id} onClick={() => onAsk(`Run the ${p.name} program: `)}>Use {p.name}</Button>)}</div>
    </div>
  );
}

function SectionBody({ section, call, query, onAsk, open }: { section: Section; call: DockCall; query: string; onAsk: (t: string) => void; open: (d: Detail) => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [targets, setTargets] = useState<ClimbTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    const load = () => call<{ items?: Item[]; targets?: ClimbTarget[] }>('GET', `/dock/${encodeURIComponent(section.id)}`).then((r) => { if (on) { setItems(r.items ?? null); setTargets(r.targets ?? null); setError(null); } }, (e: Error) => { if (on) setError(e.message); });
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => { on = false; clearInterval(t); };
  }, [call, section.id]);
  if (error && !items && !targets) return <p className='text-destructive text-sm'>{error}</p>;
  if (!items && !targets) return <div className='bg-muted/40 h-24 animate-pulse rounded-lg' />;
  if (section.kind === 'climb') {
    const shown = (targets ?? []).filter((t) => hit(query, t.id, t.program));
    if (!shown.length) return query.trim() ? <p className='text-muted-foreground text-sm'>Nothing here matches.</p> : <EmptySection section={section} text='Nothing is climbing yet. A run shows here once a candidate is measured.' onAsk={onAsk} />;
    return <>{shown.map((t) => <div key={`${t.kind}:${t.id}`} className='flex flex-col gap-2 rounded-lg border p-3'><div className='flex items-center gap-2'><span className='min-w-0 flex-1 truncate text-sm font-medium'>{t.id}</span>{t.active && <StatusBadge status='running' />}</div><Climb target={t} onAsk={onAsk} /></div>)}</>;
  }
  const rows = (items ?? []).filter((i) => hit(query, i.title, i.program, i.ref, i.status, ...i.meta));
  if (!rows.length) return query.trim() ? <p className='text-muted-foreground text-sm'>Nothing here matches.</p> : <EmptySection section={section} text={`Nothing here yet. ${section.programs.length === 1 ? section.programs[0]!.description : 'Results show here as programs finish.'}`} onAsk={onAsk} />;
  return <>{rows.map((i) => (
    <Row key={i.id} title={i.title} status={i.status === 'done' ? undefined : i.status} live={i.status === 'running' || i.status === 'queued'} facts={[i.ref, ...i.meta.slice(0, 3)]}
      onOpen={() => open({ title: i.title, node: section.kind === 'changes' ? <ChangeView item={i} call={call} onAsk={onAsk} open={open} /> : <ItemView item={i} call={call} onAsk={onAsk} open={open} /> })} />
  ))}</>;
}

function ChangeView({ item, call, onAsk, open }: { item: Item; call: DockCall; onAsk: (t: string) => void; open: (d: Detail) => void }) {
  const f = item.fields as { reasons?: string[]; metrics?: { n?: number; baseline_mean?: number | null; candidate_mean?: number | null; lift?: number | null }; paths?: string[] };
  const m = f.metrics ?? {};
  const num = (v: number | null | undefined) => (typeof v === 'number' ? v.toFixed(3) : 'Not measured');
  return (
    <div className='flex flex-col gap-4' data-dock-change={item.id}>
      <div className='flex items-center gap-2'><StatusBadge status={item.status} /><span className='text-muted-foreground text-xs'>{item.meta[0]} · <When d={item.at} /></span></div>
      {(f.reasons?.length ?? 0) > 0 && <ul className='list-disc pl-4 text-sm'>{f.reasons!.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      <Facts rows={[['Cases', String(m.n ?? 0)], ['Current best', num(m.baseline_mean)], ['This change', num(m.candidate_mean)], ['Improvement', typeof m.lift === 'number' ? `${(m.lift * 100).toFixed(1)}%` : 'Not measured']]} />
      {(f.paths?.length ?? 0) > 0 && <div className='flex flex-col gap-1'><span className='text-muted-foreground text-xs'>What it changed</span><ul className='flex flex-col gap-0.5 font-mono text-xs'>{f.paths!.map((p) => <li key={p} className='break-all'>{p}</li>)}</ul></div>}
      <div className='flex flex-wrap gap-2'>
        {item.root_id && <Button size='sm' variant='outline' onClick={() => open({ title: 'Its run', node: <RunView id={item.root_id!} call={call} onAsk={onAsk} /> })}>Its run</Button>}
        <Button size='sm' variant='outline' onClick={() => onAsk(`About this change, "${item.title}": `)}>Ask about this</Button>
      </div>
    </div>
  );
}

/** A second agent, forked from a point in the conversation: a session of its own that the conversation it came from never sees. */
function ForkPanel({ parent, checkpoint, call, onOpenSession }: { parent: string; checkpoint: DockCheckpoint; call: DockCall; onOpenSession: (id: string) => void }) {
  const [session, setSession] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (c: ComposerSend): Promise<boolean> => {
    setBusy(true);
    try {
      if (!session) { const r = await call<{ session: { id: string } }>('POST', `/${parent}/fork`, { message_id: checkpoint.id, message: c.message }); setSession(r.session.id); }
      else await call('POST', `/${session}/messages`, { message: c.message, files: c.files, repositories: c.repositories });
      return true;
    } catch (e) { fail(e); return false; } finally { setBusy(false); }
  };
  return (
    <div className='flex min-h-0 flex-1 flex-col gap-2' data-dock-fork=''>
      {session ? <ForkTrace id={session} call={call} /> : <p className='text-muted-foreground flex-1 text-sm'>A second agent, picking up from &ldquo;{checkpoint.label}&rdquo;. It knows the conversation up to there and is a separate session: this one never sees what you say to it.</p>}
      {session && <Button size='sm' variant='outline' className='self-start' onClick={() => onOpenSession(session)}>Open in full</Button>}
      <AgentComposer id={`fork-${checkpoint.id}`} label='Message the second agent' value={text} onChange={setText} placeholder='Ask it to go a different way' sendLabel='Send' disabledReason={null} busy={busy} session={session} onSend={send} />
    </div>
  );
}
function ForkTrace({ id, call }: { id: string; call: DockCall }) {
  const trace = useTrace(call, `/api/agent/${id}/trace/stream`, id, () => {});
  return <TraceStream sessionId={id} call={call} steps={trace.steps} waitingOn={trace.waitingOn} connected={trace.connected} live={false} pruned={false} dock={null} dockHeight={0} />;
}

export function useAgentDock({ enabled, call, sessionId, checkpoints, onAsk, onOpenSession }: { enabled: boolean; call: DockCall; sessionId: string; checkpoints: DockCheckpoint[]; onAsk: (text: string) => void; onOpenSession: (id: string) => void }) {
  const [sections, setSections] = useState<Section[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [query, setQuery] = useState('');
  const [fork, setFork] = useState<DockCheckpoint | null>(null);
  const [picking, setPicking] = useState(false);
  const [sheet, setSheet] = useState(false);
  const wide = useWide();
  useEffect(() => {
    if (!enabled) return;
    let on = true;
    const load = () => call<{ sections: Section[] }>('GET', '/dock').then((r) => { if (on) setSections(r.sections); }, () => { /* the badges keep their last numbers */ });
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => { on = false; clearInterval(t); };
  }, [enabled, call]);
  const current = useMemo(() => sections.find((s) => s.id === openId) ?? null, [sections, openId]);
  const openSection = useCallback((id: string | null) => { setDetail(null); setFork(null); setPicking(false); setQuery(''); setOpenId(id); }, []);
  const ask = useCallback((t: string) => { onAsk(t); setSheet(false); }, [onAsk]);
  if (!enabled || !sections.length) return { column: null, phoneButton: null };

  const body = current && (
    <>
      <nav aria-label='Breadcrumb' className='flex h-12 shrink-0 flex-nowrap items-center gap-1.5 overflow-hidden border-b px-3' data-dock-breadcrumb=''>
        {(() => { const I = iconOf(current.icon); return <I className='text-muted-foreground size-4 shrink-0' />; })()}
        {detail || fork
          ? <Button variant='outline' size='sm' className='h-7 max-w-[45%] shrink-0 truncate px-2 text-sm font-medium' onClick={() => { setDetail(null); setFork(null); }}>{current.label}</Button>
          : <span className='min-w-0 truncate text-sm font-medium' aria-current='page'>{current.label}</span>}
        {(fork || detail) && <><Icons.chevronRight className='text-muted-foreground/60 size-3.5 shrink-0' /><span className='min-w-0 flex-1 truncate text-sm font-medium' title={fork ? 'Second agent' : detail!.title}>{fork ? 'Second agent' : detail!.title}</span></>}
        <Button variant='outline' size='icon' aria-label='Close' className='ml-auto size-7 shrink-0' onClick={() => { setSheet(false); openSection(null); }}><Icons.close className='size-4' /></Button>
      </nav>
      <div className='relative flex shrink-0 items-center gap-2 border-b px-3 py-2'>
        <Input aria-label={`Search ${current.label}`} className='h-8 min-w-0 flex-1' value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${current.label.toLowerCase()}`} />
        <Button variant='outline' size='sm' className='h-8 shrink-0' aria-expanded={picking} onClick={() => (fork ? setFork(null) : setPicking((v) => !v))}><Icons.gitBranch className='size-3.5' />{fork ? 'Close agent' : 'Attach agent'}</Button>
        {picking && (
          <div className='bg-popover absolute top-full right-3 z-50 mt-1 w-[min(420px,90%)] overflow-hidden rounded-md border p-1 shadow-md' data-dock-checkpoints=''>
            <p className='text-muted-foreground px-2 py-1.5 text-xs'>Fork from</p>
            {checkpoints.length === 0 ? <p className='text-muted-foreground px-2 py-1.5 text-xs'>Nothing to fork from yet: say something in the conversation first.</p>
              : <div className='flex max-h-72 flex-col gap-1 overflow-y-auto'>{checkpoints.map((c) => <Button key={c.id} variant='outline' size='sm' className='h-auto w-full justify-start px-2 py-1.5 text-left text-xs font-normal whitespace-normal' onClick={() => { setFork(c); setPicking(false); setDetail(null); }}><span className='truncate'>{c.label}</span></Button>)}</div>}
          </div>
        )}
      </div>
      <div className={cn('flex min-h-0 flex-1 flex-col gap-2 overscroll-contain p-3', detail?.fill || fork ? 'overflow-hidden' : 'overflow-y-auto')} data-dock-body={current.id}>
        {fork ? <ForkPanel parent={sessionId} checkpoint={fork} call={call} onOpenSession={onOpenSession} />
          : detail ? detail.node
            : <SectionBody section={current} call={call} query={query} onAsk={ask} open={setDetail} />}
      </div>
    </>
  );

  const column = !wide ? null : current
    ? <aside aria-label={current.label} className='bg-background flex h-full shrink-0 flex-col border-l' style={{ width: 'min(40vw, 640px)', minWidth: 380 }} data-right-dock-panel={current.id}>{body}</aside>
    : <div className='flex h-full w-14 shrink-0 flex-col items-center justify-center gap-1.5 overflow-y-auto border-l' data-right-dock=''>
      {sections.map((s) => { const I = iconOf(s.icon); return (
        <Button key={s.id} variant='outline' size='icon' aria-label={`${s.label}: ${s.count} ${s.sub}`} title={`${s.label}: ${s.sub}`} className='relative size-10 rounded-xl' data-dock-section={s.id} data-live={s.live ? 'true' : undefined} onClick={() => openSection(s.id)}>
          <I className='size-4' />
          {s.count > 0 && <span className={cn('border-background absolute -top-1.5 -right-1.5 min-w-[18px] rounded-full border px-1 text-center text-[10px] leading-4 font-medium tabular-nums', s.attention ? 'bg-amber-500 text-black' : s.live ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground')} data-dock-count=''>{s.count > 99 ? '99+' : s.count}</span>}
          {s.live && s.count === 0 && <span className='bg-primary absolute -top-1 -right-1 size-2 rounded-full motion-safe:animate-pulse' aria-hidden />}
        </Button>
      ); })}
    </div>;

  const total = sections.reduce((t, s) => t + s.count, 0), live = sections.some((s) => s.live);
  const phoneButton = wide ? null : (
    <>
      <Button variant='outline' size='sm' className='relative shrink-0' aria-label={`Work so far: ${total}`} onClick={() => setSheet(true)} data-right-dock-phone=''>
        <Icons.sparkles className='size-4' />{total > 0 && <span className='text-xs tabular-nums'>{total > 99 ? '99+' : total}</span>}
        {live && <span className='bg-primary absolute -top-1 -right-1 size-2 rounded-full motion-safe:animate-pulse' aria-hidden />}
      </Button>
      <Sheet open={sheet} onOpenChange={(o) => { setSheet(o); if (!o) openSection(null); }}>
        <SheetContent side='right' showCloseButton={!current} className='flex w-full flex-col gap-0 p-0 sm:max-w-md' data-right-dock-sheet=''>
          <SheetHeader className='sr-only'><SheetTitle>{current?.label ?? 'The work so far'}</SheetTitle><SheetDescription>Each section of the work this workspace is doing.</SheetDescription></SheetHeader>
          {current ? body : <div className='flex flex-col gap-2 overflow-y-auto p-3 pt-12'>{sections.map((s) => { const I = iconOf(s.icon); return (
            <Button key={s.id} variant='outline' className='flex h-11 w-full items-center justify-start gap-2 font-normal' data-dock-section={s.id} onClick={() => openSection(s.id)}><I className='size-4 shrink-0' /><span className='min-w-0 flex-1 truncate text-left'>{s.label}</span>{s.live && <span className='bg-primary size-2 shrink-0 rounded-full motion-safe:animate-pulse' aria-hidden />}<span className='text-muted-foreground text-xs tabular-nums'>{s.count}</span></Button>
          ); })}</div>}
        </SheetContent>
      </Sheet>
    </>
  );
  return { column, phoneButton };
}
