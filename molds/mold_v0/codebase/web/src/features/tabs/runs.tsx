'use client';
// A runs tab and a reports tab (mold_v0-058; ./tab-page.tsx) as the console's database table (mold_v0-176: RecordView,
// as on Accounts and the record areas): a row per run of the workspace (GET /api/runs, src/view-routes.ts: read only,
// this workspace's runs, as the person's role may read them), with its kind (the pack's label), status, target (the
// asset record it ran over, targets.asset), when it started, how long it took, its results and what it cost; search, a
// count, sorting, filters (status and kind by their options), a pager, Export CSV, a loading state and the tab's empty
// state. A row opens the run beside the list: its facts, its error and its results (GET /api/runs/:id), with a link to
// the record it ran over. A reports tab lists the finished runs only, newest result first.
import Link from 'next/link';
import { useMemo, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { recordAreas, type PackTabSpec } from '@/config/pack-nav.generated';
import { findRecordArea } from '@/features/records/registry';
import { ErrorState, LoadingCards, useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { fill } from '@/lib/vocabulary';
import { formatValue } from './charts';
import { EmptyState } from './empty';
import { ExportRowsButton } from './export';
import { duration, FINISHED, JOB_KINDS, lowerFirst, RESULT_LABELS, resultCounts, RUN_STATUSES, runKindLabel, runSeconds, runTarget, statusLabel, targetLabel, when, type Run } from './run-rows';

type Ref = { area: string; key: string };
type RunResult = { check: Ref; asset: Ref | null; source: Ref | null; status: string; evidence_ref: string | null };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, body);
  return body;
}

const dash = <span className='text-muted-foreground'>—</span>;
const statusBadge = (s: string) => (
  <Badge variant={s === 'failed' ? 'destructive' : s === 'succeeded' ? 'secondary' : 'outline'}>{statusLabel(s)}</Badge>
);

function columns(reports: boolean, runs: readonly Run[]): RecordCol<Run>[] {
  // The kinds' options: every kind of the build's packs, then any a listed run has that the build no longer declares.
  const kinds = [...JOB_KINDS.map((k) => ({ value: `${k.pack}/${k.name}`, label: k.label ?? k.name }))];
  for (const r of runs) if (!kinds.some((k) => k.value === `${r.pack}/${r.kind}`)) kinds.push({ value: `${r.pack}/${r.kind}`, label: r.kind });
  const target = targetLabel(runs);
  const anyTarget = runs.some((r) => runTarget(r)) || recordAreas.some((a) => a.role === 'asset' && a.scope === 'workspace');
  const cols: RecordCol<Run>[] = [
    {
      key: 'kind', label: 'Kind', title: true, keep: true, type: 'select', options: kinds, className: 'min-w-52',
      value: (r) => `${r.pack}/${r.kind}`,
      render: (r) => <span className='leading-snug font-medium'>{runKindLabel(r.pack, r.kind)}</span>
    },
    { key: 'status', label: 'Status', type: 'select', options: RUN_STATUSES, keep: true, value: (r) => r.status, render: (r) => statusBadge(r.status) },
    ...(anyTarget ? [{
      key: 'target', label: target, type: 'select', value: (r) => runTarget(r)?.key ?? null,
      render: (r) => { const t = runTarget(r); return t ? <span className='font-mono text-xs break-all'>{t.key}</span> : dash; }
    } satisfies RecordCol<Run>] : []),
    {
      key: reports ? 'ended' : 'started', label: reports ? 'Finished' : 'Started', type: 'date',
      value: (r) => (reports ? r.ended_at : r.started_at ?? r.created_at),
      render: (r) => <span className='tabular-nums'>{when(reports ? r.ended_at : r.started_at ?? r.created_at) || '—'}</span>
    },
    {
      key: 'duration', label: 'Duration', type: 'number', className: 'text-right',
      value: (r) => runSeconds(r), render: (r) => <span className='tabular-nums'>{duration(runSeconds(r)) || '—'}</span>
    },
    { key: 'results', label: 'Results', type: 'text', value: (r) => resultCounts(r.results), render: (r) => resultCounts(r.results) || dash },
    {
      key: 'cost', label: 'Cost', type: 'number', className: 'text-right',
      value: (r) => Number(r.cost_usd), render: (r) => <span className='tabular-nums'>{formatValue(r.cost_usd, 'usd')}</span>
    },
    ...(reports ? [] : [{ key: 'ended', label: 'Finished', type: 'date', hidden: true, value: (r) => r.ended_at, render: (r) => when(r.ended_at) || dash } satisfies RecordCol<Run>])
  ];
  return cols;
}

