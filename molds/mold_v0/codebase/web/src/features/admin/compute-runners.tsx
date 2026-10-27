'use client';
// Compute › On-premises runners (mold_v0-036; GET /runners, src/onprem-runner-routes.ts onPremAdminRoutes): every
// workspace's runners with their health (status, last seen, version, runs, allowed private hosts), never a token or a
// credential. Revoke (accounts) stops one at once, as its workspace's owners can on their Credentials page. Shown only
// in a build where a kind may need a workspace's private network.
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { adminApi } from '@/lib/api-client';
import { useAdmin } from './lib';
import { Gate } from './role';
import { DataList, ErrorBox, Mono, When } from './ui';

interface Runner {
  id: string; name: string; status: 'waiting_for_install' | 'enrollment_expired' | 'online' | 'offline' | 'revoked';
  org_id: number; org_name: string | null; last_seen_at: string | null; version: string | null; hostname: string | null;
  capacity: number | null; live_runs: number; allow: string[]; created_at: string;
}
const STATUS: Record<Runner['status'], string> = { online: 'Online', offline: 'Offline', waiting_for_install: 'Waiting for install', enrollment_expired: 'Token expired', revoked: 'Revoked' };

export function ComputeRunners() {
  const { data, error, isLoading, refetch } = useAdmin<{ runners: Runner[] }>('/runners', { refetchInterval: 15_000 });
  const revoke = async (r: Runner) => {
    if (!window.confirm(`Revoke ${r.name} of ${r.org_name ?? r.org_id}? It stops at once and its runs go back to the queue.`)) return;
    try { await adminApi('DELETE', `/runners/${encodeURIComponent(r.id)}`); toast.success('Revoked'); await refetch(); }
    catch (e) { toast.error((e as Error).message); }
  };
  return (
    <div className='flex min-w-0 flex-col gap-3'>
      <p className='text-muted-foreground text-sm'>Runners customers installed inside their own networks for runs that need them. Each takes only its own account&apos;s runs; online means it asked for work in the last 90 seconds.</p>
      <ErrorBox error={error} />
      {isLoading && !data ? <Skeleton className='h-48' /> : (
        <DataList rows={data?.runners} empty='No account has an on-premises runner.' minWidth={880} cols={[
          { label: 'Runner', render: (r) => <span className='flex flex-col gap-0.5'><span>{r.name}</span><Mono>{r.hostname ?? r.id}</Mono></span> },
          { label: 'Account', render: (r) => r.org_name ?? String(r.org_id) },
          { label: 'Status', render: (r) => (r.status === 'offline' ? <span className='text-destructive'>{STATUS[r.status]}</span> : STATUS[r.status]) },
          { label: 'Last seen', render: (r) => <When d={r.last_seen_at} /> },
          { label: 'Runs', className: 'text-right', render: (r) => <span className='tabular-nums'>{r.live_runs}{r.capacity ? ` / ${r.capacity}` : ''}</span> },
          { label: 'Version', render: (r) => <Mono>{r.version ?? '—'}</Mono> },
          { label: 'Private hosts', className: 'whitespace-normal', render: (r) => <Mono>{r.allow.join(' ') || '—'}</Mono> },
          { label: '', render: (r) => (r.status === 'revoked' ? null : <Gate need='accounts'><Button variant='ghost' size='xs' onClick={() => void revoke(r)}>Revoke</Button></Gate>) }
        ]} />
      )}
    </div>
  );
}
