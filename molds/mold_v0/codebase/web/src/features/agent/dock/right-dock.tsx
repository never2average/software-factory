'use client';
// The agent page's dock (mold_v0-292, flag nested_runs; src/agent-dock.ts): the sections of the work this workspace is doing.
// mold_v0-295: no rail beside the chat; the sections are a few grouped tabs in the session's top bar (the shared OverflowTabs:
// each group a menu of its sections). A breadcrumb is the only way in and out of a detail. Every section has the same two
// controls: find something in it, or fork a second agent from a point in the conversation. On a phone the tabs are one button
// in the session's bar, opening the same list as a sheet. The sections' words and groups are the app's (each program's dock);
// the chat bar stays in view, whatever is open.
// mold_v0-296: no counts. Each section in a group's menu is two lines (its name, then its plain words, or "Nothing yet",
// greyed), a dot on the right (green and pulsing while it works, amber while it needs a person, saying why; a legend at the
// menu's foot when one shows) and the open one checked. Choosing any section opens it in one large modal (the shared Dialog,
// about 90% of the screen; a phone's whole screen) over the full-width chat: a breadcrumb (Think › Deep Thoughts), the groups
// and each group's sections as tabs (the shared InPageTabs; every section reachable from inside), the section itself, and a
// detail drilled into in place (never a second modal); Esc or the X closes it. The open section is in the address
// (?section=<id>): a refresh, Back or a shared link reopens it.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Icons } from '@/components/icons';
import { OverflowTabs } from '@/components/layout/overflow-tabs';
import { InPageTabs } from '@/features/tabs/in-page-tabs';
import { cn } from '@/lib/utils';
import type { AgentPurpose } from '@/lib/agent-purpose';
import { AgentName } from '../agent-name';
import { When, fail } from '@/features/portal/shared';
import { AgentComposer, type ComposerSend } from '../composer/agent-composer';
import { TraceStream, useTrace } from '../session-trace';
import { Climb, RunView, StatusBadge, type ClimbTarget, type DockCall } from './run-view';
import { RecordView, type RecordCol } from '@/components/layout/record-view';

export interface DockCheckpoint { id: number; label: string; role: 'person' | 'agent' }
interface Section { id: string; label: string; sub: string; icon: string; kind: 'items' | 'changes' | 'climb'; group?: string; count: number; live: boolean; attention: boolean; needs?: { review: number; stopped: number }; programs: { id: string; name: string; description: string; purpose?: AgentPurpose }[] }
interface Group { id: string; label: string }
interface Item { id: string; title: string; meta: string[]; status: string; at: string; program: string | null; purpose?: AgentPurpose | null; handle: string | null; session_id: string | null; root_id: string | null; ref: string | null; error: string | null; fields: Record<string, unknown> }
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

/** Why a section needs a person, in plain words, no numbers (an older answer without the counts: that it does). */
export function needsWords(s: Pick<Section, 'attention' | 'needs'>): string | null {
  if (!s.attention) return null;
  const n = s.needs ?? { review: 0, stopped: 0 };
  const parts = [n.review ? (n.review === 1 ? 'A change waits for your review' : 'Changes wait for your review') : null, n.stopped ? (n.stopped === 1 ? 'A run stopped and waits for you' : 'Runs stopped and wait for you') : null].filter(Boolean) as string[];
  return parts.length ? parts.map((p, i) => (i ? p.charAt(0).toLowerCase() + p.slice(1) : p)).join(', and ') : 'Something here needs you';
}
/** The plain line under a section's name: its own words (its `sub`, capitalised; no number), or that nothing is in it yet. */
export const subWords = (s: Pick<Section, 'count' | 'sub' | 'live'>) => {
  if (!s.count) return s.live ? 'Working on the first' : 'Nothing yet';
  const t = s.sub.trim() || 'Results';
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
};
const quiet = (s: Section) => !s.count && !s.live && !s.attention;
const LIVE_DOT = 'bg-emerald-500', NEEDS_DOT = 'bg-amber-500';

