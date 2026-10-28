'use client';
/**
 * The portal's page for a signed-in person with no account open here (mold_v0-098), in place of every portal page: the
 * API answers their calls with 403 no_account (src/app.ts customerSession), which the portal's layout asks about before it
 * draws a page (web/src/app/app/layout.tsx). Plain words, and every way forward:
 *   - who they are signed in as, and signing out to use another address;
 *   - the invitations waiting for their address (and a Clerk invitation ticket in the address), the same choices as the
 *     portal's invitation dialog (./invitation-landing.tsx), and, with no organization active, the ones they are in;
 *   - platform staff: the admin console, where an account is made first;
 *   - everyone else (staff open accounts themselves): the request form (POST /api/access-requests), their address and name filled in, then a confirmation.
 * Accounts are made by the platform's staff (invite-only) or, under Clerk with self-serve on, from an organization.
 */
import { useState } from 'react';
import { SignOutButton, useOrganizationList, useUser } from '@/lib/auth';
import { BrandLogo } from '@/components/brand';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Icons } from '@/components/icons';
import { fill } from '@/lib/vocabulary';
import { RequestAccessForm } from '@/features/site/request-access-form';
import { InvitationButtons, useInvitationChoices } from './invitation-landing';

export interface NoAccountProps {
  /** `no_account`: nothing open (the API's 403); `choose`: signed in with no active account but in some (Clerk). */
  reason: 'no_account' | 'choose';
  /** The address the server knows them by (/admin/session), until the browser's sign-in has loaded. */
  email?: string | null;
  platformAdmin?: boolean;
}

