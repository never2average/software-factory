'use client';
// FinOps › the packs' runs (GET /spend/runs, src/compute-jobs.ts runKinds; mold_v0-104, on FinOps since mold_v0-126 in
// the pricing Experiments tab's place): in a build without the session engine, every job kind the packs declare, by its
// label and in the build's word for a run, with how its runs in FinOps' period ended across every account, what they
// cost, how long they took and the latest failure. Read only.
import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { usd } from '@/lib/display-format';
import { W } from '@/lib/vocabulary';
import { useAdmin } from './lib';
import { DataList, ErrorBox, Mono, When } from './ui';

interface RunKind {
  pack: string; kind: string; label: string; description: string | null;
  total: number; queued: number; running: number; succeeded: number; failed: number; cancelled: number; accounts: number;
  usd: number; avg_seconds: number | null; last_at: string | null; last_error: string | null; last_failed_at: string | null;
}
interface RunKinds { since: string | null; hours: number; range: { from: string; to: string } | null; words: { one: string; many: string }; kinds: RunKind[] }

const n = (x: number) => <span className='tabular-nums'>{x.toLocaleString()}</span>;
const secs = (s: number | null) => (s == null ? '—' : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

/** The runs tab: one row per job kind over `query` (FinOps' period, from=…&to=…), FinOps' date bar above it. */
export function PackRunKinds({ query, bar }: { query: string; bar?: ReactNode }) {
  const { data, error, isLoading } = useAdmin<RunKinds>(`/spend/runs?${query}`, { keep: true });
  const many = data?.words.many ?? W.Runs;
  const spent = (data?.kinds ?? []).reduce((a, k) => a + k.usd, 0);
  return (
    <div className='flex min-w-0 flex-col gap-3'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        {bar}
        <p className='text-muted-foreground text-sm'>{many} by kind, across every account: {usd(spent)} in this period. A kind with none shows zero.</p>
      </div>
      <ErrorBox error={error} />
      {isLoading && !data ? <Skeleton className='h-64' /> : (
        <DataList
          rows={data?.kinds}
          empty={`No ${many.toLowerCase()} in this period.`}
          minWidth={880}
          cols={[
            { label: 'Kind', render: (k) => <span className='flex flex-col gap-0.5'><span>{k.label}</span><Mono>{k.pack}/{k.kind}</Mono></span> },
            { label: many, className: 'text-right', render: (k) => n(k.total) },
            { label: 'Running', className: 'text-right', render: (k) => n(k.queued + k.running) },
            { label: 'Succeeded', className: 'text-right', render: (k) => n(k.succeeded) },
            { label: 'Failed', className: 'text-right', render: (k) => (k.failed ? <span className='text-destructive tabular-nums'>{k.failed}</span> : n(0)) },
            { label: 'Accounts', className: 'text-right', render: (k) => n(k.accounts) },
            { label: 'Spend', className: 'text-right', render: (k) => <span className='tabular-nums'>{usd(k.usd)}</span> },
            { label: 'Typical time', className: 'text-right', render: (k) => <span className='tabular-nums'>{secs(k.avg_seconds)}</span> },
            { label: 'Last', render: (k) => <When d={k.last_at} /> },
            { label: 'Latest failure', className: 'whitespace-normal', render: (k) => (k.last_error ? <span className='text-sm'>{k.last_error}</span> : <span className='text-muted-foreground'>—</span>) }
          ]}
        />
      )}
    </div>
  );
}
