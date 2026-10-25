'use client';
// /app/notices (mold_v0-035; src/schedule-routes.ts): the workspace's in-app notices. Once a day the shell posts one for
// each record whose due date falls within its area's window, and emails the workspace's owners a list of them.
// The same list is a section of a home tab (mold_v0-134: an overview tab's include: notices), where /app/notices leads.
import { useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ErrorState, LoadingCards, When, fail, useOrgLoad } from '@/features/portal/shared';

interface Notice { id: string; kind: 'due'; area: string; area_label: string; key: string; title: string | null; due_on: string; created_at: string; emailed: boolean; dismissed: boolean }

async function call<T>(method: string, path = ''): Promise<T> {
  const res = await fetch(`/api/notices${path}`, {
    method, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(method !== 'GET' ? { 'x-pack-request': '1' } : {}) }
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

const DESCRIPTION = 'Records due soon in this workspace. Checked once a day; owners also get them by email.';

/** The notices as a table (`limit`: the first so many, with a button for the rest), or a line saying none is due. */
function NoticesList({ limit, label }: { limit?: number; label?: string }) {
  const { data, error, reload } = useOrgLoad(() => call<{ notices: Notice[] }>('GET'));
  const [all, setAll] = useState(false);
  const dismiss = (n: Notice) => call('POST', `/${n.id}/dismiss`).then(() => { toast.success('Dismissed'); return reload(); }).catch(fail);
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingCards count={1} />;
  if (!data.notices.length) return <p className='text-muted-foreground text-sm'>Nothing is due soon.</p>;
  const shown = limit && !all ? data.notices.slice(0, limit) : data.notices;
  return (
    <div className='flex flex-col gap-2'>
      <Table label={label}>
        <TableHeader>
          <TableRow>
            <TableHead>Due</TableHead>
            <TableHead>Record</TableHead>
            <TableHead>Area</TableHead>
            <TableHead>Posted</TableHead>
            <TableHead><span className='sr-only'>Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((n) => (
            <TableRow key={n.id}>
              <TableCell className='font-mono text-sm'>{n.due_on}</TableCell>
              <TableCell>
                <a className='underline-offset-4 hover:underline' href={`/app/records/${encodeURIComponent(n.area)}/${encodeURIComponent(n.key)}`}>{n.title ?? n.key}</a>
                {n.emailed && <Badge variant='secondary' className='ml-2'>emailed</Badge>}
              </TableCell>
              <TableCell>{n.area_label}</TableCell>
              <TableCell><When d={n.created_at} /></TableCell>
              <TableCell className='text-right'><Button variant='ghost' size='sm' onClick={() => void dismiss(n)}>Dismiss<span className='sr-only'> {n.title ?? n.key}</span></Button></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {limit && data.notices.length > limit && (
        <Button variant='link' size='sm' className='self-start px-0' aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${data.notices.length}`}
        </Button>
      )}
    </div>
  );
}

export function NoticesPage() {
  return (
    <PageContainer pageTitle='Notices' pageDescription={DESCRIPTION}>
      <NoticesList label='Notices' />
    </PageContainer>
  );
}

/** The notices as a section of a home tab (mold_v0-134): the first five, then a button for the rest. */
export function DueSoonSection() {
  return (
    <section aria-labelledby='home-notices-title' data-home-section='notices' className='flex min-w-0 flex-col gap-3'>
      <div>
        <h2 id='home-notices-title' className='text-base font-semibold tracking-tight'>Due soon</h2>
        <p className='text-muted-foreground text-sm'>{DESCRIPTION}</p>
      </div>
      <NoticesList limit={5} label='Due soon' />
    </section>
  );
}
