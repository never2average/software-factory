import 'server-only';
/**
 * Server components' sign-in check (mold_v0-004): Clerk's auth.protect() under Clerk, unchanged; under the built-in
 * sign-in the API server's /api/auth/session read with the browser's cookie (src/lib/server-api.ts), and a redirect to
 * the sign-in page when nobody is signed in. Returns the active workspace's directory id (Clerk's orgId).
 */
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { serverApi } from '@/lib/server-api';
import { CLERK } from './provider';

export async function protect(): Promise<{ orgId: string | null | undefined; userId: string | null | undefined }> {
  if (CLERK) return auth.protect();
  const s = await serverApi<{ signed_in: boolean; user?: { id: string }; active_organization?: { id: string } | null }>('/api/auth/session');
  if (!s.body?.signed_in) redirect('/auth/sign-in');
  return { orgId: s.body.active_organization?.id ?? null, userId: s.body.user?.id ?? null };
}
