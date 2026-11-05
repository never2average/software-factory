'use client';
// Settings › Credentials (mold_v0-034, mold_v0-218; src/credential-routes.ts): the workspace's credentials as one
// full-page table in the standard list layout: four cards (set, missing, required missing, recently changed), the search
// row, then the table. A row is a credential field a pack declares (pasted or connected through OAuth), the GitHub
// connection, or the on-premises runner; opening one shows its full details card, where owners Set, Replace, Clear,
// Connect and Disconnect. A value is typed once, sent once and never shown again (owners see only its last 4
// characters in the card); everyone else in the workspace sees which are set.
import { useState } from 'react';
import { toast } from 'sonner';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ErrorState, LoadingCards, When, fail, useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { GITHUB_PURPOSE, GithubAppSection, githubCall, useGithubOutcome } from './github-app-section';
import { OAuthConnections, oauthCall, useOAuthOutcome, type OAuthView } from './oauth-connections';
import { RUNNER_PURPOSE, RunnersSection, runnersCall } from './runners-section';
import { ago, who } from '@/features/settings/words';
import { singular } from '@/features/tabs/run-rows';
import { onPremRunners, recordAreas } from '@/config/pack-nav.generated';

interface Field {
  pack: string; name: string; label: string; help: string | null; bound_to: 'workspace' | 'asset' | 'environment';
  area: string | null; environments: string[] | null; deliver_as: { env: string } | { file: string };
  /** mold_v0-014: runs get a GitHub App installation token instead, when the workspace has connected GitHub. */
  github_app?: boolean;
  /** mold_v0-014: the OAuth provider this field connects to, when it does. */
  oauth?: string;
  /** mold_v0-186: the runs go ahead without a value (they do less); `adds`: what a value adds, when the pack says. */
  optional?: boolean; adds?: string | null;
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
  if (!res.ok) throw httpError(res.status, json);
  return json;
}

/** One record of the field's area, in words ("application" for Applications). */
const one = (area: string | null) => singular(recordAreas.find((a) => a.name === area)?.label ?? area ?? 'record').toLowerCase();
/** What a value is bound to, in words: the workspace, each record of an area (each application), or each record and environment. */
const bound = (f: Field) => (f.bound_to === 'workspace' ? 'Workspace' : f.bound_to === 'asset' ? `Each ${one(f.area)}` : `Each ${one(f.area)}, per environment`);

type Status = 'Set' | 'Missing' | 'Optional';
/** One row of the table: a credential field, the GitHub connection or the on-premises runner. */
interface Row {
  key: string; kind: 'field' | 'github' | 'runner'; name: string; purpose: string; bound: string; status: Status; required: boolean;
  changed_at: string | null; changed_by: string | null; field?: Field;
}
const latestOf = (xs: { at: string | null; by: string | null }[]) => xs.filter((x) => x.at).sort((a, b) => a.at!.localeCompare(b.at!)).at(-1) ?? { at: null, by: null };

function rowsOf(vault: Vault | null, oauth: OAuthView | null, github: Awaited<ReturnType<typeof githubCall>>, runners: Awaited<ReturnType<typeof runnersCall>>): Row[] {
  const rows: Row[] = (vault?.fields ?? []).map((f) => {
    const vs = vault!.values.filter((v) => v.pack === f.pack && v.name === f.name);
    const cs = (oauth?.connections ?? []).filter((c) => c.pack === f.pack && c.name === f.name);
    const set = vs.length > 0 || cs.some((c) => c.status === 'active');
    const last = latestOf([...vs.map((v) => ({ at: v.updated_at, by: v.updated_by })), ...cs.map((c) => ({ at: c.connected_at, by: c.connected_by }))]);
    return { key: `field:${f.pack}/${f.name}`, kind: 'field', name: f.label, purpose: f.help ?? '', bound: bound(f), status: set ? 'Set' : f.optional ? 'Optional' : 'Missing',
      required: !f.optional, changed_at: last.at, changed_by: who(last.by), field: f };
  });
  if (github?.available) {
    const i = github.installation;
    rows.push({ key: 'github', kind: 'github', name: 'GitHub', purpose: GITHUB_PURPOSE, bound: 'Workspace', status: i ? 'Set' : 'Optional', required: false,
      changed_at: i?.connected_at ?? null, changed_by: who(i?.connected_by) });
  }
  if (runners?.available) {
    const live = runners.runners.filter((r) => r.status !== 'revoked');
    const online = live.some((r) => r.status === 'online');
    const last = latestOf(runners.runners.map((r) => ({ at: r.revoked_at ?? r.enrolled_at ?? r.created_at, by: null })));
    rows.push({ key: 'runner', kind: 'runner', name: 'On-premises runner', purpose: RUNNER_PURPOSE, bound: 'Workspace',
      status: online ? 'Set' : runners.location === 'on_premises' ? 'Missing' : 'Optional', required: runners.location === 'on_premises', changed_at: last.at, changed_by: null });
  }
  return rows;
}

const notFound = (e: unknown) => (e as { status?: number } | null)?.status === 404;

