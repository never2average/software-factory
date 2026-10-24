import { AreaShell } from '@/components/layout/area-shell';
import { portalNav } from '@/config/nav-config';
import { protect } from '@/lib/auth/server';
import type { Metadata } from 'next';
import { profile } from '@/config/profile.generated';
import { serverApi } from '@/lib/server-api';
import { NoOrganization } from '@/features/portal/no-organization';
import { InvitationLanding } from '@/features/portal/invitation-landing';
import { customerDocsNav } from '@/features/docs/customer-docs';

export const metadata: Metadata = { title: { default: 'Account', template: `%s | ${profile.console_title}` } };

/** The customer portal works on the user's active workspace (Clerk organization, or the built-in sign-in's; switchable in the sidebar). */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const { orgId } = await protect();
  if (!orgId) {
    // Platform staff with no customer account of their own get a way into the admin panel from here.
    const s = await serverApi<{ is_platform_admin: boolean }>('/admin/session').catch(() => null);
    return <NoOrganization platformAdmin={!!s?.body?.is_platform_admin} />;
  }
  return (
    <AreaShell area='portal' groups={portalNav} docs={customerDocsNav()}>
      {children}
      <InvitationLanding activeOrgId={orgId} />
    </AreaShell>
  );
}
