'use client';
// /app/credentials (mold_v0-034; src/credential-routes.ts): the credential fields the packs declare, each value stored
// sealed with the workspace's data key. A value is typed once, sent once, and never shown again: the page shows only
// its last 4 characters, to owners. Owners set, replace and remove values; everyone else in the workspace sees which are set.
import { useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Section } from '@/components/layout/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ErrorState, LoadingCards, When, fail, useOrgLoad } from '@/features/portal/shared';

interface Field {
  pack: string; name: string; label: string; help: string | null; bound_to: 'workspace' | 'asset' | 'environment';
  area: string | null; environments: string[] | null; deliver_as: { env: string } | { file: string };
}
interface Stored { pack: string; name: string; bound_to: string; asset: string | null; environment: string | null; last4: string | null; updated_at: string; updated_by: string | null }
interface Vault { fields: Field[]; values: Stored[]; can_manage: boolean }

async function call<T>(method: string, body?: unknown): Promise<T> {
  const res = await fetch('/api/credentials', {
    method, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json', 'x-pack-request': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 204) return null as T;
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

const bound = (f: Field) => (f.bound_to === 'workspace' ? 'One value for the workspace' : f.bound_to === 'asset' ? `One value per ${f.area} record` : `One value per ${f.area} record and environment`);

export function CredentialsPage() {
  const { data, error, reload } = useOrgLoad(() => call<Vault>('GET'));
  return (
    <PageContainer pageTitle='Credentials' pageDescription='Keys and tokens your runs use to reach your own systems. Stored encrypted; only the last 4 characters are ever shown again.'>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={2} /> : !data.fields.length ? (
        <p className='text-muted-foreground text-sm'>Nothing here needs a credential.</p>
      ) : (
        <div className='flex flex-col gap-10'>
          {data.fields.map((f) => (
            <FieldSection key={`${f.pack}/${f.name}`} f={f} values={data.values.filter((v) => v.pack === f.pack && v.name === f.name)} canManage={data.can_manage} onChanged={reload} />
          ))}
        </div>
      )}
    </PageContainer>
  );
}

function FieldSection({ f, values, canManage, onChanged }: { f: Field; values: Stored[]; canManage: boolean; onChanged: () => unknown }) {
  const [asset, setAsset] = useState('');
  const [environment, setEnvironment] = useState(f.environments?.[0] ?? '');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const slot = { pack: f.pack, name: f.name, ...(f.bound_to !== 'workspace' ? { asset } : {}), ...(f.bound_to === 'environment' ? { environment } : {}) };
  const save = async () => {
    setBusy(true);
    try {
      const out = await call<Stored>('PUT', { ...slot, value });
      setValue('');
      toast.success(`Saved (ends in ${out.last4})`);
      await onChanged();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const remove = (v: Stored) => call('DELETE', { pack: v.pack, name: v.name, asset: v.asset, environment: v.environment })
    .then(() => { toast.success('Removed'); return onChanged(); }).catch(fail);
  return (
    <Section title={f.label} description={<>{f.help ?? bound(f)} <Badge variant='secondary' className='ml-1'>{'env' in f.deliver_as ? f.deliver_as.env : f.deliver_as.file}</Badge></>}>
      {values.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              {f.bound_to !== 'workspace' && <TableHead>{f.area}</TableHead>}
              {f.bound_to === 'environment' && <TableHead>Environment</TableHead>}
              <TableHead>Value</TableHead>
              <TableHead>Updated</TableHead>
              {canManage && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {values.map((v) => (
              <TableRow key={`${v.asset ?? ''}/${v.environment ?? ''}`}>
                {f.bound_to !== 'workspace' && <TableCell className='font-mono text-sm'>{v.asset}</TableCell>}
                {f.bound_to === 'environment' && <TableCell>{v.environment}</TableCell>}
                <TableCell className='font-mono text-sm'>{v.last4 ? '••••' + v.last4 : 'Set'}</TableCell>
                <TableCell><When d={v.updated_at} /></TableCell>
                {canManage && <TableCell className='text-right'><Button variant='ghost' size='sm' onClick={() => void remove(v)}>Remove</Button></TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : <p className='text-muted-foreground text-sm'>Not set.</p>}
      {canManage ? (
        <form className='flex flex-wrap items-end gap-2' onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {f.bound_to !== 'workspace' && <Input className='w-48' placeholder={`${f.area} key`} value={asset} onChange={(e) => setAsset(e.target.value)} aria-label={`${f.area} key`} />}
          {f.bound_to === 'environment' && (f.environments ? (
            <NativeSelect value={environment} onChange={(e) => setEnvironment(e.target.value)} aria-label='Environment'>
              {f.environments.map((x) => <NativeSelectOption key={x} value={x}>{x}</NativeSelectOption>)}
            </NativeSelect>
          ) : <Input className='w-36' placeholder='environment' value={environment} onChange={(e) => setEnvironment(e.target.value)} aria-label='Environment' />)}
          {'file' in f.deliver_as ? (
            // A file (a key, a certificate) keeps its line breaks: a text area, not a one-line field.
            <Textarea className='w-96 font-mono text-xs' rows={4} autoComplete='off' spellCheck={false} placeholder='Paste the file' value={value} onChange={(e) => setValue(e.target.value)} aria-label={`${f.label} value`} />
          ) : (
            <Input className='w-72' type='password' autoComplete='off' spellCheck={false} placeholder='Paste the value' value={value} onChange={(e) => setValue(e.target.value)} aria-label={`${f.label} value`} />
          )}
          <Button type='submit' size='sm' disabled={busy || !value}>{values.length ? 'Save or replace' : 'Save'}</Button>
        </form>
      ) : <p className='text-muted-foreground text-xs'>An owner of this workspace sets these.</p>}
    </Section>
  );
}
