'use client';
// /app/keys (mold_v0-007; src/member-keys.ts): a person's own MCP keys for clients that send a header instead of
// signing in. Each is named, expires, is shown once (with each client's exact setup, the key in a header, never in an
// address) and can be revoked at any time. A key acts with its person's role. Owners also see and revoke every key of
// the workspace, the older ones included.
import { useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Section } from '@/components/layout/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CopyButton, ErrorState, LoadingCards, When, fail, useOrgLoad } from '@/features/portal/shared';

interface Key {
  id: number; name: string; key_prefix: string; kind: 'member' | 'person' | 'account'; user_id: string | null;
  created_at: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null;
  state: 'active' | 'expired' | 'revoked'; owner_label?: string;
}
interface Keys { me: string; can_manage_all: boolean; expiry_days: number[]; keys: Key[]; all?: Key[] }
interface SetupClient { id: string; client: string; group: 'chat' | 'agent' | 'editor'; auth: 'token' | 'oauth'; steps: string; command: string | null; file: string | null; snippet: string | null }
interface Created extends Key { key: string; setup: { name: string; url: string; clients: SetupClient[] } }

async function call<T>(method: string, path = '', body?: unknown): Promise<T> {
  const res = await fetch(`/api/keys${path}`, {
    method, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-pack-request': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

const KIND: Record<Key['kind'], string> = { member: 'Personal key', person: 'Older personal key', account: 'Workspace key' };

export function KeysPage() {
  const { data, error, reload } = useOrgLoad(() => call<Keys>('GET'));
  const [created, setCreated] = useState<Created | null>(null);
  return (
    <PageContainer pageTitle='API keys' pageDescription='Keys for AI clients that send a key instead of signing in. A key acts as you, with your role, and works only in a header.'>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={2} /> : (
        <div className='flex flex-col gap-10'>
          <NewKey days={data.expiry_days} onCreated={(c) => { setCreated(c); void reload(); }} />
          {created && <Setup created={created} onDone={() => setCreated(null)} />}
          <Section title='Your keys' description='Revoke a key you no longer use: it stops working on its next call.'>
            <KeyTable keys={data.keys} canRevoke={() => true} onChanged={reload} />
          </Section>
          {data.can_manage_all && data.all && (
            <Section title='Every key in this workspace' description='As an owner you see every key and can revoke any of them, the older ones included.'>
              <KeyTable keys={data.all} showOwner canRevoke={() => true} onChanged={reload} />
            </Section>
          )}
        </div>
      )}
    </PageContainer>
  );
}

function NewKey({ days, onCreated }: { days: number[]; onCreated: (c: Created) => void }) {
  const [name, setName] = useState('');
  const [expires, setExpires] = useState(String(days.includes(90) ? 90 : days[0]));
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      const c = await call<Created>('POST', '', { name, expires_in_days: Number(expires) });
      setName('');
      onCreated(c);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <Section title='New key' description='Name it after the client and the machine it is for. You see the key once, right after you make it.'>
      <form className='flex flex-wrap items-end gap-2' onSubmit={(e) => { e.preventDefault(); void make(); }}>
        <Input className='w-72' maxLength={80} placeholder='e.g. Cursor on my laptop' value={name} onChange={(e) => setName(e.target.value)} aria-label='Key name' />
        <NativeSelect value={expires} onChange={(e) => setExpires(e.target.value)} aria-label='Expires after'>
          {days.map((d) => <NativeSelectOption key={d} value={String(d)}>{d === 365 ? 'Expires in a year' : `Expires in ${d} days`}</NativeSelectOption>)}
        </NativeSelect>
        <Button type='submit' size='sm' disabled={busy || !name.trim()}>Make key</Button>
      </form>
    </Section>
  );
}

function Setup({ created, onDone }: { created: Created; onDone: () => void }) {
  const token = created.setup.clients.filter((c) => c.auth === 'token');
  const [client, setClient] = useState(token[0]?.id ?? '');
  const c = created.setup.clients.find((x) => x.id === client);
  return (
    <Section title={`Your key: ${created.name}`} description='Copy it now: it is not shown again. It goes in a header (never in an address); the snippets below have it in place.'>
      <div className='flex flex-wrap items-center gap-2'>
        <code className='bg-muted rounded px-2 py-1 font-mono text-sm break-all'>{created.key}</code>
        <CopyButton text={created.key} label='Copy key' />
      </div>
      <div className='flex flex-wrap items-end gap-2'>
        <NativeSelect value={client} onChange={(e) => setClient(e.target.value)} aria-label='Client'>
          {created.setup.clients.map((x) => <NativeSelectOption key={x.id} value={x.id}>{x.client}{x.auth === 'oauth' ? ' (signs in instead)' : ''}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      {c && (
        <div className='flex flex-col gap-2'>
          <p className='text-sm'><Badge variant='secondary' className='mr-2'>{c.auth === 'token' ? 'Uses this key' : 'Signs in (OAuth)'}</Badge>{c.steps}</p>
          {c.command && <Snippet text={c.command} />}
          {c.snippet && <>{c.file && <p className='text-muted-foreground text-xs'>{c.file}</p>}<Snippet text={c.snippet} /></>}
        </div>
      )}
      <div><Button variant='outline' size='sm' onClick={() => { toast.success('Key hidden'); onDone(); }}>I have copied it</Button></div>
    </Section>
  );
}

function Snippet({ text }: { text: string }) {
  return (
    <div className='flex items-start gap-2'>
      <pre className='bg-muted max-w-full flex-1 overflow-x-auto rounded p-3 font-mono text-xs whitespace-pre-wrap break-all'>{text}</pre>
      <CopyButton text={text} />
    </div>
  );
}

function KeyTable({ keys, showOwner, canRevoke, onChanged }: { keys: Key[]; showOwner?: boolean; canRevoke: (k: Key) => boolean; onChanged: () => unknown }) {
  const revoke = (k: Key) => call('POST', `/${k.id}/revoke`, {}).then(() => { toast.success(`Revoked ${k.name}`); return onChanged(); }).catch(fail);
  if (!keys.length) return <p className='text-muted-foreground text-sm'>No keys yet.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          {showOwner && <TableHead>Belongs to</TableHead>}
          <TableHead>Kind</TableHead>
          <TableHead>Key</TableHead>
          <TableHead>Last used</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead>State</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {keys.map((k) => (
          <TableRow key={k.id}>
            <TableCell>{k.name}</TableCell>
            {showOwner && <TableCell>{k.owner_label ?? ''}</TableCell>}
            <TableCell>{KIND[k.kind]}</TableCell>
            <TableCell className='font-mono text-sm'>{k.key_prefix}…</TableCell>
            <TableCell>{k.last_used_at ? <When d={k.last_used_at} /> : 'Never'}</TableCell>
            <TableCell>{k.expires_at ? <When d={k.expires_at} /> : 'Never'}</TableCell>
            <TableCell><Badge variant={k.state === 'active' ? 'secondary' : 'outline'}>{k.state}</Badge></TableCell>
            <TableCell className='text-right'>{k.state === 'active' && canRevoke(k) && <Button variant='ghost' size='sm' onClick={() => void revoke(k)}>Revoke</Button>}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