/** Settings › Credentials: the cards, the search row and the table; a row opens its full details card. */
export function CredentialsTab() {
  // Each part answers 404 when the build has none of it (no field, no OAuth field, no GitHub App field, no private network).
  const { data, error, reload } = useOrgLoad(() => call<Vault>('GET').catch((e) => { if (notFound(e)) return { fields: [], values: [], can_manage: false } as Vault; throw e; }));
  const { data: oauth, reload: reloadOAuth } = useOrgLoad(() => oauthCall<OAuthView>('GET'));
  const { data: github, error: githubError, reload: reloadGithub } = useOrgLoad(() => githubCall());
  const { data: runners, error: runnersError, reload: reloadRunners } = useOrgLoad(() => onPremRunners ? runnersCall() : Promise.resolve(null));
  useOAuthOutcome();
  useGithubOutcome();
  if (error) return <ErrorState error={error} />;
  if (!data || (github === null && !githubError && data.fields.some((f) => f.github_app)) || (onPremRunners && runners === null && !runnersError)) return <LoadingCards count={2} />;
  const rows = rowsOf(data, oauth, github, runners);
  const count = (s: Status) => rows.filter((r) => r.status === s).length;
  const requiredMissing = rows.filter((r) => r.status === 'Missing' && r.required).length;
  const recent = rows.filter((r) => ago(r.changed_at, 7)).length;
  const canManage = data.can_manage || !!github?.can_manage || !!runners?.can_manage;
  return (
    <RecordView<Row>
      id='settings-credentials' compact noun={rows.length === 1 ? 'credential' : 'credentials'} properties
      rows={rows} rowKey={(r) => r.key} cols={COLUMNS}
      summary={<StatStrip quad items={[
        { label: 'Set', value: count('Set'), said: `${count('Set')} set` },
        { label: 'Missing', value: count('Missing') + count('Optional'), said: `${count('Missing') + count('Optional')} not set` },
        { label: 'Required missing', value: requiredMissing, said: `${requiredMissing} required and not set` },
        { label: 'Changed in the last 7 days', value: recent, said: `${recent} changed in the last 7 days` }
      ]} />}
      searchText={(r) => `${r.name} ${r.purpose} ${r.bound} ${r.status} ${r.changed_by ?? ''}`}
      searchPlaceholder='Search credentials'
      empty={<p className='text-muted-foreground text-sm'>Nothing here needs a credential.</p>}
      detailTitle={(r) => r.name}
      detail={(r) => r.kind === 'github' ? <GithubAppSection bare onChanged={reloadGithub} />
        : r.kind === 'runner' ? <RunnersSection bare onChanged={reloadRunners} />
        : <FieldSection key={r.key} f={r.field!} values={data.values.filter((v) => v.pack === r.field!.pack && v.name === r.field!.name)} canManage={data.can_manage} onChanged={reload}
            oauth={r.field!.oauth && oauth ? <OAuthConnections f={r.field!} view={oauth} onChanged={reloadOAuth} /> : null} />}
    />
  );
}

const COLUMNS: RecordCol<Row>[] = [
  { key: 'name', label: 'Name', title: true, keep: true, type: 'text', className: 'min-w-48', value: (r) => r.name, render: (r) => <span className='leading-snug font-medium'>{r.name}</span> },
  { key: 'purpose', label: 'What it is for', type: 'text', className: 'min-w-64 max-w-md', value: (r) => r.purpose, render: (r) => <span className='text-muted-foreground line-clamp-2 text-sm'>{r.purpose}</span> },
  { key: 'bound', label: 'Bound to', type: 'text', value: (r) => r.bound, render: (r) => r.bound },
  { key: 'status', label: 'Status', type: 'select', keep: true, options: [{ value: 'Set', label: 'Set' }, { value: 'Missing', label: 'Missing' }, { value: 'Optional', label: 'Optional' }],
    value: (r) => r.status, render: (r) => <span className={r.status === 'Missing' && r.required ? 'text-destructive' : undefined}>{r.status}</span> },
  { key: 'changed', label: 'Last changed', type: 'date', value: (r) => r.changed_at, render: (r) => (r.changed_at ? <When d={r.changed_at} /> : <span className='text-muted-foreground'>Never</span>) },
  { key: 'by', label: 'Changed by', type: 'text', value: (r) => r.changed_by, render: (r) => r.changed_by ?? '' }
];

function FieldSection({ f, values, canManage, onChanged, oauth }: { f: Field; values: Stored[]; canManage: boolean; onChanged: () => unknown; oauth?: React.ReactNode }) {
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
      toast.success(`Set (ends in ${out.last4})`);
      await onChanged();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const remove = (v: Stored) => call('DELETE', { pack: v.pack, name: v.name, asset: v.asset, environment: v.environment })
    .then(() => { toast.success('Cleared'); return onChanged(); }).catch(fail);
  return (
    <div className='flex min-w-0 flex-col gap-3'>
      {/* What it is for is the card's properties above (mold_v0-218); here only what they do not say. */}
      {(f.optional || f.github_app) && <p className='text-muted-foreground text-sm'>
        {f.optional && <span className='block'>Optional: runs go ahead without it{f.adds ? `; a value adds: ${f.adds}` : ''}.</span>}
        {f.github_app && <span className='block'>When GitHub is connected, runs get a short-lived token from it instead; a value pasted here is used only while it is not.</span>}</p>}
      {oauth}
      {oauth && <p className='text-muted-foreground text-xs'>Or paste a value: it is used where nothing is connected.</p>}
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
            <Textarea className='w-full max-w-96 font-mono text-xs' rows={4} autoComplete='off' spellCheck={false} placeholder='Paste the file' value={value} onChange={(e) => setValue(e.target.value)} aria-label={`${f.label} value`} />
          ) : (
            <Input className='w-full max-w-72' type='password' autoComplete='off' spellCheck={false} placeholder='Paste the value' value={value} onChange={(e) => setValue(e.target.value)} aria-label={`${f.label} value`} />
          )}
          <Button type='submit' size='sm' disabled={busy || !value}>{f.bound_to === 'workspace' && values.length ? 'Replace' : 'Set'}</Button>
        </form>
      ) : <p className='text-muted-foreground text-xs'>An owner of this workspace sets these.</p>}
    </div>
  );
}
