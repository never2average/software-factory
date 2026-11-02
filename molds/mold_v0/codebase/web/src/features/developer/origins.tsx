'use client';
// Settings › Developers › Allowed origins (mold_v0-201; src/developer-sessions.ts): the browser origins a client session
// (cs_..., minted by your backend for one of your users) may call this app's API from. The app's own (its pack's
// client_sessions.allowed_origins, the same for every workspace) and the workspace's, which owners add and remove here.
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Allowed, useAccountRole } from '@/features/portal/role';
import { ErrorState, fail, useOrgLoad } from '@/features/portal/shared';
import { dev, type Offer } from './api';

interface Row { origin: string; from: 'app' | 'workspace' }

export function OriginsTab({ offer }: { offer: Offer }) {
  const { data, error, reload } = useOrgLoad(() => dev<{ data: string[]; app: string[] }>('GET', '/origins'));
  const { lock, can } = useAccountRole();
  const [origin, setOrigin] = useState('');
  const [busy, setBusy] = useState(false);
  const rows = useMemo<Row[]>(() => (data ? [...data.app.map((o) => ({ origin: o, from: 'app' as const })), ...data.data.filter((o) => !data.app.includes(o)).map((o) => ({ origin: o, from: 'workspace' as const }))] : []), [data]);
  const cols: RecordCol<Row>[] = [
    { key: 'origin', label: 'Origin', title: true, keep: true, type: 'text', value: (r) => r.origin, render: (r) => <span className='font-mono text-xs'>{r.origin}</span> },
    { key: 'from', label: 'Set by', type: 'select', value: (r) => r.from, options: [{ value: 'app', label: 'This app' }, { value: 'workspace', label: 'This workspace' }],
      render: (r) => (r.from === 'app' ? <Badge variant='outline'>This app</Badge> : <Badge variant='secondary'>This workspace</Badge>) },
  ];
  const remove = (r: Row) => dev('DELETE', `/origins?origin=${encodeURIComponent(r.origin)}`).then(() => { toast.success(`Removed ${r.origin}`); return reload(); }).catch(fail);
  const add = async () => {
    setBusy(true);
    try { await dev('POST', '/origins', { origin }); toast.success(`Allowed ${origin.trim()}`); setOrigin(''); await reload(); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  if (error) return <ErrorState error={error} />;
  return (
    <div className='flex flex-col gap-6'>
      <form className='flex flex-wrap items-end gap-2' onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <Input className='w-80 font-mono text-xs' placeholder='https://app.yourcompany.com' value={origin} onChange={(e) => setOrigin(e.target.value)} aria-label='Origin to allow' disabled={!can('manage')} />
        <Allowed need='manage'><Button type='submit' size='sm' disabled={busy || !origin.trim()} data-add-origin=''>Allow origin</Button></Allowed>
        <span className='text-muted-foreground text-xs'>Scheme, host and port only (https). A client session lives at most {Math.round(offer.client_sessions.ttl_seconds / 60)} minutes and holds at most {offer.client_sessions.scopes.join(', ')}.</span>
      </form>
      <RecordView<Row>
        id='app-developer-origins' compact noun='origins' rows={rows} rowKey={(r) => r.origin} cols={cols} loading={!data}
        searchText={(r) => r.origin} searchPlaceholder='Search origins'
        filters={<span className='text-muted-foreground text-xs'>Browsers call this app&apos;s API with a client session from these origins only. A secret key is never accepted from a browser.</span>}
        actions={(r) => (r.from === 'app' ? [] : [lock({ label: 'Remove', destructive: true, onSelect: () => void remove(r) }, 'manage')])}
        empty={<p className='text-muted-foreground py-10 text-center text-sm'>No origins yet. Add the address of the web app that calls this API with a client session.</p>}
      />
    </div>
  );
}
