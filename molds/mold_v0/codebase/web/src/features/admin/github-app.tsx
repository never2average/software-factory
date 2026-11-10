'use client';
// The platform's GitHub App on /admin/keys (mold_v0-014; src/github-app-routes.ts at /api/admin/onboarding/github-app).
// mold_v0-288: one row of the Key vault's providers (./keyvault.tsx); its side panel holds what to type into GitHub's
// "Register new GitHub App" form, the app's settings (sealed in the key vault: secrets are typed once and never shown
// again, only which are set and the key's fingerprint). mold_v0-293: every workspace's installation, with a revoke, is a
// modal from the panel's ⋯ menu (Installations), not a list in the panel. There only in a build whose packs declare a
// credential field that asks for a GitHub App.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Icons } from '@/components/icons';
import { downloadCsv, today } from '@/lib/csv';
import { adminApi, ApiError } from '@/lib/api-client';
import { useAdminAction } from './lib';
import { usePanelGuard } from '@/components/layout/detail-panel';
import { Gate } from './role';
import { ConfirmButton, copyText, DataList, FormRow, Mono, StatusBadge, When } from './ui';

interface Installation {
  id: number; workspace: { id: number; slug: string; name: string }; installation_id: number; account: string; account_type: string;
  repository_selection: string; repositories: number; narrowed_assets: number; suspended: boolean; connected_by: string | null;
  connected_at: string | null; removed_at: string | null; removed_reason: string | null; live_tokens: number;
}
export interface GithubAppView {
  available: true;
  app: { configured: boolean; app_id: string | null; slug: string | null; client_id: string | null; set: Record<string, boolean>; private_key_fingerprint: string | null };
  setup: { homepage_url: string; callback_url: string; webhook_url: string; permissions: Record<string, string>; events: string[] };
  fields: { pack: string; name: string; label: string }[];
  installations: Installation[];
}

const EMPTY = { app_id: '', slug: '', client_id: '', client_secret: '', webhook_secret: '', private_key: '' };

/** The app's settings and installations; null while it loads and in a build where it is not mounted (no pack asks for a GitHub App). */
export function useGithubApp() {
  return useQuery<GithubAppView | null>({
    queryKey: ['admin', '/github-app'],
    queryFn: () => adminApi<GithubAppView>('GET', '/github-app').catch((e) => { if (e instanceof ApiError && e.status === 404) return null; throw e; }),
    staleTime: 15_000
  }).data ?? null;
}

/** The workspaces with the app connected now (ended installations are listed behind the modal's filter, and are not counted). */
export const liveInstallations = (data: GithubAppView) => data.installations.filter((i) => !i.removed_at).length;

