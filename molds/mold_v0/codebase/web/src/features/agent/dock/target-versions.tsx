'use client';
// A record's runs and versions (mold_v0-292, flag nested_runs): on a record's page, the programs that targeted it, each
// version they produced and which is current (a record section `versions`; src/agent-dock.ts targetHistory).
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { adminApi } from '@/lib/api-client';
import { When } from '@/features/portal/shared';
import { StatusBadge, VersionTimeline, type Version } from './run-view';

interface History { runs: { id: string; root_id: string; program: string; outcome: string | null; lift: number | null; hypothesis: string; at: string; workspace: string | null }[]; versions: Version[]; champion: number | null }

export function TargetVersions({ target, title, empty }: { target: string; title: string; empty?: string }) {
  const staff = usePathname().startsWith('/admin');
  const [data, setData] = useState<History | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const load = staff ? adminApi<History>('GET', `/program-targets/${encodeURIComponent(target)}`)
      : fetch(`/api/agent/targets/${encodeURIComponent(target)}`, { credentials: 'same-origin' }).then(async (r) => { if (!r.ok) throw new Error('unavailable'); return (await r.json()) as History; });
    void load.then(setData, () => setFailed(true));
  }, [target, staff]);
  return (
    <section className='bg-card flex flex-col gap-3 rounded-xl border p-6' data-record-versions='' aria-label={title}>
      <h2 className='text-sm font-semibold'>{title}</h2>
      {failed ? <p className='text-muted-foreground text-sm'>This could not be read just now.</p>
        : !data ? <div className='bg-muted/40 h-16 animate-pulse rounded-lg' />
          : !data.runs.length && !data.versions.length ? <p className='text-muted-foreground text-sm'>{empty ?? 'No run has improved this yet.'}</p>
            : <div className='grid gap-6 md:grid-cols-2'>
              <div className='flex flex-col gap-2'><h3 className='text-muted-foreground text-xs font-medium'>Versions</h3><VersionTimeline versions={data.versions} /></div>
              <div className='flex flex-col gap-2'><h3 className='text-muted-foreground text-xs font-medium'>Runs</h3>
                <ul className='flex flex-col gap-2'>{data.runs.map((r) => (
                  <li key={r.id} className='flex items-center gap-2 text-sm' data-record-version-run=''>
                    {staff ? <span className='min-w-0 flex-1 truncate' title={r.hypothesis}>{r.hypothesis || r.program}{r.workspace ? ` · ${r.workspace}` : ''}</span>
                      : <Link href={`/app/agent/runs/${encodeURIComponent(r.root_id)}`} className='min-w-0 flex-1 truncate underline-offset-4 hover:underline' title={r.hypothesis}>{r.hypothesis || r.program}</Link>}
                    <span className='text-muted-foreground shrink-0 text-xs'><When d={r.at} /></span><StatusBadge status={r.outcome ?? 'measuring'} />
                  </li>
                ))}</ul></div>
            </div>}
    </section>
  );
}