/** A section's state as one dot: amber while it needs a person, green and pulsing while it works, nothing otherwise. */
function StateDot({ live, attention, why }: { live: boolean; attention: boolean; why?: string | null }) {
  if (!attention && !live) return null;
  return <span role='img' aria-label={attention ? (why ?? 'Needs you') : 'Working'} title={attention ? (why ?? 'Needs you') : 'Working'} data-dock-dot={attention ? 'attention' : 'live'}
    className={cn('size-2 shrink-0 rounded-full', attention ? NEEDS_DOT : cn(LIVE_DOT, 'motion-safe:animate-pulse'))} />;
}
/** The one line at a menu's foot that says what its dots mean. */
function Legend() {
  return <span className='inline-flex items-center gap-1.5' data-dock-legend=''><span className={cn('size-2 rounded-full', LIVE_DOT)} aria-hidden />working<span aria-hidden>·</span><span className={cn('size-2 rounded-full', NEEDS_DOT)} aria-hidden />needs you</span>;
}
/** The plain line under a section's name in a group's menu (the menu draws the name). */
function SectionSub({ s }: { s: Section }) {
  const why = needsWords(s);
  return <>{subWords(s)}{why && <> · <span className='text-amber-700 dark:text-amber-400'>{why}</span></>}</>;
}
/** Two lines: the section's name, then its plain words (and, amber, why it needs a person). */
function SectionWords({ s }: { s: Section }) {
  const why = needsWords(s);
  return <><span className='truncate'>{s.label}</span><span className='text-muted-foreground truncate text-xs' data-menu-sub=''>{subWords(s)}{why && <> · <span className='text-amber-700 dark:text-amber-400'>{why}</span></>}</span></>;
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
      <Facts rows={[...(item.ref ? [['From', item.ref] as [string, ReactNode]] : []), ...(item.program ? [['Agent', <AgentName key='agent' name={item.program} purpose={item.purpose} muted={false} />] as [string, ReactNode]] : []), ['When', <When key='when' d={item.at} />]]} />
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
      <div className='flex flex-wrap gap-2'>{section.programs.map((p) => <Button key={p.id} size='sm' variant='outline' className='items-center' data-dock-start={p.id} onClick={() => onAsk(`Run the ${p.name} program: `)}><AgentName name={`Use ${p.name}`} purpose={p.purpose} muted={false} className='text-sm' /></Button>)}</div>
    </div>
  );
}

/** The columns of a section's list: the same table as every other list in the tool (mold_v0-297). */
function itemCols(kind: Section['kind']): RecordCol<Item>[] {
  return [
    { key: 'ref', label: 'Number', type: 'text', keep: true, value: (i) => i.ref ?? '', render: (i) => (i.ref ? <span className='font-mono text-xs whitespace-nowrap'>{i.ref}</span> : dash) },
    { key: 'title', label: kind === 'changes' ? 'Change' : 'Title', title: true, keep: true, type: 'text', className: 'min-w-56', value: (i) => i.title, render: (i) => <span className='leading-snug font-medium'>{i.title}</span> },
    { key: 'agent', label: 'Agent', type: 'text', value: (i) => i.program ?? '', render: (i) => (i.program ? <AgentName name={i.program} purpose={i.purpose} muted={false} className='text-sm' /> : dash) },
    { key: 'status', label: 'Status', type: 'select', value: (i) => i.status, render: (i) => <StatusBadge status={i.status} /> },
    { key: 'details', label: 'Details', type: 'text', value: (i) => i.meta.join(' · '), render: (i) => (i.meta.length ? <span className='text-muted-foreground line-clamp-2 max-w-[28rem]'>{i.meta.join(' · ')}</span> : dash) },
    { key: 'at', label: 'When', type: 'date', keep: true, value: (i) => i.at, render: (i) => <When d={i.at} /> },
  ];
}
const dash = <span className='text-muted-foreground'>—</span>;

