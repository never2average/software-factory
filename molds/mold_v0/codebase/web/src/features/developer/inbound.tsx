'use client';
// Settings › Developers › Inbound webhooks (mold_v0-201; src/developer-inbound.ts): sources for the receivers this app
// declares. Adding one gives its address (POST /v1/inbound/<id>) and its signing secret, shown once; the sender signs as
// Standard Webhooks does and each verified payload is written into the receiver's area. A row opens the source with its
// last deliveries (the last 24 hours: each message id, when, and what was written).
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Allowed, useAccountRole } from '@/features/portal/role';
import { CopyButton, ErrorState, FormRow, When, fail, useOrgLoad } from '@/features/portal/shared';
import { dev, type Offer, type Source, type SourceDelivery } from './api';
import { OnceDialog, type Once } from './once';

const address = (s: Pick<Source, 'path'>) => (typeof window === 'undefined' ? s.path : `${window.location.origin}${s.path}`);

export function InboundTab({ offer }: { offer: Offer }) {
  const { data, error, reload } = useOrgLoad(() => dev<{ data: Source[] }>('GET', '/sources'));
  const { lock } = useAccountRole();
  const [adding, setAdding] = useState(false);
  const [once, setOnce] = useState<Once | null>(null);
  const cols = useMemo<RecordCol<Source>[]>(() => [
    { key: 'source', label: 'Source', title: true, keep: true, type: 'text', className: 'min-w-48', value: (s) => s.description ?? s.receiver,
      render: (s) => <span className='flex flex-col gap-1'><span className='font-medium'>{s.description ?? s.receiver}</span><span className='text-muted-foreground font-mono text-xs'>{s.path}</span></span> },
    { key: 'receiver', label: 'Receiver', type: 'select', value: (s) => s.receiver, options: offer.receivers.map((r) => ({ value: r.name })), render: (s) => <span className='font-mono text-xs'>{s.receiver}</span> },
    { key: 'area', label: 'Writes into', type: 'text', value: (s) => offer.receivers.find((r) => r.name === s.receiver)?.area ?? '', render: (s) => offer.receivers.find((r) => r.name === s.receiver)?.area ?? '—' },
    { key: 'received', label: 'Received', type: 'number', value: (s) => s.received, render: (s) => s.received.toLocaleString('en') },
    { key: 'last', label: 'Last received', type: 'date', value: (s) => s.last_received_at, render: (s) => <When d={s.last_received_at} /> },
    { key: 'state', label: 'State', type: 'select', value: (s) => (s.disabled_at ? 'disabled' : 'enabled'), render: (s) => <Badge variant={s.disabled_at ? 'outline' : 'secondary'}>{s.disabled_at ? 'Disabled' : 'Enabled'}</Badge>, hidden: true },
  ], [offer]);
  const remove = (s: Source) => dev('DELETE', `/sources/${s.id}`).then(() => { toast.success('Source deleted'); return reload(); }).catch(fail);
  if (error) return <ErrorState error={error} />;
  return (
    <>
      <RecordView<Source>
        id='app-developer-sources' compact noun='sources' properties rows={data?.data ?? []} rowKey={(s) => s.id} cols={cols} loading={!data}
        searchText={(s) => `${s.description ?? ''} ${s.receiver} ${s.id}`} searchPlaceholder='Search sources'
        filters={<span className='text-muted-foreground text-xs'>Other systems send their events here, signed; each one becomes records.</span>}
        primary={<Allowed need='manage'><Button size='sm' onClick={() => setAdding(true)} data-add-source=''>Add source</Button></Allowed>}
        actions={(s) => [lock({ label: 'Delete', destructive: true, onSelect: () => void remove(s) }, 'manage')]}
        detailTitle={(s) => s.description ?? s.receiver}
        detail={(s) => <SourceDetail key={s.id} s={s} />}
        empty={<p className='text-muted-foreground py-10 text-center text-sm'>No sources yet. Add one for each system that should send its events here.</p>}
      />
      {adding && <AddSource offer={offer} onClose={() => setAdding(false)} onAdded={(s, secret) => {
        setAdding(false);
        setOnce({ title: 'Source added', label: 'Signing secret', secret, extra: [{ label: 'Address', value: address(s) }],
          description: 'Give the sender this address and secret. Copy the secret now: it is not shown again (delete the source and add another to replace it).' });
        void reload();
      }} />}
      <OnceDialog once={once} onClose={() => setOnce(null)} />
    </>
  );
}

function SourceDetail({ s }: { s: Source }) {
  const { data, error } = useOrgLoad(() => dev<{ data: SourceDelivery[] }>('GET', `/sources/${s.id}/deliveries`), [s.id]);
  return (
    <div className='flex flex-col gap-4 text-sm'>
      <div className='flex items-start gap-2'>
        <code className='bg-muted min-w-0 flex-1 rounded px-2 py-1.5 font-mono text-xs break-all'>{address(s)}</code>
        <CopyButton text={address(s)} />
      </div>
      <dl><Field label='Secret'>Shown once, when the source was added</Field></dl>
      <section className='grid gap-2' aria-label='Last deliveries'>
        <h3 className='font-medium'>Last deliveries</h3>
        {error ? <p className='text-destructive text-xs'>{error.message}</p> : !data ? <p className='text-muted-foreground text-xs'>Loading…</p>
          : !data.data.length ? <p className='text-muted-foreground text-xs'>Nothing received in the last 24 hours.</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Message</TableHead><TableHead>Written</TableHead></TableRow></TableHeader>
              <TableBody>
                {data.data.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell><When d={d.at} /></TableCell>
                    <TableCell className='max-w-40 truncate font-mono text-xs'>{d.id}</TableCell>
                    <TableCell className='text-xs'>{d.state === 'writing' ? 'Writing…' : d.skipped ? `Skipped: ${d.skipped}` : `${d.written ?? 0} record${d.written === 1 ? '' : 's'}${d.area ? ` in ${d.area}` : ''}`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        <p className='text-muted-foreground text-xs'>Payloads that failed their signature check are refused and not listed.</p>
      </section>
    </div>
  );
}

function AddSource({ offer, onClose, onAdded }: { offer: Offer; onClose: () => void; onAdded: (s: Source, secret: string) => void }) {
  const [receiver, setReceiver] = useState(offer.receivers[0]?.name ?? '');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try { const r = await dev<{ data: Source & { secret: string } }>('POST', '/sources', { receiver, description }); const { secret, ...s } = r.data; onAdded(s, secret); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form className='grid gap-4' onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <DialogHeader>
            <DialogTitle>Add source</DialogTitle>
            <DialogDescription>A sender of its own: its address and secret are this source&apos;s only.</DialogDescription>
          </DialogHeader>
          <FormRow label='Receiver' htmlFor='src-receiver' hint={offer.receivers.find((r) => r.name === receiver)?.description ?? undefined}>
            <NativeSelect id='src-receiver' value={receiver} onChange={(e) => setReceiver(e.target.value)}>
              {offer.receivers.map((r) => <NativeSelectOption key={r.name} value={r.name}>{r.name} (into {r.area})</NativeSelectOption>)}
            </NativeSelect>
          </FormRow>
          <FormRow label='Name' htmlFor='src-desc' hint='Optional: which system sends here'><Input id='src-desc' maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} /></FormRow>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Button type='submit' disabled={busy || !receiver}>Add source</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
