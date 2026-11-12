'use client';
// One run of an agent tree (mold_v0-292, flag nested_runs; src/agent-dock.ts): what it spent, its children, each machine's step
// graph live, what the guardian decided, the versions it made and the climb across them. The Active runs panel, its full page
// and the dock's panels all draw this one view.
import dynamic from 'next/dynamic';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { When } from '@/features/portal/shared';
import type { AgentLabel, AgentPurpose } from '@/lib/agent-purpose';
import { AgentName } from '../agent-name';

const HillClimbing3D = dynamic(() => import('./hill-climbing-3d').then((m) => m.HillClimbing3D), { ssr: false, loading: () => <div className='bg-muted/40 h-64 animate-pulse rounded-lg' /> });

export type DockCall = <T>(method: string, path?: string, body?: unknown) => Promise<T>;
export interface ClimbAxis { metric: string; higherIsBetter: boolean; role: 'objective' | 'constraint'; bound: number | null }
export interface ClimbPoint { id: string; label: string; at: string; coords: [number | null, number | null, number | null]; values: (number | null)[]; color: string; outcome: string | null; lift: number | null; version: number | null }
export interface Version { id: string; version: number; status: string; lift: number | null; applied_at: string | null; applied_ref: string | null; rolled_back_at: string | null; rollback_reason: string | null; at: string; workspace?: string | null }
export interface ClimbTarget { id: string; kind: string; program: string; axes: ClimbAxis[]; points: ClimbPoint[]; versions: Version[]; active: boolean }
interface Graph { states: { id: string; kind: string; entries: number; settled: boolean; running: boolean }[]; transitions: { from: string; to: string; label: string | null }[]; status: string; error: string | null; fired: number; max: number }
interface RunNode { handle: string; name: string; ref: string | null; kind: string; program: string | null; state: string | null; status: string; settled: boolean; error: string | null; budget_usd: number; spent_usd: number; waiting: string | null; attention: boolean; session_id: string | null; started_at: string; settled_at: string | null; parent_id: string; step_of: string | null; graph: Graph | null; purpose?: AgentPurpose }
export interface RunDetail { root: { id: string; ref: string | null; title: string; agent?: AgentLabel; state: string; budget_usd: number; spent_usd: number; carved_usd: number; children_spent_usd: number; remaining_usd: number }; children: RunNode[]; decisions: { id: string; target: string; outcome: string | null; lift: number | null; hypothesis: string; reasons: string[]; at: string; promoted: boolean }[]; targets: ClimbTarget[] }

export const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (v: number | null | undefined) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : 'Not measured');
export const STATUS_WORDS: Record<string, string> = { queued: 'Waiting', running: 'Working', done: 'Done', error: 'Failed', cancelled: 'Cancelled', accepted: 'Accepted', refused: 'Refused', needs_review: 'Needs a person', measuring: 'Measuring' };
const STATUS_TONE: Record<string, string> = { running: 'border-emerald-500/50 text-emerald-700 dark:text-emerald-300', accepted: 'border-emerald-500/50 text-emerald-700 dark:text-emerald-300', done: 'border-emerald-500/50 text-emerald-700 dark:text-emerald-300', error: 'border-destructive/50 text-destructive', refused: 'border-destructive/50 text-destructive', needs_review: 'border-amber-500/50 text-amber-700 dark:text-amber-300' };
export function StatusBadge({ status }: { status: string }) {
  return <Badge variant='outline' className={cn('shrink-0 font-normal', STATUS_TONE[status])}>{STATUS_WORDS[status] ?? status}</Badge>;
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return <section className='flex flex-col gap-2'><h3 className='text-muted-foreground text-xs font-medium'>{title}</h3>{children}</section>;
}

