'use client';
// Active runs (mold_v0-292, flag nested_runs; src/agent-dock.ts): every root session with a child still at work, as the standard
// list; a row opens its run in the panel beside it, and Expand or its own page shows the same view in full. mold_v0-334: each
// run's one status (web/src/lib/run-status.ts, saying whose decision it waits for), the outcome of what it made, its
// attention mark, and a Finished view (the last 30 days), so a failed or refused run does not vanish.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import PageContainer from '@/components/layout/page-container';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { setBreadcrumbLeaf } from '@/lib/breadcrumb-leaf';
import { ErrorState, When } from '@/features/portal/shared';
import { EmptyState } from '@/features/tabs/empty';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { httpError } from '@/features/status/from-error';
import { RunView, usd, type DockCall } from './run-view';
import { AgentName } from '../agent-name';
import type { AgentLabel } from '@/lib/agent-purpose';
import { OUTCOME_WORDS, RUN_OUTCOME_BADGES, RUN_STATUSES, RUN_STATUS_WORDS, type RunNeeds, type RunOutcomeBadge, type RunStatus } from '@/lib/run-status';
import { AttentionMark, OutcomeBadge, RunStatusBadge } from '../run-badges';

interface ActiveRun { id: string; ref: string | null; title: string; state: string; started_by: string | null; children: number; open: number; waiting: number; attention: boolean; programs: string[]; agent?: AgentLabel; agents?: AgentLabel[]; budget_usd: number; spent_usd: number; children_spent_usd: number; carved_usd: number; last_activity_at: string;
  status: RunStatus; needs: RunNeeds | null; why: string | null; outcome: RunOutcomeBadge | null; finished: boolean; settled_at: string | null }