export function NoAccount({ reason, email: serverEmail = null, platformAdmin = false }: NoAccountProps) {
  const { user } = useUser();
  const { isLoaded, setActive, userMemberships } = useOrganizationList({ userMemberships: true });
  // The pending invitations (and a Clerk invitation ticket in the address), as the portal's invitation dialog offers them.
  const invites = useInvitationChoices();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const email = user?.primaryEmailAddress?.emailAddress || serverEmail || '';
  const name = user ? [user.firstName, user.lastName].filter(Boolean).join(' ') : '';
  // `choose` (Clerk, no organization active): the person's organizations, to make one active.
  const mine = reason === 'choose' ? (userMemberships?.data ?? []).map((m) => ({ id: m.organization.id, name: m.organization.name })) : [];
  const choosing = mine.length > 0;
  // `choose`: the directory's list is still loading; nothing to offer yet, so no form either.
  const pending = reason === 'choose' && !choosing && !isLoaded;
  // A full load after switching, so the layout asks the server again with the new account.
  const open = async (id: string) => {
    setBusy(id); setProblem(null);
    try {
      await setActive?.({ organization: id });
      window.location.assign('/app');
    } catch (e) {
      setProblem((e as Error).message || 'That did not work. Try again.');
      setBusy(null);
    }
  };

  return (
    <div className='flex min-h-screen flex-col'>
      <header className='border-b'>
        <div className='mx-auto flex min-h-16 w-full max-w-3xl items-center justify-between gap-3 px-4 py-3 sm:px-6'>
          <BrandLogo className='min-w-0' />
          <SignOutButton redirectUrl='/auth/sign-in'>
            <Button variant='ghost' className='h-10'><Icons.logout aria-hidden='true' /> Sign out</Button>
          </SignOutButton>
        </div>
      </header>
      <main id='main' className='flex-1'>
        <div className='mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 sm:px-6 sm:py-14' data-testid='no-account'>
          <div className='flex flex-col gap-3'>
            <h1 className='text-2xl font-semibold tracking-tight text-balance break-words sm:text-3xl'>
              {choosing ? fill('Choose your {product} {account}') : fill('You are not in a {product} {account} yet')}
            </h1>
            <p className='text-muted-foreground break-words'>
              Signed in as <span className='text-foreground font-medium break-all' data-testid='signed-in-as'>{email || 'an address with no email'}</span>.{' '}
              <SignOutButton redirectUrl='/auth/sign-in'>
                <button type='button' className='text-foreground inline-flex min-h-6 items-center underline underline-offset-4'>Sign out and use another address</button>
              </SignOutButton>
            </p>
            {!choosing && !platformAdmin ? (
              <p className='text-muted-foreground break-words'>
                {fill('{product} {accounts} are opened by invitation. If someone you work with already uses {product}, ask them to invite')}{' '}
                {email ? <span className='text-foreground break-all'>{email}</span> : 'you'}. Otherwise, ask for access below.
              </p>
            ) : null}
          </div>

          {problem ? <p role='alert' className='text-destructive text-sm'>{problem}</p> : null}

          {platformAdmin ? (
            <section aria-labelledby='no-account-admin' className='bg-card flex flex-col gap-3 rounded-xl border p-5'>
              <h2 id='no-account-admin' className='flex items-center gap-2 text-lg font-semibold'><Icons.shield aria-hidden='true' className='text-primary size-5 shrink-0' /> You are platform staff</h2>
              <p className='text-muted-foreground text-sm break-words'>
                {fill('The admin console works without an {account}. To use this portal yourself, create an {account} there first and invite your own address to it; then come back here.')}
              </p>
              <div>
                <a href='/admin' className={cn(buttonVariants(), 'h-10 px-4')} data-testid='open-admin'>Open the admin console <Icons.arrowRight aria-hidden='true' /></a>
              </div>
            </section>
          ) : null}

          {choosing ? (
            <section aria-labelledby='no-account-yours' className='flex flex-col gap-3'>
              <h2 id='no-account-yours' className='text-lg font-semibold'>{fill('Your {accounts}')}</h2>
              <ul className='flex flex-col gap-2'>
                {mine.map((a) => (
                  <li key={a.id}>
                    <Button variant='outline' className='h-auto min-h-11 w-full justify-between gap-3 py-2 text-left whitespace-normal' disabled={!!busy} onClick={() => void open(a.id)}>
                      <span className='min-w-0 break-words'>Open {a.name}</span>
                      {busy === a.id ? <Icons.spinner aria-hidden='true' className='animate-spin' /> : <Icons.arrowRight aria-hidden='true' />}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {invites.any ? (
            <section aria-labelledby='no-account-invitations' className='flex flex-col gap-3' data-testid='no-account-invitations'>
              <h2 id='no-account-invitations' className='text-lg font-semibold'>{invites.invitations.length ? 'You have an invitation' : 'Accept your invitation'}</h2>
              {/* A full load after joining, so the layout asks the server again with the new account. */}
              <InvitationButtons choices={invites} onJoined={() => window.location.assign('/app')} />
            </section>
          ) : null}

          {pending ? <p role='status'><Icons.spinner aria-hidden='true' className='text-muted-foreground size-5 animate-spin' /><span className='sr-only'>{fill('Loading your {accounts}')}</span></p> : null}

          {!choosing && !pending && !platformAdmin ? (
            <section aria-labelledby='no-account-request' className='flex flex-col gap-4'>
              <div className='flex flex-col gap-1'>
                <h2 id='no-account-request' className='text-lg font-semibold'>Ask for access</h2>
                <p className='text-muted-foreground text-sm break-words'>{fill('The {product} team reads every request. When yours is approved, an invitation comes to your email.')}</p>
              </div>
              <RequestAccessForm from='/app' defaults={{ email, name }} key={email} />
            </section>
          ) : null}
        </div>
      </main>
    </div>
  );
}

/**
 * The same answer met inside a page (an account switched away in another tab): a short notice that leads to the page
 * above, in place of an error card.
 */
export function NoAccountNotice() {
  return (
    <div role='status' className='bg-card flex flex-col gap-3 rounded-xl border p-5' data-testid='no-account-notice'>
      <p className='font-semibold'>{fill('You are not in a {product} {account} here')}</p>
      <p className='text-muted-foreground text-sm'>{fill('Open one of your {accounts}, accept an invitation, or ask for access.')}</p>
      <div><a href='/app' className={cn(buttonVariants(), 'h-10 px-4')}>See your options <Icons.arrowRight aria-hidden='true' /></a></div>
    </div>
  );
}
