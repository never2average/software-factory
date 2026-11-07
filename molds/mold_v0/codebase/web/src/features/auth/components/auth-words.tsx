'use client';
/**
 * The sign-in and sign-up pages' words staff saved (mold_v0-266; Admin › Access requests › Sign-in page, src/access-pages.ts)
 * for Clerk's widgets: Clerk takes its words from ClerkProvider's `localization` (web/src/components/layout/providers.tsx),
 * above every page, so the auth page hands them over here and the provider merges them in (Clerk updates its widgets
 * when localization changes). Nothing saved: nothing is handed over and the provider's own words stand, as before.
 */
import { useLayoutEffect, useSyncExternalStore } from 'react';
import type { AuthWords } from '@/lib/access-request.generated';

export interface ClerkWords { page: 'sign_in' | 'sign_up'; words: AuthWords; social_button?: string }

let current: ClerkWords | null = null;
const subscribers = new Set<() => void>();
const subscribe = (f: () => void) => { subscribers.add(f); return () => void subscribers.delete(f); };

/** The words the open auth page handed over, or null. */
export const useClerkWords = () => useSyncExternalStore(subscribe, () => current, () => null);

/** On a sign-in or sign-up page: its saved words, for Clerk's widget, while the page is open. */
export function ApplyClerkWords({ words }: { words: ClerkWords }) {
  const key = JSON.stringify(words);
  useLayoutEffect(() => {
    current = JSON.parse(key) as ClerkWords;
    subscribers.forEach((f) => f());
    return () => { current = null; subscribers.forEach((f) => f()); };
  }, [key]);
  return null;
}

/**
 * Clerk's localization with the saved words over the shell's: each page's title and subtitle, the primary button (Clerk
 * has one for every step, so only the open page's), and a provider button ({provider} is Clerk's {{provider|titleize}}).
 */
export function clerkLocalization<T extends Record<string, unknown>>(base: T, w: ClerkWords | null): T {
  if (!w) return base;
  const start = (k: 'signIn' | 'signUp', page: 'sign_in' | 'sign_up') => {
    const own = ((base as Record<string, Record<string, Record<string, string>>>)[k]?.start ?? {});
    const words = w.page === page ? w.words : {};
    return { start: { ...own, ...(words.title ? { title: words.title } : {}), ...(words.subtitle ? { subtitle: words.subtitle } : {}) } };
  };
  return {
    ...base,
    signIn: { ...((base as Record<string, object>).signIn ?? {}), ...start('signIn', 'sign_in') },
    signUp: { ...((base as Record<string, object>).signUp ?? {}), ...start('signUp', 'sign_up') },
    ...(w.words.button ? { formButtonPrimary: w.words.button } : {}),
    ...(w.social_button ? { socialButtonsBlockButton: w.social_button.replace(/\{provider\}/g, '{{provider|titleize}}') } : {})
  };
}
