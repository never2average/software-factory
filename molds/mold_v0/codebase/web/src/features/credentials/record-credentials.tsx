'use client';
// A record's own Credentials card (mold_v0-239; src/credentials.ts recordCredentials, GET /api/credentials?area=&key=):
// on the record's page (features/records/record-pages.tsx RecordDetailPage), what this record needs and the status of
// each. First the credentials of the record itself (one per record), then one group per environment the record has
// (Production, Staging, ...) with the credentials set per environment. Each in the customer's words: what it is for,
// its status, when it was set and last used, what works without it, and how to get it. Set, Replace and Clear open a
// full card in the page's place (./credential-card.tsx); an environment is picked from the record's own, never typed.
// Nothing here is shown when the record's area has no credential (the API answers 404).
// mold_v0-241: the card is the page's #credentials anchor: a record's row on Settings › Credentials opens the page
// scrolled to it (once the card is drawn: the record and its credentials load after the page).
import { useCallback, useRef, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { When, useOrgLoad } from '@/features/portal/shared';
import { singular } from '@/features/tabs/run-rows';
import type { RecordAreaSpec } from '@/config/pack-nav.generated';
import { CredentialCard, HowToGet, StatusText, credentialsCall, useCredentialCard } from './credential-card';
import { CREDENTIALS_ANCHOR, credentialsOf, envWord, forRecord, recordSections, stateIn, type Credential, type CredField, type CredValue, type SlotState } from './model';
import { OAuthConnections, oauthCall, useOAuthOutcome, type OAuthView } from './oauth-connections';

interface RecordVault {
  fields: CredField[]; values: CredValue[]; can_manage: boolean;
  record: { area: string; key: string; title: string }; environments: string[]; field_environments: Record<string, string[] | null>;
}

const notFound = (e: unknown) => (e as { status?: number } | null)?.status === 404;

/**
 * The record's credentials: `section`, its Credentials card for the page, and `card`, the full set or clear card while
 * one is open (the page draws it in its own place). Nothing for staff pages or an area with no credential.
 */
export function useRecordCredentials(area: RecordAreaSpec, recordKey: string, on: boolean): { section: ReactNode; card: ReactNode } {
  const q = `?area=${encodeURIComponent(area.name)}&key=${encodeURIComponent(recordKey)}`;
  const { data, reload } = useOrgLoad(() => (on ? credentialsCall<RecordVault>('GET', undefined, q).catch((e) => { if (notFound(e)) return null; throw e; }) : Promise.resolve(null)), [q, on]);
  const needsOAuth = !!data?.fields.some((f) => f.oauth);
  const { data: oauth, reload: reloadOAuth } = useOrgLoad(() => (needsOAuth ? oauthCall<OAuthView>('GET') : Promise.resolve(null)), [needsOAuth]);
  const open = useCredentialCard();
  useOAuthOutcome();
  // Opened at #credentials: scroll to the card when it is first drawn (once, so a later redraw does not move the page),
  // its heading below the page's sticky header (scroll-mt-20).
  const scrolled = useRef(false);
  const anchor = useCallback((el: HTMLElement | null) => {
    if (!el || scrolled.current || window.location.hash !== `#${CREDENTIALS_ANCHOR}`) return;
    scrolled.current = true;
    requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
  }, []);
  if (!data) return { section: null, card: null };
  const noun = singular(area.label).toLowerCase();
  const creds = credentialsOf(data.fields);
  const { record, environment } = forRecord(creds, area.name);
  if (!record.length && !environment.length) return { section: null, card: null };
  const sections = recordSections(creds, area.name, data.environments, data.values, recordKey, data.field_environments);
  const title = data.record.title || recordKey;
  // The open card: the credential, and (one per environment) the environment it is set for.
  const c = open.open ? creds.find((x) => x.id === open.open!.id && x.area === area.name) : null;
  let card: ReactNode = null;
  if (c && data.can_manage) {
    const env = c.place === 'record-environment' ? open.open!.environment : null;
    const takes = data.field_environments[`${c.pack}/${c.parts[0]!.name}`] ?? data.environments;
    card = (
      <div className='flex w-full max-w-4xl flex-col gap-4'>
        <CredentialCard c={c} state={c.place === 'record-environment' && !env ? null : stateIn(c, data.values, recordKey, env)} mode={open.open!.mode}
          back={title} forWhat={`For ${noun} ${title}`} noun={noun} asset={recordKey} environment={env}
          environments={c.place === 'record-environment' ? takes : null} onEnvironment={(e) => open.show(c.id, open.open!.mode, e)}
          onClose={open.close} onDone={reload} />
        {c.oauth && oauth && open.open!.mode === 'set' && (c.place !== 'record-environment' || env) && (
          <Card className='w-full max-w-4xl'><CardContent>
            <OAuthConnections f={c.parts[0]!} view={oauth} onChanged={reloadOAuth} slot={{ asset: recordKey, environment: env }} />
          </CardContent></Card>
        )}
      </div>
    );
  }
  const section = (
    <Card id={CREDENTIALS_ANCHOR} ref={anchor} className='w-full max-w-4xl scroll-mt-20 gap-0 py-0' data-record-credentials=''>
      <CardHeader className='border-b py-4 [.border-b]:pb-4'>
        {/* No count line under the heading (mold_v0-240): each credential says its own status. */}
        <CardTitle className='text-base'>Credentials</CardTitle>
      </CardHeader>
      <CardContent className='flex flex-col gap-6 py-4'>
        {sections.record.length > 0 && (
          <section className='flex flex-col gap-2' data-credential-group='record'>
            <h3 className='text-sm font-medium'>For this {noun}</h3>
            <ul className='flex flex-col divide-y rounded-md border'>
              {sections.record.map(({ c, state }) => <Item key={c.id} c={c} state={state} canManage={data.can_manage} open={(m) => open.show(c.id, m)} />)}
            </ul>
          </section>
        )}
        {environment.length > 0 && (sections.environments.length ? sections.environments.map((g) => (
          <section key={g.environment} className='flex flex-col gap-2' data-credential-group='environment' data-environment={g.environment}>
            <h3 className='text-sm font-medium'>{g.label}</h3>
            {g.items.length ? (
              <ul className='flex flex-col divide-y rounded-md border'>
                {g.items.map(({ c, state }) => <Item key={c.id} c={c} state={state} canManage={data.can_manage} open={(m) => open.show(c.id, m, g.environment)} />)}
              </ul>
            ) : <p className='text-sm'>Nothing is needed for {envWord(g.environment)}.</p>}
          </section>
        )) : (
          <section className='flex flex-col gap-2' data-credential-group='environment'>
            <h3 className='text-sm font-medium'>Per environment</h3>
            <p className='text-sm'>This {noun} lists no environments yet. {environment.map((c) => c.label).join(', ')} {environment.length > 1 ? 'are' : 'is'} set per environment once it does.</p>
          </section>
        ))}
        {!data.can_manage && <p className='text-sm'>An owner of this workspace sets these.</p>}
      </CardContent>
    </Card>
  );
  return { section, card };
}

/** One credential in one place: its name and purpose, its status and dates, what works without it, how to get it. */
function Item({ c, state, canManage, open }: { c: Credential; state: SlotState; canManage: boolean; open: (mode: 'set' | 'clear') => void }) {
  const set = state.status === 'Set' || state.partial;
  return (
    <li className='flex flex-col gap-2 p-3' data-credential={c.id} data-credential-place={c.place}>
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div className='flex min-w-0 flex-col gap-1'>
          <span className='leading-snug font-medium'>{c.label}</span>
          {c.purpose && <span className='text-muted-foreground text-sm leading-snug'>{c.purpose}</span>}
        </div>
        {canManage && (
          <div className='flex shrink-0 gap-2'>
            <Button size='sm' variant={set ? 'outline' : 'default'} onClick={() => open('set')} data-credential-open='set'>{set ? 'Replace' : 'Set'}</Button>
            {set && <Button size='sm' variant='ghost' onClick={() => open('clear')} data-credential-open='clear'>Clear</Button>}
          </div>
        )}
      </div>
      <p className='flex flex-wrap gap-x-4 gap-y-1 text-sm'>
        <span>Status: <StatusText state={state} /></span>
        <span>Set: {state.set_at ? <When d={state.set_at} /> : 'not yet'}</span>
        <span>Last used: {state.last_used_at ? <When d={state.last_used_at} /> : 'not yet'}</span>
      </p>
      {c.without && state.status !== 'Set' && <p className='text-sm'>Without it: {c.without}</p>}
      {c.steps.length > 0 && (
        <details className='text-sm'>
          <summary className='cursor-pointer underline-offset-4 hover:underline'>How to get it</summary>
          <div className='pt-2'><HowToGet steps={c.steps} /></div>
        </details>
      )}
    </li>
  );
}
