import { SignUp } from '@clerk/nextjs';
import Link from 'next/link';
import { fill } from '@/lib/vocabulary';
import { CLERK } from '@/lib/auth/provider';
import { accountsMode } from '@/features/site/accounts-mode';
import { AuthShell } from './auth-shell';
import { BuiltinSignIn } from './builtin-sign-in';
import { ApplyClerkWords } from './auth-words';
import { clerkAppearance } from './clerk-appearance';
import { accessPagesLive } from '@/features/site/access-pages-live';

/**
 * Under the built-in sign-in, signing up is signing in with an invited address: the same form. When accounts are
 * invite-only (mold_v0-098), the page says so first and leads anyone without an invitation to the request form.
 */
export default async function SignUpViewPage() {
  const inviteOnly = (await accountsMode()) === 'invite_only';
  // mold_v0-266: the words staff saved (Admin › Access requests › Sign-in page), read on each request; else the page's own.
  const cfg = (await accessPagesLive()).sign_in;
  return (
    <AuthShell legal={cfg?.legal}>
      <div className='flex flex-col items-center gap-6'>
        {inviteOnly ? (
          <div className='bg-card text-card-foreground w-full max-w-sm rounded-xl border p-4 text-sm' data-testid='invite-only-note'>
            <p className='font-medium'>{fill('{product} is invite-only.')}</p>
            <p className='text-muted-foreground mt-1'>
              Invited? Continue below with the address the invitation went to. No invitation yet?{' '}
              <Link href='/request-access' className='text-foreground inline-flex min-h-6 items-center font-medium underline underline-offset-4'>Request access</Link>
            </p>
          </div>
        ) : null}
        {CLERK ? (
          <>
            {cfg ? <ApplyClerkWords words={{ page: 'sign_up', words: cfg.sign_up ?? {}, ...(cfg.social_button ? { social_button: cfg.social_button } : {}) }} /> : null}
            <SignUp fallbackRedirectUrl='/app' signInUrl='/auth/sign-in' {...(cfg?.hidden_methods?.length ? { appearance: clerkAppearance(cfg.hidden_methods) } : {})} />
          </>
        ) : <BuiltinSignIn words={cfg?.sign_up} socialButton={cfg?.social_button} hidden={cfg?.hidden_methods} />}
      </div>
    </AuthShell>
  );
}
