import { SignUp } from '@clerk/nextjs';
import Link from 'next/link';
import { fill } from '@/lib/vocabulary';
import { CLERK } from '@/lib/auth/provider';
import { accountsMode } from '@/features/site/accounts-mode';
import { AuthShell } from './auth-shell';
import { BuiltinSignIn } from './builtin-sign-in';

/**
 * Under the built-in sign-in, signing up is signing in with an invited address: the same form. When accounts are
 * invite-only (mold_v0-098), the page says so first and leads anyone without an invitation to the request form.
 */
export default async function SignUpViewPage() {
  const inviteOnly = (await accountsMode()) === 'invite_only';
  return (
    <AuthShell>
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
        {CLERK ? <SignUp fallbackRedirectUrl='/app' signInUrl='/auth/sign-in' /> : <BuiltinSignIn />}
      </div>
    </AuthShell>
  );
}
