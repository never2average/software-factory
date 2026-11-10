import { SignIn } from '@clerk/nextjs';
import { CLERK } from '@/lib/auth/provider';
import { AuthShell } from './auth-shell';
import { BuiltinSignIn } from './builtin-sign-in';

/** The sign-in page: the build's own words (mold_v0-289: staff no longer edit them). */
export default async function SignInViewPage() {
  return (
    <AuthShell>
      {CLERK ? <SignIn fallbackRedirectUrl='/app' signUpUrl='/auth/sign-up' /> : <BuiltinSignIn />}
    </AuthShell>
  );
}
