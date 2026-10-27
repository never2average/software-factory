'use client';
// The workspace's on-premises runners on /app/credentials (mold_v0-036; src/onprem-runner-routes.ts at /api/runners).
// Shown only when a kind of the build may need the workspace's private network (the API answers 404 otherwise): where
// those runs go (hosted, or on one of the workspace's own runners), each runner's health, and for owners adding a
// runner (its one-time token and install command, shown once) and revoking one, at once.
import { useState } from 'react';
import { toast } from 'sonner';
import { Section } from '@/components/layout/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CopyButton, When, fail, useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';

type Status = 'waiting_for_install' | 'enrollment_expired' | 'online' | 'offline' | 'revoked';
interface Runner {
  id: string; name: string; status: Status; created_at: string; enroll_expires_at: string | null; enrolled_at: string | null;
  revoked_at: string | null; last_seen_at: string | null; version: string | null; hostname: string | null; capacity: number | null;
  live_runs: number; allow: string[];
}
interface View {
  available: boolean; location: 'hosted' | 'on_premises'; runners: Runner[]; can_manage: boolean;
  kinds: { pack: string; name: string; label: string }[]; queued_on_premises: number;
}
interface Created { runner: Runner; enrollment_token: string; expires_at: string; command: string }

async function call<T>(method: string, path = '', body?: unknown): Promise<T | null> {
  const res = await fetch(`/api/runners${path}`, {
    method, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(method !== 'GET' ? { 'x-pack-request': '1' } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  // Not mounted (no kind needs a private network): nothing to show.
  if (res.status === 404 && method === 'GET') return null;
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, json);
  return json;
}

const STATUS: Record<Status, [label: string, variant: 'default' | 'secondary' | 'destructive' | 'outline']> = {
  online: ['Online', 'default'],
  offline: ['Offline', 'destructive'],
  waiting_for_install: ['Waiting for install', 'secondary'],
  enrollment_expired: ['Token expired', 'outline'],
  revoked: ['Revoked', 'outline']
};

export function RunnersSection() {
  const { data, reload } = useOrgLoad(() => call<View>('GET'));
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  if (!data || !data.available) return null;
  const online = data.runners.some((r) => r.status === 'online');
  const shown = data.runners;
  const add = async () => {
    setBusy(true);
    try { const out = await call<Created>('POST', '', { name: name.trim() }); setCreated(out); setName(''); await reload(); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  const revoke = async (r: Runner) => {
    if (!window.confirm(`Revoke ${r.name}? It stops at once: the runs it is carrying out stop and go back to the queue.`)) return;
    try { await call('DELETE', `/${encodeURIComponent(r.id)}`); toast.success('Revoked'); await reload(); } catch (e) { fail(e); }
  };
  const setLocation = async (location: View['location']) => {
    setBusy(true);
    try { await call('PUT', '/location', { location }); toast.success(location === 'on_premises' ? 'These runs now go to your own runner' : 'These runs now run hosted'); await reload(); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <Section title='On-premises runner' description={<>Some runs need to reach systems inside your own network ({data.kinds.map((k) => k.label).join(', ')}).
      A runner you install there connects out to this app (nothing connects in), takes only this workspace&apos;s runs, and reaches only the hosts you allow.</>}>
      <div className='flex flex-col gap-4'>
        <div className='flex flex-wrap items-center gap-2 text-sm'>
          <span>These runs go to</span>
          <Badge variant='secondary'>{data.location === 'on_premises' ? 'Your on-premises runner' : 'Hosted (default)'}</Badge>
          {data.location === 'on_premises' && !online && <Badge variant='destructive'>No runner online: they wait</Badge>}
          {data.queued_on_premises > 0 && <span className='text-muted-foreground'>{data.queued_on_premises} waiting for a runner</span>}
          {data.can_manage && (data.location === 'on_premises'
            ? <Button variant='outline' size='sm' disabled={busy} onClick={() => void setLocation('hosted')}>Run them hosted</Button>
            : <Button size='sm' disabled={busy || !online} onClick={() => void setLocation('on_premises')}>Run them on premises</Button>)}
        </div>
        {data.location === 'hosted' && !online && <p className='text-muted-foreground text-xs'>Add a runner and install it first: on premises needs one online.</p>}
        {shown.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Runner</TableHead><TableHead>Status</TableHead><TableHead>Last seen</TableHead><TableHead>Runs</TableHead><TableHead>Allowed private hosts</TableHead>
                {data.can_manage && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => (
                <TableRow key={r.id}>
                  <TableCell><span className='font-medium'>{r.name}</span>{r.hostname && <span className='text-muted-foreground block text-xs'>{r.hostname}{r.version ? ` · ${r.version}` : ''}</span>}</TableCell>
                  <TableCell><Badge variant={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge>
                    {r.status === 'waiting_for_install' && r.enroll_expires_at && <span className='text-muted-foreground block text-xs'>token until <When d={r.enroll_expires_at} /></span>}</TableCell>
                  <TableCell>{r.last_seen_at ? <When d={r.last_seen_at} /> : <span className='text-muted-foreground'>Never</span>}</TableCell>
                  <TableCell>{r.status === 'online' || r.status === 'offline' ? `${r.live_runs} of ${r.capacity ?? '?'}` : ''}</TableCell>
                  <TableCell className='font-mono text-xs break-words'>{r.allow.length ? r.allow.join(' ') : r.status === 'online' || r.status === 'offline' ? 'None' : ''}</TableCell>
                  {data.can_manage && <TableCell className='text-right'>{r.status !== 'revoked' && <Button variant='ghost' size='sm' onClick={() => void revoke(r)}>Revoke</Button>}</TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : <p className='text-muted-foreground text-sm'>No runner yet.</p>}
        {created && (
          <div className='bg-muted flex flex-col gap-2 rounded-md p-3 text-sm'>
            <p><span className='font-medium'>Install {created.runner.name}</span>: run this once on a machine inside your network that has Docker. The token works once,
              until <When d={created.expires_at} />, and is not shown again.</p>
            <pre className='overflow-x-auto font-mono text-xs whitespace-pre'>{created.command}</pre>
            <div className='flex gap-2'><CopyButton text={created.command} label='Copy the command' /><Button variant='ghost' size='sm' onClick={() => setCreated(null)}>Done</Button></div>
            <p className='text-muted-foreground text-xs'>Put the hosts and networks your runs may reach in APP_RUNNER_ALLOW (for example <code>*.corp.example 10.20.0.0/16:443|6443</code>). The guide&apos;s On-premises runner page says more.</p>
          </div>
        )}
        {data.can_manage ? (
          <form className='flex flex-wrap items-end gap-2' onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <Input className='w-64' placeholder='A name, like Data centre 1' value={name} onChange={(e) => setName(e.target.value)} aria-label='Runner name' />
            <Button type='submit' size='sm' variant='outline' disabled={busy || !name.trim()}>Add a runner</Button>
          </form>
        ) : <p className='text-muted-foreground text-xs'>An owner of this workspace adds and revokes runners.</p>}
      </div>
    </Section>
  );
}
