'use client';
// Compute › Failures (GET /compute/failures, src/compute-jobs.ts): one table over the last 24 h (or 7 days). Each row is
// a reason: failed orchestrator launches by step, unattended deletes, reaps by normalized reason (routine ones, the
// autoscaler doing its job, are marked and not counted as failures) and session failures by class
// (src/error-classes.ts) with the page that fixes each. A row's ⋯ menu opens the matching orchestrators or sessions.
import { useMemo, type ReactNode } from 'react';
import Link from 'next/link';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { useAdmin } from './lib';
import { copyText, StatusBadge, type Tone } from './ui';
import { dur, since, useComputeParams } from './compute-common';

export interface Failures {
  hours: number; ended: number;
  launches: { step: string; label: string; count: number; last_at: string; message: string }[];
  reaps: { reason: string; key: string; label: string; routine: boolean; count: number; last_at: string; message: string }[];
  unattended: { kind: string; label: string; count: number; last_at: string; message: string | null }[];
  sessions: { key: string; label: string; count: number; share: number | null; jobs: number; top_agent: string | null; last_at: string; fix: { text: string; href: string } | null }[];
}

type Kind = 'launch' | 'unattended' | 'reap' | 'routine' | 'session';
interface Row {
  id: string; kind: Kind; reason: string; count: number; last_at: string; message: string | null; share: number | null;
  detail: string | null; fix: { text: string; href: string } | null; open: (() => void) | null; openLabel: string | null;
}
const KIND: Record<Kind, { label: string; tone: Tone }> = {
  launch: { label: 'launch failed', tone: 'bad' }, unattended: { label: 'unattended', tone: 'warn' }, reap: { label: 'reaped', tone: 'warn' },
  routine: { label: 'routine', tone: 'neutral' }, session: { label: 'session', tone: 'bad' }
};

export function useFailures() {
  const url = useComputeParams();
  const hours = url.get('fhours') === '168' ? 168 : 24;
  const q = useAdmin<Failures>(`/compute/failures?hours=${hours}`, { refetchInterval: 30_000, keep: true });
  return { ...q, hours };
}

