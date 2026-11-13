'use client';
/**
 * /app/connected-apps (mold_v0-087): each person's own connected apps, the agents signed in to /mcp.
 * Built-in sign-in: the list (GET /api/oauth/grants, src/mcp-oauth.ts), across the person's workspaces, as the standard
 * list (mold_v0-298: RecordView: search, the row's ⋯ menu with Revoke, which asks first, and the side panel).
 * Hosted sign-in provider: the provider keeps the connections and has no API to list them, so (mold_v0-298) the page lists
 * the agents most recently seen working in this workspace as the person (GET /api/app/setup `clients`), with when each was
 * last seen, how to disconnect one and a ⋯ Remove from this list; and links to the person's account at the provider.
 * Words and rules: ./model.ts.
 */
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { Icons } from '@/components/icons';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { ErrorState, When, fail, useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { appApi } from '@/lib/api-client';
import { CLERK } from '@/lib/auth/provider';
import { W } from '@/lib/vocabulary';
import {
  appIdentity, appName, CLERK_NOTE, clerkAccountLink, CONNECT_URL, DESCRIPTION, disconnectSteps, EMPTY, forgetQuestion, PAGE_TITLE, revokeQuestion, scopeWords,
  SEEN_EMPTY, seenPartial,
  type ConnectedApp, type SeenApp
} from './model';

async function call<T>(method: 'GET' | 'POST', path: string): Promise<T> {
  const res = await fetch(`/api/oauth/grants${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'x-pack-request': '1' } : {}) },
    ...(method === 'POST' ? { body: '{}' } : {})
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, json);
  return json;
}

/** Who vouches for the app: its verified address, else a "Not verified" mark. */
function Identity({ app }: { app: ConnectedApp }) {
  const id = appIdentity(app);
  return id.verified ? (
    <span className='text-muted-foreground flex items-center gap-1 text-xs'>
      <Icons.circleCheck className='size-3.5 shrink-0' aria-hidden='true' />
      <span>Verified: </span>
      <a href={id.url} target='_blank' rel='noopener noreferrer' className='truncate underline-offset-4 hover:underline'>{id.host}</a>
    </span>
  ) : (
    <Badge variant='outline' className='w-fit font-normal' title={id.note}>Not verified</Badge>
  );
}

/** The primary action of both lists: the setup steps for connecting an agent (mold_v0-298). */
const ConnectButton = () => (
  <a href={CONNECT_URL} className={buttonVariants({ size: 'sm' })}><Icons.plug aria-hidden='true' /><span className='max-sm:sr-only'>Connect an agent</span></a>
);

function BuiltinConnectedApps() {
  const { data, error, reload } = useOrgLoad(() => call<{ grants: ConnectedApp[] }>('GET', ''));
  const [ask, setAsk] = useState<ConnectedApp | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const revoke = (app: ConnectedApp) => {
    setBusy(app.id);
    call('POST', `/${encodeURIComponent(app.id)}/revoke`)
      .then(() => { toast.success(`${appName(app)} is disconnected`); return reload(); })
      .catch(fail)
      .finally(() => setBusy(null));
  };
  const cols = useMemo<RecordCol<ConnectedApp>[]>(() => [
    // data-connected-app: one per app listed (scripts/connected-apps-test.ts counts them).
    { key: 'app', label: 'App', title: true, keep: true, type: 'text', className: 'max-w-72', value: (g) => appName(g),
      render: (g) => (
        <span data-connected-app={g.id} className='flex min-w-0 flex-col gap-1'>
          <span className='font-medium'>{appName(g)}</span>
          <Identity app={g} />
        </span>
      ) },
    { key: 'workspace', label: W.Workspace, type: 'select', value: (g) => g.workspace.name, render: (g) => g.workspace.name },
    { key: 'created', label: 'Connected', type: 'date', value: (g) => g.created_at, render: (g) => <When d={g.created_at} /> },
    { key: 'used', label: 'Last used', type: 'date', value: (g) => g.last_used_at, render: (g) => <When d={g.last_used_at} /> },
  ], []);
  if (error) return <ErrorState error={error} />;
  const grants = data?.grants ?? [];
  const q = ask ? revokeQuestion(ask) : null;
  const revokeItem = (g: ConnectedApp) => ({ label: 'Revoke', icon: <Icons.logout />, destructive: true, disabled: busy === g.id, onSelect: () => setAsk(g), testId: 'revoke' });
  return (
    // mold_v0-298: 'list' or 'empty' only once the grants arrived (the browser test waits on either as "ready").
    <div data-connected-apps={!data ? 'loading' : grants.length ? 'list' : 'empty'}>
      <RecordView<ConnectedApp>
        id='app-connected-apps' noun='apps' rows={grants} rowKey={(g) => g.id} cols={cols} loading={!data} exportName='connected-apps'
        searchText={(g) => `${appName(g)} ${g.client.id_host ?? ''} ${g.workspace.name}`} searchPlaceholder='Search connected apps'
        toolbarAction={<ConnectButton />}
        actions={(g) => [revokeItem(g)]}
        detailTitle={(g) => appName(g)}
        detail={(g) => (
          <div className='flex flex-col gap-4 text-sm'>
            <dl>
              <Field label='Who vouches for it'><Identity app={g} /></Field>
              <Field label={W.Workspace}>{g.workspace.name}</Field>
              <Field label='Connected'><When d={g.created_at} /></Field>
              <Field label='Last used'><When d={g.last_used_at} /></Field>
              <Field label='What it may do'>{scopeWords(g.scope)}</Field>
            </dl>
            <p className='text-muted-foreground'>Revoking signs it out of {g.workspace.name} at once. You can connect it again later from the app.</p>
            <Button variant='outline' size='sm' className='self-start' disabled={busy === g.id} onClick={() => setAsk(g)}>
              <Icons.logout aria-hidden='true' />Revoke<span className='sr-only'> {appName(g)} in {g.workspace.name}</span>
            </Button>
          </div>
        )}
        empty={{ title: EMPTY.title, text: EMPTY.text, action: EMPTY.cta }}
      />
      <AlertDialog open={!!ask} onOpenChange={(o) => !o && setAsk(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{q?.title}</AlertDialogTitle>
            <AlertDialogDescription>{q?.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={() => { if (ask) revoke(ask); setAsk(null); }}>{q?.action}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Under the hosted sign-in provider (mold_v0-298): the agents seen working in this workspace as this person, from the
 * usage log the Setup page reads, with when each was last seen; a row's panel says how to disconnect it. The note above
 * says why there is no Revoke here, and links to the person's sign-in account.
 */
function HostedConnectedApps() {
  const { data, error, reload } = useOrgLoad(() => appApi<{ clients: SeenApp[] }>('GET', '/setup'));
  const [ask, setAsk] = useState<SeenApp | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // mold_v0-298: forget an app in this person's own list (DELETE /api/app/clients/<name>); it does not disconnect it.
  const forget = (c: SeenApp) => {
    setBusy(c.client);
    appApi('DELETE', `/clients/${encodeURIComponent(c.client)}`)
      .then(() => { toast.success(`${c.client} is removed from this list`); return reload(); })
      .catch(fail)
      .finally(() => setBusy(null));
  };
  const clients = data?.clients ?? [];
  const partial = seenPartial(clients.length);
  const q = ask ? forgetQuestion(ask.client) : null;
  const link = clerkAccountLink(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const cols = useMemo<RecordCol<SeenApp>[]>(() => [
    { key: 'client', label: 'App', title: true, keep: true, type: 'text', value: (c) => c.client, render: (c) => <span className='font-medium'>{c.client}</span> },
    { key: 'last', label: 'Last seen', type: 'date', value: (c) => c.last, render: (c) => <When d={c.last} /> },
  ], []);
  return (
    <div className='flex flex-col gap-4'>
      <section data-connected-apps='provider' aria-labelledby='connected-apps-provider' className='flex flex-col items-start gap-2 rounded-md border p-4'>
        <h2 id='connected-apps-provider' className='flex items-center gap-2 text-sm font-semibold'>
          <Icons.shield className='size-4' aria-hidden='true' />{CLERK_NOTE.title}
        </h2>
        <p className='max-w-prose text-sm'>{CLERK_NOTE.text}</p>
        <p className='text-muted-foreground max-w-prose text-sm'>{CLERK_NOTE.disconnect}</p>
        <div className='flex flex-wrap gap-2'>
          {link.external
            ? <a href={link.href} target='_blank' rel='noopener noreferrer' className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                {link.label}<Icons.externalLink aria-hidden='true' /><span className='sr-only'> (opens in a new tab)</span>
              </a>
            : <a href={link.href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{link.label}</a>}
          {link.external && <a href='/app/profile' className={buttonVariants({ variant: 'ghost', size: 'sm' })}>Your profile</a>}
        </div>
      </section>
      {error ? <ErrorState error={error} /> : (
        <div data-connected-apps-seen=''>
          <RecordView<SeenApp>
            id='app-connected-apps-seen' compact noun='apps' rows={clients} rowKey={(c) => c.client} cols={cols} loading={!data} exportName='connected-apps'
            searchText={(c) => c.client} searchPlaceholder='Search apps'
            toolbarAction={<ConnectButton />}
            actions={(c) => [{ label: 'Remove from this list', icon: <Icons.trash />, destructive: true, disabled: busy === c.client, onSelect: () => setAsk(c) }]}
            detailTitle={(c) => c.client}
            detail={(c) => (
              <div className='flex flex-col gap-4 text-sm'>
                <dl>
                  <Field label='Last seen'><When d={c.last} /></Field>
                </dl>
                <div className='flex flex-col gap-2'>
                  <h3 className='font-medium'>How to disconnect it</h3>
                  <ol className='text-muted-foreground list-decimal space-y-1 pl-5'>
                    {disconnectSteps(c.client).map((s) => <li key={s}>{s}</li>)}
                  </ol>
                </div>
                <Button variant='outline' size='sm' className='self-start' disabled={busy === c.client} onClick={() => setAsk(c)}>
                  <Icons.trash aria-hidden='true' />Remove from this list<span className='sr-only'> ({c.client})</span>
                </Button>
              </div>
            )}
            empty={{ title: SEEN_EMPTY.title, text: SEEN_EMPTY.text, action: SEEN_EMPTY.cta }}
          />
          {partial && <p className='text-muted-foreground mt-2 text-xs' data-connected-apps-partial=''>{partial}</p>}
        </div>
      )}
      <AlertDialog open={!!ask} onOpenChange={(o) => !o && setAsk(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{q?.title}</AlertDialogTitle>
            <AlertDialogDescription>{q?.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={() => { if (ask) forget(ask); setAsk(null); }}>{q?.action}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function ConnectedAppsPage() {
  return (
    <PageContainer pageTitle={PAGE_TITLE} pageDescription={CLERK ? undefined : DESCRIPTION}>
      {CLERK ? <HostedConnectedApps /> : <BuiltinConnectedApps />}
    </PageContainer>
  );
}
