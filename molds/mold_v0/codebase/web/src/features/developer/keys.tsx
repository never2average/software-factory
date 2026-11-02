'use client';
// Settings › Developers › API keys (mold_v0-201; src/developer-keys.ts): the workspace's keys for its own servers. A key
// is made with a name, its scopes (each of read, write and run may be narrowed to one area or run kind), an expiry or
// none, and a kind (a secret key holds any scopes; an integration key exactly one). It is shown once; the table keeps its
// first characters to tell keys apart. Rotate makes a new key with the same name and scopes and keeps the old one working
// for a grace period; Revoke stops a key at once.
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { JOB_KINDS } from '@/config/build-facts.generated';
import { recordAreas } from '@/config/pack-nav.generated';
import { Allowed, useAccountRole } from '@/features/portal/role';
import { ErrorState, FormRow, When, fail, useOrgLoad } from '@/features/portal/shared';
import { dev, type DevKey, type Offer } from './api';
import { OnceDialog, type Once } from './once';
import { NARROWABLE, SCOPE_HELP } from './words';

const EXPIRY = [
  { value: '', label: 'Never expires' }, { value: '30', label: 'In 30 days' }, { value: '90', label: 'In 90 days' },
  { value: '180', label: 'In 180 days' }, { value: '365', label: 'In a year' }
];
const GRACE = [
  { value: '0', label: 'Stop the old key now' }, { value: '1', label: 'Keep the old key for an hour' }, { value: '24', label: 'Keep the old key for a day' },
  { value: '72', label: 'Keep the old key for 3 days' }, { value: '168', label: 'Keep the old key for a week' }
];
const STATE: Record<DevKey['state'], 'secondary' | 'outline' | 'destructive'> = { active: 'secondary', expired: 'outline', revoked: 'outline' };

const onceFor = (key: string, name: string, rotated?: boolean): Once => ({
  title: rotated ? `New key for ${name}` : `Your key: ${name}`, label: 'Secret key', secret: key,
  description: 'Copy it now: it is not shown again. Keep it on your server only, in a header (Authorization: Bearer ...), never in a browser or an address.'
});