/** The Failures tab: every reason in one table; the window (24 h / 7 d) is a dropdown on the search row. */
export function ComputeFailures({ stats }: { stats?: (data: Failures | undefined, hours: number) => ReactNode }) {
  const url = useComputeParams();
  const { data, error, isLoading, refetch, hours } = useFailures();
  const span = hours === 24 ? 'the last 24 hours' : 'the last 7 days';
  // Ended (24 h) holds a day of orchestrators; a week needs All.
  const orchState = hours === 24 ? 'ended' : 'all';
  const showOrch = (reason: string) => url.write({ section: 'orchestrators', state: orchState, oreason: reason, ojob: null, orch: null, back: null });
  const showSessions = (cls: string) => url.write({ section: 'sessions', class: cls, status: cls === 'unclaimable' ? 'queued' : 'failed,timeout', since: hours === 168 ? '7d' : null, session: null });

  const rows = useMemo((): Row[] => !data ? [] : [
    ...data.launches.map((l): Row => ({ id: `l:${l.step}`, kind: 'launch', reason: l.label, count: l.count, last_at: l.last_at, message: l.message, share: null, detail: null, fix: null,
      open: () => showOrch(`launch:${l.step}`), openLabel: 'Show these orchestrators' })),
    ...data.unattended.map((u): Row => ({ id: `u:${u.kind}`, kind: 'unattended', reason: u.label, count: u.count, last_at: u.last_at, message: u.message, share: null, detail: null, fix: null, open: null, openLabel: null })),
    ...data.reaps.map((r): Row => ({ id: r.key, kind: r.routine ? 'routine' : 'reap', reason: r.label, count: r.count, last_at: r.last_at, message: r.message, share: null, detail: null, fix: null,
      open: () => showOrch(r.key), openLabel: 'Show these orchestrators' })),
    ...data.sessions.map((x): Row => ({ id: `s:${x.key}`, kind: 'session', reason: x.label, count: x.count, last_at: x.last_at, message: null, share: x.share,
      detail: `${x.share != null ? `${(x.share * 100).toFixed(x.share < 0.1 ? 1 : 0)}% of the ${data.ended} sessions that ended` : 'queued, never claimed'} · ${x.jobs} job${x.jobs === 1 ? '' : 's'}${x.top_agent ? ` · mostly ${x.top_agent}` : ''}`,
      fix: x.fix, open: () => showSessions(x.key), openLabel: 'Show these sessions' }))
  ], [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const cols: RecordCol<Row>[] = [
    { key: 'reason', label: 'Reason', title: true, keep: true, type: 'text', value: (r) => r.reason, render: (r) => (
      <span className='flex min-w-0 flex-col gap-1'>
        <span className={cn('font-medium', r.kind === 'routine' && 'text-muted-foreground font-normal')}>{r.reason}</span>
        {r.detail ? <span className='text-muted-foreground text-xs'>{r.detail}</span>
          : r.message && <span className='text-muted-foreground line-clamp-1 font-mono text-xs' title={r.message}>{r.message}</span>}
      </span>
    ) },
    { key: 'kind', label: 'Kind', keep: true, type: 'select', value: (r) => KIND[r.kind].label, render: (r) => <StatusBadge tone={KIND[r.kind].tone}>{KIND[r.kind].label}</StatusBadge> },
    { key: 'count', label: 'Count', className: 'text-right', type: 'number', value: (r) => r.count, render: (r) => (
      <span className='flex flex-col items-end gap-1'>
        <span className='tabular-nums'>{r.count}</span>
        <span className='text-muted-foreground text-xs' title={new Date(r.last_at).toLocaleString()}>{dur(since(r.last_at))} ago</span>
      </span>
    ) },
    // Off by default (Count's second line); kept for sorting and filtering by recency.
    { key: 'last', label: 'Last seen', hidden: true, className: 'text-right', type: 'date', value: (r) => r.last_at,
      render: (r) => <span className='text-muted-foreground text-xs' title={new Date(r.last_at).toLocaleString()}>{dur(since(r.last_at))} ago</span> },
    // Off by default (Reason's second line); turn it on to export the message.
    { key: 'message', label: 'Message', hidden: true, className: 'max-w-96', type: 'text', value: (r) => r.message ?? '',
      render: (r) => (r.message ? <span className='text-muted-foreground line-clamp-2 font-mono text-xs' title={r.message}>{r.message}</span> : null) },
    { key: 'fix', label: 'Fix it in', type: 'text', value: (r) => r.fix?.text ?? '',
      render: (r) => (r.fix ? <Link href={r.fix.href} className='text-sm font-medium hover:underline' onClick={(e) => e.stopPropagation()}>{r.fix.text}</Link> : null) }
  ];

  const filters = (
    <NativeSelect aria-label='Window' value={String(hours)} onChange={(e) => url.write({ fhours: e.target.value === '24' ? null : '168' })}>
      <NativeSelectOption value='24'>Last 24 hours</NativeSelectOption>
      <NativeSelectOption value='168'>Last 7 days</NativeSelectOption>
    </NativeSelect>
  );

  return (
    <div id='compute-failures-anchor' className='flex min-w-0 flex-col gap-3'>
      {error && !data && (
        <div role='alert' className='border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-3 rounded-lg border px-4 py-3 text-sm'>
          <span className='min-w-0 flex-1'>Could not load failures: {error.message}</span>
          <Button variant='outline' size='xs' onClick={() => void refetch()}>Retry</Button>
        </div>
      )}
      <RecordView id='compute-failures' rows={rows} loading={isLoading && !data} rowKey={(r) => r.id} cols={cols} noun='reasons' initialSize={50}
        searchText={(r) => `${r.reason} ${KIND[r.kind].label} ${r.message ?? ''} ${r.detail ?? ''} ${r.fix?.text ?? ''}`}
        searchPlaceholder='Search reasons, messages' filters={filters} summary={stats?.(data, hours)} exportName='compute-failures' compact
        actions={(r) => [
          ...(r.open ? [{ label: r.openLabel!, icon: <Icons.search />, onSelect: r.open }] : []),
          ...(r.message ? [{ label: 'Copy message', icon: <Icons.page />, onSelect: () => copyText(r.message!, 'Message copied') }] : [])
        ]}
        empty={`No failures in ${span}.`} />
    </div>
  );
}
