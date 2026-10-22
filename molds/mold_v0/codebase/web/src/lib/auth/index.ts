'use client';
/**
 * The console's sign-in hooks (mold_v0-004): Clerk's own when the build runs Clerk (src/lib/auth/provider.ts), else the
 * built-in sign-in's, which answer the same calls in Clerk's shapes (src/lib/auth/builtin-client.tsx). Components import
 * from here, never from @clerk/nextjs, so one build runs either. Under Clerk these are Clerk's functions, unchanged.
 */
import * as C from '@clerk/nextjs';
import * as B from './builtin-client';
import { CLERK } from './provider';

export { AUTH_PROVIDER, CLERK } from './provider';
export { BuiltinAuthProvider, useBuiltinSession, authPost } from './builtin-client';

export const useAuth = (CLERK ? C.useAuth : B.useAuth) as typeof C.useAuth;
export const useUser = (CLERK ? C.useUser : B.useUser) as unknown as typeof C.useUser;
export const useOrganization = (CLERK ? C.useOrganization : B.useOrganization) as unknown as typeof C.useOrganization;
export const useOrganizationList = (CLERK ? C.useOrganizationList : B.useOrganizationList) as unknown as typeof C.useOrganizationList;
export const useClerk = (CLERK ? C.useClerk : B.useClerk) as unknown as typeof C.useClerk;
export const useSession = (CLERK ? C.useSession : B.useSession) as unknown as typeof C.useSession;
export const SignOutButton = (CLERK ? C.SignOutButton : B.SignOutButton) as typeof C.SignOutButton;
