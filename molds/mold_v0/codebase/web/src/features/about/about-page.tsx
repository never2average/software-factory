'use client';
// The About page (mold_v0-050; src/about-routes.ts, src/data-map.ts, src/source-offer.ts): the source offer (each upstream
// project the build runs, its licence and the exact commit's address, and the app's own source or why it is not
// offered), then the data-flow and residency statement: where the code runs, where data is stored, the credentials by
// name, where model calls go, the hosts runs may reach, and what the running server measures about itself. /app/about
// reads /api/about (a workspace's person), /admin/about reads /api/admin/about (platform staff). No value is ever shown.
import * as React from 'react';
import PageContainer from '@/components/layout/page-container';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { ErrorState, LoadingCards } from '@/features/portal/shared';

interface Row { item: string; detail: string }
interface Section { id: string; title: string; intro?: string; rows: Row[] }
interface Upstream { pack: string; pack_name: string; project: string; repo: string; commit: string; url: string; license: string | null; copyleft: boolean }
interface About {
  name: string;
  deploy: { app_id: string; target: string; source: string } | null;
  sections: Section[];
  measured: Section;
  offer: { upstreams: Upstream[]; app: { kind: 'offered'; url: string; license: string } | { kind: 'licensor_exception' } | { kind: 'not_stated' }; offered: boolean };
}

/** `code` spans and https:// addresses as elements; everything else as text (React escapes it). */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|https:\/\/[^\s,;()]+[^\s,;().])/g);
  return (
    <>
      {parts.map((p, i) => p.startsWith('`') && p.endsWith('`') && p.length > 1
        ? <code key={i} className='bg-muted rounded px-1 text-[0.85em]'>{p.slice(1, -1)}</code>
        : /^https:\/\//.test(p) ? <a key={i} href={p} className='underline underline-offset-4' rel='noreferrer noopener' target='_blank'>{p}</a> : <React.Fragment key={i}>{p}</React.Fragment>)}
    </>
  );
}

function SectionCard({ s }: { s: Section }) {
  return (
    <Card id={s.id}>
      <CardHeader>
        <CardTitle>{s.title}</CardTitle>
        {s.intro && <CardDescription>{s.intro}</CardDescription>}
      </CardHeader>
      <CardContent>
        <Table>
          <TableBody>
            {s.rows.map((r, i) => (
              <TableRow key={i}>
                <TableCell className='w-1/4 align-top font-medium whitespace-normal'><Rich text={r.item} /></TableCell>
                <TableCell className='align-top whitespace-normal'><Rich text={r.detail} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function AboutPage({ endpoint }: { endpoint: '/api/about' | '/api/admin/about' }) {
  const [data, setData] = React.useState<About | null>(null);
  const [error, setError] = React.useState<Error | null>(null);
  React.useEffect(() => {
    let live = true;
    fetch(endpoint, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`); return j as About; })
      .then((j) => { if (live) setData(j); }, (e: Error) => { if (live) setError(e); });
    return () => { live = false; };
  }, [endpoint]);
  const source = data?.sections.find((s) => s.id === 'source');
  return (
    <PageContainer pageTitle='About' pageDescription='The source code this service runs, and where its code runs, its data is kept and its model calls go.'>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={2} /> : (
        <div className='flex flex-col gap-4'>
          {source && <SectionCard s={source} />}
          {data.sections.filter((s) => s.id !== 'source').map((s) => <SectionCard key={s.id} s={s} />)}
          <SectionCard s={data.measured} />
          <p className='text-muted-foreground text-xs'>
            {data.deploy ? <>Deploy facts for {data.deploy.app_id} ({data.deploy.target}), from {data.deploy.source}. </> : 'This build carries no deploy facts. '}
            Secrets are shown by name only.
          </p>
        </div>
      )}
    </PageContainer>
  );
}
