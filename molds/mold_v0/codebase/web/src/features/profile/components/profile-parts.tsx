'use client';
// The profile page's shared parts (mold_v0-298), under either sign-in: the name field with its own Save and Cancel (and a
// Saved tick after), and the links to the person's own API keys and connected apps, each only where this build shows it.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icons } from '@/components/icons';
import { hiddenConsoleUrls, settingsTabs } from '@/config/pack-nav.generated';
import { profile } from '@/config/profile.generated';
import { settingsTabUrl } from '@/config/settings';

/**
 * Your name, saved only by Save (or Enter); Cancel (or Esc) puts it back. Saved shows beside it for a few seconds after,
 * so a change is never kept or lost without a word. `save` resolves when the name is stored and throws when it is not.
 */
export function NameField({ full, save }: { full: string; save: (first: string, last: string) => Promise<unknown> }) {
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (!saved) return; const t = setTimeout(() => setSaved(false), 4000); return () => clearTimeout(t); }, [saved]);
  const value = name ?? full;
  const changed = name !== null && name.trim() !== full;
  const submit = () => {
    const v = value.trim();
    if (!changed || !v) return;
    const [first, ...rest] = v.split(/\s+/);
    setBusy(true);
    save(first ?? '', rest.join(' ')).then(() => { setName(null); setSaved(true); }, () => {}).finally(() => setBusy(false));
  };
  return (
    <div className='flex flex-wrap items-center gap-2'>
      <Input value={value} onChange={(e) => { setName(e.target.value); setSaved(false); }}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setName(null); }}
        placeholder='Your name' aria-label='Your name' maxLength={120} disabled={busy} className='h-9 min-w-0 flex-1 text-base font-medium' data-profile-name='' />
      {changed && (
        <>
          <Button size='sm' onClick={submit} disabled={busy || !value.trim()} data-profile-name-save=''>{busy ? 'Saving…' : 'Save'}</Button>
          <Button size='sm' variant='outline' onClick={() => setName(null)} disabled={busy}>Cancel</Button>
        </>
      )}
      {/* mold_v0-298: the status element is always there and only its text changes, so screen readers announce Saved. */}
      <span role='status' className='text-muted-foreground flex items-center gap-1 text-sm empty:hidden' {...(!changed && saved ? { 'data-profile-name-saved': '' } : {})}>
        {!changed && saved ? <><Icons.check aria-hidden className='size-4 text-emerald-600 dark:text-emerald-400' />Saved</> : null}
      </span>
    </div>
  );
}

const shown = (url: string) => !hiddenConsoleUrls.some((h) => url === h || url.startsWith(`${h}/`));

/** Where this build keeps the person's own API keys: a tab of Settings, the page, or nowhere (turned off or hidden). */
function keysHref(): string | null {
  if ((profile as Readonly<Record<string, unknown>>).member_keys === false) return null;
  // mold_v0-298: a keys tab inside Settings is shown as the sidebar shows it (the page's own hide rule is not its rule).
  const tab = settingsTabs.find((t) => (t.kind as string) === 'keys');
  return tab ? settingsTabUrl(tab.id) : shown('/app/keys') ? '/app/keys' : null;
}

/** Your API keys and Connected apps, as rows of the profile's list; in the workspace console only, each only when shown. */
export function ProfileLinks() {
  const path = usePathname() ?? '';
  if (!path.startsWith('/app')) return null;
  const links = [
    ...(keysHref() ? [{ href: keysHref()!, label: 'API keys', what: 'Keys for tools that connect to this workspace as you' }] : []),
    ...(shown('/app/connected-apps') ? [{ href: '/app/connected-apps', label: 'Connected apps', what: 'Agents connected to this workspace as you, and how to disconnect one' }] : []),
  ];
  if (!links.length) return null;
  return (
    <>
      {links.map((l) => (
        <div key={l.href} className='flex items-center justify-between gap-4 py-3'>
          <dt className='flex flex-col gap-1'>
            <span className='text-muted-foreground leading-none'>{l.label}</span>
            <span className='text-muted-foreground text-xs'>{l.what}</span>
          </dt>
          <dd><Button variant='outline' size='sm' nativeButton={false} render={<Link href={l.href} />}>Open<Icons.arrowRight /></Button></dd>
        </div>
      ))}
    </>
  );
}
