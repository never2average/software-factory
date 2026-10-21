'use client';
// A tab a pack declares (mold_v0-058), at /app/packs/<pack>/<tab>: the shell draws it from pack.json alone.
//   overview   the tab's charts (mold_v0-063; ./charts.tsx)
//   area       a record area's records: a table, a board (a column per state), a timeline (by a date), each row opening
//              the record's page when the tab has the detail view; the tab's charts above
//   runs       the workspace's runs; reports: finished runs and their results
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
import { ErrorState, LoadingCards, useOrgLoad } from '@/features/portal/shared';
import { findRecordArea } from '@/features/records/registry';
import { BoardColumns, fieldLabel, RecordLink, show, type Page, type RecordRow } from './board';
import { ChartCell, formatValue, type MetricResult } from './charts';
import { tabCharts } from './registry';


async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}


/** The charts of a tab, from one request for all their metrics. */
function ChartGrid({ charts }: { charts: PackChartSpec[] }) {
  const names = useMemo(() => [...new Set(charts.flatMap((c) => c.metrics))], [charts]);
  const url = `/api/metrics?names=${encodeURIComponent(names.join(','))}`;
  const { data, error } = useOrgLoad(async () => {
    const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as { metrics?: MetricResult[]; error?: string };
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return new Map((body.metrics ?? []).map((m) => [m.name, m]));
  }, [url]);
  if (!charts.length) return null;
  if (error) return <ErrorState error={error} />;
  const results = data ?? new Map<string, MetricResult>();
  return (
    <div className='grid border-t border-l lg:grid-cols-2'>
      {charts.map((c) => <ChartCell key={`${c.pack}/${c.name}`} chart={c} results={results} />)}
    </div>
  );
}

// ---------- the area views ----------

