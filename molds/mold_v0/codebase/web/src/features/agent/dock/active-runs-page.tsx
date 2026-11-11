'use client';
// Active runs (mold_v0-292, flag nested_runs; src/agent-dock.ts): every root session with a child still at work, as the standard
// list; a row opens its run in the panel beside it, and Expand or its own page shows the same view in full.
import { useCallback, useEffect, useMemo, useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { setBreadcrumbLeaf } from '@/lib/breadcrumb-leaf';
import { ErrorState, When } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { RunView, usd, type DockCall } from './run-view';
import { AgentName } from '../agent-name';
import type { AgentLabel } from '@/lib/agent-purpose';

interface ActiveRun { id: string; ref: string | null; title: string; state: string; started_by: string | null; children: number; open: number; waiting: number; attention: boolean; programs: string[]; agent?: AgentLabel; agents?: AgentLabel[]; budget_usd: number; spent_usd: number; children_spent_usd: number; carved_usd: number; last_activity_at: string }

export const agentCall: DockCall = async <T,>(method: string, path = '', body?: unknown): Promise<T> => {
  const res = await fetch(`/api/agent${path}`, { method, credentials: 'same-origin', headers: { accept: 'application/json', ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-pack-request': '1' } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, json);
  return json;
};

export function ActiveRunsPage() {
  const [runs, setRuns] = useState<ActiveRun[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => agentCall<{ runs: ActiveRun[] }>('GET', '/runs').then((r) => { setRuns(r.runs); setError(null); }, (e: Error) => setError(e)), []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 5000); return () => clearInterval(t); }, [load]);
  const cols = useMemo<RecordCol<ActiveRun>[]>(() => [
    { key: 'ref', label: 'Number', type: 'text', keep: true, value: (r) => r.ref ?? '', render: (r) => <span className='font-mono text-xs whitespace-nowrap'>{r.ref}</span> },
    { key: 'title', label: 'Run', title: true, keep: true, type: 'text', className: 'min-w-56', value: (r) => r.title, render: (r) => <span className='leading-snug font-medium'>{r.title}</span> },
    // mold_v0-295: who runs it and the agents at work under it, each by name with its purpose's icon.
    { key: 'agent', label: 'Agent', type: 'text', value: (r) => r.agent?.name ?? '', render: (r) => (r.agent ? <AgentName name={r.agent.name} purpose={r.agent.purpose} muted={false} className='text-sm' /> : null) },
    { key: 'programs', label: 'Programs', type: 'text', value: (r) => r.programs.join(', '), render: (r) => (
      <span className='flex max-w-[320px] flex-wrap items-center gap-x-3 gap-y-1' title={r.programs.join(', ')}>
        {(r.agents ?? r.programs.map((name) => ({ name, purpose: 'general' as const }))).map((a) => <AgentName key={a.name} name={a.name} purpose={a.purpose} muted={false} className='text-sm' />)}
      </span>
    ) },
    { key: 'open', label: 'Working', type: 'number', value: (r) => r.open, render: (r) => <span className='tabular-nums'>{r.open} of {r.children}</span> },
    { key: 'spent', label: 'Spent', type: 'number', value: (r) => r.spent_usd + r.children_spent_usd, render: (r) => <span className='tabular-nums'>{usd(r.spent_usd + r.children_spent_usd)} <span className='text-muted-foreground'>of {usd(r.budget_usd)}</span></span> },
    { key: 'activity', label: 'Last activity', type: 'date', keep: true, value: (r) => r.last_activity_at, render: (r) => <When d={r.last_activity_at} /> },
  ], []);
  if (error) return <PageContainer><ErrorState error={error} /></PageContainer>;
  const rows = runs ?? [];
  const sum = (f: (r: ActiveRun) => number) => rows.reduce((t, r) => t + f(r), 0);
  return (
    <PageContainer>
      <RecordView<ActiveRun> id='active-runs' compact noun={rows.length === 1 ? 'run' : 'runs'} loading={!runs} rows={rows} rowKey={(r) => r.id} cols={cols} openKey={open} onOpenChange={setOpen}
        detailTitle={(r) => r.title} detail={(r) => <RunView key={r.id} id={r.id} call={agentCall} />} pageHref={(r) => `/app/agent/runs/${encodeURIComponent(r.id)}`}
        defaultSort={[{ key: 'activity', dir: 'desc' }]}
        summary={<StatStrip quad items={[
          { label: 'Active runs', value: rows.length, said: `${rows.length} active runs` },
          { label: 'Children working', value: sum((r) => r.open - r.waiting), said: 'children working now' },
          { label: 'Waiting for a place', value: sum((r) => r.waiting), said: 'children waiting for a place' },
          { label: 'Spent', value: usd(sum((r) => r.spent_usd + r.children_spent_usd)), said: 'spent by these runs' },
        ]} />}
        searchText={(r) => `${r.ref ?? ''} ${r.title} ${r.agent?.name ?? ''} ${r.programs.join(' ')} ${r.started_by ?? ''}`} searchPlaceholder='Search runs'
        empty={<p className='text-muted-foreground text-sm'>Nothing is running now. A session that starts child runs shows here while they work.</p>} />
    </PageContainer>
  );
}

/** A run's own page: its ref in the breadcrumb, the same view at full width. */
export function ActiveRunPage({ id }: { id: string }) {
  const [ref, setRef] = useState<string | null>(null);
  useEffect(() => { void agentCall<{ session: { ref: string } }>('GET', `/${encodeURIComponent(id)}`).then((r) => setRef(r.session.ref), () => {}); }, [id]);
  useEffect(() => { setBreadcrumbLeaf(ref); return () => setBreadcrumbLeaf(null); }, [ref]);
  return <PageContainer><div className='mx-auto w-full max-w-4xl'><RunView id={id} call={agentCall} onOpenChild={(sid) => { window.location.href = `/app/agent?session=${encodeURIComponent(sid)}`; }} /></div></PageContainer>;
}
