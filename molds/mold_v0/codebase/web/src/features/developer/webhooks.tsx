'use client';
// Settings › Developers › Webhooks (mold_v0-201; src/developer-webhooks.ts, Standard Webhooks): the workspace's endpoints.
// An endpoint takes every event or the ones picked; its signing secret is shown when it is made or rotated, and read
// again only on purpose (Reveal, recorded on the endpoint and in the platform's audit). A row opens the endpoint beside
// the table: its events, its secret, a test ping, Enable again after the app disabled it (30 failed attempts in a row),
// and its delivery log: each delivery's status, attempts and next retry, with the payload (never a credential) and every
// attempt on its own peek, under four numbers with the last two weeks' sparkline.
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Allowed, useAccountRole } from '@/features/portal/role';
import { ErrorState, FormRow, When, fail, useOrgLoad } from '@/features/portal/shared';
import { dev, type Delivery, type Endpoint, type Offer } from './api';
import { OnceDialog, type Once } from './once';
import { perDay, redacted } from './words';

const DSTATUS: Record<Delivery['status'], { label: string; variant: 'secondary' | 'outline' | 'destructive' }> = {
  succeeded: { label: 'Delivered', variant: 'secondary' }, pending: { label: 'Retrying', variant: 'outline' }, failed: { label: 'Failed', variant: 'destructive' }
};
const eventsWords = (e: Endpoint) => (e.events.length ? e.events.join(', ') : 'Every event');

