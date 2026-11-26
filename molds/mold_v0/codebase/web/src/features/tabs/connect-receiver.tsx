'use client';
// A receiver set up where its service is connected (mold_v0-347; pack.json `tabs[].connect.services.<key>.receiver`,
// checked and resolved by scripts/gen-packs.mjs): once a service has an account in this workspace, its panel shows the
// developer surface's receiver it names (a hosting provider's request logs, say): its state (Not connected, Waiting,
// Receiving, Silent: a log drain's health, src/log-drain-health.ts; else from the sources), the address to give the
// provider (Copy), the pack's one line on where it goes, and what it feeds. Every read and write is the inbound sources'
// own (src/developer-routes.ts /api/developer/sources: every role reads, only an owner adds or removes one; its signing
// secret made and sealed by the server, shown once), and the drain's state is GET /api/log-drains/status: nothing new
// is stored and nothing crosses workspaces. Settings › Inbound webhooks no longer lists a receiver set up here.
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import type { PackTabSpec } from '@/config/pack-nav.generated';
import { ConfirmDialog } from '@/features/admin/ui';
import { dev, type Offer, type Source } from '@/features/developer/api';
import { OnceDialog, type Once } from '@/features/developer/once';
import { Allowed, useAccountRole } from '@/features/portal/role';
import { CopyButton, fail, useOrgLoad, When } from '@/features/portal/shared';
import { ToneBadge } from '@/features/records/detail-page';
import type { BadgeColor } from '@/features/records/detail-layout';
import type { Drain } from './drain-status';

export type LinkedReceiver = NonNullable<NonNullable<NonNullable<NonNullable<PackTabSpec['connect']>['services']>[string]['receiver']>>;
export type ReceiverState = 'not_connected' | 'waiting' | 'receiving' | 'silent';

const STATE: Record<ReceiverState, { label: string; color: BadgeColor }> = {
  not_connected: { label: 'Not connected', color: 'neutral' },
  waiting: { label: 'Waiting', color: 'warning' },
  receiving: { label: 'Receiving', color: 'success' },
  silent: { label: 'Silent', color: 'danger' }
};

/** The receiver's state: a log drain's own health when the server gives it, else from its sources (none, nothing yet, receiving). */
export function receiverState(sources: readonly Pick<Source, 'last_received_at' | 'disabled_at'>[], drain: Pick<Drain, 'state'> | null): ReceiverState {
  if (drain) return drain.state;
  const live = sources.filter((s) => !s.disabled_at);
  if (!live.length) return 'not_connected';
  return live.some((s) => s.last_received_at) ? 'receiving' : 'waiting';
}

const address = (s: Pick<Source, 'path'>) => (typeof window === 'undefined' ? s.path : `${window.location.origin}${s.path}`);

