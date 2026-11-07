import { SignIn } from '@clerk/nextjs';
import { CLERK } from '@/lib/auth/provider';
import { accessPagesLive } from '@/features/site/access-pages-live';
import { AuthShell } from './auth-shell';
import { ApplyClerkWords } from './auth-words';
import { BuiltinSignIn } from './builtin-sign-in';
import { clerkAppearance } from './clerk-appearance';

/** mold_v0-266: the words staff saved (Admin › Access requests › Sign-in page), read on each request; else the page's own. */
export default async function SignInViewPage() {
  const cfg = (await accessPagesLive()).sign_in;
  return (
    <AuthShell legal={cfg?.legal}>
      {CLERK ? (
        <>
          {cfg ? <ApplyClerkWords words={{ page: 'sign_in', words: cfg.sign_in ?? {}, ...(cfg.social_button ? { social_button: cfg.social_button } : {}) }} /> : null}
          <SignIn fallbackRedirectUrl='/app' signUpUrl='/auth/sign-up' {...(cfg?.hidden_methods?.length ? { appearance: clerkAppearance(cfg.hidden_methods) } : {})} />
        </>
      ) : <BuiltinSignIn words={cfg?.sign_in} socialButton={cfg?.social_button} hidden={cfg?.hidden_methods} />}
    </AuthShell>
  );
}
