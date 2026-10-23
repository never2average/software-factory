import { AreaShell } from '@/components/layout/area-shell';
import { portalNav } from '@/config/nav-config';
import { protect } from '@/lib/auth/server';
import type { Metadata } from 'next';
import { profile } from '@/config/profile.generated';
import { serverApi } from '@/lib/server-api';
import { NoAccount } from '@/features/portal/no-account';
import { customerDocsNav } from '@/features/docs/customer-docs';

export const metadata: Metadata = { title: { default: 'Account', template: `%s | ${profile.console_title}` } };

interface Refusal { code?: string; accounts?: { id: string; name: string }[] }

/**
 * The customer portal works on the user's active workspace (Clerk organization, or the built-in sign-in's; switchable in
 * the sidebar). Before drawing a page it asks the API whether the person has an account open here (GET /api/app/access);
 * when they do not (403 no_account: no membership, or a directory organization that is not an account), or Clerk has no
 * organization active, every portal route shows the page for that (mold_v0-098) instead of pages that cannot load.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const { orgId } = await protect();
  const gate = await serverApi<Refusal>('/api/app/access').catch(() => null);
  const refused = gate?.status === 403 && gate.body?.code === 'no_account';
  if (!orgId || refused) {
    // Platform staff with no customer account of their own get a way into the admin panel from here.
    const s = await serverApi<{ is_platform_admin: boolean; email: string | null }>('/admin/session').catch(() => null);
    return <NoAccount reason={refused ? 'no_account' : 'choose'} accounts={refused ? (gate?.body?.accounts ?? []) : []}
      email={s?.body?.email ?? null} platformAdmin={!!s?.body?.is_platform_admin} />;
  }
  return <AreaShell area='portal' groups={portalNav} docs={customerDocsNav()}>{children}</AreaShell>;
}