export function WebhooksTab({ offer }: { offer: Offer }) {
  const { data, error, reload } = useOrgLoad(() => dev<{ data: Endpoint[] }>('GET', '/webhooks'));
  const { lock } = useAccountRole();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [once, setOnce] = useState<Once | null>(null);
  const [logKick, setLogKick] = useState(0);
  const endpoints = data?.data ?? [];
  const current = endpoints.find((e) => e.id === open) ?? null;
  const cols = useMemo<RecordCol<Endpoint>[]>(() => [
    { key: 'url', label: 'Endpoint', title: true, keep: true, type: 'text', className: 'min-w-56', value: (e) => e.url,
      render: (e) => <span className='flex min-w-0 flex-col gap-1'><span className='truncate font-mono text-xs'>{e.url}</span>{e.description && <span className='text-muted-foreground text-xs'>{e.description}</span>}</span> },
    { key: 'events', label: 'Events', type: 'text', value: eventsWords, render: (e) => <span className='text-xs'>{eventsWords(e)}</span> },
    { key: 'status', label: 'Status', type: 'select', keep: true, value: (e) => e.status, options: [{ value: 'enabled', label: 'Enabled' }, { value: 'disabled', label: 'Disabled' }],
      render: (e) => <Badge variant={e.status === 'enabled' ? 'secondary' : 'destructive'}>{e.status === 'enabled' ? 'Enabled' : 'Disabled'}</Badge> },
    { key: 'failures', label: 'Failing in a row', type: 'number', value: (e) => e.failure_streak, render: (e) => (e.failure_streak ? e.failure_streak : '—') },
    { key: 'secret', label: 'Secret', type: 'date', value: (e) => e.secret_rotated_at ?? e.created_at,
      render: (e) => <span className='text-xs'>{e.secret_rotated_at ? <>rotated <When d={e.secret_rotated_at} /></> : <>made <When d={e.created_at} /></>}{e.secret_reveals ? `, revealed ${e.secret_reveals}×` : ''}</span> },
    { key: 'created', label: 'Added', type: 'date', value: (e) => e.created_at, render: (e) => <When d={e.created_at} />, hidden: true },
  ], []);
  const patch = (e: Endpoint, body: Record<string, unknown>, done: string) => dev('PATCH', `/webhooks/${e.id}`, body).then(() => { toast.success(done); return reload(); }).catch(fail);
  const reveal = (e: Endpoint) => dev<{ data: { secret: string } }>('POST', `/webhooks/${e.id}/reveal`).then((r) => {
    setOnce({ title: 'Signing secret', label: 'Signing secret', secret: r.data.secret, description: 'This reveal is recorded (when, and by whom). Verify each delivery\'s webhook-signature with it; never send it anywhere.' });
    return reload();
  }).catch(fail);
  const rotate = (e: Endpoint, grace: number) => dev<{ data: { secret: string } }>('POST', `/webhooks/${e.id}/rotate`, { grace_hours: grace }).then((r) => {
    setOnce({ title: 'New signing secret', label: 'Signing secret', secret: r.data.secret,
      description: grace ? `Deliveries are signed with both the new and the old secret for ${grace} hour${grace === 1 ? '' : 's'}: switch your receiver over within that time.` : 'Deliveries are signed with this secret only from now on.' });
    return reload();
  }).catch(fail);
  const ping = (e: Endpoint) => dev<{ data: Delivery }>('POST', `/webhooks/${e.id}/test`).then((r) => {
    const d = r.data;
    if (d.status === 'succeeded') toast.success(`Test ping delivered (${d.last_status})`); else toast.error(`Test ping not delivered: ${d.last_error ?? d.status}`);
    setLogKick((n) => n + 1);
    return reload();
  }).catch(fail);
  if (error) return <ErrorState error={error} />;
  return (
    <div className='flex flex-col gap-10'>
      <RecordView<Endpoint>
        id='app-developer-webhooks' compact noun='endpoints' properties rows={endpoints} rowKey={(e) => e.id} cols={cols} loading={!data}
        openKey={open} onOpenChange={setOpen}
        searchText={(e) => `${e.url} ${e.description ?? ''} ${eventsWords(e)} ${e.status}`} searchPlaceholder='Search endpoints'
        filters={<span className='text-muted-foreground text-xs'>Signed as Standard Webhooks. Retried for about a day; an endpoint failing 30 times in a row is disabled until you enable it again.</span>}
        primary={<Allowed need='manage'><Button size='sm' onClick={() => setAdding(true)} data-add-endpoint=''>Add endpoint</Button></Allowed>}
        actions={(e) => [
          lock({ label: 'Send test ping', onSelect: () => void ping(e), disabled: e.status !== 'enabled' }, 'manage'),
          lock({ label: 'Reveal secret', onSelect: () => void reveal(e) }, 'manage'),
          lock({ label: e.status === 'enabled' ? 'Disable' : 'Enable again', onSelect: () => void patch(e, { status: e.status === 'enabled' ? 'disabled' : 'enabled' }, e.status === 'enabled' ? 'Disabled' : 'Enabled again') }, 'manage'),
          lock({ label: 'Delete', destructive: true, separator: true, onSelect: () => void dev('DELETE', `/webhooks/${e.id}`).then(() => { toast.success('Endpoint deleted'); setOpen(null); return reload(); }).catch(fail) }, 'manage'),
        ]}
        detailTitle={(e) => <span className='font-mono text-sm break-all'>{e.url}</span>}
        detail={(e) => <EndpointDetail key={e.id} e={e} offer={offer} onPatch={patch} onReveal={reveal} onRotate={rotate} onPing={ping} />}
        empty={<p className='text-muted-foreground py-10 text-center text-sm'>No endpoints yet. Add the address on your server that should hear about changes here.</p>}
      />
      {current && <DeliveryLog key={`${current.id}:${logKick}`} e={current} />}
      {adding && <AddEndpoint offer={offer} onClose={() => setAdding(false)} onAdded={(e, secret) => {
        setAdding(false); setOpen(e.id);
        setOnce({ title: 'Endpoint added', label: 'Signing secret', secret, description: 'Copy the signing secret now: you can reveal it again later, and each reveal is recorded. Your receiver verifies every delivery\'s signature with it.' });
        void reload();
      }} />}
      <OnceDialog once={once} onClose={() => setOnce(null)} />
    </div>
  );
}

