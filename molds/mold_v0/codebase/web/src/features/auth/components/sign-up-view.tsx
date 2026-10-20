import { SignUp } from '@clerk/nextjs';
import { AuthShell } from './auth-shell';

export default function SignUpViewPage() {
  return (
    <AuthShell>
      <SignUp fallbackRedirectUrl='/app' signInUrl='/auth/sign-in' />
    </AuthShell>
  );
}
