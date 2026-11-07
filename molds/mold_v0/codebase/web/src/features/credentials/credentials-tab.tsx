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
//
// mold_v0-241: below the workspace's own rows, one row per record whose credentials are its own (each application):
// its title, what they are for, its status in words ("All set", "2 missing", "Optional only"), when one last changed,
// was last used and who set it. One request per such area (?records=<area>, only the areas and records the person may
// read), never one per record. Opening the row opens the record's own page at its Credentials card (#credentials): the
// card is never drawn here. The four cards count every credential: the workspace's, and each record's one by one.
import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingCards, When, useOrgLoad } from '@/features/portal/shared';
import { GITHUB_PURPOSE, GithubAppSection, githubCall, useGithubOutcome } from './github-app-section';
import { OAuthConnections, oauthCall, useOAuthOutcome, type OAuthView } from './oauth-connections';
import { RUNNER_PURPOSE, RunnersSection, runnersCall } from './runners-section';
import { CredentialCard, CredentialFacts, credentialsCall, useCredentialCard } from './credential-card';
import { credentialsOf, forSettings, recordCredentialsHref, recordPurpose, recordSummary, settingsCounts, stateIn, type AreaRecord, type Credential, type CredField, type CredValue, type SlotState, type Status, type Unit } from './model';
import { who } from '@/features/settings/words';
import { singular } from '@/features/tabs/run-rows';
import { onPremRunners, recordAreas } from '@/config/pack-nav.generated';

interface Vault { fields: CredField[]; values: CredValue[]; can_manage: boolean; record_areas?: string[] }
/** One area's records and their credentials (GET /api/credentials?records=<area>, mold_v0-241). */
interface AreaVault { fields: CredField[]; values: CredValue[]; records: AreaRecord[]; more: boolean }

/**
 * One row of the table: a workspace credential, the GitHub connection, the on-premises runner, or (mold_v0-241) a record
 * whose credentials are its own, opening its page's Credentials card (`href`).
 */
