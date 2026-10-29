'use client';
// /app/notices (mold_v0-035; src/schedule-routes.ts): the workspace's in-app notices. Once a day the shell posts one for
// each record whose due date falls within its area's window, and emails the workspace's owners a list of them.
// The same list is a section of a home tab (mold_v0-134: an overview tab's include: notices), where /app/notices leads,
// or a card of its right column (mold_v0-172: pack.json rail notices).
import { useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Badge } from '@/components/ui/badge';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { EmptyState } from '@/features/tabs/empty';
import { ExportRowsButton } from '@/features/tabs/export';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ErrorState, LoadingCards, When, fail, useOrgLoad } from '@/features/portal/shared';
import { FloatPanel } from '@/features/portal/setup';
import { Icons } from '@/components/icons';
import { httpError } from '@/features/status/from-error';

interface Notice { id: string; kind: 'due'; area: string; area_label: string; key: string; title: string | null; due_on: string; created_at: string; emailed: boolean; dismissed: boolean }

async function call<T>(method: string, path = ''): Promise<T> {
  const res = await fetch(`/api/notices${path}`, {
    method, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(method !== 'GET' ? { 'x-pack-request': '1' } : {}) }
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, json);
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

/**
 * /app/notices as the console's database table (mold_v0-176, as on Accounts): due date, record, area, when it was posted
 * and whether it was emailed; search, filters, a pager, Export CSV; a row opens the notice beside the list with Open
 * record, and each row's menu dismisses it. Home's section and card keep their short lists (NoticesList, DueSoonCard).
 */
export function NoticesPage() {
  const { data, error, reload } = useOrgLoad(() => call<{ notices: Notice[] }>('GET'));
  const dismiss = (n: Notice) => call('POST', `/${n.id}/dismiss`).then(() => { toast.success('Dismissed'); return reload(); }).catch(fail);
  const href = (n: Notice) => `/app/records/${encodeURIComponent(n.area)}/${encodeURIComponent(n.key)}`;
  const cols: RecordCol<Notice>[] = [
    {
      key: 'record', label: 'Record', title: true, keep: true, type: 'text', className: 'min-w-56', value: (n) => n.title ?? n.key,
      render: (n) => (
        <span className='flex min-w-0 flex-col gap-1'>
          <span className='leading-snug font-medium'>{n.title ?? n.key}</span>
          {n.title && n.title !== n.key && <span className='text-muted-foreground font-mono text-xs leading-none break-all'>{n.key}</span>}
        </span>
      )
    },
    { key: 'due', label: 'Due', type: 'date', keep: true, value: (n) => n.due_on, render: (n) => <span className='font-mono text-sm'>{n.due_on}</span> },
    { key: 'area', label: 'Area', type: 'select', value: (n) => n.area_label, render: (n) => n.area_label },
    { key: 'posted', label: 'Posted', type: 'date', value: (n) => n.created_at, render: (n) => <When d={n.created_at} /> },
    { key: 'emailed', label: 'Emailed', type: 'boolean', value: (n) => n.emailed, render: (n) => (n.emailed ? 'Yes' : 'No') }
  ];
  return (
    <PageContainer pageTitle='Notices' pageDescription={DESCRIPTION}>
      {error ? <ErrorState error={error} /> : (
        <RecordView<Notice>
          id='app-notices' compact noun='notices' properties
          rows={data?.notices ?? []} rowKey={(n) => n.id} cols={cols} loading={!data}
          defaultSort={[{ key: 'due', dir: 'asc' }]}
          searchText={(n) => `${n.title ?? ''} ${n.key} ${n.area_label} ${n.due_on}`}
          searchPlaceholder='Search notices'
          primary={data?.notices.length ? <ExportRowsButton name='notices' rows={data.notices} cols={cols} /> : undefined}
          empty={<div className='sticky left-0 max-w-[min(36rem,calc(100vw-5rem))] text-left sm:mx-auto'><EmptyState id='empty-notices' empty={{
            title: 'Nothing is due soon.',
            text: 'A record shows here when its due date comes within its area\'s window. Checked once a day; owners also get them by email.',
            cta: null
          }} /></div>}
          actions={(n) => [{ label: 'Dismiss', onSelect: () => void dismiss(n) }]}
          detailTitle={(n) => n.title ?? n.key}
          detailActions={(n) => <Button variant='outline' size='sm' render={<a href={href(n)} />}>Open record</Button>}
          detail={(n) => <Button variant='ghost' size='sm' onClick={() => void dismiss(n)}>Dismiss<span className='sr-only'> {n.title ?? n.key}</span></Button>}
        />
      )}
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

/**
 * The notices as a card of the home page's right column (mold_v0-172: pack.json rail notices): the first five, each a
 * link to its record with its due date, then a button for the rest.
 */
export function DueSoonCard() {
  const { data, error } = useOrgLoad(() => call<{ notices: Notice[] }>('GET'));
  const [all, setAll] = useState(false);
  const shown = data ? (all ? data.notices : data.notices.slice(0, 5)) : [];
  return (
    <FloatPanel title='Due soon' icon={<Icons.calendar />} description='Records due soon. Checked once a day; owners also get them by email.'>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={1} /> : !data.notices.length ? <p className='text-muted-foreground text-sm'>Nothing is due soon.</p> : (
        <>
          <ul className='flex flex-col gap-0.5' aria-label='Due soon'>
            {shown.map((n) => (
              <li key={n.id}>
                <a href={`/app/records/${encodeURIComponent(n.area)}/${encodeURIComponent(n.key)}`}
                  className='hover:bg-muted/60 flex items-center gap-3 rounded-lg px-3 py-2 text-sm'>
                  <span className='min-w-0 flex-1 truncate font-medium'>{n.title ?? n.key}</span>
                  <span className='text-muted-foreground shrink-0 font-mono text-xs'>{n.due_on}</span>
                </a>
              </li>
            ))}
          </ul>
          {data.notices.length > 5 && (
            <button type='button' aria-expanded={all} onClick={() => setAll(!all)} className='text-primary self-start px-3 text-xs font-medium hover:underline'>
              {all ? 'Show fewer' : `Show all ${data.notices.length}`}
            </button>
          )}
        </>
      )}
    </FloatPanel>
  );
}
