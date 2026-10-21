'use client';
// The shell's generic pack page (mold_v0-038): the title and description a pack declares in pack.json, and a table of
// the rows its data route returns ({ rows: [...] } or a list). A pack with a page of its own ships it under
// web/src/app/<area>/packs/<id>/, which Next routes before this one.
import PageContainer from '@/components/layout/page-container';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { PackPage as PackPageSpec } from '@/config/pack-nav.generated';
import { ErrorState, LoadingCards, useOrgLoad } from '@/features/portal/shared';
import { packDataUrl } from './registry';

type Row = Record<string, unknown>;

async function loadRows(url: string): Promise<Row[]> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as { rows?: Row[]; error?: string } | Row[];
  if (!res.ok) throw new Error((!Array.isArray(body) && body.error) || `Request failed (${res.status})`);
  return Array.isArray(body) ? body : (body.rows ?? []);
}

const cell = (v: unknown) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function PackPage({ spec }: { spec: PackPageSpec }) {
  const url = packDataUrl(spec);
  const { data, error } = useOrgLoad(() => loadRows(url), [url]);
  const columns = spec.columns.length ? spec.columns : Object.keys(data?.[0] ?? {}).map((key) => ({ key, label: key }));
  return (
    <PageContainer pageTitle={spec.title} pageDescription={spec.description ?? undefined}>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={1} /> : !data.length ? (
        <p className='text-muted-foreground text-sm'>Nothing here yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>{columns.map((c) => <TableHead key={c.key}>{c.label}</TableHead>)}</TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row, i) => (
              <TableRow key={i}>{columns.map((c) => <TableCell key={c.key}>{cell(row[c.key])}</TableCell>)}</TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageContainer>
  );
}
