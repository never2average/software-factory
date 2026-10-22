import { SignUp } from '@clerk/nextjs';
import { CLERK } from '@/lib/auth/provider';
import { AuthShell } from './auth-shell';
import { BuiltinSignIn } from './builtin-sign-in';

/** Under the built-in sign-in, signing up is signing in with an invited address: the same form. */
export default function SignUpViewPage() {
  return (
    <AuthShell>
      {CLERK ? <SignUp fallbackRedirectUrl='/app' signInUrl='/auth/sign-in' /> : <BuiltinSignIn />}
    </AuthShell>
  );
}
