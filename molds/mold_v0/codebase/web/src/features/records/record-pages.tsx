'use client';
// The shell's generic record-area pages (mold_v0-047): a list page and a detail page for every area a pack declares in
// definePack({ recordAreas }), with no pack code. Labels and columns come from the generated registry
// (web/src/config/pack-nav.generated.ts); rows from /api/records (a workspace's view: shared areas and its own) or
// /api/admin/records (platform staff: the shared areas). Read only: records are written by the packs and the platform.
import Link from 'next/link';
import { useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { RecordAreaSpec } from '@/config/pack-nav.generated';
import { ErrorState, LoadingCards, useOrgLoad } from '@/features/portal/shared';
import { areaFieldLabel, findRecordArea, recordsApi } from './registry';

type RecordRow = { key: string; title: string | null; data: Record<string, unknown>; version: string | null; updated_at: string };
type Page = { records: RecordRow[]; next: string | null };
type Detail = { record: RecordRow; links: { field: string; area: string; records: { key: string; title: string | null }[] }[] };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const cell = (v: unknown) => (v == null ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));
const where = (area: RecordAreaSpec) => (area.scope === 'platform' ? 'Shared by every workspace (read only)' : "This workspace's own");

export function RecordListPage({ area, base }: { area: RecordAreaSpec; base: 'app' | 'admin' }) {
  const [after, setAfter] = useState<string[]>([]);
  const cursor = after.at(-1) ?? '';
  const url = `${recordsApi(base)}/${area.name}?limit=50${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
  const { data, error } = useOrgLoad(() => getJson<Page>(url), [url]);
  return (
    <PageContainer pageTitle={area.label} pageDescription={area.description ?? where(area)}>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={1} /> : !data.records.length ? (
        <p className='text-muted-foreground text-sm'>No records yet.</p>
      ) : (
        <div className='flex flex-col gap-4'>
          <Table label={area.label}>
            <TableHeader>
              <TableRow>
                <TableHead>Record</TableHead>
                {area.list_columns.map((c) => <TableHead key={c}>{areaFieldLabel(area, c)}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.records.map((r) => (
                <TableRow key={r.key}>
                  <TableCell><Link className='underline-offset-4 hover:underline' href={`/${base}/records/${area.name}/${encodeURIComponent(r.key)}`}>{r.title || r.key}</Link></TableCell>
                  {area.list_columns.map((c) => <TableCell key={c}>{cell(r.data[c])}</TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className='flex gap-2'>
            {after.length > 0 && <Button variant='outline' size='sm' onClick={() => setAfter(after.slice(0, -1))}>Previous</Button>}
            {data.next && <Button variant='outline' size='sm' onClick={() => setAfter([...after, data.next!])}>Next</Button>}
          </div>
        </div>
      )}
    </PageContainer>
  );
}

export function RecordDetailPage({ area, recordKey, base }: { area: RecordAreaSpec; recordKey: string; base: 'app' | 'admin' }) {
  const url = `${recordsApi(base)}/${area.name}/${encodeURIComponent(recordKey)}`;
  const { data, error } = useOrgLoad(() => getJson<Detail>(url), [url]);
  return (
    <PageContainer pageTitle={data?.record.title || recordKey} pageDescription={`${area.label} · ${where(area)}`}>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={2} /> : (
        <div className='flex flex-col gap-6'>
          <dl className='grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[12rem_1fr]'>
            <dt className='text-muted-foreground text-sm'>Key</dt><dd className='font-mono text-sm break-all'>{data.record.key}</dd>
            {data.record.version && (<><dt className='text-muted-foreground text-sm'>Version</dt><dd className='text-sm'>{data.record.version}</dd></>)}
            {area.fields.map((f) => (
              <div key={f.name} className='contents'>
                <dt className='text-muted-foreground text-sm'>{f.label}</dt>
                <dd className='text-sm break-words whitespace-pre-wrap'>{cell(data.record.data[f.name]) || '—'}</dd>
              </div>
            ))}
          </dl>
          {data.links.map((l) => {
            const target = findRecordArea(base, l.area);
            return (
              <section key={l.field} className='flex flex-col gap-2'>
                <h2 className='text-sm font-medium'>{areaFieldLabel(area, l.field)} · {target?.label ?? l.area}</h2>
                <ul className='flex flex-col gap-1 text-sm'>
                  {l.records.map((r) => (
                    <li key={r.key}><Link className='underline-offset-4 hover:underline' href={`/${base}/records/${l.area}/${encodeURIComponent(r.key)}`}>{r.title || r.key}</Link></li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </PageContainer>
  );
}
