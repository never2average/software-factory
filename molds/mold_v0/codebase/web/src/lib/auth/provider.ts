/**
 * Which sign-in the console runs (mold_v0-004), fixed at build time by next.config.ts from AUTH_PROVIDER (or
 * NEXT_PUBLIC_AUTH_PROVIDER), else Clerk when NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is set (an app already on Clerk keeps
 * it), else the built-in sign-in: an emailed code and Google, served by the API server's /api/auth (src/builtin-auth.ts).
 */
export type AuthProviderName = 'builtin' | 'clerk';
export const AUTH_PROVIDER: AuthProviderName = process.env.NEXT_PUBLIC_AUTH_PROVIDER === 'clerk' ? 'clerk' : 'builtin';
export const CLERK = AUTH_PROVIDER === 'clerk';

/** The built-in session cookies (src/builtin-auth.ts): `__Host-` on https, the plain name on http for local work. */
export const BUILTIN_SESSION_COOKIES = ['__Host-oct_session', 'oct_session'] as const;