/** A run's results (GET /api/runs/:id), beside the list: each check, the asset, the result and its evidence. */
export function RunResults({ id }: { id: string }) {
  const { data, error } = useOrgLoad(() => getJson<{ results: RunResult[] }>(`/api/runs/${encodeURIComponent(id)}`), [id]);
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingCards count={1} />;
  if (!data.results.length) return <p className='text-muted-foreground text-sm'>{fill('This {run} recorded no results.')}</p>;
  const ref = (x: Ref | null) => (x ? (findRecordArea('app', x.area)
    ? <Link className='underline-offset-4 hover:underline' href={`/app/records/${x.area}/${encodeURIComponent(x.key)}`}>{x.key}</Link> : x.key) : '—');
  return (
    <Table label={fill('Results of the {run}')}>
      <TableHeader><TableRow><TableHead>Check</TableHead><TableHead>Asset</TableHead><TableHead>Result</TableHead><TableHead>Evidence</TableHead></TableRow></TableHeader>
      <TableBody>
        {data.results.map((r, i) => (
          <TableRow key={i}>
            <TableCell className='whitespace-normal break-all'>{ref(r.check)}</TableCell><TableCell className='whitespace-normal break-all'>{ref(r.asset)}</TableCell>
            <TableCell><Badge variant={r.status === 'fail' || r.status === 'error' ? 'destructive' : 'secondary'}>{RESULT_LABELS[r.status] ?? r.status}</Badge></TableCell>
            <TableCell className='font-mono text-xs break-all whitespace-normal'>{r.evidence_ref ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The runs (or, `reports`, the finished runs) of the workspace as the database table. */
export function RunsTable({ tab, reports, summary }: {
  tab: Pick<PackTabSpec, 'pack' | 'id' | 'label' | 'empty'>; reports: boolean;
  /** Between the toolbar and the table: the tab's four cards (mold_v0-181, ./sparklines.tsx). */
  summary?: ReactNode;
}) {
  const { data, error } = useOrgLoad(() => getJson<{ runs: Run[] }>('/api/runs?limit=200'), []);
  const runs = useMemo(() => {
    const all = data?.runs ?? [];
    return reports ? all.filter((r) => FINISHED.has(r.status) && r.status !== 'cancelled') : all;
  }, [data, reports]);
  const cols = useMemo(() => columns(reports, runs), [reports, runs]);
  if (error) return <ErrorState error={error} />;
  const noun = lowerFirst(tab.label);
  return (
    <RecordView<Run>
      id={`app-${reports ? 'reports' : 'runs'}-${tab.pack}-${tab.id}`} compact noun={noun} properties summary={summary}
      rows={runs} rowKey={(r) => r.id} cols={cols} loading={!data}
      defaultSort={[{ key: reports ? 'ended' : 'started', dir: 'desc' }]}
      searchText={(r) => `${runKindLabel(r.pack, r.kind)} ${r.kind} ${statusLabel(r.status)} ${runTarget(r)?.key ?? ''} ${r.id}`}
      searchPlaceholder={`Search ${noun}`}
      primary={runs.length ? <ExportRowsButton name={`${tab.pack}-${tab.id}`} rows={runs} cols={cols} /> : undefined}
      empty={<div className='sticky left-0 max-w-[min(36rem,calc(100vw-5rem))] text-left sm:mx-auto'><EmptyState empty={tab.empty} id={reports ? 'empty-reports' : 'empty-runs'} /></div>}
      detailTitle={(r) => runKindLabel(r.pack, r.kind)}
      detailActions={(r) => {
        const t = runTarget(r);
        return t && findRecordArea('app', t.area)
          ? <Button variant='outline' size='sm' render={<Link href={`/app/records/${t.area}/${encodeURIComponent(t.key)}`} />}>Open {lowerFirst(targetLabel([r]))}</Button>
          : null;
      }}
      detail={(r) => (
        <div className='flex flex-col gap-4'>
          <dl>
            <Field label='Reference'><span className='font-mono text-xs break-all'>{r.id}</span></Field>
            <Field label='Queued'>{when(r.created_at)}</Field>
            {r.budget_usd !== undefined && <Field label='Budget'>{formatValue(r.budget_usd, 'usd')}</Field>}
            {r.max_attempts !== undefined && r.max_attempts > 1 && <Field label='Attempt'>{r.attempt} of {r.max_attempts}</Field>}
            {r.error && <Field label='Error'><span className='text-destructive whitespace-pre-wrap'>{r.error}</span></Field>}
          </dl>
          <section aria-label={fill('Results of the {run}')} className='flex flex-col gap-2'>
            <h3 className='text-sm font-medium'>Results</h3>
            <RunResults id={r.id} />
          </section>
        </div>
      )}
    />
  );
}
