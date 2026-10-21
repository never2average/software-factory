import { AreaShell } from '@/components/layout/area-shell';
import { portalNav } from '@/config/nav-config';
import { auth } from '@clerk/nextjs/server';
import type { Metadata } from 'next';
import { profile } from '@/config/profile.generated';
import { serverApi } from '@/lib/server-api';
import { NoOrganization } from '@/features/portal/no-organization';
import { customerDocsNav } from '@/features/docs/customer-docs';

export const metadata: Metadata = { title: { default: 'Account', template: `%s | ${profile.console_title}` } };

/** The customer portal works on the user's active Clerk organization (switchable in the sidebar). */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const { orgId } = await auth.protect();
  if (!orgId) {
    // Platform staff with no customer account of their own get a way into the admin panel from here.
    const s = await serverApi<{ is_platform_admin: boolean }>('/admin/session').catch(() => null);
    return <NoOrganization platformAdmin={!!s?.body?.is_platform_admin} />;
  }
  return <AreaShell area='portal' groups={portalNav} docs={customerDocsNav()}>{children}</AreaShell>;
}