/** The GitHub App row's side panel: one flat card of numbered steps (the installations: its ⋯ menu's modal). */
export function GithubAppPanel({ data }: { data: GithubAppView }) {
  const [f, setF] = useState(EMPTY);
  usePanelGuard(Object.values(f).some((v) => v.trim()), 'the GitHub App settings you typed');
  const save = useAdminAction(() => adminApi('PUT', '/github-app', Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim()))), { success: 'GitHub App saved' });
  const a = data.app;
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className='flex min-w-0 flex-col gap-6 text-sm'>
      <p className='text-muted-foreground'>
        Workspaces connect their GitHub organization to it instead of pasting tokens{data.fields.length ? ` (${data.fields.map((x) => x.label).join(', ')})` : ''}. Each run gets a short-lived installation token that can only read the repositories the workspace chose. The private key and secrets never leave the server.
        {!a.configured && ' Not set up: workspaces use pasted tokens until every setting below is saved.'}
      </p>
      <ol className='flex list-decimal flex-col gap-6 pl-5'>
        <li className='pl-1'>
          <div className='flex min-w-0 flex-col gap-3'>
            <p className='font-medium'>Register the app on GitHub with these</p>
            <FormRow id='gh-home' label='Homepage URL'><Copyable id='gh-home' value={data.setup.homepage_url} /></FormRow>
            <FormRow id='gh-cb' label='Callback URL' hint='Also tick "Request user authorization (OAuth) during installation".'><Copyable id='gh-cb' value={data.setup.callback_url} /></FormRow>
            <FormRow id='gh-hook' label='Webhook URL' hint={<>Webhook active, with a secret you make up and paste below. Events: {data.setup.events.map((e) => <Mono key={e}>{e} </Mono>)}</>}><Copyable id='gh-hook' value={data.setup.webhook_url} /></FormRow>
            <p className='text-muted-foreground text-xs'>Repository permissions: {Object.entries(data.setup.permissions).map(([k, v]) => `${k}: ${v}`).join(', ')} and nothing else. Installable by any account.</p>
          </div>
        </li>
        <li className='pl-1'>
          <form className='flex min-w-0 flex-col gap-3' autoComplete='off' onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: () => setF(EMPTY) }); }}>
            <p className='font-medium'>Then paste what GitHub shows</p>
            <FormRow id='gh-app-id' label={<>App ID {a.app_id && <Mono>({a.app_id})</Mono>}</>}><Input id='gh-app-id' inputMode='numeric' value={f.app_id} onChange={set('app_id')} /></FormRow>
            <FormRow id='gh-slug' label={<>URL name, from github.com/apps/… {a.slug && <Mono>({a.slug})</Mono>}</>}><Input id='gh-slug' value={f.slug} onChange={set('slug')} /></FormRow>
            <FormRow id='gh-client' label={<>Client ID {a.client_id && <Mono>({a.client_id})</Mono>}</>}><Input id='gh-client' value={f.client_id} onChange={set('client_id')} /></FormRow>
            <FormRow id='gh-csecret' label={<>Client secret {a.set.client_secret && <StatusBadge tone='ok'>set</StatusBadge>}</>}><Input id='gh-csecret' type='password' autoComplete='new-password' value={f.client_secret} onChange={set('client_secret')} /></FormRow>
            <FormRow id='gh-wsecret' label={<>Webhook secret {a.set.webhook_secret && <StatusBadge tone='ok'>set</StatusBadge>}</>}><Input id='gh-wsecret' type='password' autoComplete='new-password' value={f.webhook_secret} onChange={set('webhook_secret')} /></FormRow>
            <FormRow id='gh-key' label={<>Private key (.pem) {a.set.private_key && <StatusBadge tone='ok'>set</StatusBadge>}</>} hint={a.private_key_fingerprint ? <>Held: <Mono>{a.private_key_fingerprint}</Mono> (GitHub shows the same beside the key)</> : 'Open the downloaded .pem file and paste all of it.'}>
              <Textarea id='gh-key' rows={3} spellCheck={false} className='font-mono text-xs [-webkit-text-security:disc]' placeholder='Paste the whole .pem file the GitHub App gave you' value={f.private_key} onChange={set('private_key')} />
            </FormRow>
            <div><Gate need='keys'><Button type='submit' size='sm' disabled={save.isPending || !Object.values(f).some((v) => v.trim())}>Save</Button></Gate></div>
          </form>
        </li>
      </ol>
    </div>
  );
}

type Show = 'active' | 'ended' | 'all';
const SHOW: readonly (readonly [Show, string])[] = [['active', 'Active'], ['ended', 'Ended'], ['all', 'All']];
const statusOf = (i: Installation) => (i.removed_at ? (i.removed_reason ?? 'ended').replaceAll('_', ' ') : i.suspended ? 'suspended' : 'live');

/**
 * Every workspace's installation (mold_v0-293), from the GitHub App panel's ⋯ menu: the standard list (search, the
 * Show filter, Export, then the table), active ones by default, ended ones behind the filter; Revoke on each live one.
 */
