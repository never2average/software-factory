'use client';
// A tab a pack declares (mold_v0-058), at /app/packs/<pack>/<tab>: the shell draws it from pack.json alone.
//   overview   the tab's charts (mold_v0-063; ./charts.tsx), below the shell's sections it includes, in its order
//              (mold_v0-134, a home page): the Setup page's checklist (folded to a line once done), the notices
//   area       a record area's records: a table, a board (a column per state), a timeline (by a date), each row opening
//              the record's page when the tab has the detail view; the tab's charts above. A merged tab (mold_v0-135:
//              pack.json `areas`) draws several areas as one list, rows merged by key on the server (./merged.ts)
//   runs       the workspace's runs; reports: finished runs and their results
// An area tab offers Export CSV (mold_v0-108; ./export.tsx): every row it reads, as the generated export_<area> tool writes it.
// Records come from /api/records (src/record-routes.ts), runs from /api/runs (src/view-routes.ts): read only, for this
// workspace, as the person's role may read them. The sidebar shows a tab only to the roles that may read what it shows;
// the server refuses the rest whatever the page asks.
import Link from 'next/link';
import { useMemo, useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { PackChartSpec, PackTabSpec, RecordAreaSpec } from '@/config/pack-nav.generated';
import { useAccountRole } from '@/features/portal/role';
import { SetupChecklist } from '@/features/portal/setup';
import { DueSoonSection } from '@/features/schedules/notices-page';
import { ErrorState, LoadingCards, useOrgLoad } from '@/features/portal/shared';
import { BoardColumns, RecordTable, TimelineList, type Page } from './board';
import { ChartCell, formatValue, type MetricResult } from './charts';
import { EmptyState, type EmptySpec } from './empty';
import { ExportCsvButton } from './export';
import { tabRecordsUrl, viewArea, withSource } from './merged';
import { tabCharts } from './registry';
import { fill } from '@/lib/vocabulary';
import { httpError } from '@/features/status/from-error';
import { StatusPage } from '@/features/status/status-page';


async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, body);
  return body;
}


/** The charts of a tab, from one request for all their metrics. */
function ChartGrid({ charts, whole = false }: { charts: PackChartSpec[]; whole?: boolean }) {
  const names = useMemo(() => [...new Set(charts.flatMap((c) => c.metrics))], [charts]);
  const url = `/api/metrics?names=${encodeURIComponent(names.join(','))}`;
  const { data, error } = useOrgLoad(async () => {
    const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as { metrics?: MetricResult[]; error?: string };
    if (!res.ok) throw httpError(res.status, body);
    return new Map((body.metrics ?? []).map((m) => [m.name, m]));
  }, [url]);
  if (!charts.length) return null;
  if (error) return <ErrorState error={error} />;
  const results = data ?? new Map<string, MetricResult>();
  // A tab that is only charts, every one hidden from this role (each metric refused, 403): the status page that says
  // so (mold_v0-131), never an empty page.
  const refused = (c: PackChartSpec) => c.metrics.some((n) => { const r = results.get(n); return !!r && 'error' in r && r.status === 403; });
  if (whole && data && charts.every(refused)) return <StatusPage kind='denied' area='app' />;
  return (
    <div className='grid border-t border-l lg:grid-cols-2'>
      {charts.map((c) => <ChartCell key={`${c.pack}/${c.name}`} chart={c} results={results} />)}
    </div>
  );
}

/** An overview tab: the shell's sections it includes (mold_v0-134), then its charts. */
function OverviewTab({ tab }: { tab: PackTabSpec }) {
  const charts = tabCharts(tab);
  // Charts alone: every one refused is the denied status page (mold_v0-131), never an empty grid.
  if (!tab.include?.length) return <ChartGrid charts={charts} whole />;
  return (
    <div className='flex flex-col gap-8'>
      {tab.include.map((x) => (x === 'setup' ? <SetupChecklist key={x} /> : <DueSoonSection key={x} />))}
      {charts.length > 0 && <ChartGrid charts={charts} />}
    </div>
  );
}

// ---------- the area views ----------

/** What an area view reads: the area as the tab shows it, where its rows come from, and how they are completed. */
type Source = { area: RecordAreaSpec; url: string; rows: (p: Page) => Page };

