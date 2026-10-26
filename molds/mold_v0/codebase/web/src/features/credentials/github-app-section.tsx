'use client';
// The workspace's GitHub connection on /app/credentials (mold_v0-014; src/github-app-routes.ts at /api/github-app). Shown
// only when a pack's credential field asks for a GitHub App and the platform has one set up: owners connect an
// installation (GitHub's own install page, then back here), see its account and repositories, narrow each record's runs
// to some of them, and disconnect. No token is ever shown: runs get a short-lived one each, read-only.
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Section } from '@/components/layout/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { When, fail, useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';

interface GhField { pack: string; name: string; label: string; bound_to: 'workspace' | 'asset' | 'environment'; area: string | null }
interface Installation {
  account: string; account_type: string; repository_selection: 'all' | 'selected'; repositories: string[];
  asset_repositories: Record<string, string[]>; suspended: boolean; connected_at: string | null; connected_by: string | null;
}
interface View { available: boolean; fields: GhField[]; installation: Installation | null; can_manage: boolean }

async function call<T>(method: string, path = '', body?: unknown): Promise<T | null> {
  const res = await fetch(`/api/github-app${path}`, {
    method, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(method !== 'GET' ? { 'x-pack-request': '1' } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  // Not mounted (no field asks for a GitHub App): nothing to show.
  if (res.status === 404 && method === 'GET') return null;
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, json);
  return json;
}

/** What the install's return (?github=<code>) means, in words. */
const OUTCOME: Record<string, [ok: boolean, text: string]> = {
  connected: [true, 'GitHub is connected.'],
  requested: [true, 'Your GitHub organization owner was asked to approve the app. Connect again once they have.'],
  not_owner: [false, 'Only an owner of this workspace can connect GitHub.'],
  other_workspace: [false, 'That install was started in another workspace: start it again from here.'],
  state_used: [false, 'That install link was already used or was started by someone else: start again.'],
  expired: [false, 'That install link expired (10 minutes): start again.'],
  bad_state: [false, 'That install link was not ours: start again from this page.'],
  no_user_authorization: [false, 'GitHub did not confirm who you are: the app must ask for user authorization during installation. Ask the platform staff.'],
  user_authorization_failed: [false, 'GitHub did not confirm who you are: start again.'],
  not_your_installation: [false, 'Your GitHub account cannot reach that installation.'],
  other_app: [false, 'That installation is of another app.'],
  installation_in_use: [false, 'That installation is already connected to another workspace.'],
  already_connected: [false, 'This workspace is already connected to another installation: disconnect it first.'],
  no_installation: [false, 'GitHub did not say which installation: start again.'],
  not_configured: [false, 'The platform has no GitHub App set up yet.'],
  github_unreachable: [false, 'GitHub could not be reached: try again in a minute.'],
  failed: [false, 'Connecting GitHub failed: try again.']
};

export function GithubAppSection() {
  const { data, reload } = useOrgLoad(() => call<View>('GET'));
  const [busy, setBusy] = useState(false);
  // The install's return: say what happened once, then drop it from the address.
  useEffect(() => {
    const u = new URL(window.location.href);
    const code = u.searchParams.get('github');
    if (!code) return;
    const [ok, text] = OUTCOME[code] ?? OUTCOME.failed!;
    if (ok) toast.success(text); else toast.error(text);
    u.searchParams.delete('github');
    window.history.replaceState(null, '', u.pathname + (u.search ? u.search : ''));
  }, []);
  if (!data || !data.available) return null;
  const i = data.installation;
  const connect = async () => {
    setBusy(true);
    try { const out = await call<{ url: string }>('POST', '/install'); if (out?.url) window.location.assign(out.url); }
    catch (e) { fail(e); setBusy(false); }
  };
  const disconnect = async () => {
    if (!window.confirm('Disconnect GitHub? Runs stop getting tokens at once and the app is uninstalled from your GitHub account.')) return;
    setBusy(true);
    try { await call('DELETE'); toast.success('Disconnected'); await reload(); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const areas = [...new Set(data.fields.filter((f) => f.bound_to !== 'workspace' && f.area).map((f) => f.area!))];
  return (
    <Section title='GitHub' description={<>Connect your GitHub organization instead of pasting tokens: each run gets its own short-lived, read-only token for the repositories you chose. Used by {data.fields.map((f) => f.label).join(', ')}.</>}>
      {i ? (
        <div className='flex flex-col gap-4'>
          <div className='flex flex-wrap items-center gap-2 text-sm'>
            <span>Connected to <span className='font-medium'>{i.account}</span></span>
            <Badge variant='secondary'>{i.repository_selection === 'all' ? 'All repositories' : `${i.repositories.length} selected ${i.repositories.length === 1 ? 'repository' : 'repositories'}`}</Badge>
            {i.suspended && <Badge variant='destructive'>Suspended on GitHub</Badge>}
            {i.connected_at && <span className='text-muted-foreground'>since <When d={i.connected_at} /></span>}
          </div>
          {i.repositories.length > 0 && <p className='text-muted-foreground font-mono text-xs break-words'>{i.repositories.join(' · ')}</p>}
          {areas.map((area) => <Narrowing key={area} area={area} inst={i} canManage={data.can_manage} onChanged={reload} />)}
          {data.can_manage && <div><Button variant='outline' size='sm' disabled={busy} onClick={() => void disconnect()}>Disconnect</Button></div>}
        </div>
      ) : data.can_manage ? (
        <div className='flex flex-col items-start gap-2'>
          <Button size='sm' disabled={busy} onClick={() => void connect()}>Connect GitHub</Button>
          <p className='text-muted-foreground text-xs'>Opens GitHub, where you pick the organization and repositories. Until you connect, runs use a pasted token below.</p>
        </div>
      ) : <p className='text-muted-foreground text-sm'>Not connected. An owner of this workspace connects GitHub.</p>}
    </Section>
  );
}

/** Which repositories the runs for one record get (none listed: all of the installation's). */
function Narrowing({ area, inst, canManage, onChanged }: { area: string; inst: Installation; canManage: boolean; onChanged: () => unknown }) {
  const [asset, setAsset] = useState('');
  const [repos, setRepos] = useState('');
  const [busy, setBusy] = useState(false);
  const rows = Object.entries(inst.asset_repositories).filter(([k]) => k.startsWith(`${area}/`)).map(([k, v]) => ({ key: k.slice(area.length + 1), repos: v }));
  const save = async (key: string, list: string[]) => {
    setBusy(true);
    try { await call('PUT', '/repositories', { area, asset: key, repositories: list }); toast.success(list.length ? 'Saved' : 'Every repository again'); setAsset(''); setRepos(''); await onChanged(); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <div className='flex flex-col gap-2'>
      <p className='text-sm font-medium'>Repositories per {area} record</p>
      {rows.length ? (
        <Table>
          <TableHeader><TableRow><TableHead>{area}</TableHead><TableHead>Repositories</TableHead>{canManage && <TableHead />}</TableRow></TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell className='font-mono text-sm'>{r.key}</TableCell>
                <TableCell className='font-mono text-xs'>{r.repos.join(', ')}</TableCell>
                {canManage && <TableCell className='text-right'><Button variant='ghost' size='sm' disabled={busy} onClick={() => void save(r.key, [])}>Use all</Button></TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : <p className='text-muted-foreground text-xs'>Every record's runs get all of the repositories above.</p>}
      {canManage && (
        <form className='flex flex-wrap items-end gap-2' onSubmit={(e) => { e.preventDefault(); void save(asset.trim(), repos.split(/[\s,]+/).filter(Boolean)); }}>
          <Input className='w-48' placeholder={`${area} key`} value={asset} onChange={(e) => setAsset(e.target.value)} aria-label={`${area} key`} />
          <Input className='w-80' placeholder='owner/name, owner/other' value={repos} onChange={(e) => setRepos(e.target.value)} aria-label='Repositories' />
          <Button type='submit' size='sm' variant='outline' disabled={busy || !asset.trim() || !repos.trim()}>Limit</Button>
        </form>
      )}
    </div>
  );
}