function EventPicker({ offer, value, set }: { offer: Offer; value: string[]; set: (v: string[]) => void }) {
  return (
    <fieldset className='grid gap-2'>
      <legend className='mb-1 text-sm font-medium'>Events</legend>
      <label className='flex items-center gap-2 text-sm'><Checkbox checked={!value.length} onCheckedChange={(c) => c && set([])} aria-label='Every event' />Every event, including new ones</label>
      {offer.events.map((ev) => (
        <label key={ev.name} className='flex items-start gap-2 text-sm'>
          <Checkbox className='mt-0.5' checked={value.includes(ev.name)} aria-label={ev.name}
            onCheckedChange={(c) => set(c ? [...value, ev.name] : value.filter((x) => x !== ev.name))} />
          <span><span className='font-mono text-xs'>{ev.name}</span>{(ev.description || ev.about) && <span className='text-muted-foreground block text-xs'>{ev.description || ev.about}</span>}</span>
        </label>
      ))}
    </fieldset>
  );
}

function EndpointDetail({ e, offer, onPatch, onReveal, onRotate, onPing }: {
  e: Endpoint; offer: Offer; onPatch: (e: Endpoint, b: Record<string, unknown>, done: string) => Promise<unknown>;
  onReveal: (e: Endpoint) => Promise<unknown>; onRotate: (e: Endpoint, grace: number) => Promise<unknown>; onPing: (e: Endpoint) => Promise<unknown>;
}) {
  const [events, setEvents] = useState<string[]>(e.events);
  const [url, setUrl] = useState(e.url);
  const [grace, setGrace] = useState('24');
  const changed = url !== e.url || JSON.stringify([...events].sort()) !== JSON.stringify([...e.events].sort());
  return (
    <div className='flex flex-col gap-6 text-sm'>
      {e.status === 'disabled' && (
        <div className='border-destructive/40 bg-destructive/5 flex flex-col gap-2 rounded-md border p-3' role='status'>
          <p className='text-destructive font-medium'>Disabled</p>
          {e.disabled_reason && <p className='text-muted-foreground text-xs'>{e.disabled_reason}</p>}
          <p className='text-muted-foreground text-xs'>Its deliveries wait meanwhile and go out once it is enabled again.</p>
          <div><Allowed need='manage'><Button size='sm' onClick={() => void onPatch(e, { status: 'enabled' }, 'Enabled again')} data-enable-again=''>Enable again</Button></Allowed></div>
        </div>
      )}
      <div className='flex flex-wrap gap-2'>
        <Allowed need='manage'><Button size='sm' variant='outline' disabled={e.status !== 'enabled'} onClick={() => void onPing(e)} data-test-ping=''>Send test ping</Button></Allowed>
      </div>
      <form className='grid gap-3' onSubmit={(x) => { x.preventDefault(); void onPatch(e, { url, events }, 'Saved'); }}>
        <FormRow label='Address' htmlFor={`we-url-${e.id}`}><Input id={`we-url-${e.id}`} className='font-mono text-xs' value={url} onChange={(x) => setUrl(x.target.value)} /></FormRow>
        <EventPicker offer={offer} value={events} set={setEvents} />
        <div><Allowed need='manage'><Button type='submit' size='sm' variant='outline' disabled={!changed}>Save</Button></Allowed></div>
      </form>
      <section className='grid gap-2' aria-label='Signing secret'>
        <h3 className='font-medium'>Signing secret</h3>
        <dl>
          <Field label='Last rotated'>{e.secret_rotated_at ? <When d={e.secret_rotated_at} /> : 'Never (the one it was made with)'}</Field>
          <Field label='Revealed'>{e.secret_reveals ? <>{e.secret_reveals} time{e.secret_reveals === 1 ? '' : 's'}, last <When d={e.secret_revealed_at} /></> : 'Never'}</Field>
        </dl>
        <div className='flex flex-wrap items-center gap-2'>
          <Allowed need='manage'><Button size='sm' variant='outline' onClick={() => void onReveal(e)} data-reveal-secret=''>Reveal</Button></Allowed>
          <NativeSelect size='sm' value={grace} onChange={(x) => setGrace(x.target.value)} aria-label='Keep signing with the old secret for'>
            <NativeSelectOption value='0'>Old secret stops now</NativeSelectOption>
            <NativeSelectOption value='1'>Old secret for an hour</NativeSelectOption>
            <NativeSelectOption value='24'>Old secret for a day</NativeSelectOption>
            <NativeSelectOption value='168'>Old secret for a week</NativeSelectOption>
          </NativeSelect>
          <Allowed need='manage'><Button size='sm' variant='outline' onClick={() => void onRotate(e, Number(grace))} data-rotate-secret=''>Rotate</Button></Allowed>
        </div>
        <p className='text-muted-foreground text-xs'>Revealing is recorded, with who and when.</p>
      </section>
    </div>
  );
}

