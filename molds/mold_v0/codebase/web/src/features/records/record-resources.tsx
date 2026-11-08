'use client';
// A shared record's own resources on its staff page (mold_v0-282, flag record_resources; src/record-resources.ts): each
// repository field's GitHub repository (read live through the platform's GitHub App: its default branch and last
// commit, or in plain words why it cannot be read and where to fix it), and each database field's database (its
// status: being created, ready, or failed with the reason, with Retry; its Neon project, region, host, database and
// role, never its connection string). Read from GET /api/admin/records/_resources/<area>/<key>.
import { useState } from 'react';
import { toast } from 'sonner';
import { Field } from '@/components/layout/record-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Icons } from '@/components/icons';
import type { RecordAreaSpec } from '@/config/pack-nav.generated';
import { featureOn } from '@/config/features';
import { fail, useOrgLoad } from '@/features/portal/shared';
import { adminRecordsApi } from '@/lib/api-client';

interface Repo { field: string; label: string; repository: string | null; url?: string; default_branch?: string; private?: boolean;
  last_commit?: { sha: string; message: string; date: string | null; author: string | null } | null; error?: string }
export interface Database { field: string; label: string; provider: string; status: 'provisioning' | 'ready' | 'failed' | 'none'; reason: string | null;
  project_id: string | null; region: string | null; host: string | null; database: string | null; role: string | null; retry: boolean; updated_at: string | null }
interface Resources { repositories: Repo[]; databases: Database[] }

/** Whether the area's records own a repository or a database (and the flag is on): only then is the card drawn. */
export const ownsResources = (area: Pick<RecordAreaSpec, 'scope' | 'fields'>) =>
  featureOn('record_resources') && area.scope === 'platform' && area.fields.some((f) => f.type === 'repository' || f.type === 'database');
/** Whether the area's records own a database (deleting one deletes it: the confirmation says so). */
export const ownsDatabase = (area: Pick<RecordAreaSpec, 'scope' | 'fields'>) => ownsResources(area) && area.fields.some((f) => f.type === 'database');

const PROVIDER: Record<string, string> = { neon: 'Neon' };
const STATUS: Record<Database['status'], { label: string; variant: 'secondary' | 'destructive' | 'outline' }> = {
  provisioning: { label: 'Being created', variant: 'outline' }, ready: { label: 'Ready', variant: 'secondary' },
  failed: { label: 'Failed', variant: 'destructive' }, none: { label: 'Not created', variant: 'outline' },
};
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace('T', ' ') : '');

/** The record's resources card; nothing while the area owns none. */
export function RecordResources({ area, recordKey }: { area: RecordAreaSpec; recordKey: string }) {
  const shown = ownsResources(area);
  const url = `/_resources/${encodeURIComponent(area.name)}/${encodeURIComponent(recordKey)}`;
  const { data, error, reload } = useOrgLoad(() => (shown ? adminRecordsApi<Resources>('GET', url) : Promise.resolve(null)), [url, shown]);
  const [busy, setBusy] = useState<string | null>(null);
  if (!shown) return null;
  const retry = async (d: Database) => {
    setBusy(d.field);
    try {
      const r = await adminRecordsApi<{ database: Database }>('POST', `${url}/${encodeURIComponent(d.field)}/retry`, {});
      if (r.database.status === 'ready') toast.success(`${d.label}: ready`);
      else if (r.database.status === 'failed') toast.error(`${d.label}: ${r.database.reason ?? 'not created'}`);
      void reload();
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  return (
    <Card className='w-full max-w-4xl gap-0 py-0' data-record-resources=''>
      <CardHeader className='border-b py-4 [.border-b]:pb-4'><CardTitle className='text-sm'>Repository and database</CardTitle></CardHeader>
      <CardContent className='py-2'>
        {error ? <p className='text-destructive py-3 text-sm'>{error.message}</p> : !data ? <p className='text-muted-foreground py-3 text-sm'>Loading…</p> : (
          <dl>
            {data.repositories.map((r) => (
              <Field key={r.field} label={r.label}>
                {!r.repository ? <span className='text-muted-foreground'>None linked (Edit to link one: owner/name on GitHub).</span> : (
                  <span className='flex flex-col items-start gap-1' data-repository={r.repository}>
                    <a className='font-mono text-xs underline-offset-4 hover:underline' href={r.url ?? `https://github.com/${r.repository}`} target='_blank' rel='noopener noreferrer nofollow'>{r.repository}</a>
                    {r.error ? <span className='text-destructive text-xs' role='alert' data-repository-error=''>{r.error}</span> : (<>
                      <span className='text-muted-foreground text-xs'>Default branch <span className='font-mono'>{r.default_branch}</span>{r.private ? ' · private' : ''}</span>
                      <span className='text-xs' data-last-commit={r.last_commit?.sha ?? ''}>
                        {r.last_commit ? <>Last commit <span className='font-mono'>{r.last_commit.sha.slice(0, 7)}</span> {r.last_commit.message}{r.last_commit.date ? ` · ${day(r.last_commit.date)}` : ''}{r.last_commit.author ? ` · ${r.last_commit.author}` : ''}</> : 'No commit yet (an empty repository)'}
                      </span>
                    </>)}
                  </span>
                )}
              </Field>
            ))}
            {data.databases.map((d) => (
              <Field key={d.field} label={d.label}>
                <span className='flex flex-col items-start gap-1.5' data-database={d.status}>
                  <span className='flex flex-wrap items-center gap-2'>
                    <Badge variant={STATUS[d.status].variant}>{d.status === 'provisioning' && <Icons.spinner className='animate-spin' />}{STATUS[d.status].label}</Badge>
                    <span className='text-muted-foreground text-xs'>{PROVIDER[d.provider] ?? d.provider} Postgres, this record’s own</span>
                    {d.retry && (
                      <Button type='button' size='sm' variant='outline' disabled={busy === d.field} onClick={() => void retry(d)} data-database-retry=''>
                        <Icons.refresh /> {busy === d.field ? 'Creating…' : d.status === 'none' ? 'Create database' : 'Retry'}
                      </Button>
                    )}
                    {d.status === 'provisioning' && !d.retry && <Button type='button' size='sm' variant='ghost' onClick={() => void reload()}><Icons.refresh /> Refresh</Button>}
                  </span>
                  {d.reason && d.status !== 'ready' && <span className={d.status === 'failed' ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'} data-database-reason=''>{d.reason}</span>}
                  {d.status === 'ready' && (
                    <span className='text-muted-foreground font-mono text-xs break-all'>
                      {[d.project_id && `project ${d.project_id}`, d.region, d.host, d.database && `database ${d.database}`, d.role && `role ${d.role}`].filter(Boolean).join(' · ')}
                    </span>
                  )}
                  {d.status === 'ready' && <span className='text-muted-foreground text-xs'>Its connection string is kept sealed on the server: it is never shown here or given to an agent.</span>}
                </span>
              </Field>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