async function drainOf(name: string): Promise<Drain | null> {
  const res = await fetch('/api/log-drains/status', { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  return (((await res.json().catch(() => ({}))) as { drains?: Drain[] }).drains ?? []).find((d) => d.receiver === name) ?? null;
}

/** The receiver's block in a connected service's panel. */
export function ReceiverSection({ receiver }: { receiver: LinkedReceiver }) {
  const { data, error, reload } = useOrgLoad(async () => {
    const [sources, offer, drain] = await Promise.all([
      dev<{ data: Source[] }>('GET', '/sources'),
      dev<Offer>('GET', ''),
      receiver.drain ? drainOf(receiver.name).catch(() => null) : Promise.resolve(null)
    ]);
    return { sources: sources.data.filter((s) => s.receiver === receiver.name), offer: offer.receivers.find((r) => r.name === receiver.name) ?? null, drain };
  }, [receiver.name]);
  const { can } = useAccountRole();
  const [busy, setBusy] = useState(false);
  const [once, setOnce] = useState<Once | null>(null);
  const [removing, setRemoving] = useState<Source | null>(null);
  const label = receiver.label;
  const lower = label.charAt(0).toLowerCase() + label.slice(1);
  const add = async () => {
    setBusy(true);
    try {
      const r = await dev<{ data: Source & { secret: string } }>('POST', '/sources', { receiver: receiver.name, description: label });
      const { secret, ...s } = r.data;
      // The source's own signing secret, shown once (as Settings › Inbound webhooks shows it): only when the sender signs
      // with it. A receiver this app verifies with a secret its operators set on its hosting needs only the address.
      if (data?.offer?.secret === 'app') toast.success(`${label} set up: paste the address below at the provider`);
      else setOnce({ title: `${label} set up`, label: 'Signing secret', secret, extra: [{ label: 'Address', value: address(s) }],
        description: 'Give the provider this address and, as its signing secret, this secret. Copy the secret now: it is not shown again (remove this and set it up again to replace it).' });
      await reload();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const remove = async (s: Source) => {
    try { await dev('DELETE', `/sources/${encodeURIComponent(s.id)}`); toast.success(`${label} removed`); await reload(); } catch (e) { fail(e); }
  };
  if (error) return <p className='text-destructive text-sm' data-connect-receiver={receiver.name}>{label}: {error.message}</p>;
  const state = data ? receiverState(data.sources, data.drain) : null;
  const sources = data?.sources ?? [];
  return (
    <section className='flex flex-col gap-3 rounded-md border p-3' data-connect-receiver={receiver.name} aria-label={label}>
      <div className='flex flex-wrap items-center gap-2'>
        <h3 className='text-[13.5px] font-medium'>{label}</h3>
        {state && <span data-receiver-state={state}><ToneBadge color={STATE[state].color}>{STATE[state].label}</ToneBadge></span>}
      </div>
      {receiver.feeds && <p className='text-muted-foreground text-sm' data-receiver-feeds=''>{receiver.feeds}</p>}
      {!data ? <p className='text-muted-foreground text-xs'>Loading…</p> : sources.length ? (
        <>
          {sources.map((s) => (
            <div key={s.id} className='flex flex-col gap-1.5' data-receiver-source={s.id}>
              <span className='text-muted-foreground text-xs font-medium'>Address to paste at the provider</span>
              <div className='flex items-start gap-2'>
                <code className='bg-muted min-w-0 flex-1 rounded px-2 py-1.5 font-mono text-xs break-all'>{address(s)}</code>
                <CopyButton text={address(s)} />
              </div>
              <p className='text-muted-foreground text-xs'>
                {s.last_received_at ? <>Last received <When d={s.last_received_at} />{s.received ? ` · ${s.received.toLocaleString('en')} deliveries` : ''}</> : 'Nothing received yet.'}
                {data.drain?.state === 'silent' ? ` Nothing for ${data.drain.hours_since ?? data.drain.silent_hours} hours: check that the provider's drain is not paused or failing.` : ''}
              </p>
              {can('manage') && (
                <div><Button type='button' size='sm' variant='outline' className='text-destructive' onClick={() => setRemoving(s)} data-receiver-remove=''>
                  <Icons.trash aria-hidden data-icon='inline-start' />Remove</Button></div>
              )}
            </div>
          ))}
          {receiver.how && <p className='text-sm' data-receiver-how=''>{receiver.how}</p>}
        </>
      ) : (
        <>
          <p className='text-muted-foreground text-sm'>Not set up yet. Setting it up gives the address to paste at the provider{data.offer?.secret === 'app' ? '' : ' and a signing secret, shown once'}.</p>
          {receiver.how && <p className='text-sm' data-receiver-how=''>{receiver.how}</p>}
          {can('manage')
            ? <div><Allowed need='manage'><Button type='button' size='sm' disabled={busy} onClick={() => void add()} data-receiver-add=''>
                <Icons.add aria-hidden data-icon='inline-start' />{busy ? 'Setting up…' : `Set up ${lower}`}</Button></Allowed></div>
            : <p className='text-muted-foreground text-sm' data-receiver-who=''>Only workspace owners can set it up.</p>}
        </>
      )}
      <OnceDialog once={once} onClose={() => setOnce(null)} />
      {removing && (
        <ConfirmDialog open onOpenChange={(o) => { if (!o) setRemoving(null); }} destructive title={`Remove ${lower}?`}
          description='The provider’s deliveries to this address are refused from now on. What was already received stays.' confirmLabel='Remove'
          onConfirm={() => { const s = removing; setRemoving(null); void remove(s); }} />
      )}
    </section>
  );
}
