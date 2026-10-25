'use client';
/**
 * /app/connected-apps (mold_v0-087): each person's own connected apps, the AI apps signed in to /mcp.
 * Built-in sign-in: the list (GET /api/oauth/grants, src/mcp-oauth.ts), across the person's workspaces, with Revoke.
 * Clerk: Clerk keeps the connections and has no API to list them, so the page says so and links to the account there.
 * Words and rules: ./model.ts.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Icons } from '@/components/icons';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ErrorState, LoadingCards, When, fail, useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { CLERK } from '@/lib/auth/provider';
import { W } from '@/lib/vocabulary';
import { appIdentity, appName, CLERK_NOTE, clerkAccountLink, DESCRIPTION, EMPTY, PAGE_TITLE, revokeQuestion, type ConnectedApp } from './model';

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

function AppCell({ app }: { app: ConnectedApp }) {
  const id = appIdentity(app);
  return (
    <div className='flex min-w-0 flex-col gap-1'>
      <span className='font-medium'>{appName(app)}</span>
      {id.verified ? (
        <span className='text-muted-foreground flex items-center gap-1 text-xs'>
          <Icons.circleCheck className='size-3.5 shrink-0' aria-hidden='true' />
          <span>Verified: </span>
          <a href={id.url} target='_blank' rel='noopener noreferrer' className='truncate underline-offset-4 hover:underline'>{id.host}</a>
        </span>
      ) : (
        <Badge variant='outline' className='w-fit font-normal' title={id.note}>Not verified</Badge>
      )}
    </div>
  );
}

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
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingCards count={1} />;
  if (!data.grants.length) {
    return (
      <div data-connected-apps='empty' className='flex max-w-xl flex-col items-start gap-2 rounded-md border border-dashed p-6'>
        <h2 className='text-base font-semibold'>{EMPTY.title}</h2>
        <p className='text-muted-foreground text-sm'>{EMPTY.text}</p>
        <a href={EMPTY.cta.href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{EMPTY.cta.label}</a>
      </div>
    );
  }
  const q = ask ? revokeQuestion(ask) : null;
  return (
    <div data-connected-apps='list'>
      <Table label={PAGE_TITLE}>
        <TableHeader>
          <TableRow>
            <TableHead>App</TableHead>
            <TableHead>{W.Workspace}</TableHead>
            <TableHead>Connected</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead><span className='sr-only'>Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.grants.map((g) => (
            <TableRow key={g.id} data-connected-app={g.id}>
              <TableCell className='max-w-72'><AppCell app={g} /></TableCell>
              <TableCell>{g.workspace.name}</TableCell>
              <TableCell><When d={g.created_at} /></TableCell>
              <TableCell><When d={g.last_used_at} /></TableCell>
              <TableCell className='text-right'>
                <Button variant='outline' size='sm' disabled={busy === g.id} onClick={() => setAsk(g)}>
                  Revoke<span className='sr-only'> {appName(g)} in {g.workspace.name}</span>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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

function ClerkConnectedApps() {
  const link = clerkAccountLink(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  return (
    <section data-connected-apps='provider' aria-labelledby='connected-apps-provider' className='flex max-w-xl flex-col items-start gap-3 rounded-md border p-6'>
      <h2 id='connected-apps-provider' className='flex items-center gap-2 text-base font-semibold'>
        <Icons.shield className='size-4' aria-hidden='true' />{CLERK_NOTE.title}
      </h2>
      <p className='text-sm'>{CLERK_NOTE.text}</p>
      <p className='text-muted-foreground text-sm'>{CLERK_NOTE.disconnect}</p>
      <div className='flex flex-wrap gap-2'>
        {link.external
          ? <a href={link.href} target='_blank' rel='noopener noreferrer' className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              {link.label}<Icons.externalLink aria-hidden='true' /><span className='sr-only'> (opens in a new tab)</span>
            </a>
          : <a href={link.href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{link.label}</a>}
        {link.external && <a href='/app/profile' className={buttonVariants({ variant: 'ghost', size: 'sm' })}>Your profile</a>}
      </div>
    </section>
  );
}

export function ConnectedAppsPage() {
  return (
    <PageContainer pageTitle={PAGE_TITLE} pageDescription={CLERK ? undefined : DESCRIPTION}>
      {CLERK ? <ClerkConnectedApps /> : <BuiltinConnectedApps />}
    </PageContainer>
  );
}
