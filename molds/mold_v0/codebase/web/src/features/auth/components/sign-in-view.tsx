import { SignIn } from '@clerk/nextjs';
import { CLERK } from '@/lib/auth/provider';
import { AuthShell } from './auth-shell';
import { BuiltinSignIn } from './builtin-sign-in';

export default function SignInViewPage() {
  return (
    <AuthShell>
      {CLERK ? <SignIn fallbackRedirectUrl='/app' signUpUrl='/auth/sign-up' /> : <BuiltinSignIn />}
    </AuthShell>
  );
}