export function KeysTab({ offer }: { offer: Offer }) {
  const { data, error, reload } = useOrgLoad(() => dev<{ data: DevKey[] }>('GET', '/keys'));
  const { lock } = useAccountRole();
  const [making, setMaking] = useState(false);
  const [rotating, setRotating] = useState<DevKey | null>(null);
  const [revoking, setRevoking] = useState<DevKey | null>(null);
  const [once, setOnce] = useState<Once | null>(null);
  const cols = useMemo<RecordCol<DevKey>[]>(() => [
    { key: 'name', label: 'Name', title: true, keep: true, type: 'text', className: 'min-w-40', value: (k) => k.name,
      render: (k) => <span className='flex flex-col gap-1'><span className='font-medium'>{k.name}</span><span className='text-muted-foreground font-mono text-xs'>{k.key_prefix}…</span></span> },
    { key: 'kind', label: 'Kind', type: 'select', value: (k) => k.kind, options: [{ value: 'secret', label: 'Secret key' }, { value: 'integration', label: 'Integration' }],
      render: (k) => (k.kind === 'secret' ? 'Secret key' : 'Integration') },
    { key: 'scopes', label: 'Scopes', type: 'text', value: (k) => k.scopes.join(' '),
      render: (k) => <span className='flex flex-wrap gap-1'>{k.scopes.map((s) => <Badge key={s} variant='outline' className='font-mono'>{s}</Badge>)}</span> },
    { key: 'state', label: 'State', type: 'select', keep: true, value: (k) => k.state, options: ['active', 'expired', 'revoked'].map((v) => ({ value: v })),
      render: (k) => <Badge variant={STATE[k.state]}>{k.state}</Badge> },
    { key: 'last_used', label: 'Last used', type: 'date', value: (k) => k.last_used_at, render: (k) => <When d={k.last_used_at} /> },
    { key: 'expires', label: 'Expires', type: 'date', value: (k) => k.expires_at, render: (k) => (k.expires_at ? <When d={k.expires_at} /> : 'Never') },
    { key: 'created', label: 'Made', type: 'date', value: (k) => k.created_at, render: (k) => <When d={k.created_at} />, hidden: true },
    { key: 'version', label: 'API version', type: 'text', value: (k) => k.api_version, render: (k) => <span className='font-mono text-xs'>{k.api_version}</span>, hidden: true },
  ], []);
  if (error) return <ErrorState error={error} />;
  return (
    <>
      <RecordView<DevKey>
        id='app-developer-keys' compact noun='keys' properties rows={data?.data ?? []} rowKey={(k) => String(k.id)} cols={cols} loading={!data}
        searchText={(k) => `${k.name} ${k.key_prefix} ${k.scopes.join(' ')} ${k.state}`} searchPlaceholder='Search keys' defaultSort={[{ key: 'state', dir: 'asc' }]}
        filters={<span className='text-muted-foreground text-xs'>Keys for your own servers to call this app&apos;s API (version {offer.api_version}). Not for AI clients: those use your personal API keys.</span>}
        primary={<Allowed need='manage'><Button size='sm' onClick={() => setMaking(true)} data-new-key=''>New key</Button></Allowed>}
        actions={(k) => (k.state !== 'active' ? [] : [
          lock({ label: 'Rotate', onSelect: () => setRotating(k) }, 'manage'),
          lock({ label: 'Revoke', destructive: true, onSelect: () => setRevoking(k) }, 'manage')
        ])}
        detailTitle={(k) => k.name}
        detail={(k) => (
          <div className='flex flex-col gap-3 text-sm'>
            <p className='text-muted-foreground'>{k.kind === 'integration' ? 'An integration key holds exactly one scope.' : 'A secret key for your backend.'} Only its first characters are kept here; the key itself was shown once.</p>
            <ul className='text-muted-foreground list-disc pl-5 text-xs'>{k.scopes.map((s) => <li key={s}><span className='font-mono'>{s}</span>: {SCOPE_HELP[s.split(':')[0]!] ?? s}{s.includes(':') ? ` (${s.split(':')[1]} only)` : ''}</li>)}</ul>
            {k.state === 'active' && (
              <div className='flex flex-wrap gap-2'>
                <Allowed need='manage'><Button size='sm' variant='outline' onClick={() => setRotating(k)}>Rotate</Button></Allowed>
                <Allowed need='manage'><Button size='sm' variant='ghost' className='text-destructive hover:text-destructive' onClick={() => setRevoking(k)}>Revoke</Button></Allowed>
              </div>
            )}
          </div>
        )}
        empty={<p className='text-muted-foreground py-10 text-center text-sm'>No keys yet. Make one for each server that calls this app.</p>}
      />
      {making && <NewKeyDialog offer={offer} onClose={() => setMaking(false)} onMade={(key, name) => { setMaking(false); setOnce(onceFor(key, name)); void reload(); }} />}
      {rotating && <RotateDialog k={rotating} onClose={() => setRotating(null)} onMade={(key) => { const n = rotating.name; setRotating(null); setOnce(onceFor(key, n, true)); void reload(); }} />}
      {revoking && <RevokeDialog k={revoking} onClose={() => setRevoking(null)} onDone={() => { setRevoking(null); void reload(); }} />}
      <OnceDialog once={once} onClose={() => setOnce(null)} />
    </>
  );
}

/** The targets a narrowable scope may name: the workspace's record areas (read, write) or the run kinds (run). */
function targetsOf(base: string): { value: string; label: string }[] {
  if (base === 'run') return JOB_KINDS.map((k) => ({ value: k.name, label: k.label ?? k.name }));
  const seen = new Set<string>();
  return recordAreas.filter((a) => !seen.has(a.name) && seen.add(a.name)).map((a) => ({ value: a.name, label: a.label }));
}