/** A machine's states and transitions, laid out by distance from an entry state; the live state is lit. */
export function StepGraph({ graph }: { graph: Graph }) {
  const entries = new Set(graph.states.map((s) => s.id).filter((id) => !graph.transitions.some((t) => t.to === id && t.from !== id)));
  const depth = new Map<string, number>([...entries].map((id) => [id, 0]));
  if (!depth.size && graph.states[0]) depth.set(graph.states[0].id, 0);
  for (let i = 0; i < graph.states.length; i++) for (const t of graph.transitions) { const d = depth.get(t.from); if (d !== undefined && !depth.has(t.to)) depth.set(t.to, d + 1); }
  const columns: string[][] = [];
  for (const s of graph.states) (columns[depth.get(s.id) ?? 0] ??= []).push(s.id);
  const W = 124, H = 40, GX = 36, GY = 14;
  const at = new Map<string, { x: number; y: number }>();
  columns.forEach((c, x) => c.forEach((id, y) => at.set(id, { x: x * (W + GX), y: y * (H + GY) })));
  const width = columns.length * (W + GX) - GX, height = Math.max(...columns.map((c) => c.length)) * (H + GY) - GY;
  return (
    <div className='overflow-x-auto' data-step-graph=''>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role='img' aria-label='The steps of this program' className='text-muted-foreground'>
        {graph.transitions.map((t, i) => {
          const a = at.get(t.from), b = at.get(t.to);
          if (!a || !b) return null;
          const back = b.x <= a.x;
          const d = back ? `M ${a.x + W / 2} ${a.y} C ${a.x + W / 2} ${a.y - 20}, ${b.x + W / 2} ${b.y - 20}, ${b.x + W / 2} ${b.y}` : `M ${a.x + W} ${a.y + H / 2} L ${b.x} ${b.y + H / 2}`;
          return <path key={i} d={d} fill='none' stroke='currentColor' strokeOpacity={0.5} strokeDasharray={back ? '4 3' : undefined}><title>{t.label ?? 'Always'}</title></path>;
        })}
        {graph.states.map((s) => {
          const p = at.get(s.id)!;
          return (
            <g key={s.id} data-graph-state={s.id} data-running={s.running ? 'true' : undefined}>
              <rect x={p.x + 0.5} y={p.y + 0.5} width={W - 1} height={H - 1} rx={6} fill='var(--background)' stroke={s.running ? '#10b981' : s.settled ? 'currentColor' : 'currentColor'} strokeOpacity={s.running ? 1 : s.settled ? 0.9 : 0.35} strokeWidth={s.running ? 2 : 1} />
              <text x={p.x + W / 2} y={p.y + (s.entries > 1 ? 17 : 24)} textAnchor='middle' fill='var(--foreground)' fontSize={12}>{s.id.length > 16 ? `${s.id.slice(0, 15)}…` : s.id}</text>
              {s.entries > 1 && <text x={p.x + W / 2} y={p.y + 31} textAnchor='middle' fill='currentColor' fontSize={10}>{s.entries} times</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** The versions of one target, newest first, on a line: which is current, what each gained, what was rolled back. */
export function VersionTimeline({ versions }: { versions: Version[] }) {
  if (!versions.length) return <p className='text-muted-foreground text-xs'>No version has been promoted yet.</p>;
  return (
    <ol className='flex flex-col' data-version-timeline=''>
      {[...versions].sort((a, b) => b.version - a.version).map((v) => (
        <li key={v.id} className='relative flex gap-3 pb-3 last:pb-0'>
          <span className='flex w-3 shrink-0 flex-col items-center' aria-hidden>
            <span className={cn('mt-1 size-2.5 rounded-full', v.status === 'champion' ? 'bg-emerald-500' : v.status === 'rolled_back' ? 'bg-destructive' : 'bg-muted-foreground/50')} />
            <span className='bg-border mt-1 w-px flex-1' />
          </span>
          <span className='flex min-w-0 flex-1 flex-col gap-0.5 text-sm'>
            <span className='flex items-center gap-2'><span className='font-medium'>Version {v.version}</span>
              {v.status === 'champion' && <Badge variant='outline' className='font-normal'>Current</Badge>}
              {v.status === 'rolled_back' && <Badge variant='outline' className='border-destructive/50 text-destructive font-normal'>Rolled back</Badge>}</span>
            <span className='text-muted-foreground text-xs'>{pct(v.lift)} better · <When d={v.at} />{v.workspace ? ` · ${v.workspace}` : ''}</span>
            {v.applied_ref && <span className='text-muted-foreground text-xs'>Applied: {v.applied_ref}</span>}
            {v.rollback_reason && <span className='text-muted-foreground text-xs'>Why: {v.rollback_reason}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A target's climb: the space, the history under it, the versions it made. */
export function Climb({ target, onAsk, height = 260 }: { target: ClimbTarget; onAsk?: (text: string) => void; height?: number }) {
  return (
    <div className='flex flex-col gap-2' data-climb={target.id}>
      {target.axes.length > 0 && <HillClimbing3D axes={target.axes} points={target.points} height={height}
        onAsk={onAsk ? (p: { label: string }[]) => onAsk(`About ${target.id}: ${p.map((x) => x.label).join('; ')}. `) : undefined} />}
      {target.points.length > 0 && <ul className='flex flex-col gap-1 text-xs'>
        {[...target.points].reverse().slice(0, 8).map((p) => (
          <li key={p.id} className='flex items-center gap-2'><span className='size-2 shrink-0 rounded-full' style={{ background: p.color }} aria-hidden /><span className='min-w-0 flex-1 truncate' title={p.label}>{p.label}</span><span className='text-muted-foreground shrink-0 tabular-nums'>{pct(p.lift)}</span></li>
        ))}
      </ul>}
      <VersionTimeline versions={target.versions} />
    </div>
  );
}

function Tree({ nodes, onOpen }: { nodes: RunNode[]; onOpen?: (n: RunNode) => void }) {
  const roots = nodes.filter((n) => !n.step_of && !nodes.some((m) => m.session_id === n.parent_id));
  const childrenOf = (n: RunNode) => nodes.filter((m) => m.step_of === n.handle || (!m.step_of && n.session_id !== null && m.parent_id === n.session_id));
  const row = (n: RunNode, depth: number): ReactNode => {
    const inner = <><span className={cn('size-2 shrink-0 rounded-full', n.status === 'running' ? 'motion-safe:animate-pulse bg-emerald-500' : n.status === 'error' ? 'bg-destructive' : n.status === 'queued' ? 'bg-amber-500' : 'bg-muted-foreground/40')} aria-hidden />
      <AgentName name={n.name} purpose={n.purpose} muted={false} className='flex-1 text-sm' />
      {n.ref && <span className='text-muted-foreground shrink-0 font-mono text-xs'>{n.ref}</span>}
      <span className='text-muted-foreground shrink-0 text-xs tabular-nums'>{usd(n.spent_usd)}</span></>;
    return (
      <li key={n.handle} className='flex flex-col gap-1'>
        {n.session_id && onOpen
          ? <button type='button' data-outline='group' className='hover:bg-muted/50 flex items-center gap-2 rounded-md border px-2 py-1.5 text-left' style={{ marginLeft: depth * 14 }} onClick={() => onOpen(n)}>{inner}</button>
          : <div className='flex items-center gap-2 rounded-md border px-2 py-1.5' style={{ marginLeft: depth * 14 }}>{inner}</div>}
        {n.waiting && !n.settled && <span className='text-muted-foreground text-xs' style={{ marginLeft: depth * 14 + 18 }}>{n.waiting}</span>}
        {n.error && n.status !== 'cancelled' && <span className='text-destructive text-xs' style={{ marginLeft: depth * 14 + 18 }}>{n.error}</span>}
        {n.graph && <div style={{ marginLeft: depth * 14 }}><StepGraph graph={n.graph} /></div>}
        <ul className='flex flex-col gap-1'>{childrenOf(n).map((c) => row(c, depth + 1))}</ul>
      </li>
    );
  };
  return <ul className='flex flex-col gap-1' data-run-tree=''>{roots.map((n) => row(n, 0))}</ul>;
}

/** A run's own view, kept current while it works. */
export function RunView({ id, call, onAsk, onOpenChild }: { id: string; call: DockCall; onAsk?: (text: string) => void; onOpenChild?: (sessionId: string, name: string) => void }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    const load = () => call<{ run: RunDetail }>('GET', `/${id}/run`).then((r) => { if (on) { setRun(r.run); setError(null); } }, (e: Error) => { if (on) setError(e.message); });
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => { on = false; clearInterval(t); };
  }, [call, id]);
  if (error && !run) return <p className='text-destructive text-sm'>{error}</p>;
  if (!run) return <div className='bg-muted/40 h-24 animate-pulse rounded-lg' />;
  const lifts = run.decisions.filter((d) => d.outcome === 'accepted' && typeof d.lift === 'number').map((d) => d.lift as number);
  const spent = run.root.spent_usd + run.root.children_spent_usd;
  return (
    <div className='flex flex-col gap-5' data-run-view={run.root.id}>
      {run.root.agent && <span className='text-muted-foreground flex items-center gap-1.5 text-xs'>Runs as <AgentName name={run.root.agent.name} purpose={run.root.agent.purpose} muted={false} /></span>}
      <dl className='grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4'>
        {[['Spent', `${usd(spent)} of ${usd(run.root.budget_usd)}`], ['Set aside for children', usd(run.root.carved_usd)], ['Children', String(run.children.filter((c) => c.kind !== 'machine').length)], ['Best improvement', lifts.length ? pct(Math.max(...lifts)) : 'None yet']].map(([k, v]) => (
          <div key={k} className='flex min-w-0 flex-col gap-0.5'><dt className='text-muted-foreground text-xs'>{k}</dt><dd className='text-sm font-medium tabular-nums'>{v}</dd></div>
        ))}
      </dl>
      <Block title='Children'>{run.children.length ? <Tree nodes={run.children} onOpen={onOpenChild ? (n) => onOpenChild(n.session_id!, n.name) : undefined} /> : <p className='text-muted-foreground text-xs'>It has started none yet.</p>}</Block>
      {run.decisions.length > 0 && <Block title='What was decided'>
        <ul className='flex flex-col gap-2'>{run.decisions.map((d) => (
          <li key={d.id} className='flex flex-col gap-1 rounded-md border px-3 py-2' data-run-decision=''>
            <span className='flex items-center gap-2 text-sm'><span className='min-w-0 flex-1 truncate font-medium' title={d.hypothesis || d.target}>{d.hypothesis || d.target}</span><StatusBadge status={d.outcome ?? 'measuring'} /></span>
            <span className='text-muted-foreground text-xs'>{d.target} · {d.reasons[0] ?? ''}</span>
          </li>
        ))}</ul>
      </Block>}
      {run.targets.map((t) => <Block key={`${t.kind}:${t.id}`} title={`How ${t.id} climbed`}><Climb target={t} onAsk={onAsk} /></Block>)}
    </div>
  );
}
