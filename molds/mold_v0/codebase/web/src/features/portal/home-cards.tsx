'use client';
// The home page's Recent runs and Needs attention cards (mold_v0-260, flag overview_cards; pack.json rail recent_runs,
// attention): cells of the home grid's rail, as the Due soon card is. Served by GET /api/home/recent-runs and
// /api/home/attention (src/gap-routes.ts), each read as the person: a run of a pack whose runs list is withheld, or a
// record of an area their role may not read, is never shown.
import Link from 'next/link';
import { Icons } from '@/components/icons';
import { fill } from '@/lib/vocabulary';
import { Skeleton } from '@/components/ui/skeleton';
import { featureOn } from '@/config/features';
import { packTabs } from '@/config/pack-nav.generated';
import { StatusBadge } from '@/features/admin/ui';
import { GridCell } from '@/features/portal/grid-cell';
import { ErrorState, useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { cn } from '@/lib/utils';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, body);
  return body;
}

interface RecentRun { id: string; pack: string; kind: string; label: string; status: string; created_at: string; ended_at: string | null; cost_usd: number; by: string }
interface Attention { records: { area: string; area_label: string; key: string; title: string | null; tone: 'warning' | 'danger'; notice: string; updated_at: string }[]; total: number; more: boolean }

const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info' | 'neutral'> = { succeeded: 'ok', failed: 'bad', running: 'info', queued: 'neutral', cancelled: 'neutral' };
/** A run's own page (with record pages on), else its pack's runs tab with the run open. */
export const runHref = (r: { id: string; pack: string }) => featureOn('record_pages') ? `/app/runs/${encodeURIComponent(r.id)}`
  : `${packTabs.find((t) => t.pack === r.pack && t.kind === 'runs')?.url ?? '/app'}?run=${encodeURIComponent(r.id)}`;
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
const Loading = ({ label }: { label: string }) => (
  <div className='flex flex-col gap-2' aria-busy='true' aria-label={label}>{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className='h-10 w-full' />)}</div>
);
const Empty = ({ title, text }: { title: string; text: string }) => (
  <div className='flex items-center gap-3 rounded-lg border border-dashed px-3 py-4'>
    <Icons.circleCheck aria-hidden className='text-muted-foreground size-5 shrink-0' />
    <div className='min-w-0'><p className='text-sm font-medium'>{title}</p><p className='text-muted-foreground text-xs'>{text}</p></div>
  </div>
);

export function RecentRunsCard() {
  const { data, error } = useOrgLoad(() => getJson<{ runs: RecentRun[] }>('/api/home/recent-runs'));
  return (
    <GridCell title={fill('Recent {runs}')} icon={<Icons.play />}>
      {error ? <ErrorState error={error} /> : !data ? <Loading label='Loading recent runs' /> : !data.runs.length ? <Empty title='No runs yet' text='Runs show here as soon as one starts.' /> : (
        <ul className='flex flex-col gap-0.5' aria-label={fill('Recent {runs}')} data-recent-runs=''>
          {data.runs.map((r) => (
            <li key={r.id}>
              <Link href={runHref(r)} className='hover:bg-muted/60 flex items-center gap-3 rounded-lg px-2 py-2 text-sm'>
                <span className='flex min-w-0 flex-1 flex-col'>
                  <span className='truncate font-medium'>{r.label}</span>
                  <span className='text-muted-foreground truncate text-xs'>{r.by} · {ago(r.created_at)}{r.cost_usd > 0 ? ` · $${r.cost_usd.toFixed(2)}` : ''}</span>
                </span>
                <StatusBadge tone={TONE[r.status] ?? 'neutral'} className='shrink-0'>{r.status}</StatusBadge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </GridCell>
  );
}

export function AttentionCard() {
  const { data, error } = useOrgLoad(() => getJson<Attention>('/api/home/attention'));
  return (
    <GridCell title='Needs attention' icon={<Icons.warning />}
      description={data && data.total > 0 ? `${data.total} record${data.total === 1 ? '' : 's'} with a warning` : 'Records whose page shows a warning.'}>
      {error ? <ErrorState error={error} /> : !data ? <Loading label='Loading records that need attention' /> : !data.records.length ? <Empty title='Nothing needs attention' text='Records show here while one of their warnings holds.' /> : (
        <ul className='flex flex-col gap-0.5' aria-label='Needs attention' data-attention=''>
          {data.records.map((r) => (
            <li key={`${r.area}/${r.key}`}>
              <Link href={`/app/records/${encodeURIComponent(r.area)}/${encodeURIComponent(r.key)}`} className='hover:bg-muted/60 flex items-start gap-3 rounded-lg px-2 py-2 text-sm'>
                <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', r.tone === 'danger' ? 'bg-destructive' : 'bg-amber-500')} />
                <span className='flex min-w-0 flex-1 flex-col'>
                  <span className='truncate font-medium'>{r.title || r.key}</span>
                  <span className='text-muted-foreground line-clamp-2 text-xs'><span className='sr-only'>{r.tone === 'danger' ? 'Danger: ' : 'Warning: '}</span>{r.notice} · {r.area_label}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </GridCell>
  );
}