export function GithubInstallationsDialog({ data, open, onOpenChange }: { data: GithubAppView; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [q, setQ] = useState('');
  const [show, setShow] = useState<Show>('active');
  const revoke = useAdminAction((org: number) => adminApi('DELETE', `/github-app/installations/${org}`), { success: 'Installation revoked' });
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = data.installations
    .filter((i) => (show === 'all' ? true : show === 'ended' ? !!i.removed_at : !i.removed_at))
    .filter((i) => { const t = `${i.workspace.name} ${i.workspace.slug} ${i.account} ${i.installation_id} ${statusOf(i)} ${i.connected_by ?? ''}`.toLowerCase(); return words.every((w) => t.includes(w)); });
  const exportRows = () => downloadCsv(`github-app-installations-${today()}.csv`, ['Workspace', 'Slug', 'GitHub account', 'Installation', 'Repositories', 'Status', 'Connected', 'Connected by'],
    rows.map((i) => [i.workspace.name, i.workspace.slug, i.account, i.installation_id, i.repository_selection === 'all' ? `all (${i.repositories})` : i.repositories, statusOf(i), i.connected_at, i.connected_by?.replace(/^customer:/, '') ?? '']));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[85dvh] flex-col gap-3 sm:max-w-4xl' data-testid='github-installations'>
        <DialogHeader>
          <DialogTitle>Installations</DialogTitle>
          <DialogDescription>Every workspace that connected the GitHub App. Revoking ends it now: its runs stop getting tokens and the app is uninstalled from that GitHub account.</DialogDescription>
        </DialogHeader>
        <div className='flex flex-wrap items-center gap-2'>
          <div className='relative min-w-48 flex-1'>
            <Icons.search className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
            <Input type='search' value={q} onChange={(e) => setQ(e.target.value)} placeholder='Search workspaces and GitHub accounts' aria-label='Search workspaces and GitHub accounts' className='h-9 pl-8' />
          </div>
          <NativeSelect aria-label='Show' value={show} onChange={(e) => setShow(e.target.value as Show)} data-installations-show=''>
            {SHOW.map(([v, l]) => <NativeSelectOption key={v} value={v}>{l}</NativeSelectOption>)}
          </NativeSelect>
          <Button variant='ghost' size='icon' aria-label='Export CSV' title={`Export CSV (${rows.length} rows)`} onClick={exportRows} disabled={!rows.length}><Icons.download /></Button>
        </div>
        <div className='min-h-0 overflow-y-auto'>
          <DataList<Installation> rows={rows} noun='installations' minWidth={640} empty={q || show !== 'active' ? 'No installation matches.' : 'No workspace has GitHub connected now.'} cols={[
            { label: 'Workspace', render: (i) => <span className='flex flex-col'><span className='font-medium'>{i.workspace.name}</span><Mono>{i.workspace.slug}</Mono></span> },
            { label: 'GitHub account', render: (i) => <span className='flex flex-col'><span>{i.account}</span><span className='text-muted-foreground text-xs'>installation {i.installation_id}</span></span> },
            { label: 'Repositories', className: 'text-right', render: (i) => <span className='tabular-nums'>{i.repository_selection === 'all' ? `all (${i.repositories})` : i.repositories}{i.narrowed_assets ? <span className='text-muted-foreground block text-xs'>{i.narrowed_assets} narrowed</span> : null}</span> },
            { label: 'Connected', render: (i) => <span className='flex flex-col items-start gap-0.5'>{i.removed_at
              ? <StatusBadge tone='neutral' title={i.removed_at}>{statusOf(i)}</StatusBadge>
              : i.suspended ? <StatusBadge tone='warn'>suspended</StatusBadge> : <StatusBadge tone='ok'>live · {i.live_tokens} tokens</StatusBadge>}
              <When d={i.connected_at} /><span className='text-muted-foreground text-xs'>{i.connected_by?.replace(/^customer:/, '')}</span></span> },
            { label: '', className: 'text-right', render: (i) => i.removed_at ? null : (
              <Gate need='accounts'><ConfirmButton label='Revoke' variant='destructive' title={`Revoke ${i.workspace.name}'s GitHub installation?`} confirmLabel='Revoke'
                description={`Its runs stop getting tokens at once and the app is uninstalled from ${i.account}. They can connect again.`} onConfirm={() => revoke.mutate(i.workspace.id)} disabled={revoke.isPending} /></Gate>
            ) }
          ]} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A read-only address with a Copy button, labelled by its FormRow (the input carries the row's id). */
function Copyable({ id, value }: { id: string; value: string }) {
  return (
    <div className='flex gap-2'>
      <Input id={id} readOnly value={value} className='font-mono text-xs' onFocus={(e) => e.currentTarget.select()} />
      <Button type='button' variant='outline' onClick={() => copyText(value)}>Copy</Button>
    </div>
  );
}
