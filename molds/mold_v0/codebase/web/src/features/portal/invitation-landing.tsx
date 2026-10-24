'use client';
/**
 * Clerk only: lines the session's active organization up with the account the server uses, and lands an invitation
 * link for someone already signed in.
 *
 * Clerk's invitation email links to /app/?__clerk_ticket=…&__clerk_status=…; only Clerk's sign-in and sign-up pages
 * consume that ticket, so a person already signed in (with, say, an organization they made themselves active) never
 * accepted it. The server accepts a pending invitation to one of their verified addresses on their first /api/app call
 * (src/app.ts customerSession); /api/app/me then names the account, and this makes it the active organization, so the
 * console stops showing the self-made one. When the server still finds no account: the person's pending invitations
 * (Clerk's own list) with a Join button each, or, for a ticket addressed to another of their addresses, a way to sign
 * out and accept it with that address.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CLERK, useClerk, useOrganizationList } from '@/lib/auth';
import { appApi, ApiError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';

const TICKET_PARAMS = ['__clerk_ticket', '__clerk_status'];

/** Drops the invitation ticket from the address bar (it is used, or no use here). */
function dropTicket() {
  const url = new URL(window.location.href);
  if (!TICKET_PARAMS.some((p) => url.searchParams.has(p))) return;
  for (const p of TICKET_PARAMS) url.searchParams.delete(p);
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
}

export function InvitationLanding({ activeOrgId }: { activeOrgId: string | null }) {
  return CLERK ? <Landing activeOrgId={activeOrgId} /> : null;
}

function Landing({ activeOrgId }: { activeOrgId: string | null }) {
  const router = useRouter();
  const { signOut } = useClerk();
  const { isLoaded, setActive, userInvitations } = useOrganizationList({ userInvitations: { status: 'pending' } });
  const [noAccount, setNoAccount] = useState(false);
  const [ticket, setTicket] = useState<{ ticket: string; status: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const checked = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !setActive || checked.current === (activeOrgId ?? '')) return;
    checked.current = activeOrgId ?? '';
    const q = new URLSearchParams(window.location.search);
    const t = q.get('__clerk_ticket');
    if (t) setTicket({ ticket: t, status: q.get('__clerk_status') ?? 'sign_in' });
    appApi<{ account?: { clerk_org_id?: string | null } }>('GET', '/me').then(async (me) => {
      setNoAccount(false);
      dropTicket();
      const id = me.account?.clerk_org_id;
      if (id && id !== activeOrgId) {
        await setActive({ organization: id });
        router.refresh();
      }
    }, (e) => {
      if (e instanceof ApiError && e.status === 403 && e.body.code === 'no_account') setNoAccount(true);
    }).catch(() => {}); // setActive refused: the server still uses the account, so the pages work
  }, [isLoaded, setActive, activeOrgId, router]);

  if (!noAccount) return null;
  const invitations = userInvitations.data ?? [];
  const join = async (inv: (typeof invitations)[number]) => {
    setBusy(true);
    try {
      await inv.accept();
      await setActive?.({ organization: inv.publicOrganizationData.id });
      dropTicket();
      setNoAccount(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };
  // A ticket for an address this person has no pending invitation under: accept it signed in with that address.
  const acceptWithInvitedAddress = () => {
    const to = ticket!.status === 'sign_up' ? '/auth/sign-up' : '/auth/sign-in';
    const q = new URLSearchParams({ __clerk_ticket: ticket!.ticket, __clerk_status: ticket!.status, redirect_url: '/app' });
    void signOut({ redirectUrl: `${to}?${q}` });
  };
  if (!invitations.length && !ticket) return null;
  return (
    <div role='dialog' aria-labelledby='invitation-landing-title' className='bg-background fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md flex-col gap-3 rounded-lg border p-4 shadow-lg'>
      <h2 id='invitation-landing-title' className='font-semibold'>{invitations.length ? 'You have an invitation' : 'Accept your invitation'}</h2>
      {invitations.length ? (
        <ul className='flex flex-col gap-2'>
          {invitations.map((i) => (
            <li key={i.id}>
              <Button className='w-full justify-between' disabled={busy} onClick={() => void join(i)}>
                Join {i.publicOrganizationData.name}<Icons.arrowRight />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <p className='text-muted-foreground text-sm'>
            This invitation was sent to a different email address than the one you are signed in with. Sign out, then sign
            in with the invited address to accept it.
          </p>
          <Button onClick={acceptWithInvitedAddress}>Sign out and accept<Icons.arrowRight /></Button>
        </>
      )}
    </div>
  );
}
