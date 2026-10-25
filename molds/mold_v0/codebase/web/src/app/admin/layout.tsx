import { AreaShell } from '@/components/layout/area-shell';
import { adminNav } from '@/config/nav-config';
import { serverApi } from '@/lib/server-api';
import { protect } from '@/lib/auth/server';
import { CLERK } from '@/lib/auth/provider';
import { forbidden } from 'next/navigation';
import { toSignIn } from '@/features/status/server';
import { AdminRoleProvider, type AdminSession } from '@/features/admin/role';
import type { Metadata } from 'next';
import { profile } from '@/config/profile.generated';
// Server-only: the internal docs index (titles and headings) goes to the Cmd+K bar of signed-in admins, never to /app.
import { adminDocsNav } from '@/features/docs/admin-docs';

export const metadata: Metadata = { title: { default: 'Admin', template: `%s | ${profile.console_title} Admin` } };

/** Platform staff only: the API server decides who is a platform admin and their role (src/admin-roles.ts). */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await protect();
  const s = await serverApi<{ signed_in?: boolean; email: string | null; is_platform_admin: boolean } & AdminSession>('/admin/session');
  // The standard status pages (mold_v0-131): the session ended, sign in and come back; the API failed, the error page
  // (Try again); signed in but not platform staff, forbidden.tsx (a 403 that says who they are and leads to their account).
  // (Under Clerk a session Clerk accepts and the API does not is a setup problem: refused, never a sign-in loop.)
  if (s.status === 401 || (!CLERK && s.body?.signed_in === false)) await toSignIn();
  if (s.status >= 500 || !s.body) throw new Error(`The admin session could not be read (${s.status})`);
  if (!s.body!.is_platform_admin) forbidden();
  const role = { role: s.body!.role, permissions: s.body!.permissions ?? [], needs: s.body!.needs ?? {} };
  return <AdminRoleProvider session={role}><AreaShell area='admin' groups={adminNav} docs={adminDocsNav()}>{children}</AreaShell></AdminRoleProvider>;
}
