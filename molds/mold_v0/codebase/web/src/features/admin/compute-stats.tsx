'use client';
// Health › Jobs and Health › Sessions: two rows of four headline numbers between the toolbar and the table, as on the
// Errors tab. Live figures come from GET /compute/summary (the same query the Compute page refreshes); the Jobs
// figures that follow the table's range and filters come from the jobs loaded.
import { StatStrip } from '@/components/layout/section';
import { useAdmin } from './lib';
import { cents, dur, ageOf } from './compute-common';
import type { JobRow } from './compute-jobs';

interface Live {
  queue: { sessions: number; research: number; oldest_session_at: string | null; unclaimable: number; jobs_waiting: number };
  running: { sessions: number; research: number; orchestrators: { booting: number; running: number; draining: number }; pods_used: number; pods_reserved: number };
  wait_1h: { p50_s: number | null; p95_s: number | null; n: number };
  failures_24h: { sessions: number; launches: number; ended: number; rate: number; top: { key: string; label: string; count: number } | null };
  spend_today: { session_model_usd: number; orchestrator_model_usd: number; sandbox_est_usd: number; total_usd: number };
}

const useLive = () => useAdmin<Live>('/compute/summary', { refetchInterval: 30_000 }).data;
/** The last 24 hours, hour by hour (GET /compute/trends): every card's sparkline. */
const useTrend = () => {
  const t = useAdmin<{ series: Record<string, number[]> }>('/compute/trends', { refetchInterval: 60_000 }).data?.series;
  return (k: string) => t?.[k];
};
const n = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString());
const pct = (r: number) => `${Math.round(r * 100)}%`;

/** Jobs: what the loaded jobs are doing (range and filters applied), then live capacity, failures and spend. */
export function JobsStats({ rows }: { rows: readonly JobRow[] }) {
  const s = useLive(), t = useTrend();
  const by = (st: string) => rows.filter((j) => j.state === st).length;
  const o = s?.running.orchestrators;
  const failed = rows.filter((j) => j.failures.count > 0 || j.failed_launches > 0).length;
  const spend = rows.reduce((t, j) => t + j.spend.session_model_usd + j.spend.orchestrator_model_usd, 0);
  return (
    <StatStrip items={[
      { label: 'Waiting', spark: t('queued'), value: n(by('waiting') + by('queued')) },
      { label: 'Running', spark: t('running'), value: n(by('running') + by('booting')) },
      { label: 'Jobs with failures', spark: t('jobs_failed'), value: n(failed) },
      { label: 'Model spend', spark: t('spend'), value: cents(spend) }
    ]} />
  );
}

/** Sessions: the queue and what runs now, then how sessions ended in the last 24 hours and today's spend. */
export function SessionsStats() {
  const s = useLive(), t = useTrend();
  const oldest = ageOf(s?.queue.oldest_session_at);
  const f = s?.failures_24h;
  return (
    <StatStrip items={[
      { label: 'Queued now', spark: t('queued'), value: n(s?.queue.sessions) },
      { label: 'Running now', spark: t('running'), value: n(s?.running.sessions) },
      { label: 'Failed, 24 h', spark: t('failed'), value: n(f?.sessions) },
      { label: 'Wait to start, p50', spark: t('wait_p50'), value: s?.wait_1h.p50_s != null ? dur(s.wait_1h.p50_s) : '—' }
    ]} />
  );
}