interface Row {
  key: string; kind: 'credential' | 'github' | 'runner' | 'record'; name: string; purpose: string; status: Status; required: boolean;
  changed_at: string | null; changed_by: string | null; used_at: string | null; credential?: Credential; state?: SlotState;
  /** A record's row: its status in words, its credentials one by one (the cards' count) and its page's Credentials card. */
  words?: string; units?: Unit[]; href?: string;
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

/** mold_v0-241: one row per record of each area whose records have credentials, in the area's order, by title. */
function recordRowsOf(areas: readonly (AreaVault & { area: string })[]): Row[] {
  return areas.flatMap(({ area, fields, values, records }) => {
    const spec = recordAreas.find((a) => a.name === area);
    if (!spec) return [];
    const cs = credentialsOf(fields);
    const noun = singular(spec.label).toLowerCase();
    const purpose = recordPurpose(cs, area, noun);
    return records.slice().sort((a, b) => a.title.localeCompare(b.title)).map((r): Row => {
      const s = recordSummary(cs, area, r, values);
      return { key: `record:${area}:${r.key}`, kind: 'record', name: r.title, purpose, status: s.status, required: s.missing > 0,
        changed_at: s.changed_at, changed_by: who(s.changed_by), used_at: s.used_at, words: s.words,
        units: s.slots.map((x) => ({ status: x.state.status, required: x.required, changed_at: x.state.set_at })),
        href: recordCredentialsHref(area, r.key) };
    });
  });
}

const notFound = (e: unknown) => (e as { status?: number } | null)?.status === 404;
/** An area the person may not read (403) or that a later build dropped (404) has no rows. */
const noRows = (e: unknown) => [403, 404].includes((e as { status?: number } | null)?.status ?? 0);

/** Settings › Credentials: the cards, the search row and the table; a row opens its details card, Set its full card. */
export function CredentialsTab() {
  // Each part answers 404 when the build has none of it (no field, no OAuth field, no GitHub App field, no private network).
  const { data, error, reload } = useOrgLoad(() => credentialsCall<Vault>('GET', undefined, '?scope=workspace').catch((e) => { if (notFound(e)) return { fields: [], values: [], can_manage: false } as Vault; throw e; }));
  const { data: oauth, reload: reloadOAuth } = useOrgLoad(() => oauthCall<OAuthView>('GET'));
  const { data: github, error: githubError, reload: reloadGithub } = useOrgLoad(() => githubCall());
  const { data: runners, error: runnersError, reload: reloadRunners } = useOrgLoad(() => onPremRunners ? runnersCall() : Promise.resolve(null));
  // mold_v0-241: each area's records in one request (never one per record), once the workspace's answer names them.
  const areas = data ? (data.record_areas ?? []).join(',') : null;
  const { data: records, error: recordsError } = useOrgLoad(() => areas === null ? Promise.resolve(null) : Promise.all(areas.split(',').filter(Boolean).map((area) =>
    credentialsCall<AreaVault>('GET', undefined, `?records=${encodeURIComponent(area)}`).then((v) => ({ ...v, area }), (e) => { if (noRows(e)) return null; throw e; })))
    .then((xs) => xs.filter((x) => x !== null)), [areas]);
  const router = useRouter();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const card = useCredentialCard();
  useOAuthOutcome();
  useGithubOutcome();
  if (error || recordsError) return <ErrorState error={(error ?? recordsError)!} />;
  if (!data || records === null || (github === null && !githubError && data.fields.some((f) => f.github_app)) || (onPremRunners && runners === null && !runnersError)) return <LoadingCards count={2} />;
  const creds = forSettings(credentialsOf(data.fields));
  // The workspace's own rows first, then one per record.
  const rows = [...rowsOf(creds, data, oauth, github, runners), ...recordRowsOf(records)];
  const opened = card.open ? creds.find((c) => c.id === card.open!.id) : null;
  if (opened && data.can_manage) return <CredentialCard c={opened} state={stateIn(opened, data.values, null, null)} mode={card.open!.mode} back='the list' forWhat='For the whole workspace'
    asset={null} environment={null} environments={null} onClose={card.close} onDone={reload} entry={card.open!.entry} />;
  // The cards count credentials, not rows: a record's row counts each of its credentials (each environment's apart).
  const n = settingsCounts(rows.flatMap((r) => r.units ?? [{ status: r.status, required: r.required, changed_at: r.changed_at }]));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return (
    <RecordView<Row>
      id='settings-credentials' compact noun={rows.length === 1 ? 'credential' : 'credentials'} properties
      // A record's row opens the record's own page at its Credentials card; any other row its details card here.
      openKey={openKey} onOpenChange={(k) => { const href = k ? byKey.get(k)?.href : undefined; if (href) router.push(href); else setOpenKey(k); }}
      rows={rows} rowKey={(r) => r.key} cols={COLUMNS}
      summary={<StatStrip quad items={[
        { label: 'Set', value: n.set, said: `${n.set} set` },
        { label: 'Missing', value: n.missing, said: `${n.missing} not set` },
        { label: 'Required missing', value: n.required_missing, said: `${n.required_missing} required and not set` },
        { label: 'Changed in the last 7 days', value: n.recent, said: `${n.recent} changed in the last 7 days` }
      ]} />}
      searchText={(r) => `${r.name} ${r.purpose} ${r.words ?? r.status} ${r.changed_by ?? ''}`}
      searchPlaceholder='Search credentials'
      empty={<p className='text-muted-foreground text-sm'>Nothing for the whole workspace needs a credential. One that belongs to a single record is on that record&apos;s own page.</p>}
      detailTitle={(r) => r.name}
      detail={(r) => r.kind === 'record' ? null : r.kind === 'github' ? <GithubAppSection bare onChanged={reloadGithub} />
        : r.kind === 'runner' ? <RunnersSection bare onChanged={reloadRunners} />
        : <CredentialDetails key={r.key} c={r.credential!} state={r.state!} canManage={data.can_manage} open={(mode, entry) => card.show(r.credential!.id, mode, null, entry ?? null)}
            oauth={r.credential!.oauth && oauth ? <OAuthConnections f={r.credential!.parts[0]!} view={oauth} onChanged={reloadOAuth} /> : null} />}
    />
  );
}

const COLUMNS: RecordCol<Row>[] = [
  { key: 'name', label: 'Name', title: true, keep: true, type: 'text', className: 'min-w-48', value: (r) => r.name, render: (r) => <span className='leading-snug font-medium'>{r.name}</span> },
  { key: 'purpose', label: 'What it is for', type: 'text', className: 'min-w-64 max-w-md', value: (r) => r.purpose, render: (r) => <span className='text-muted-foreground line-clamp-2 text-sm'>{r.purpose}</span> },
  { key: 'status', label: 'Status', type: 'select', keep: true, options: [{ value: 'Set', label: 'Set' }, { value: 'Missing', label: 'Missing' }, { value: 'Optional', label: 'Optional' }],
    value: (r) => r.status, render: (r) => <span className={r.status === 'Missing' && r.required ? 'text-destructive' : undefined}>{r.words ?? r.status}</span> },
  { key: 'changed', label: 'Set', type: 'date', value: (r) => r.changed_at, render: (r) => (r.changed_at ? <When d={r.changed_at} /> : <span className='text-muted-foreground'>Not yet</span>) },
  { key: 'used', label: 'Last used', type: 'date', value: (r) => r.used_at, render: (r) => (r.used_at ? <When d={r.used_at} /> : <span className='text-muted-foreground'>Not yet</span>) },
  { key: 'by', label: 'Set by', type: 'text', value: (r) => r.changed_by, render: (r) => r.changed_by ?? '' }
];

/** A workspace credential's details card: its facts, then Set or Replace and Clear (owners), each a full card. */
function CredentialDetails({ c, state, canManage, open, oauth }: { c: Credential; state: SlotState; canManage: boolean; open: (mode: 'set' | 'clear', entry?: string) => void; oauth?: ReactNode }) {
  const set = state.status === 'Set' || state.partial;
  // mold_v0-260 (flag credential_sets): several labelled values, each replaced or removed on its own.
  if (c.entries) {
    const entries = state.values.filter((v) => !!v.entry).sort((a, b) => a.entry!.localeCompare(b.entry!));
    return (
      <div className='flex min-w-0 flex-col gap-4'>
        <CredentialFacts c={c} state={state} />
        {entries.length > 0 && (
          <ul className='flex flex-col divide-y rounded-md border' data-credential-entries=''>
            {entries.map((v) => (
              <li key={v.entry} className='flex items-center justify-between gap-3 px-3 py-2 text-sm' data-credential-entry={v.entry}>
                <span className='flex min-w-0 flex-1 flex-col'><span className='truncate font-medium'>{v.entry}</span>{v.last4 && <span className='text-muted-foreground font-mono text-xs'>ends in ••••{v.last4}</span>}</span>
                {canManage && <span className='flex shrink-0 gap-2'>
                  <Button size='sm' variant='outline' onClick={() => open('set', v.entry!)} aria-label={`Replace ${v.entry}`}>Replace</Button>
                  <Button size='sm' variant='ghost' onClick={() => open('clear', v.entry!)} aria-label={`Remove ${v.entry}`}>Remove</Button>
                </span>}
              </li>
            ))}
          </ul>
        )}
        {canManage ? <div className='flex flex-wrap gap-2'><Button size='sm' disabled={entries.length >= c.entries.max} onClick={() => open('set')} data-credential-open='add'>Add {c.entries.label.toLowerCase()}</Button></div>
          : <p className='text-sm'>An owner of this workspace sets these.</p>}
      </div>
    );
  }
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
