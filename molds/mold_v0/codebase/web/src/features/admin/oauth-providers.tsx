'use client';
// The packs' OAuth providers on /admin/keys (mold_v0-014; src/oauth-routes.ts at /api/admin/onboarding/oauth): for each,
// the key-vault labels its client id and secret go under (provider "OAuth clients", Add a key above) and whether they are
// set, the redirect address to register with the provider, and every workspace's connection with a remove. Shown only
// when a pack's credential field connects through one.
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminApi, ApiError } from '@/lib/api-client';
import { useAdminAction } from './lib';
import { Gate } from './role';
import { ConfirmButton, copyText, DataList, Mono, Section, StatusBadge, When } from './ui';

interface Provider { pack: string; name: string; label: string; authorize_host: string; scopes: string[]; client_id_label: string; client_secret_label: string; set: { client_id: boolean; client_secret: boolean } }
interface Connection { id: number; workspace: { id: number; slug: string; name: string }; pack: string; name: string; asset: string | null; environment: string | null;
  provider: string; status: string; expires_at: string | null; connected_by: string | null; connected_at: string | null; refreshed_at: string | null; last_error: string | null }
interface View { redirect_uri: string; providers: Provider[]; connections: Connection[] }

export function AdminOAuthProviders() {
  const { data } = useQuery<View | null>({
    queryKey: ['admin', '/oauth'],
    queryFn: () => adminApi<View>('GET', '/oauth').catch((e) => { if (e instanceof ApiError && e.status === 404) return null; throw e; }),
    staleTime: 15_000
  });
  const remove = useAdminAction((id: number) => adminApi('DELETE', `/oauth/connections/${id}`), { success: 'Connection removed' });
  if (!data) return null;
  return (
    <div className='mt-10 flex flex-col gap-10'>
      <Section title='OAuth providers' description='Workspaces connect these instead of pasting tokens; runs get the access token, renewed before it expires. Register this redirect address with each provider, then add its client id and secret above under "OAuth clients" with the labels shown.'>
        <div className='flex max-w-2xl gap-2'>
          <Input readOnly aria-label='Redirect address' value={data.redirect_uri} className='font-mono text-xs' onFocus={(e) => e.currentTarget.select()} />
          <Button type='button' variant='outline' onClick={() => copyText(data.redirect_uri)}>Copy</Button>
        </div>
        <DataList<Provider> rows={data.providers} noun='providers' empty='No provider.' cols={[
          { label: 'Provider', render: (p) => <span className='flex flex-col'><span className='font-medium'>{p.label}</span><Mono>{p.authorize_host}</Mono></span> },
          { label: 'Scopes', render: (p) => <Mono>{p.scopes.join(' ') || '—'}</Mono> },
          { label: 'Client id label', render: (p) => <span className='flex items-center gap-2'><Mono>{p.client_id_label}</Mono>{p.set.client_id ? <StatusBadge tone='ok'>set</StatusBadge> : <StatusBadge tone='warn'>missing</StatusBadge>}</span> },
          { label: 'Client secret label', render: (p) => <span className='flex items-center gap-2'><Mono>{p.client_secret_label}</Mono>{p.set.client_secret ? <StatusBadge tone='ok'>set</StatusBadge> : <StatusBadge tone='warn'>missing</StatusBadge>}</span> }
        ]} />
      </Section>
      <Section title='OAuth connections' description='Every workspace connection. Removing one stops its token at once and tells the provider; the workspace can connect again.'>
        <DataList<Connection> rows={data.connections} noun='connections' empty='No workspace has connected one yet.' cols={[
          { label: 'Workspace', render: (c) => <span className='flex flex-col'><span className='font-medium'>{c.workspace.name}</span><Mono>{c.workspace.slug}</Mono></span> },
          { label: 'Credential', render: (c) => <span className='flex flex-col'><Mono>{c.pack}/{c.name}</Mono><span className='text-muted-foreground text-xs'>{[c.asset, c.environment].filter(Boolean).join(' · ') || 'workspace'}</span></span> },
          { label: 'Status', render: (c) => c.status === 'active' ? <StatusBadge tone='ok'>active</StatusBadge> : <StatusBadge tone='warn' title={c.last_error ?? undefined}>needs reconnect</StatusBadge> },
          { label: 'Token expires', render: (c) => c.expires_at ? <When d={c.expires_at} /> : <span className='text-muted-foreground'>never</span> },
          { label: 'Connected', render: (c) => <span className='flex flex-col'><When d={c.connected_at} /><span className='text-muted-foreground text-xs'>{c.connected_by?.replace(/^customer:/, '')}</span></span> },
          { label: '', className: 'text-right', render: (c) => (
            <Gate need='accounts'><ConfirmButton label='Remove' variant='destructive' title={`Remove ${c.workspace.name}'s connection?`} confirmLabel='Remove'
              description='Its runs stop getting the token at once and the provider is told. They can connect again.' onConfirm={() => remove.mutate(c.id)} disabled={remove.isPending} /></Gate>
          ) }
        ]} />
      </Section>
    </div>
  );
}