function TableView({ src: { area, url: base, rows }, detail, empty }: { src: Source; detail: boolean; empty?: EmptySpec }) {
  const [after, setAfter] = useState<string[]>([]);
  const cursor = after.at(-1) ?? '';
  const url = `${base}?limit=50${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
  const { data: raw, error } = useOrgLoad(() => getJson<Page>(url), [url]);
  const data = raw && rows(raw);
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingCards count={1} />;
  // (A merged tab's page may hold no row and still have more: then its Next button shows.)
  if (!data.records.length && !after.length && !data.next) return <EmptyState empty={empty} id={`empty-${area.name}`} />;
  return (
    <div className='flex flex-col gap-4'>
      <RecordTable area={area} detail={detail} data={data} />
      <div className='flex gap-2'>
        {after.length > 0 && <Button variant='outline' size='sm' onClick={() => setAfter(after.slice(0, -1))}>Previous</Button>}
        {data.next && <Button variant='outline' size='sm' onClick={() => setAfter([...after, data.next!])}>Next</Button>}
      </div>
    </div>
  );
}

/** Up to 200 records of an area at once (a board or a timeline), and whether there are more. */
function useMany({ url: base, rows }: Source) {
  const url = `${base}?limit=200`;
  const loaded = useOrgLoad(() => getJson<Page>(url), [url]);
  return { ...loaded, data: loaded.data && rows(loaded.data) };
}

function BoardView({ src, by, detail, empty, merged }: { src: Source; by: string; detail: boolean; empty?: EmptySpec; merged: boolean }) {
  const { area } = src;
  const { data, error, reload } = useMany(src);
  const { role } = useAccountRole();
  const [moveError, setMoveError] = useState<string | null>(null);
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingCards count={1} />;
  if (!data.records.length) return <EmptyState empty={empty} id={`empty-${area.name}`} />;
  // Moves go through the generic data API (mold_v0-059: the record store's move, with its roles and transitions).
  // A merged tab's board only shows (its rows are several areas' records).
  const movable = !merged && area.scope === 'workspace' && area.lifecycle?.field === by;
  const onMove = async (key: string, to: string) => {
    setMoveError(null);
    const res = await fetch(`/api/data/${area.name}/${encodeURIComponent(key)}/move`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-Pack-Request': '1' }, body: JSON.stringify({ to })
    });
    if (!res.ok) setMoveError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The move failed (${res.status})`);
    await reload();
  };
  return (
    <div className='flex flex-col gap-2'>
      {moveError && <p role='alert' className='text-destructive text-sm'>{moveError}</p>}
      <BoardColumns area={area} by={by} detail={detail} data={data} role={role} onMove={movable ? (k, t) => void onMove(k, t) : undefined} />
    </div>
  );
}


function TimelineView({ src, by, badge, detail, empty }: { src: Source; by: string; badge: string | null; detail: boolean; empty?: EmptySpec }) {
  const { area } = src;
  const { data, error } = useMany(src);
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingCards count={1} />;
  if (!data.records.length) return <EmptyState empty={empty} id={`empty-${area.name}`} />;
  return <TimelineList area={area} by={by} badge={badge} detail={detail} data={data} />;
}

const VIEW_LABELS = { table: 'Table', board: 'Board', timeline: 'Timeline' } as const;

function AreaTab({ tab }: { tab: PackTabSpec }) {
  const area = useMemo(() => viewArea(tab), [tab]);
  const src = useMemo(() => area && { area, url: tabRecordsUrl(tab, area), rows: (p: Page) => withSource(tab, p) }, [tab, area]);
  const views = (tab.views ?? ['table', 'detail']).filter((v): v is 'table' | 'board' | 'timeline' => v !== 'detail');
  const detail = (tab.views ?? ['table', 'detail']).includes('detail');
  const [view, setView] = useState<'table' | 'board' | 'timeline'>(views[0] ?? 'table');
  if (!area || !src) return <p className='text-muted-foreground text-sm'>This area is not in this build.</p>;
  return (
    <div className='flex flex-col gap-6'>
      <ChartGrid charts={tabCharts(tab)} />
      <div className='flex min-w-0 flex-wrap items-center justify-between gap-3'>
      {views.length > 1 ? (
        <div role='tablist' aria-label='Views' className='bg-muted text-muted-foreground inline-flex w-fit items-center rounded-lg p-[3px]'
          onKeyDown={(e) => {
            // Arrow keys move between the views, as a tab list does.
            const i = views.indexOf(view), d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            const v = views[(i + d + views.length) % views.length]!;
            setView(v);
            (e.currentTarget.querySelector(`[data-view='${v}']`) as HTMLElement | null)?.focus();
          }}>
          {views.map((v) => (
            <button key={v} type='button' role='tab' data-view={v} id={`view-tab-${v}`} aria-controls='view-panel' tabIndex={view === v ? 0 : -1}
              aria-selected={view === v} onClick={() => setView(v)}
              className={`rounded-md px-3 py-1 text-sm ${view === v ? 'bg-background text-foreground shadow-sm' : ''}`}>{VIEW_LABELS[v]}</button>
          ))}
        </div>
      ) : <span />}
        <ExportCsvButton url={src.url} area={area} rows={src.rows} name={`${tab.pack}-${tab.id}`} areas={tab.areas ? tab.areas.map((a) => a.area) : [area.name]} />
      </div>
      <div role={views.length > 1 ? 'tabpanel' : undefined} id='view-panel' aria-labelledby={views.length > 1 ? `view-tab-${view}` : undefined}>
      {view === 'board' && tab.board_by ? <BoardView src={src} by={tab.board_by} detail={detail} empty={tab.empty} merged={!!tab.areas} />
        : view === 'timeline' ? <TimelineView src={src} by={tab.timeline_by ?? 'updated'} badge={area.lifecycle?.field ?? (tab.areas ? tab.board_by ?? null : null)} detail={detail} empty={tab.empty} />
        : views.length ? <TableView src={src} detail={detail} empty={tab.empty} /> : null}
      </div>
    </div>
  );
}