function NewKeyDialog({ offer, onClose, onMade }: { offer: Offer; onClose: () => void; onMade: (key: string, name: string) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'secret' | 'integration'>('secret');
  const [on, setOn] = useState<Set<string>>(() => new Set(offer.scopes));
  const [narrow, setNarrow] = useState<Record<string, string>>({});
  const [expires, setExpires] = useState('90');
  const [busy, setBusy] = useState(false);
  const pick = (s: string, v: boolean) => setOn((cur) => {
    if (kind === 'integration') return v ? new Set([s]) : new Set();
    const n = new Set(cur); if (v) n.add(s); else n.delete(s); return n;
  });
  const scopes = offer.scopes.filter((s) => on.has(s)).map((s) => (narrow[s] ? `${s}:${narrow[s]}` : s));
  const make = async () => {
    setBusy(true);
    try {
      const r = await dev<{ key: string; data: DevKey }>('POST', '/keys', { name, kind, scopes, ...(expires ? { expires_in_days: Number(expires) } : {}) });
      onMade(r.key, r.data.name);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-lg'>
        <form className='grid gap-4' onSubmit={(e) => { e.preventDefault(); void make(); }}>
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>Name it after the server or integration that will hold it. You see the key once, right after you make it.</DialogDescription>
          </DialogHeader>
          <FormRow label='Name' htmlFor='dk-name'><Input id='dk-name' maxLength={80} required value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. Billing backend (production)' /></FormRow>
          <FormRow label='Kind' htmlFor='dk-kind' hint={kind === 'integration' ? 'An integration key holds exactly one scope: give a third-party tool only what it needs.' : 'A secret key for your own backend: any of the scopes below.'}>
            <NativeSelect id='dk-kind' value={kind} onChange={(e) => { const k = e.target.value as 'secret' | 'integration'; setKind(k); if (k === 'integration') setOn(new Set()); }}>
              <NativeSelectOption value='secret'>Secret key</NativeSelectOption>
              <NativeSelectOption value='integration'>Integration (one scope only)</NativeSelectOption>
            </NativeSelect>
          </FormRow>
          <fieldset className='grid gap-2'>
            <legend className='mb-1 text-sm font-medium'>Scopes</legend>
            {offer.scopes.map((s) => {
              const targets = NARROWABLE.has(s) ? targetsOf(s) : [];
              return (
                <div key={s} className='flex flex-wrap items-center gap-2'>
                  <label className='flex min-w-44 flex-1 items-center gap-2 text-sm'>
                    <Checkbox checked={on.has(s)} onCheckedChange={(c) => pick(s, !!c)} aria-label={`Scope ${s}`} />
                    <span className='font-mono'>{s}</span><span className='text-muted-foreground text-xs'>{SCOPE_HELP[s] ?? ''}</span>
                  </label>
                  {targets.length > 0 && on.has(s) && (
                    <NativeSelect size='sm' value={narrow[s] ?? ''} onChange={(e) => setNarrow((n) => ({ ...n, [s]: e.target.value }))} aria-label={`Narrow ${s} to`}>
                      <NativeSelectOption value=''>{s === 'run' ? 'Every run kind' : 'Every area'}</NativeSelectOption>
                      {targets.map((t) => <NativeSelectOption key={t.value} value={t.value}>{t.label} only</NativeSelectOption>)}
                    </NativeSelect>
                  )}
                </div>
              );
            })}
          </fieldset>
          <FormRow label='Expires' htmlFor='dk-expires'>
            <NativeSelect id='dk-expires' value={expires} onChange={(e) => setExpires(e.target.value)}>
              {EXPIRY.map((x) => <NativeSelectOption key={x.value} value={x.value}>{x.label}</NativeSelectOption>)}
            </NativeSelect>
          </FormRow>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Button type='submit' disabled={busy || !name.trim() || !scopes.length}>Make key</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RotateDialog({ k, onClose, onMade }: { k: DevKey; onClose: () => void; onMade: (key: string) => void }) {
  const [grace, setGrace] = useState('24');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { const r = await dev<{ key: string }>('POST', `/keys/${k.id}/rotate`, { grace_hours: Number(grace) }); toast.success(`Rotated ${k.name}`); onMade(r.key); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>Rotate {k.name}</DialogTitle>
          <DialogDescription>A new key with the same name and scopes. Put it on your server, then let the old one ({k.key_prefix}…) run out.</DialogDescription>
        </DialogHeader>
        <FormRow label='The old key' htmlFor='dk-grace'>
          <NativeSelect id='dk-grace' value={grace} onChange={(e) => setGrace(e.target.value)}>
            {GRACE.map((x) => <NativeSelectOption key={x.value} value={x.value}>{x.label}</NativeSelectOption>)}
          </NativeSelect>
        </FormRow>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>Cancel</Button>
          <Button onClick={() => void go()} disabled={busy}>Rotate</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({ k, onClose, onDone }: { k: DevKey; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>Revoke {k.name}?</DialogTitle>
          <DialogDescription>Calls with {k.key_prefix}… are refused from now on, and the client sessions it made stop working. This cannot be undone.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>Cancel</Button>
          <Button variant='destructive' disabled={busy} onClick={() => { setBusy(true); void dev('POST', `/keys/${k.id}/revoke`).then(() => { toast.success(`Revoked ${k.name}`); onDone(); }).catch(fail).finally(() => setBusy(false)); }}>Revoke</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
