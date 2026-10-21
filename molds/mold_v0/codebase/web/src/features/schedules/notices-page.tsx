'use client';
// /app/notices (mold_v0-035; src/schedule-routes.ts): the workspace's in-app notices. Once a day the shell posts one for
// each record whose due date falls within its area's window, and emails the workspace's owners a list of them.
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

export function NoticesPage() {
  const { data, error, reload } = useOrgLoad(() => call<{ notices: Notice[] }>('GET'));
  const dismiss = (n: Notice) => call('POST', `/${n.id}/dismiss`).then(() => { toast.success('Dismissed'); return reload(); }).catch(fail);
  return (
    <PageContainer pageTitle='Notices' pageDescription='Records due soon in this workspace. Checked once a day; owners also get them by email.'>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={1} /> : !data.notices.length ? (
        <p className='text-muted-foreground text-sm'>Nothing is due soon.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Due</TableHead>
              <TableHead>Record</TableHead>
              <TableHead>Area</TableHead>
              <TableHead>Posted</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.notices.map((n) => (
              <TableRow key={n.id}>
                <TableCell className='font-mono text-sm'>{n.due_on}</TableCell>
                <TableCell>
                  <a className='underline-offset-4 hover:underline' href={`/app/records/${encodeURIComponent(n.area)}/${encodeURIComponent(n.key)}`}>{n.title ?? n.key}</a>
                  {n.emailed && <Badge variant='secondary' className='ml-2'>emailed</Badge>}
                </TableCell>
                <TableCell>{n.area_label}</TableCell>
                <TableCell><When d={n.created_at} /></TableCell>
                <TableCell className='text-right'><Button variant='ghost' size='sm' onClick={() => void dismiss(n)}>Dismiss</Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageContainer>
  );
}