function TableView({ area, detail }: { area: RecordAreaSpec; detail: boolean }) {
  const [after, setAfter] = useState<string[]>([]);
  const cursor = after.at(-1) ?? '';
  const url = `/api/records/${area.name}?limit=50${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
  const { data, error } = useOrgLoad(() => getJson<Page>(url), [url]);
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingCards count={1} />;
  if (!data.records.length) return <p className='text-muted-foreground text-sm'>No records yet.</p>;
  return (
    <div className='flex flex-col gap-4'>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Record</TableHead>
            {area.list_columns.map((c) => <TableHead key={c}>{fieldLabel(area, c)}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.records.map((r) => (
            <TableRow key={r.key}>
              <TableCell><RecordLink area={area} r={r} detail={detail} /></TableCell>
              {area.list_columns.map((c) => <TableCell key={c}>{show(area, c, r.data[c])}</TableCell>)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className='flex gap-2'>
        {after.length > 0 && <Button variant='outline' size='sm' onClick={() => setAfter(after.slice(0, -1))}>Previous</Button>}
        {data.next && <Button variant='outline' size='sm' onClick={() => setAfter([...after, data.next!])}>Next</Button>}
      </div>
    </div>
  );
}

/** Up to 200 records of an area at once (a board or a timeline), and whether there are more. */
function useMany(area: RecordAreaSpec) {
  const url = `/api/records/${area.name}?limit=200`;
  return useOrgLoad(() => getJson<Page>(url), [url]);
}

function BoardView({ area, by, detail }: { area: RecordAreaSpec; by: string; detail: boolean }) {
  const { data, error } = useMany(area);
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingCards count={1} />;
  return <BoardColumns area={area} by={by} detail={detail} data={data} />;
}


function TimelineView({ area, by, detail }: { area: RecordAreaSpec; by: string; detail: boolean }) {
  const { data, error } = useMany(area);
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingCards count={1} />;
  const when = (r: RecordRow) => {
    const v = by === 'updated' ? r.updated_at : r.data[by];
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  };
  const dated = data.records.filter((r) => when(r)).sort((a, b) => when(b)!.localeCompare(when(a)!));
  const undated = data.records.filter((r) => !when(r));
  const months = [...new Set(dated.map((r) => when(r)!.slice(0, 7)))];
  const month = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const label = by === 'updated' ? 'Last changed' : fieldLabel(area, by);
  return (
    <div className='flex flex-col gap-6'>
      {data.next && <p className='text-muted-foreground text-xs'>The first 200 records; the table has them all.</p>}
      {!data.records.length && <p className='text-muted-foreground text-sm'>No records yet.</p>}
      {months.map((m) => (
        <section key={m} className='flex flex-col gap-2'>
          <h3 className='text-sm font-medium'>{month(m)}</h3>
          <ol className='border-l pl-4'>
            {dated.filter((r) => when(r)!.startsWith(m)).map((r) => (
              <li key={r.key} className='relative py-1.5 text-sm'>
                <span aria-hidden className='bg-foreground/40 absolute top-3 -left-[1.3rem] size-2 rounded-full' />
                <span className='text-muted-foreground mr-3 inline-block w-14 tabular-nums'><span className='sr-only'>{label}: </span>{day(when(r)!)}</span>
                <RecordLink area={area} r={r} detail={detail} />
                {area.lifecycle && r.data[area.lifecycle.field] !== undefined && (
                  <Badge variant='outline' className='ml-2'>{show(area, area.lifecycle.field, r.data[area.lifecycle.field])}</Badge>
                )}
              </li>
            ))}
          </ol>
        </section>
      ))}
      {undated.length > 0 && (
        <section className='flex flex-col gap-2'>
          <h3 className='text-sm font-medium'>No {label.toLowerCase()}</h3>
          <ul className='flex flex-col gap-1 text-sm'>{undated.map((r) => <li key={r.key}><RecordLink area={area} r={r} detail={detail} /></li>)}</ul>
        </section>
      )}
    </div>
  );
}

const VIEW_LABELS = { table: 'Table', board: 'Board', timeline: 'Timeline' } as const;

function AreaTab({ tab }: { tab: PackTabSpec }) {
  const area = findRecordArea('app', tab.area ?? '');
  const views = (tab.views ?? ['table', 'detail']).filter((v): v is 'table' | 'board' | 'timeline' => v !== 'detail');
  const detail = (tab.views ?? ['table', 'detail']).includes('detail');
  const [view, setView] = useState<'table' | 'board' | 'timeline'>(views[0] ?? 'table');
  if (!area) return <p className='text-muted-foreground text-sm'>This area is not in this build.</p>;
  return (
    <div className='flex flex-col gap-6'>
      <ChartGrid charts={tabCharts(tab)} />
      {views.length > 1 && (
        <div role='tablist' aria-label='Views' className='bg-muted text-muted-foreground inline-flex w-fit items-center rounded-lg p-[3px]'>
          {views.map((v) => (
            <button key={v} type='button' role='tab' aria-selected={view === v} onClick={() => setView(v)}
              className={`rounded-md px-3 py-1 text-sm ${view === v ? 'bg-background text-foreground shadow-sm' : ''}`}>{VIEW_LABELS[v]}</button>
          ))}
        </div>
      )}
      {view === 'board' && tab.board_by ? <BoardView area={area} by={tab.board_by} detail={detail} />
        : view === 'timeline' ? <TimelineView area={area} by={tab.timeline_by ?? 'updated'} detail={detail} />
        : views.length ? <TableView area={area} detail={detail} /> : null}
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
    <Table>
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

function RunsTab({ reports }: { reports: boolean }) {
  const { data, error } = useOrgLoad(() => getJson<{ runs: Run[] }>('/api/runs?limit=100'), []);
  const [open, setOpen] = useState<string | null>(null);
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingCards count={1} />;
  const runs = reports ? data.runs.filter((r) => r.status === 'succeeded' || r.status === 'failed') : data.runs;
  if (!runs.length) return <p className='text-muted-foreground text-sm'>{reports ? 'No finished runs yet.' : 'No runs yet.'}</p>;
  return (
    <div className='flex flex-col gap-4'>
      <Table>
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
  const { role, loaded } = useAccountRole();
  const allowed = !loaded || role === null || tab.roles.includes(role);
  return (
    <PageContainer pageTitle={tab.label} pageDescription={tab.description ?? undefined}>
      {!allowed ? <p className='text-muted-foreground text-sm'>Your role can't see this tab. Ask an account owner.</p>
        : tab.kind === 'overview' ? <ChartGrid charts={tabCharts(tab)} />
        : tab.kind === 'area' ? <AreaTab tab={tab} />
        : tab.kind === 'runs' || tab.kind === 'reports' ? <RunsTab reports={tab.kind === 'reports'} />
        : null}
    </PageContainer>
  );
}
