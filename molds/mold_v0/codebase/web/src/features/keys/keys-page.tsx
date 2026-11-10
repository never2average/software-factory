'use client';
// Settings > API tokens (/app/keys; mold_v0-007; src/member-keys.ts): a person's own MCP keys for clients that send a header instead of
// signing in. Each is named, expires, is shown once (with each client's exact setup, the key in a header, never in an
// address) and can be revoked at any time. A key acts with its person's role. Owners also see and revoke every key of
// the workspace, the older ones included.
import { useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { StatStrip } from '@/components/layout/section';
import { Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { ToolbarAction } from '@/features/tabs/tab-action';
import { Icons } from '@/components/icons';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { CopyButton, ErrorState, When, fail, useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';

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
  if (!res.ok) throw httpError(res.status, json);
  return json;
}

const KIND: Record<Key['kind'], string> = { member: 'Personal key', person: 'Older personal key', account: 'Workspace key' };

export function KeysPage() {
  return <PageContainer><KeysPanel /></PageContainer>;
}

const STATE_WORD: Record<Key['state'], string> = { active: 'Active', expired: 'Expired', revoked: 'Revoked' };

/** The API tokens page's body (mold_v0-280, mold_v0-289: the standard list): four cards, the search row with New API token, one table; a row opens its panel. */
export function KeysPanel() {
  const { data, error, reload } = useOrgLoad(() => call<Keys>('GET'));
  const [making, setMaking] = useState(false);
  if (error) return <ErrorState error={error} />;
  // An owner's list is the whole workspace's (their own among it); anyone else's is their own.
  const rows = data ? (data.can_manage_all && data.all ? data.all : data.keys) : [];
  const owners = !!data?.can_manage_all;
  const active = rows.filter((k) => k.state === 'active');
  const revoke = (k: Key) => call('POST', `/${k.id}/revoke`, {}).then(() => { toast.success(`Revoked ${k.name}`); return reload(); }).catch(fail);
  const cols: RecordCol<Key>[] = [
    { key: 'name', label: 'Name', title: true, keep: true, type: 'text', className: 'min-w-48', value: (k) => k.name, render: (k) => <span className='font-medium'>{k.name}</span> },
    ...(owners ? [{ key: 'owner', label: 'Belongs to', type: 'text' as const, value: (k: Key) => k.owner_label ?? '', render: (k: Key) => k.owner_label ?? '' }] : []),
    { key: 'kind', label: 'Kind', type: 'text', value: (k) => KIND[k.kind], render: (k) => KIND[k.kind] },
    { key: 'state', label: 'State', type: 'select', keep: true, options: Object.entries(STATE_WORD).map(([value, label]) => ({ value, label })), value: (k) => k.state, render: (k) => <Badge variant={k.state === 'active' ? 'secondary' : 'outline'}>{STATE_WORD[k.state]}</Badge> },
    { key: 'last', label: 'Last used', type: 'date', value: (k) => k.last_used_at, render: (k) => (k.last_used_at ? <When d={k.last_used_at} /> : 'Never') },
    { key: 'expires', label: 'Expires', type: 'date', value: (k) => k.expires_at, render: (k) => (k.expires_at ? <When d={k.expires_at} /> : 'Never') },
  ];
  const n = (s: Key['state']) => rows.filter((k) => k.state === s).length;
  return (
    <RecordView<Key>
      id='settings-api-tokens' compact noun={rows.length === 1 ? 'API token' : 'API tokens'} loading={!data} rows={rows} rowKey={(k) => String(k.id)} cols={cols}
      summary={<StatStrip quad items={[
        { label: 'Active', value: active.length, said: `${active.length} active API tokens` },
        { label: 'Expired', value: n('expired'), said: `${n('expired')} expired` },
        { label: 'Revoked', value: n('revoked'), said: `${n('revoked')} revoked` },
        { label: 'Used in the last 30 days', value: rows.filter((k) => k.last_used_at && Date.now() - new Date(k.last_used_at).getTime() < 30 * 86_400_000).length, said: 'tokens used in the last 30 days' },
      ]} />}
      searchText={(k) => `${k.name} ${k.owner_label ?? ''} ${KIND[k.kind]} ${STATE_WORD[k.state]}`} searchPlaceholder='Search API tokens'
      toolbarAction={data ? <div className='ml-auto flex shrink-0 gap-2'><ToolbarAction label='New API token' icon={<Icons.add />} onClick={() => setMaking(true)} /></div> : undefined}
      empty={<p className='text-muted-foreground text-sm'>No API tokens yet.</p>}
      detailTitle={(k) => k.name}
      detail={(k) => (
        <dl className='flex flex-col text-sm' data-api-token-panel=''>
          {owners && <Field label='Belongs to'>{k.owner_label ?? ''}</Field>}
          <Field label='Kind'>{KIND[k.kind]}</Field>
          <Field label='Starts with'><span className='font-mono text-xs'>{k.key_prefix}…</span></Field>
          <Field label='State'>{STATE_WORD[k.state]}</Field>
          <Field label='Created'><When d={k.created_at} /></Field>
          <Field label='Last used'>{k.last_used_at ? <When d={k.last_used_at} /> : 'Never'}</Field>
          <Field label='Expires'>{k.expires_at ? <When d={k.expires_at} /> : 'Never'}</Field>
        </dl>
      )}
      actions={(k) => (k.state === 'active' ? [{ label: 'Revoke', icon: <Icons.trash />, destructive: true, onSelect: () => void revoke(k) }] : [])}
      sidePanel={making && data ? { key: 'new-api-token', title: 'New API token', onClose: () => setMaking(false), body: <NewKey days={data.expiry_days} onChanged={() => void reload()} onClose={() => setMaking(false)} /> } : null}
    />
  );
}

/** New API token, in the side panel: its name and expiry; once made, the token and each client's setup. */
function NewKey({ days, onChanged, onClose }: { days: number[]; onChanged: () => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [expires, setExpires] = useState(String(days.includes(90) ? 90 : days[0]));
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const make = async () => {
    setBusy(true);
    try {
      setCreated(await call<Created>('POST', '', { name, expires_in_days: Number(expires) }));
      onChanged();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  if (created) return <Setup created={created} onDone={onClose} />;
  return (
    <form className='flex flex-col gap-3' onSubmit={(e) => { e.preventDefault(); void make(); }}>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='api-token-name'>Name</Label>
        <Input id='api-token-name' maxLength={80} placeholder='For example, Cursor on my laptop' value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='api-token-expires'>Expires</Label>
        <NativeSelect id='api-token-expires' className='w-full' value={expires} onChange={(e) => setExpires(e.target.value)}>
          {days.map((d) => <NativeSelectOption key={d} value={String(d)}>{d === 365 ? 'In a year' : `In ${d} days`}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      <div><Button type='submit' size='sm' disabled={busy || !name.trim()}>Make token</Button></div>
    </form>
  );
}

function Setup({ created, onDone }: { created: Created; onDone: () => void }) {
  const token = created.setup.clients.filter((c) => c.auth === 'token');
  const [client, setClient] = useState(token[0]?.id ?? '');
  const c = created.setup.clients.find((x) => x.id === client);
  return (
    <div className='flex flex-col gap-3 text-sm'>
      <p className='text-muted-foreground'>Copy it now: it is not shown again. It goes in a header, never in an address; the snippets below have it in place.</p>
      <div className='flex flex-wrap items-center gap-2'>
        <code className='bg-muted rounded px-2 py-1 font-mono text-sm break-all'>{created.key}</code>
        <CopyButton text={created.key} label='Copy' />
      </div>
      <NativeSelect value={client} onChange={(e) => setClient(e.target.value)} aria-label='Client' className='w-full'>
        {created.setup.clients.map((x) => <NativeSelectOption key={x.id} value={x.id}>{x.client}{x.auth === 'oauth' ? ' (signs in instead)' : ''}</NativeSelectOption>)}
      </NativeSelect>
      {c && (
        <div className='flex flex-col gap-2'>
          <p>{c.auth === 'token' ? 'Uses this token. ' : 'Signs in instead. '}{c.steps}</p>
          {c.command && <Snippet text={c.command} />}
          {c.snippet && <>{c.file && <p className='text-muted-foreground text-xs'>{c.file}</p>}<Snippet text={c.snippet} /></>}
        </div>
      )}
      <div><Button variant='outline' size='sm' onClick={() => { toast.success('Hidden'); onDone(); }}>I have copied it</Button></div>
    </div>
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
