'use client';
// Private catalogs on /admin/keys (mold_v0-260, flag private_catalogs; src/catalog-access.ts at
// /api/admin/onboarding/catalog-access): each shared catalog the packs read from a private repository, how it is read
// (a deploy key, or the platform's GitHub App), whether its access is set, and the form to set, replace or remove it.
// A key is typed once and never shown again: staff read back its fingerprint, the host its known_hosts line names, or
// the installation's number. Shown only while the flag is on and a pack declares a private catalog.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { featureOn } from '@/config/features';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { adminApi, ApiError } from '@/lib/api-client';
import { useAdminAction } from './lib';
import { Gate } from './role';
import { ConfirmButton, FormRow, Mono, Notice, Section, StatusBadge, When } from './ui';

interface Catalog { pack: string; name: string; label: string; access: 'deploy_key' | 'github_app'; repo: string | null; host: string | null; set: boolean; hint: string | null; updated_at: string | null }
const EMPTY = { private_key: '', known_hosts: '', installation_id: '' };

export function AdminPrivateCatalogs() {
  const on = featureOn('private_catalogs');
  const { data } = useQuery<{ catalogs: Catalog[] } | null>({
    queryKey: ['admin', '/catalog-access'],
    queryFn: () => adminApi<{ catalogs: Catalog[] }>('GET', '/catalog-access').catch((e) => { if (e instanceof ApiError && e.status === 404) return null; throw e; }),
    enabled: on, staleTime: 15_000
  });
  const [open, setOpen] = useState<string | null>(null);
  const [f, setF] = useState(EMPTY);
  const save = useAdminAction((c: Catalog) => adminApi('PUT', `/catalog-access/${encodeURIComponent(c.pack)}/${encodeURIComponent(c.name)}`,
    c.access === 'deploy_key' ? { private_key: f.private_key, known_hosts: f.known_hosts } : { installation_id: f.installation_id.trim() }),
  { success: 'Access saved', invalidate: ['admin', '/catalog-access'] });
  const remove = useAdminAction((c: Catalog) => adminApi('DELETE', `/catalog-access/${encodeURIComponent(c.pack)}/${encodeURIComponent(c.name)}`), { success: 'Access removed', invalidate: ['admin', '/catalog-access'] });
  if (!on || !data?.catalogs.length) return null;
  return (
    <div className='mt-10 flex flex-col gap-10' data-private-catalogs=''>
      <Section title='Private catalogs' description='Shared catalogs indexed from a private repository, each pinned to its commit. Give each its deploy key or the GitHub App installation it is read with: they stay sealed on the server and are never shown again.'>
        <ul className='flex flex-col divide-y rounded-md border'>
          {data.catalogs.map((c) => {
            const id = `${c.pack}/${c.name}`;
            return (
              <li key={id} className='flex flex-col gap-3 p-4' data-catalog={id}>
                <div className='flex items-start justify-between gap-3'>
                  <div className='flex min-w-0 flex-1 flex-col gap-1'>
                    <span className='font-medium'>{c.label}</span>
                    <span className='text-muted-foreground text-sm break-all'>{c.repo ?? 'its upstream'} · {c.access === 'deploy_key' ? 'read with a deploy key over SSH' : 'read with the platform’s GitHub App'}</span>
                    <span className='flex flex-wrap items-center gap-2 text-sm'>
                      <StatusBadge tone={c.set ? 'ok' : 'warn'}>{c.set ? 'Set' : 'Not set'}</StatusBadge>
                      {c.hint && <Mono>{c.hint}</Mono>}
                      {c.updated_at && <span className='text-muted-foreground'>changed <When d={c.updated_at} /></span>}
                    </span>
                  </div>
                  <div className='flex shrink-0 gap-2'>
                    <Gate need='keys'><Button size='sm' variant={c.set ? 'outline' : 'default'} onClick={() => { setF(EMPTY); setOpen(open === id ? null : id); }} aria-expanded={open === id}>{c.set ? 'Replace' : 'Set'}</Button></Gate>
                    {c.set && <Gate need='keys'><ConfirmButton label='Remove' title={`Remove ${c.label}'s access?`} description='Its next index is refused until the access is set again. The rows already indexed stay.' confirmLabel='Remove' onConfirm={() => remove.mutate(c)} /></Gate>}
                  </div>
                </div>
                {!c.set && <Notice>Not indexed until its access is set.</Notice>}
                {open === id && (
                  <form className='flex flex-col gap-3' autoComplete='off' onSubmit={(e) => { e.preventDefault(); save.mutate(c, { onSuccess: () => { setF(EMPTY); setOpen(null); } }); }}>
                    {c.access === 'deploy_key' ? (<>
                      <FormRow id={`${id}-key`} label='Deploy key (its private part, the whole file)' hint='Read-only, for this repository alone, with no passphrase (ssh-keygen -t ed25519 -N ""). Add its public part to the repository as a deploy key.'>
                        <Textarea id={`${id}-key`} rows={4} spellCheck={false} className='font-mono text-xs [-webkit-text-security:disc]' value={f.private_key} onChange={(e) => setF({ ...f, private_key: e.target.value })} />
                      </FormRow>
                      <FormRow id={`${id}-kh`} label={`The host's public key (one known_hosts line${c.host ? ` for ${c.host}` : ''})`} hint={<>As <Mono>ssh-keyscan {c.host ?? '<host>'}</Mono> prints it: the host is checked on every fetch, never trusted on first use.</>}>
                        <Input id={`${id}-kh`} spellCheck={false} className='font-mono text-xs' value={f.known_hosts} onChange={(e) => setF({ ...f, known_hosts: e.target.value })} />
                      </FormRow>
                    </>) : (
                      <FormRow id={`${id}-inst`} label='Installation number' hint='The platform’s own installation of its GitHub App on the account that holds the repository: the number at the end of its address (…/settings/installations/<number>). Each fetch gets a token that reads this one repository, revoked when the fetch is done.'>
                        <Input id={`${id}-inst`} inputMode='numeric' className='w-full max-w-xs' value={f.installation_id} onChange={(e) => setF({ ...f, installation_id: e.target.value })} />
                      </FormRow>
                    )}
                    <div className='flex gap-2'>
                      <Button type='submit' size='sm' disabled={save.isPending}>Save</Button>
                      <Button type='button' size='sm' variant='outline' onClick={() => setOpen(null)}>Cancel</Button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}