function useSectionData(call: DockCall, id: string) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [targets, setTargets] = useState<ClimbTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    const load = () => call<{ items?: Item[]; targets?: ClimbTarget[] }>('GET', `/dock/${encodeURIComponent(id)}`).then((r) => { if (on) { setItems(r.items ?? null); setTargets(r.targets ?? null); setError(null); } }, (e: Error) => { if (on) setError(e.message); });
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => { on = false; clearInterval(t); };
  }, [call, id]);
  return { items, targets, error };
}

/** A section of items or changes: the tool's standard list filling the modal; a row opens it in the panel beside the table. */
function SectionTable({ section, call, onAsk, open, toolbar }: { section: Section; call: DockCall; onAsk: (t: string) => void; open: (d: Detail) => void; toolbar: ReactNode }) {
  const { items, error } = useSectionData(call, section.id);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const cols = useMemo(() => itemCols(section.kind), [section.kind]);
  if (error && !items) return <p className='text-destructive text-sm'>{error}</p>;
  const rows = items ?? [];
  return (
    // The table fills the modal below its tabs (RecordView's page height is replaced by the modal's own).
    <div className='flex min-h-0 flex-1 flex-col [&>[data-slot=list-split]]:!h-full [&>[data-slot=list-split]]:!min-h-0' data-dock-table={section.id}>
      <RecordView<Item> id={`dock-${section.id}`} noun={rows.length === 1 ? 'item' : 'items'} loading={!items} rows={rows} rowKey={(i) => i.id} cols={cols}
        openKey={openKey} onOpenChange={setOpenKey} defaultSort={[{ key: 'at', dir: 'desc' }]} ask={false}
        searchText={(i) => `${i.ref ?? ''} ${i.title} ${i.program ?? ''} ${i.status} ${i.meta.join(' ')}`} searchPlaceholder={`Search ${section.label.toLowerCase()}`}
        toolbarAction={toolbar} exportName={`dock-${section.id}`}
        detailTitle={(i) => i.title}
        detail={(i) => (section.kind === 'changes' ? <ChangeView key={i.id} item={i} call={call} onAsk={onAsk} open={open} /> : <ItemView key={i.id} item={i} call={call} onAsk={onAsk} open={open} />)}
        empty={<EmptySection section={section} text={`Nothing here yet. ${section.programs.length === 1 ? section.programs[0]!.description : 'Results show here as programs finish.'}`} onAsk={onAsk} />} />
    </div>
  );
}

/** A climbing section: each target's measured candidates as a card (no table: a chart per target). */
function ClimbBody({ section, call, query, onAsk }: { section: Section; call: DockCall; query: string; onAsk: (t: string) => void }) {
  const { targets, error } = useSectionData(call, section.id);
  if (error && !targets) return <p className='text-destructive text-sm'>{error}</p>;
  if (!targets) return <div className='bg-muted/40 h-24 animate-pulse rounded-lg' />;
  const shown = targets.filter((t) => hit(query, t.id, t.program));
  if (!shown.length) return query.trim() ? <p className='text-muted-foreground text-sm'>Nothing here matches.</p> : <EmptySection section={section} text='Nothing is climbing yet. A run shows here once a candidate is measured.' onAsk={onAsk} />;
  return <>{shown.map((t) => <div key={`${t.kind}:${t.id}`} className='flex flex-col gap-2 rounded-lg border p-3'><div className='flex items-center gap-2'><span className='min-w-0 flex-1 truncate text-sm font-medium'>{t.id}</span>{t.active && <StatusBadge status='running' />}</div><Climb target={t} onAsk={onAsk} /></div>)}</>;
}

