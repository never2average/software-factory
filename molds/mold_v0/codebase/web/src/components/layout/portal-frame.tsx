import { AreaShell } from '@/components/layout/area-shell';
import { portalNav } from '@/config/nav-config';
import { protect } from '@/lib/auth/server';
import { serverApi } from '@/lib/server-api';
import { NoAccount, PlatformAccountProblem } from '@/features/portal/no-account';
import { InvitationLanding } from '@/features/portal/invitation-landing';
import { customerDocsNav } from '@/features/docs/customer-docs';

interface Refusal { code?: string; error?: string }

/**
 * The customer portal's frame (app/app/layout.tsx; and the root not-found page's for an unknown /app address,
 * mold_v0-155). It works on the user's active workspace (Clerk organization, or the built-in sign-in's; switchable in
 * the sidebar). Before drawing a page it asks the API whether the person has an account open here (GET /api/app/access);
 * when they do not (403 no_account: no account membership, and no pending invitation the server could accept), or Clerk has
 * no organization active, every portal route shows the page for that (mold_v0-098) instead of pages that cannot load.
 * Never to platform staff: the API puts them in the platform account (mold_v0-276); they see PlatformAccountProblem only
 * when that failed, with a way to try again.
 */
export async function PortalFrame({ children }: { children: React.ReactNode }) {
  const { orgId } = await protect();
  const gate = await serverApi<Refusal>('/api/app/access').catch(() => null);
  const refused = gate?.status === 403 && gate.body?.code === 'no_account';
  // No organization active but an account the server uses (src/app.ts: the oldest account membership): the pages work,
  // and InvitationLanding makes that account the active organization.
  // Platform staff are put in the platform account by the API itself (mold_v0-276, src/platform-account.ts), so they never
  // get the page for no account: when that could not be done just now, they are told so and may try again.
  if (gate?.status === 503 && gate.body?.code === 'platform_account_unavailable') return <PlatformAccountProblem message={gate.body.error ?? null} />;
  if (refused || (!orgId && gate?.status !== 200)) {
    const s = await serverApi<{ is_platform_admin: boolean; email: string | null }>('/admin/session').catch(() => null);
    if (s?.body?.is_platform_admin) return <PlatformAccountProblem message={gate?.body?.error ?? null} />;
    return <NoAccount reason={refused ? 'no_account' : 'choose'} email={s?.body?.email ?? null} />;
  }
  return (
    <AreaShell area='portal' groups={portalNav} docs={customerDocsNav()}>
      {children}
      <InvitationLanding activeOrgId={orgId ?? null} />
    </AreaShell>
  );
}
