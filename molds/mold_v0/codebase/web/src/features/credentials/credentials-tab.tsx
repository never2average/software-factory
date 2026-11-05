'use client';
// Settings › Credentials (mold_v0-034, mold_v0-218, mold_v0-239; src/credential-routes.ts): the workspace's own
// credentials as one full-page table in the standard list layout: four cards (set, missing, required missing, recently
// changed), the search row, then the table. A row is a credential for the whole workspace a pack declares (a field, or
// a group of fields set together: an access key id and its secret), the GitHub connection, or the on-premises runner.
// A credential that belongs to one record (one per record, or one per record and environment) is never here: it is on
// that record's own page (features/credentials/record-credentials.tsx). Opening a row shows its details card in the
// customer's words (what it is for, how to get it, what works without it, its status, when it was set and last used);
// Set, Replace and Clear open a full card in the list's place (./credential-card.tsx). A value is typed once, hidden,
// sent once and never shown again (owners see only its last 4 characters); everyone else sees which are set.
import type { ReactNode } from 'react';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingCards, When, useOrgLoad } from '@/features/portal/shared';
import { GITHUB_PURPOSE, GithubAppSection, githubCall, useGithubOutcome } from './github-app-section';
import { OAuthConnections, oauthCall, useOAuthOutcome, type OAuthView } from './oauth-connections';
import { RUNNER_PURPOSE, RunnersSection, runnersCall } from './runners-section';
import { CredentialCard, CredentialFacts, credentialsCall, useCredentialCard } from './credential-card';
import { credentialsOf, forSettings, stateIn, type Credential, type CredField, type CredValue, type SlotState, type Status } from './model';
import { ago, who } from '@/features/settings/words';
import { onPremRunners } from '@/config/pack-nav.generated';

interface Vault { fields: CredField[]; values: CredValue[]; can_manage: boolean }

/** One row of the table: a workspace credential, the GitHub connection or the on-premises runner. */
interface Row {
  key: string; kind: 'credential' | 'github' | 'runner'; name: string; purpose: string; status: Status; required: boolean;
  changed_at: string | null; changed_by: string | null; used_at: string | null; credential?: Credential; state?: SlotState;
}
const latestOf = (xs: { at: string | null; by: string | null }[]) => xs.filter((x) => x.at).sort((a, b) => a.at!.localeCompare(b.at!)).at(-1) ?? { at: null, by: null };

function rowsOf(creds: Credential[], vault: Vault | null, oauth: OAuthView | null, github: Awaited<ReturnType<typeof githubCall>>, runners: Awaited<ReturnType<typeof runnersCall>>): Row[] {
  const rows: Row[] = creds.map((c) => {
    const state = stateIn(c, vault?.values ?? [], null, null);
    // A credential connected through OAuth (mold_v0-014) is set while its connection is.
    const cs = (oauth?.connections ?? []).filter((x) => x.pack === c.pack && x.name === c.parts[0]!.name && !x.asset);
    const connected = cs.some((x) => x.status === 'active');
    const last = latestOf([{ at: state.set_at, by: state.set_by }, ...cs.map((x) => ({ at: x.connected_at, by: x.connected_by }))]);
    return { key: `credential:${c.id}`, kind: 'credential', name: c.label, purpose: c.purpose, status: connected ? 'Set' : state.status,
      required: !c.optional, changed_at: last.at, changed_by: who(last.by), used_at: state.last_used_at, credential: c, state };
  });
  if (github?.available) {
    const i = github.installation;
    rows.push({ key: 'github', kind: 'github', name: 'GitHub', purpose: GITHUB_PURPOSE, status: i ? 'Set' : 'Optional', required: false,
      changed_at: i?.connected_at ?? null, changed_by: who(i?.connected_by), used_at: null });
  }
  if (runners?.available) {
    const live = runners.runners.filter((r) => r.status !== 'revoked');
    const online = live.some((r) => r.status === 'online');
    const last = latestOf(runners.runners.map((r) => ({ at: r.revoked_at ?? r.enrolled_at ?? r.created_at, by: null })));
    rows.push({ key: 'runner', kind: 'runner', name: 'On-premises runner', purpose: RUNNER_PURPOSE,
      status: online ? 'Set' : runners.location === 'on_premises' ? 'Missing' : 'Optional', required: runners.location === 'on_premises', changed_at: last.at, changed_by: null, used_at: null });
  }
  return rows;
}

const notFound = (e: unknown) => (e as { status?: number } | null)?.status === 404;