const VIEWS = ['active', 'finished'] as const;
type View = (typeof VIEWS)[number];
/** mold_v0-338: one or many, for the cards' spoken words ("1 active run"). */
const runsWords = (n: number) => `${n} ${n === 1 ? 'run' : 'runs'}`;

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
  // mold_v0-298: a refresh that fails keeps the rows already shown (a small note says so); only a first load that fails is
  // the page's error. It reads again every 10 s while the tab is shown, and at once when the tab comes back.
  const [stale, setStale] = useState(false);
  // mold_v0-338: the view is kept in the address (?view=finished), as every in-page tab is: a link to Finished opens it, a
  // reload stays on it.
  const [viewQ, setViewQ] = useQueryState('view', parseAsStringLiteral(VIEWS).withDefault('active'));
  const view: View = viewQ;
  const load = useCallback(() => agentCall<{ runs: ActiveRun[] }>('GET', view === 'finished' ? '/runs?view=finished' : '/runs').then((r) => { setRuns(r.runs); setError(null); setStale(false); }, (e: Error) => { setError(e); setStale(true); }), [view]);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 10000);
    const back = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', back);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', back); };
  }, [load]);
  const cols = useMemo<RecordCol<ActiveRun>[]>(() => [
    // mold_v0-298: on a phone the run, its agents at work and its last activity (max-sm:hidden on the rest).
    // mold_v0-338: the short number is the title's muted prefix (still searched), no column of its own.
    { key: 'title', label: 'Run', title: true, type: 'text', className: 'min-w-40 sm:min-w-56', value: (r) => r.title, render: (r) => <span className='flex flex-col gap-0.5'><span className='leading-snug'>{r.ref && <><span className='text-muted-foreground font-mono text-xs whitespace-nowrap'>{r.ref}</span><span className='text-muted-foreground' aria-hidden> · </span></>}<span className='font-medium'>{r.title}</span></span><AttentionMark on={r.attention} /></span> },
    // mold_v0-338: why it failed, said once (the line under the badge; the badge keeps it only when there is no line).
    { key: 'status', label: 'Status', type: 'select', options: RUN_STATUSES.map((value) => ({ value, label: RUN_STATUS_WORDS[value] })), value: (r) => r.status,
      render: (r) => { const line = r.status === 'failed' && !!r.why; return <span className='flex flex-col items-start gap-1'><RunStatusBadge status={r.status} needs={r.needs} why={line ? null : r.why} pulse />{line && <span className='text-muted-foreground line-clamp-2 text-xs'>{r.why}</span>}</span>; } },
    { key: 'outcome', label: 'Outcome', type: 'select', className: 'max-sm:hidden', options: RUN_OUTCOME_BADGES.map((value) => ({ value, label: OUTCOME_WORDS[value] })), value: (r) => r.outcome ?? '', render: (r) => (r.outcome ? <OutcomeBadge outcome={r.outcome} /> : null) },
    // mold_v0-295: who runs it and the agents at work under it, each by name with its purpose's icon.
    { key: 'agent', label: 'Started by agent', type: 'text', className: 'max-sm:hidden', value: (r) => r.agent?.name ?? '', render: (r) => (r.agent ? <AgentName name={r.agent.name} purpose={r.agent.purpose} muted={false} className='text-sm' /> : null) },
    // mold_v0-298: the agents at work under it, by name (the server's `programs` are those agents' names).
    { key: 'programs', label: 'Agents', type: 'text', className: 'max-sm:hidden', value: (r) => r.programs.join(', '), render: (r) => (
      <span className='flex max-w-[320px] flex-wrap items-center gap-x-3 gap-y-1' title={r.programs.join(', ')}>
        {(r.agents ?? r.programs.map((name) => ({ name, purpose: 'general' as const }))).map((a) => <AgentName key={a.name} name={a.name} purpose={a.purpose} muted={false} className='text-sm' />)}
      </span>
    ) },
    // mold_v0-298: agents at work count as the tile does (open less those still waiting to start). mold_v0-338: nobody is at
    // work on a finished run: there, when it finished.
    view === 'finished'
      ? { key: 'settled', label: 'Finished', type: 'date', value: (r) => r.settled_at ?? r.last_activity_at, render: (r) => <When d={r.settled_at ?? r.last_activity_at} /> }
      : { key: 'open', label: 'At work', type: 'number', value: (r) => r.open - r.waiting, render: (r) => <span className='tabular-nums whitespace-nowrap'>{r.open - r.waiting} of {r.children}</span> },
    { key: 'spent', label: 'Spent', type: 'number', className: 'max-sm:hidden', value: (r) => r.spent_usd + r.children_spent_usd, render: (r) => <span className='tabular-nums whitespace-nowrap'>{usd(r.spent_usd + r.children_spent_usd)} <span className='text-muted-foreground'>of {usd(r.budget_usd)}</span></span> },
    ...(view === 'finished' ? [] : [{ key: 'activity', label: 'Last activity', type: 'date' as const, value: (r: ActiveRun) => r.last_activity_at, render: (r: ActiveRun) => <span className='whitespace-nowrap'><When d={r.last_activity_at} /></span> }]),
  ], [view]);
  if (error && !runs) return <PageContainer><ErrorState error={error} /></PageContainer>;
  const rows = runs ?? [];
  const sum = (f: (r: ActiveRun) => number) => rows.reduce((t, r) => t + f(r), 0);
  const count = (f: (r: ActiveRun) => boolean) => rows.filter(f).length;
  const attention = count((r) => r.attention || r.status === 'needs_you');
  // mold_v0-338: the line tab strip every other in-page tab uses.
  const switcher = (
    <Tabs value={view} onValueChange={(v) => { if (v === view) return; void setViewQ(v === 'finished' ? 'finished' : null); setRuns(null); setOpen(null); }} className='mb-3 w-full' data-runs-view={view}>
      <TabsList variant='line' aria-label='Which runs' className='flex-nowrap justify-start gap-x-6 p-0 group-data-horizontal/tabs:h-auto'>
        {VIEWS.map((v) => <TabsTrigger key={v} value={v} className='h-9 flex-none px-0' data-runs-view-tab={v}>{v === 'active' ? 'Active' : 'Finished'}</TabsTrigger>)}
      </TabsList>
    </Tabs>
  );
  return (
    <PageContainer>
      {stale && (
        <p role='status' className='text-muted-foreground mb-2 flex items-center gap-2 text-xs' data-runs-stale=''>
          Could not refresh just now; showing what was last read.
          <Button type='button' variant='outline' size='sm' className='h-6 px-2 text-xs' onClick={() => void load()}>Try again</Button>
        </p>
      )}
      {switcher}
      <RecordView<ActiveRun> id={view === 'finished' ? 'finished-runs' : 'active-runs'} compact noun={rows.length === 1 ? 'run' : 'runs'} loading={!runs} rows={rows} rowKey={(r) => r.id} cols={cols} openKey={open} onOpenChange={setOpen}
        detailTitle={(r) => r.title} detail={(r) => <RunView key={r.id} id={r.id} call={agentCall} />} pageHref={(r) => `/app/agent/runs/${encodeURIComponent(r.id)}`}
        defaultSort={[{ key: view === 'finished' ? 'settled' : 'activity', dir: 'desc' }]}
        summary={view === 'active' ? <StatStrip quad items={[
          { label: 'Active runs', value: rows.length, said: `${rows.length} active ${rows.length === 1 ? 'run' : 'runs'}` },
          { label: 'Agents at work', value: sum((r) => r.open - r.waiting), said: `${sum((r) => r.open - r.waiting)} ${sum((r) => r.open - r.waiting) === 1 ? 'agent' : 'agents'} at work now` },
          { label: 'Waiting to start', value: sum((r) => r.waiting), said: `${sum((r) => r.waiting)} ${sum((r) => r.waiting) === 1 ? 'agent' : 'agents'} waiting to start` },
          { label: 'Need attention', value: attention, said: `${runsWords(attention)} ${attention === 1 ? 'needs' : 'need'} someone to look at them` },
        ]} /> : <StatStrip quad items={[
          { label: 'Finished runs', value: rows.length, said: `${runsWords(rows.length)} finished in the last 30 days` },
          { label: 'Accepted or applied', value: count((r) => r.outcome === 'accepted' || r.outcome === 'applied'), said: `${runsWords(count((r) => r.outcome === 'accepted' || r.outcome === 'applied'))} whose result was accepted or applied` },
          { label: 'Failed or refused', value: count((r) => r.status === 'failed' || r.outcome === 'refused'), said: `${runsWords(count((r) => r.status === 'failed' || r.outcome === 'refused'))} that failed or whose result was refused` },
          { label: 'Waiting for staff', value: count((r) => r.outcome === 'waiting_for_staff'), said: `${runsWords(count((r) => r.outcome === 'waiting_for_staff'))} whose result waits for a staff review` },
        ]} />}
        searchText={(r) => `${r.ref ?? ''} ${r.title} ${r.agent?.name ?? ''} ${r.programs.join(' ')} ${r.started_by ?? ''}`} searchPlaceholder='Search runs'
        empty={view === 'active'
          ? <EmptyState id='active-runs-empty' empty={{ title: 'Nothing is running now', cta: { label: 'Open agent sessions', href: '/app/agent' },
            text: 'When a session hands parts of its task to other agents, it shows here while they work. Finished runs stay under Finished for 30 days.' }} />
          : <EmptyState id='finished-runs-empty' empty={{ title: 'No run finished in the last 30 days', cta: null,
            text: 'A run moves here once every agent under it has finished, with how it ended and what came of it.' }} />} />
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
