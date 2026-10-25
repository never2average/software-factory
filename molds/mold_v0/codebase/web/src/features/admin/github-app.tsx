'use client';
// The platform's GitHub App on /admin/keys (mold_v0-014; src/github-app-routes.ts at /api/admin/onboarding/github-app):
// what to type into GitHub's "Register new GitHub App" form, the app's settings (sealed in the key vault: secrets are
// typed once and never shown again, only which are set and the key's fingerprint), and every workspace's installation,
// with a revoke. Shown only in a build whose packs declare a credential field that asks for a GitHub App.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { adminApi, ApiError } from '@/lib/api-client';
import { useAdminAction } from './lib';
import { Gate } from './role';
import { ConfirmButton, CopyField, DataList, FormRow, Mono, Notice, Section, StatusBadge, When } from './ui';

interface Installation {
  id: number; workspace: { id: number; slug: string; name: string }; installation_id: number; account: string; account_type: string;
  repository_selection: string; repositories: number; narrowed_assets: number; suspended: boolean; connected_by: string | null;
  connected_at: string | null; removed_at: string | null; removed_reason: string | null; live_tokens: number;
}
interface GithubAppView {
  available: true;
  app: { configured: boolean; app_id: string | null; slug: string | null; client_id: string | null; set: Record<string, boolean>; private_key_fingerprint: string | null };
  setup: { homepage_url: string; callback_url: string; webhook_url: string; permissions: Record<string, string>; events: string[] };
  fields: { pack: string; name: string; label: string }[];
  installations: Installation[];
}

const EMPTY = { app_id: '', slug: '', client_id: '', client_secret: '', webhook_secret: '', private_key: '' };

