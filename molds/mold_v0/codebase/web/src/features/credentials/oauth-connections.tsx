'use client';
// A credential field connected through OAuth on /app/credentials (mold_v0-014; src/oauth-routes.ts at /api/credential-connections): its
// connections (per slot: the workspace, a record, a record's environment), each with when its token expires and whether
// the provider still accepts it, a Connect button that opens the provider's own sign-in, and Disconnect. No token is
// ever shown: runs get the access token, refreshed before it expires.
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { When, fail } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';

export interface OAuthConnection {
  pack: string; name: string; asset: string | null; environment: string | null; provider: string; status: 'active' | 'needs_reconnect';
  expires_at: string | null; connected_by: string | null; connected_at: string | null; refreshed_at: string | null;
}
export interface OAuthView { providers: { pack: string; name: string; label: string; scopes: string[] }[]; connections: OAuthConnection[]; can_manage: boolean }
interface OAuthField { pack: string; name: string; label: string; bound_to: 'workspace' | 'asset' | 'environment'; area: string | null; environments: string[] | null; oauth?: string }

export async function oauthCall<T>(method: string, path = '', body?: unknown): Promise<T | null> {
  const res = await fetch(`/api/credential-connections${path}`, {
    method, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(method !== 'GET' ? { 'x-pack-request': '1' } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 404 && method === 'GET') return null; // no field connects through OAuth: not mounted
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, json);
  return json;
}

const OUTCOME: Record<string, [boolean, string]> = {
  connected: [true, 'Connected.'],
  denied: [false, 'The sign-in was cancelled or refused: nothing was connected.'],
  not_owner: [false, 'Only an owner of this workspace can connect.'],
  other_workspace: [false, 'That sign-in was started in another workspace: start it again from here.'],
  state_used: [false, 'That sign-in link was already used or started by someone else: start again.'],
  expired: [false, 'That sign-in took longer than 10 minutes: start again.'],
  bad_state: [false, 'That sign-in did not come from this page: start again.'],
  no_code: [false, 'The provider did not finish the sign-in: start again.'],
  token_refused: [false, 'The provider refused the sign-in code: start again.'],
  provider_unreachable: [false, 'The provider could not be reached: try again in a minute.'],
  not_configured: [false, 'The platform has not set this provider up yet.'],
  field_gone: [false, 'That credential is no longer in this workspace.'],
  failed: [false, 'Connecting failed: try again.']
};
/** The provider's return (?oauth=<code>): say what happened once, then drop it from the address. */
export function useOAuthOutcome() {
  useEffect(() => {
    const u = new URL(window.location.href);
    const code = u.searchParams.get('oauth');
    if (!code) return;
    const [ok, text] = OUTCOME[code] ?? OUTCOME.failed!;
    if (ok) toast.success(text); else toast.error(text);
    u.searchParams.delete('oauth');
    window.history.replaceState(null, '', u.pathname + u.search);
  }, []);
}

export function OAuthConnections({ f, view, onChanged }: { f: OAuthField; view: OAuthView; onChanged: () => unknown }) {
  const [asset, setAsset] = useState('');
  const [environment, setEnvironment] = useState(f.environments?.[0] ?? '');
  const [busy, setBusy] = useState(false);
  const provider = view.providers.find((p) => p.pack === f.pack && p.name === f.oauth);
  const mine = view.connections.filter((c) => c.pack === f.pack && c.name === f.name);
  const connect = async () => {
    setBusy(true);
    try {
      const out = await oauthCall<{ url: string }>('POST', '/connect', { pack: f.pack, name: f.name, ...(f.bound_to !== 'workspace' ? { asset } : {}), ...(f.bound_to === 'environment' ? { environment } : {}) });
      if (out?.url) window.location.assign(out.url);
    } catch (e) { fail(e); setBusy(false); }
  };
  const disconnect = async (c: OAuthConnection) => {
    if (!window.confirm(`Disconnect ${provider?.label ?? c.provider}? Runs stop getting its token at once.`)) return;
    try { await oauthCall('DELETE', '', { pack: c.pack, name: c.name, asset: c.asset, environment: c.environment }); toast.success('Disconnected'); await onChanged(); }
    catch (e) { fail(e); }
  };
  const label = provider?.label ?? f.oauth;
  return (
    <div className='flex flex-col gap-2'>
      <p className='text-sm'>Connect with <span className='font-medium'>{label}</span>{provider?.scopes.length ? <> <span className='text-muted-foreground'>({provider.scopes.join(', ')})</span></> : null}: runs then get its token, renewed before it expires, instead of a pasted value.</p>
      {mine.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              {f.bound_to !== 'workspace' && <TableHead>{f.area}</TableHead>}
              {f.bound_to === 'environment' && <TableHead>Environment</TableHead>}
              <TableHead>Status</TableHead>
              <TableHead>Connected</TableHead>
              {view.can_manage && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {mine.map((c) => (
              <TableRow key={`${c.asset ?? ''}/${c.environment ?? ''}`}>
                {f.bound_to !== 'workspace' && <TableCell className='font-mono text-sm'>{c.asset}</TableCell>}
                {f.bound_to === 'environment' && <TableCell>{c.environment}</TableCell>}
                <TableCell>{c.status === 'active' ? <Badge variant='secondary'>Connected</Badge> : <Badge variant='destructive'>Connect again</Badge>}</TableCell>
                <TableCell><When d={c.connected_at} /></TableCell>
                {view.can_manage && <TableCell className='text-right'><Button variant='ghost' size='sm' onClick={() => void disconnect(c)}>Disconnect</Button></TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {view.can_manage && (
        <form className='flex flex-wrap items-end gap-2' onSubmit={(e) => { e.preventDefault(); void connect(); }}>
          {f.bound_to !== 'workspace' && <Input className='w-48' placeholder={`${f.area} key`} value={asset} onChange={(e) => setAsset(e.target.value)} aria-label={`${f.area} key to connect`} />}
          {f.bound_to === 'environment' && (f.environments ? (
            <NativeSelect value={environment} onChange={(e) => setEnvironment(e.target.value)} aria-label='Environment to connect'>
              {f.environments.map((x) => <NativeSelectOption key={x} value={x}>{x}</NativeSelectOption>)}
            </NativeSelect>
          ) : <Input className='w-36' placeholder='environment' value={environment} onChange={(e) => setEnvironment(e.target.value)} aria-label='Environment to connect' />)}
          <Button type='submit' size='sm' disabled={busy || (f.bound_to !== 'workspace' && !asset.trim())}>{mine.length && f.bound_to === 'workspace' ? `Connect ${label} again` : `Connect ${label}`}</Button>
        </form>
      )}
    </div>
  );
}