/** Settings › Credentials: the cards, the search row and the table; a row opens its details card, Set its full card. */
export function CredentialsTab() {
  // Each part answers 404 when the build has none of it (no field, no OAuth field, no GitHub App field, no private network).
  const { data, error, reload } = useOrgLoad(() => credentialsCall<Vault>('GET', undefined, '?scope=workspace').catch((e) => { if (notFound(e)) return { fields: [], values: [], can_manage: false } as Vault; throw e; }));
  const { data: oauth, reload: reloadOAuth } = useOrgLoad(() => oauthCall<OAuthView>('GET'));
  const { data: github, error: githubError, reload: reloadGithub } = useOrgLoad(() => githubCall());
  const { data: runners, error: runnersError, reload: reloadRunners } = useOrgLoad(() => onPremRunners ? runnersCall() : Promise.resolve(null));
  const card = useCredentialCard();
  useOAuthOutcome();
  useGithubOutcome();
  if (error) return <ErrorState error={error} />;
  if (!data || (github === null && !githubError && data.fields.some((f) => f.github_app)) || (onPremRunners && runners === null && !runnersError)) return <LoadingCards count={2} />;
  const creds = forSettings(credentialsOf(data.fields));
  const rows = rowsOf(creds, data, oauth, github, runners);
  const opened = card.open ? creds.find((c) => c.id === card.open!.id) : null;
  if (opened && data.can_manage) return <CredentialCard c={opened} state={stateIn(opened, data.values, null, null)} mode={card.open!.mode} back='the list' forWhat='For the whole workspace'
    asset={null} environment={null} environments={null} onClose={card.close} onDone={reload} />;
  const count = (s: Status) => rows.filter((r) => r.status === s).length;
  const requiredMissing = rows.filter((r) => r.status === 'Missing' && r.required).length;
  const recent = rows.filter((r) => ago(r.changed_at, 7)).length;
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
      searchText={(r) => `${r.name} ${r.purpose} ${r.status} ${r.changed_by ?? ''}`}
      searchPlaceholder='Search credentials'
      empty={<p className='text-muted-foreground text-sm'>Nothing for the whole workspace needs a credential. One that belongs to a single record is on that record&apos;s own page.</p>}
      detailTitle={(r) => r.name}
      detail={(r) => r.kind === 'github' ? <GithubAppSection bare onChanged={reloadGithub} />
        : r.kind === 'runner' ? <RunnersSection bare onChanged={reloadRunners} />
        : <CredentialDetails key={r.key} c={r.credential!} state={r.state!} canManage={data.can_manage} open={(mode) => card.show(r.credential!.id, mode)}
            oauth={r.credential!.oauth && oauth ? <OAuthConnections f={r.credential!.parts[0]!} view={oauth} onChanged={reloadOAuth} /> : null} />}
    />
  );
}

const COLUMNS: RecordCol<Row>[] = [
  { key: 'name', label: 'Name', title: true, keep: true, type: 'text', className: 'min-w-48', value: (r) => r.name, render: (r) => <span className='leading-snug font-medium'>{r.name}</span> },
  { key: 'purpose', label: 'What it is for', type: 'text', className: 'min-w-64 max-w-md', value: (r) => r.purpose, render: (r) => <span className='text-muted-foreground line-clamp-2 text-sm'>{r.purpose}</span> },
  { key: 'status', label: 'Status', type: 'select', keep: true, options: [{ value: 'Set', label: 'Set' }, { value: 'Missing', label: 'Missing' }, { value: 'Optional', label: 'Optional' }],
    value: (r) => r.status, render: (r) => <span className={r.status === 'Missing' && r.required ? 'text-destructive' : undefined}>{r.status}</span> },
  { key: 'changed', label: 'Set', type: 'date', value: (r) => r.changed_at, render: (r) => (r.changed_at ? <When d={r.changed_at} /> : <span className='text-muted-foreground'>Not yet</span>) },
  { key: 'used', label: 'Last used', type: 'date', value: (r) => r.used_at, render: (r) => (r.used_at ? <When d={r.used_at} /> : <span className='text-muted-foreground'>Not yet</span>) },
  { key: 'by', label: 'Set by', type: 'text', value: (r) => r.changed_by, render: (r) => r.changed_by ?? '' }
];

/** A workspace credential's details card: its facts, then Set or Replace and Clear (owners), each a full card. */
function CredentialDetails({ c, state, canManage, open, oauth }: { c: Credential; state: SlotState; canManage: boolean; open: (mode: 'set' | 'clear') => void; oauth?: ReactNode }) {
  const set = state.status === 'Set' || state.partial;
  return (
    <div className='flex min-w-0 flex-col gap-4'>
      <CredentialFacts c={c} state={state} />
      {c.github_app && <p className='text-sm'>When GitHub is connected, it is used instead; a value set here is used only while it is not.</p>}
      {oauth}
      {canManage ? (
        <div className='flex flex-wrap gap-2'>
          <Button size='sm' onClick={() => open('set')} data-credential-open='set'>{set ? 'Replace' : 'Set'}</Button>
          {set && <Button size='sm' variant='outline' onClick={() => open('clear')} data-credential-open='clear'>Clear</Button>}
        </div>
      ) : <p className='text-sm'>An owner of this workspace sets these.</p>}
    </div>
  );
}