// ---------- runs and reports ----------

type Run = { id: string; kind: string; status: string; cost_usd: number; created_at: string; started_at: string | null; ended_at: string | null; error: string | null; results: Record<string, number> };
type RunResult = { check: { area: string; key: string }; asset: { area: string; key: string } | null; source: { area: string; key: string } | null; status: string; evidence_ref: string | null };
const when = (d: string | null) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const RESULT_ORDER = ['fail', 'error', 'pass', 'not_applicable', 'unknown'];
const RESULT_LABELS: Record<string, string> = { pass: 'Pass', fail: 'Fail', error: 'Error', not_applicable: 'Not applicable', unknown: 'Unknown' };
const counts = (r: Record<string, number>) => RESULT_ORDER.filter((s) => r[s]).map((s) => `${r[s]} ${RESULT_LABELS[s]!.toLowerCase()}`).join(', ') || '—';

function RunResults({ id }: { id: string }) {
  const { data, error } = useOrgLoad(() => getJson<{ results: RunResult[] }>(`/api/runs/${encodeURIComponent(id)}`), [id]);
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingCards count={1} />;
  if (!data.results.length) return <p className='text-muted-foreground text-sm'>This run recorded no results.</p>;
  const ref = (x: { area: string; key: string } | null) => (x ? <Link className='underline-offset-4 hover:underline' href={`/app/records/${x.area}/${encodeURIComponent(x.key)}`}>{x.key}</Link> : '—');
  return (
    <Table label={fill('Results of the {run}')}>
      <TableHeader><TableRow><TableHead>Check</TableHead><TableHead>Asset</TableHead><TableHead>Result</TableHead><TableHead>Evidence</TableHead></TableRow></TableHeader>
      <TableBody>
        {data.results.map((r, i) => (
          <TableRow key={i}>
            <TableCell>{ref(r.check)}</TableCell><TableCell>{ref(r.asset)}</TableCell>
            <TableCell><Badge variant={r.status === 'fail' || r.status === 'error' ? 'destructive' : 'secondary'}>{RESULT_LABELS[r.status] ?? r.status}</Badge></TableCell>
            <TableCell className='font-mono text-xs break-all'>{r.evidence_ref ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RunsTab({ reports, label, empty }: { reports: boolean; label: string; empty?: EmptySpec }) {
  const { data, error } = useOrgLoad(() => getJson<{ runs: Run[] }>('/api/runs?limit=100'), []);
  const [open, setOpen] = useState<string | null>(null);
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingCards count={1} />;
  const runs = reports ? data.runs.filter((r) => r.status === 'succeeded' || r.status === 'failed') : data.runs;
  if (!runs.length) return <EmptyState empty={empty} id={reports ? 'empty-reports' : 'empty-runs'} />;
  return (
    <div className='flex flex-col gap-4'>
      <Table label={label}>
        <TableHeader>
          <TableRow>
            <TableHead>Kind</TableHead><TableHead>Status</TableHead><TableHead>{reports ? 'Finished' : 'Started'}</TableHead>
            <TableHead>Results</TableHead><TableHead className='text-right'>Cost</TableHead>{reports && <TableHead />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((r) => (
            <TableRow key={r.id}>
              <TableCell className='font-medium'>{r.kind}</TableCell>
              <TableCell><Badge variant={r.status === 'failed' ? 'destructive' : 'secondary'}>{r.status}</Badge></TableCell>
              <TableCell>{when(reports ? r.ended_at : r.started_at ?? r.created_at)}</TableCell>
              <TableCell>{counts(r.results)}</TableCell>
              <TableCell className='text-right tabular-nums'>{formatValue(r.cost_usd, 'usd')}</TableCell>
              {reports && (
                <TableCell className='text-right'>
                  <Button variant='ghost' size='sm' aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide' : 'Results'}</Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {reports && open && <section aria-label='Results of the run'><RunResults id={open} /></section>}
    </div>
  );
}

export function TabPage({ tab }: { tab: PackTabSpec }) {
  const { role, loaded, error } = useAccountRole();
  // Nothing is asked of the server until the role is known (the server refuses what the role may not read anyway).
  const allowed = role === null || tab.roles.includes(role);
  return (
    <PageContainer pageTitle={tab.label} pageDescription={tab.description ?? undefined}>
      {/* /me refused (no account, suspended, signed out) or a role the tab is not for: the status page (mold_v0-131). */}
      {error && !loaded ? <ErrorState error={error} /> : !loaded ? <LoadingCards count={1} /> : !allowed ? <StatusPage kind='denied' area='app' />
        : tab.kind === 'overview' ? <OverviewTab tab={tab} />
        : tab.kind === 'area' ? <AreaTab tab={tab} />
        : tab.kind === 'runs' || tab.kind === 'reports' ? <RunsTab reports={tab.kind === 'reports'} label={tab.label} empty={tab.empty} />
        : null}
    </PageContainer>
  );
}