function AddEndpoint({ offer, onClose, onAdded }: { offer: Offer; onClose: () => void; onAdded: (e: Endpoint, secret: string) => void }) {
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try { const r = await dev<{ data: Endpoint & { secret: string } }>('POST', '/webhooks', { url, description, events }); const { secret, ...e } = r.data; onAdded(e, secret); }
    catch (x) { fail(x); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-lg'>
        <form className='grid gap-4' onSubmit={(x) => { x.preventDefault(); void add(); }}>
          <DialogHeader>
            <DialogTitle>Add endpoint</DialogTitle>
            <DialogDescription>An https address on your server. Each event is POSTed to it, signed; it answers 2xx within 15 seconds.</DialogDescription>
          </DialogHeader>
          <FormRow label='Address' htmlFor='we-url'><Input id='we-url' required className='font-mono text-xs' placeholder='https://api.yourcompany.com/webhooks' value={url} onChange={(x) => setUrl(x.target.value)} /></FormRow>
          <FormRow label='Description' htmlFor='we-desc' hint='Optional'><Input id='we-desc' maxLength={300} value={description} onChange={(x) => setDescription(x.target.value)} /></FormRow>
          <EventPicker offer={offer} value={events} set={setEvents} />
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Button type='submit' disabled={busy || !url.trim()}>Add endpoint</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** At most this many deliveries in the log (the newest). */
const LOG_MAX = 1000;
async function loadDeliveries(id: string): Promise<{ rows: Delivery[]; more: boolean }> {
  const rows: Delivery[] = [];
  let after: string | null = null;
  for (;;) {
    const page: { data: Delivery[]; next: string | null } = await dev('GET', `/webhooks/${id}/deliveries?limit=200${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    rows.push(...page.data);
    if (!page.next || rows.length >= LOG_MAX) return { rows, more: !!page.next };
    after = page.next;
  }
}

function DeliveryLog({ e }: { e: Endpoint }) {
  const { data, error, reload } = useOrgLoad(() => loadDeliveries(e.id), [e.id]);
  const rows = data?.rows ?? [];
  const cols = useMemo<RecordCol<Delivery>[]>(() => [
    { key: 'at', label: 'When', title: true, keep: true, type: 'date', value: (d) => d.created_at, render: (d) => new Date(d.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' }) },
    { key: 'event', label: 'Event', type: 'select', value: (d) => d.event_type, render: (d) => <span className='font-mono text-xs'>{d.event_type}</span> },
    { key: 'status', label: 'Status', type: 'select', keep: true, value: (d) => d.status, options: (['succeeded', 'pending', 'failed'] as const).map((v) => ({ value: v, label: DSTATUS[v].label })),
      render: (d) => <Badge variant={DSTATUS[d.status].variant}>{DSTATUS[d.status].label}</Badge> },
    { key: 'attempts', label: 'Attempts', type: 'number', value: (d) => d.attempts, render: (d) => d.attempts },
    { key: 'answer', label: 'Answer', type: 'text', value: (d) => (d.last_status ? String(d.last_status) : d.last_error ?? ''),
      render: (d) => (d.last_status ? <span className='font-mono text-xs'>{d.last_status}</span> : <span className='text-muted-foreground text-xs'>{d.last_error ?? '—'}</span>) },
    { key: 'next', label: 'Next retry', type: 'date', value: (d) => d.next_attempt_at, render: (d) => (d.next_attempt_at ? <When d={d.next_attempt_at} /> : '—') },
    { key: 'id', label: 'Message id', type: 'text', value: (d) => d.id, render: (d) => <span className='font-mono text-xs'>{d.id}</span>, hidden: true },
  ], []);
  const summary = useMemo(() => {
    if (!data) return null;
    const ok = rows.filter((d) => d.status === 'succeeded').length, failed = rows.filter((d) => d.status === 'failed').length;
    const recent = rows.filter((d) => Date.parse(d.created_at) > Date.now() - 14 * 86_400_000);
    const done = rows.filter((d) => d.status !== 'pending').length;
    return (
      <StatStrip quad items={[
        { label: 'Deliveries, 14 days', value: recent.length, spark: perDay(recent.map((d) => d.created_at)), said: `${recent.length} deliveries in the last 14 days` },
        { label: 'Delivered', value: done ? `${Math.round((ok / done) * 100)}%` : '—', spark: perDay(rows.filter((d) => d.status === 'succeeded').map((d) => d.delivered_at ?? d.created_at)) },
        { label: 'Retrying', value: rows.filter((d) => d.status === 'pending').length },
        { label: 'Failed', value: failed, spark: perDay(rows.filter((d) => d.status === 'failed').map((d) => d.created_at)) },
      ]} />
    );
  }, [data, rows]);
  if (error) return <ErrorState error={error} />;
  return (
    <section className='flex flex-col gap-3' aria-label='Delivery log' data-delivery-log={e.id}>
      <div className='flex flex-wrap items-end justify-between gap-2'>
        <div className='min-w-0'>
          <h2 className='text-base font-semibold tracking-tight'>Delivery log</h2>
          <p className='text-muted-foreground truncate text-sm'>Every delivery to <span className='font-mono text-xs'>{e.url}</span>, newest first. Open one for its payload and attempts.</p>
        </div>
        <Button size='sm' variant='outline' onClick={() => void reload()}>Refresh</Button>
      </div>
      <RecordView<Delivery>
        id='app-developer-deliveries' compact noun='deliveries' properties rows={rows} rowKey={(d) => d.id} cols={cols} loading={!data}
        summary={summary}
        searchText={(d) => `${d.id} ${d.event_type} ${d.status} ${d.last_status ?? ''} ${d.last_error ?? ''}`} searchPlaceholder='Search deliveries'
        defaultSort={[{ key: 'at', dir: 'desc' }]}
        filters={data?.more ? <span className='text-muted-foreground text-xs'>The latest {LOG_MAX.toLocaleString('en')} deliveries</span> : undefined}
        detailTitle={(d) => <span className='font-mono text-sm'>{d.event_type}</span>}
        detail={(d) => (
          <div className='flex flex-col gap-4 text-sm'>
            <section className='grid gap-1' aria-label='Attempts'>
              <h3 className='font-medium'>Attempts</h3>
              {d.attempt_log.length ? (
                <ol className='grid gap-1 text-xs'>
                  {d.attempt_log.map((a, i) => (
                    <li key={i} className='flex flex-wrap gap-x-3'>
                      <span className='text-muted-foreground'>{i + 1}.</span>
                      <span>{new Date(a.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' })}</span>
                      <span className={a.error ? 'text-destructive' : ''}>{a.status ?? 'no answer'}{a.error ? `: ${a.error}` : ''}</span>
                      <span className='text-muted-foreground'>{a.ms} ms</span>
                    </li>
                  ))}
                </ol>
              ) : <p className='text-muted-foreground text-xs'>Not sent yet.</p>}
              {d.next_attempt_at && <p className='text-muted-foreground text-xs'>Next attempt <When d={d.next_attempt_at} />.</p>}
            </section>
            <section className='grid gap-1' aria-label='Payload'>
              <h3 className='font-medium'>Payload</h3>
              <pre className='bg-muted max-h-96 overflow-auto rounded p-3 font-mono text-xs whitespace-pre-wrap break-all' data-payload-preview=''>{JSON.stringify(redacted(d.payload), null, 2)}</pre>
              <p className='text-muted-foreground text-xs'>As it was sent; its signature headers are not shown.</p>
            </section>
          </div>
        )}
        empty={<p className='text-muted-foreground py-10 text-center text-sm'>No deliveries yet. Send a test ping to see one here.</p>}
      />
    </section>
  );
}