export function AdminGithubApp() {
  // Not mounted (no pack asks for a GitHub App): nothing on the page.
  const { data } = useQuery<GithubAppView | null>({
    queryKey: ['admin', '/github-app'],
    queryFn: () => adminApi<GithubAppView>('GET', '/github-app').catch((e) => { if (e instanceof ApiError && e.status === 404) return null; throw e; }),
    staleTime: 15_000
  });
  const [f, setF] = useState(EMPTY);
  const save = useAdminAction(() => adminApi('PUT', '/github-app', Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim()))), { success: 'GitHub App saved' });
  const revoke = useAdminAction((org: number) => adminApi('DELETE', `/github-app/installations/${org}`), { success: 'Installation revoked' });
  if (!data) return null;
  const a = data.app;
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className='mt-10 flex flex-col gap-10'>
      <Section title='GitHub App' description={<>Workspaces connect their GitHub organization to it instead of pasting tokens ({data.fields.map((x) => x.label).join(', ')}). Each run gets a short-lived installation token that can only read the repositories the workspace chose. The private key and secrets never leave the server.</>}>
        {!a.configured && <Notice>Not set up: workspaces use pasted tokens until every setting below is saved.</Notice>}
        <div className='grid gap-6 lg:grid-cols-2'>
          <div className='flex min-w-0 flex-col gap-3'>
            <p className='text-sm font-medium'>Register the app on GitHub with these</p>
            <FormRow id='gh-home' label='Homepage URL'><CopyField value={data.setup.homepage_url} /></FormRow>
            <FormRow id='gh-cb' label='Callback URL' hint='Also tick "Request user authorization (OAuth) during installation".'><CopyField value={data.setup.callback_url} /></FormRow>
            <FormRow id='gh-hook' label='Webhook URL' hint={<>Webhook active, with a secret you make up and paste below. Events: {data.setup.events.map((e) => <Mono key={e}>{e} </Mono>)}</>}><CopyField value={data.setup.webhook_url} /></FormRow>
            <p className='text-muted-foreground text-xs'>Repository permissions: {Object.entries(data.setup.permissions).map(([k, v]) => `${k}: ${v}`).join(', ')} and nothing else. Installable by any account.</p>
          </div>
          <form className='flex min-w-0 flex-col gap-3' autoComplete='off' onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: () => setF(EMPTY) }); }}>
            <p className='text-sm font-medium'>Then paste what GitHub shows</p>
            <FormRow id='gh-app-id' label={<>App ID {a.app_id && <Mono>({a.app_id})</Mono>}</>}><Input id='gh-app-id' inputMode='numeric' value={f.app_id} onChange={set('app_id')} /></FormRow>
            <FormRow id='gh-slug' label={<>URL name, from github.com/apps/… {a.slug && <Mono>({a.slug})</Mono>}</>}><Input id='gh-slug' value={f.slug} onChange={set('slug')} /></FormRow>
            <FormRow id='gh-client' label={<>Client ID {a.client_id && <Mono>({a.client_id})</Mono>}</>}><Input id='gh-client' value={f.client_id} onChange={set('client_id')} /></FormRow>
            <FormRow id='gh-csecret' label={<>Client secret {a.set.client_secret && <StatusBadge tone='ok'>set</StatusBadge>}</>}><Input id='gh-csecret' type='password' autoComplete='new-password' value={f.client_secret} onChange={set('client_secret')} /></FormRow>
            <FormRow id='gh-wsecret' label={<>Webhook secret {a.set.webhook_secret && <StatusBadge tone='ok'>set</StatusBadge>}</>}><Input id='gh-wsecret' type='password' autoComplete='new-password' value={f.webhook_secret} onChange={set('webhook_secret')} /></FormRow>
            <FormRow id='gh-key' label={<>Private key (.pem) {a.set.private_key && <StatusBadge tone='ok'>set</StatusBadge>}</>} hint={a.private_key_fingerprint ? <>Held: <Mono>{a.private_key_fingerprint}</Mono> (GitHub shows the same beside the key)</> : 'Open the downloaded .pem file and paste all of it.'}>
              <Textarea id='gh-key' rows={3} spellCheck={false} className='font-mono text-xs [-webkit-text-security:disc]' placeholder='-----BEGIN RSA PRIVATE KEY-----' value={f.private_key} onChange={set('private_key')} />
            </FormRow>
            <div><Gate need='keys'><Button type='submit' size='sm' disabled={save.isPending || !Object.values(f).some((v) => v.trim())}>Save</Button></Gate></div>
          </form>
        </div>
      </Section>
      <Section title='GitHub installations' description='Every workspace that connected the app, live first. Revoking ends it now: its runs stop getting tokens and the app is uninstalled from that GitHub account.'>
        <DataList<Installation> rows={data.installations} noun='installations' empty='No workspace has connected GitHub yet.' cols={[
          { label: 'Workspace', render: (i) => <span className='flex flex-col'><span className='font-medium'>{i.workspace.name}</span><Mono>{i.workspace.slug}</Mono></span> },
          { label: 'GitHub account', render: (i) => <span className='flex flex-col'><span>{i.account}</span><span className='text-muted-foreground text-xs'>installation {i.installation_id}</span></span> },
          { label: 'Repositories', render: (i) => <span className='tabular-nums'>{i.repository_selection === 'all' ? `all (${i.repositories})` : i.repositories}{i.narrowed_assets ? ` · ${i.narrowed_assets} narrowed` : ''}</span> },
          { label: 'Status', render: (i) => i.removed_at
            ? <StatusBadge tone='neutral' title={i.removed_at}>{(i.removed_reason ?? 'ended').replaceAll('_', ' ')}</StatusBadge>
            : i.suspended ? <StatusBadge tone='warn'>suspended</StatusBadge> : <StatusBadge tone='ok'>live · {i.live_tokens} tokens</StatusBadge> },
          { label: 'Connected', render: (i) => <span className='flex flex-col'><When d={i.connected_at} /><span className='text-muted-foreground text-xs'>{i.connected_by?.replace(/^customer:/, '')}</span></span> },
          { label: '', className: 'text-right', render: (i) => i.removed_at ? null : (
            <Gate need='accounts'><ConfirmButton label='Revoke' variant='destructive' title={`Revoke ${i.workspace.name}'s GitHub installation?`} confirmLabel='Revoke'
              description={`Its runs stop getting tokens at once and the app is uninstalled from ${i.account}. They can connect again.`} onConfirm={() => revoke.mutate(i.workspace.id)} disabled={revoke.isPending} /></Gate>
          ) }
        ]} />
      </Section>
    </div>
  );
}
