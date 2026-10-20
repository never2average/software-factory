import { SignIn } from '@clerk/nextjs';
import { AuthShell } from './auth-shell';

export default function SignInViewPage() {
  return (
    <AuthShell>
      <SignIn fallbackRedirectUrl='/app' signUpUrl='/auth/sign-up' />
    </AuthShell>
  );
}
