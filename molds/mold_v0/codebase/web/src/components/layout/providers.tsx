'use client';
import { ClerkProvider } from '@clerk/nextjs';
import { BuiltinAuthProvider } from '@/lib/auth/builtin-client';
import { CLERK } from '@/lib/auth/provider';
import React from 'react';
import { ActiveThemeProvider } from '../themes/active-theme';
import QueryProvider from './query-provider';
import { profile } from '@/config/profile.generated';

/** The sign-up form's subtitle: the profile's sign_up_subtitle (mold_v0-140; a host pack's profile may set it), else its short description. */
const signUpSubtitle = (profile as Readonly<Record<string, unknown>>).sign_up_subtitle;

export default function Providers({
  activeThemeValue,
  children
}: {
  activeThemeValue: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <ActiveThemeProvider initialTheme={activeThemeValue}>
        {/* The built-in sign-in (mold_v0-004) needs no provider's script: one read of /api/auth/session. */}
        {!CLERK ? <BuiltinAuthProvider><QueryProvider>{children}</QueryProvider></BuiltinAuthProvider> : <ClerkProvider
          localization={{
            signIn: { start: { title: `Sign in to ${profile.name}`, subtitle: 'Welcome back' } },
            signUp: { start: { title: `Create your ${profile.name} account`, subtitle: typeof signUpSubtitle === 'string' ? signUpSubtitle : profile.short_description } }
          }}
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