/** Fork a second agent from a point in the conversation: the button and its list of points. */
function AttachAgent({ checkpoints, forking, picking, setPicking, onPick, onClose }: { checkpoints: DockCheckpoint[]; forking: boolean; picking: boolean; setPicking: (f: (v: boolean) => boolean) => void; onPick: (c: DockCheckpoint) => void; onClose: () => void }) {
  return (
    <div className='relative shrink-0'>
      <Button variant='outline' size='sm' className='h-9 shrink-0' aria-expanded={picking} onClick={() => (forking ? onClose() : setPicking((v) => !v))}><Icons.gitBranch className='size-3.5' />{forking ? 'Close agent' : 'Attach agent'}</Button>
      {picking && (
        <div className='bg-popover absolute top-full right-0 z-50 mt-1 w-[min(420px,80vw)] overflow-hidden rounded-md border p-1 shadow-md' data-dock-checkpoints=''>
          <p className='text-muted-foreground px-2 py-1.5 text-xs'>Fork from</p>
          {checkpoints.length === 0 ? <p className='text-muted-foreground px-2 py-1.5 text-xs'>Nothing to fork from yet: say something in the conversation first.</p>
            : <div className='flex max-h-72 flex-col gap-1 overflow-y-auto'>{checkpoints.map((c) => <Button key={c.id} variant='outline' size='sm' className='h-auto w-full justify-start px-2 py-1.5 text-left text-xs font-normal whitespace-normal' onClick={() => onPick(c)}><span className='truncate'>{c.label}</span></Button>)}</div>}
        </div>
      )}
    </div>
  );
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
  const [groups, setGroups] = useState<Group[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [query, setQuery] = useState('');
  const [fork, setFork] = useState<DockCheckpoint | null>(null);
  const [picking, setPicking] = useState(false);
  const [sheet, setSheet] = useState(false);
  const wide = useWide();
  // The open section is in the address (?section=<id>): read on arrival and on Back, written when one opens or closes.
  useEffect(() => {
    const read = () => { setDetail(null); setFork(null); setPicking(false); setOpenId(new URLSearchParams(window.location.search).get('section')); };
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let on = true;
    const load = () => call<{ sections: Section[]; groups?: Group[] }>('GET', '/dock').then((r) => { if (on) { setSections(r.sections); setGroups(r.groups ?? []); } }, () => { /* the badges keep their last numbers */ });
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => { on = false; clearInterval(t); };
  }, [enabled, call]);
  const current = useMemo(() => sections.find((s) => s.id === openId) ?? null, [sections, openId]);
  const openSection = useCallback((id: string | null) => {
    setDetail(null); setFork(null); setPicking(false); setQuery(''); setOpenId(id);
    const u = new URL(window.location.href);
    if (id) u.searchParams.set('section', id); else u.searchParams.delete('section');
    if (u.toString() !== window.location.href) window.history.pushState(null, '', u.toString());
  }, []);
  const ask = useCallback((t: string) => { onAsk(t); openSection(null); setSheet(false); }, [onAsk, openSection]);
  if (!enabled || !sections.length) return { modal: null, bar: null };
  // A section that names no group (an older answer) sits under one of its own words.
  const groupOf = (s: Section) => s.group ?? 'sections';
  const shownGroups: Group[] = [...groups.filter((g) => sections.some((s) => groupOf(s) === g.id)), ...[...new Set(sections.map(groupOf))].filter((id) => !groups.some((g) => g.id === id)).map((id) => ({ id, label: id === 'sections' ? 'Sections' : id }))];
  const inGroup = (g: Group) => sections.filter((s) => groupOf(s) === g.id);
  const groupOfCurrent = current ? shownGroups.find((g) => g.id === groupOf(current)) ?? null : null;
  const siblings = groupOfCurrent ? inGroup(groupOfCurrent) : [];
  const tabOf = (x: Section) => { const I = iconOf(x.icon); return { id: x.id, label: x.label, icon: <I aria-hidden />, data: { 'data-dock-sibling': x.id, 'data-empty': quiet(x) ? 'true' : undefined } }; };

  const body = current && (
    <>
      <nav aria-label='Breadcrumb' className='flex h-12 shrink-0 flex-nowrap items-center gap-1.5 overflow-hidden border-b px-4' data-dock-breadcrumb=''>
        {(() => { const I = iconOf(current.icon); return <I className='text-muted-foreground size-4 shrink-0' aria-hidden />; })()}
        {groupOfCurrent && <><span className='text-muted-foreground shrink-0 text-sm' data-dock-crumb-group={groupOfCurrent.id}>{groupOfCurrent.label}</span><Icons.chevronRight className='text-muted-foreground/60 size-3.5 shrink-0' aria-hidden /></>}
        {detail || fork
          ? <Button variant='outline' size='sm' className='h-7 max-w-[45%] shrink-0 truncate px-2 text-sm font-medium' onClick={() => { setDetail(null); setFork(null); }}>{current.label}</Button>
          : <span className='min-w-0 truncate text-sm font-medium' aria-current='page'>{current.label}</span>}
        {(fork || detail) && <><Icons.chevronRight className='text-muted-foreground/60 size-3.5 shrink-0' aria-hidden /><span className='min-w-0 flex-1 truncate text-sm font-medium' title={fork ? 'Second agent' : detail!.title}>{fork ? 'Second agent' : detail!.title}</span></>}
        <Button variant='outline' size='icon' aria-label='Close' title='Close (Esc)' className='ml-auto size-8 shrink-0' onClick={() => openSection(null)}><Icons.close className='size-4' /></Button>
      </nav>
      {/* Every section reachable from inside: the groups, then the open group's sections. */}
      <div className='flex shrink-0 flex-col gap-1 border-b px-4 pt-2' data-dock-tabs=''>
        {shownGroups.length > 1 && <div data-dock-group-tabs=''><InPageTabs size='sm' label='Groups' value={groupOfCurrent?.id ?? shownGroups[0]!.id} onValueChange={(id) => { const first = sections.find((x) => groupOf(x) === id); if (first) openSection(first.id); }}
          tabs={shownGroups.map((g) => ({ id: g.id, label: g.label, data: { 'data-dock-group-tab': g.id } }))} /></div>}
        {siblings.length > 1 && <div data-dock-siblings={groupOfCurrent!.id}><InPageTabs size='sm' label={groupOfCurrent!.label} value={current.id} onValueChange={(id) => openSection(id)} tabs={siblings.map(tabOf)} /></div>}
      </div>
      {(() => {
        const attach = <AttachAgent checkpoints={checkpoints} forking={!!fork} picking={picking} setPicking={setPicking} onPick={(c) => { setFork(c); setPicking(false); setDetail(null); }} onClose={() => setFork(null)} />;
        // mold_v0-297: a section of items is the tool's standard table, filling the modal (its own search row carries Attach agent).
        const table = !fork && !detail && current.kind !== 'climb';
        return (<>
          {!table && <div className='flex shrink-0 items-center gap-2 border-b px-4 py-2'>
            {current.kind === 'climb' && !fork && !detail ? <Input aria-label={`Search ${current.label}`} className='h-9 min-w-0 flex-1' value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${current.label.toLowerCase()}`} /> : <span className='flex-1' />}
            {attach}
          </div>}
          <div className={cn('flex min-h-0 flex-1 flex-col gap-2 overscroll-contain p-4', detail?.fill || fork || table ? 'overflow-hidden' : 'overflow-y-auto')} data-dock-body={current.id}>
            {fork ? <ForkPanel parent={sessionId} checkpoint={fork} call={call} onOpenSession={onOpenSession} />
              : detail ? detail.node
                : table ? <SectionTable key={current.id} section={current} call={call} onAsk={ask} open={setDetail} toolbar={attach} />
                  : <ClimbBody key={current.id} section={current} call={call} query={query} onAsk={ask} />}
          </div>
        </>);
      })()}
    </>
  );

  // Any section, from the bar or the phone's list: one large modal over the chat (the chat stays full width behind it).
  const modal = (
    <Dialog open={!!current} onOpenChange={(o) => { if (!o) openSection(null); }}>
      <DialogContent showCloseButton={false} data-right-dock-panel={current?.id ?? ''} data-dock-modal=''
        className='flex h-[90vh] w-[90vw] max-w-[90vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[90vw] max-sm:h-[100dvh] max-sm:w-screen max-sm:max-w-none max-sm:rounded-none'>
        <DialogTitle className='sr-only'>{current ? `${groupOfCurrent ? `${groupOfCurrent.label}: ` : ''}${current.label}` : 'The work so far'}</DialogTitle>
        <DialogDescription className='sr-only'>One section of the work this workspace is doing.</DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );

  // Wide: the groups as tabs in the session's top bar, each a menu of its sections (two lines, a state dot, the open one
  // checked); as many groups as the bar has room for, the rest behind its » (the title keeps its room).
  const tabs = wide ? (
    <OverflowTabs strip fit label='Work so far' value={current ? groupOf(current) : null} tabs={shownGroups.map((g) => {
      const mine = inGroup(g);
      const live = mine.some((s) => s.live), attention = mine.some((s) => s.attention);
      const why = mine.map((s) => { const w = needsWords(s); return w ? `${s.label}: ${w}` : null; }).filter(Boolean).join('; ') || null;
      return {
        id: g.id, label: g.label,
        data: { 'data-dock-group': g.id, 'data-live': live ? 'true' : undefined, 'data-attention': attention ? 'true' : undefined },
        mark: <StateDot live={live} attention={attention} why={why} />,
        foot: mine.some((s) => s.live || s.attention) ? <Legend /> : undefined,
        menu: mine.map((s) => { const I = iconOf(s.icon); return {
          id: s.id, label: s.label, sub: <SectionSub s={s} />, current: s.id === openId, dim: quiet(s), onSelect: () => openSection(s.id),
          icon: <I className='size-4 shrink-0' aria-hidden />,
          end: <StateDot live={s.live} attention={s.attention} why={needsWords(s)} />,
          data: { 'data-dock-section': s.id, 'data-live': s.live ? 'true' : undefined, 'data-attention': s.attention ? 'true' : undefined, 'data-empty': quiet(s) ? 'true' : undefined },
        }; }),
      };
    })} />
  ) : null;

  // A phone: one button, its list of sections as a sheet; choosing one closes the sheet and opens the modal, full screen.
  const live = sections.some((s) => s.live), attention = sections.some((s) => s.attention);
  const phoneButton = wide ? null : (
    <>
      <Button variant='outline' size='sm' className='relative shrink-0' aria-label='Work so far' onClick={() => setSheet(true)} data-right-dock-phone=''>
        <Icons.sparkles className='size-4' />
        {(live || attention) && <span className={cn('absolute -top-1 -right-1 size-2 rounded-full', attention ? NEEDS_DOT : cn(LIVE_DOT, 'motion-safe:animate-pulse'))} aria-hidden />}
      </Button>
      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent side='right' className='flex w-full flex-col gap-0 p-0 sm:max-w-md' data-right-dock-sheet=''>
          <SheetHeader className='sr-only'><SheetTitle>The work so far</SheetTitle><SheetDescription>Each section of the work this workspace is doing.</SheetDescription></SheetHeader>
          <div className='flex flex-col gap-4 overflow-y-auto p-3 pt-12'>{shownGroups.map((g) => (
            <section key={g.id} className='flex flex-col gap-2' data-dock-group={g.id} aria-label={g.label}>
              <h3 className='text-muted-foreground text-xs font-medium'>{g.label}</h3>
              {inGroup(g).map((s) => { const I = iconOf(s.icon); return (
                <Button key={s.id} variant='outline' className={cn('flex h-auto min-h-11 w-full items-center justify-start gap-2.5 py-2 text-left font-normal', quiet(s) && 'text-muted-foreground')}
                  data-dock-section={s.id} data-empty={quiet(s) ? 'true' : undefined} data-attention={s.attention ? 'true' : undefined} onClick={() => { setSheet(false); openSection(s.id); }}>
                  <I className='size-4 shrink-0' />
                  <span className='flex min-w-0 flex-1 flex-col'><SectionWords s={s} /></span>
                  <StateDot live={s.live} attention={s.attention} why={needsWords(s)} />
                </Button>
              ); })}
            </section>
          ))}
          {(live || attention) && <p className='text-muted-foreground text-xs'><Legend /></p>}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
  return { modal, bar: wide ? tabs : phoneButton };
}
