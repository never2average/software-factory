'use client';
import { ClerkProvider } from '@clerk/nextjs';
import { BuiltinAuthProvider } from '@/lib/auth/builtin-client';
import { CLERK } from '@/lib/auth/provider';
import React, { useMemo } from 'react';
import { clerkLocalization, useClerkWords } from '@/features/auth/components/auth-words';
import { ActiveThemeProvider } from '../themes/active-theme';
import QueryProvider from './query-provider';
import { profile } from '@/config/profile.generated';

/** The sign-up form's subtitle: the profile's sign_up_subtitle (mold_v0-140; a host pack's profile may set it), else its short description. */
const signUpSubtitle = (profile as Readonly<Record<string, unknown>>).sign_up_subtitle;
/** The shell's words for Clerk's sign-in and sign-up widgets. */
const CLERK_WORDS = {
  signIn: { start: { title: `Sign in to ${profile.name}`, subtitle: 'Welcome back' } },
  signUp: { start: { title: `Create your ${profile.name} account`, subtitle: typeof signUpSubtitle === 'string' ? signUpSubtitle : profile.short_description } }
};

export default function Providers({
  activeThemeValue,
  children
}: {
  activeThemeValue: string;
  children: React.ReactNode;
}) {
  // mold_v0-266: the open sign-in or sign-up page's saved words over the shell's (none saved: the shell's, as before).
  const words = useClerkWords();
  const localization = useMemo(() => clerkLocalization(CLERK_WORDS, words), [words]);
  return (
    <>
      <ActiveThemeProvider initialTheme={activeThemeValue}>
        {/* The built-in sign-in (mold_v0-004) needs no provider's script: one read of /api/auth/session. */}
        {!CLERK ? <BuiltinAuthProvider><QueryProvider>{children}</QueryProvider></BuiltinAuthProvider> : <ClerkProvider
          localization={localization}
          appearance={{
            variables: {
              colorPrimary: 'var(--primary)',
              colorPrimaryForeground: 'var(--primary-foreground)',
              colorDanger: 'var(--destructive)',
              colorBackground: 'var(--card)',
              colorForeground: 'var(--foreground)',
              colorMuted: 'var(--muted)',
              colorMutedForeground: 'var(--muted-foreground)',
              colorInput: 'var(--input)',
              colorInputForeground: 'var(--foreground)',
              colorBorder: 'var(--border)',
              colorRing: 'var(--ring)',
              fontFamily: 'var(--font-sans)'
            }
          }}
        >
          <QueryProvider>{children}</QueryProvider>
        </ClerkProvider>}
      </ActiveThemeProvider>
    </>
  );
}
