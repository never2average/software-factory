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

/**
 * The person's pending invitations and an invitation ticket in the address (Clerk), shared by the dialog below and the
 * portal's page for no account (web/src/features/portal/no-account.tsx, mold_v0-098), so both offer the same choices.
 * Under the built-in sign-in the invitations are its own (src/lib/auth/builtin-client.tsx) and there is no ticket.
 */
export function useInvitationChoices() {
  const { signOut } = useClerk();
  const { isLoaded, setActive, userInvitations } = useOrganizationList({ userInvitations: { status: 'pending' } });
  const [ticket, setTicket] = useState<{ ticket: string; status: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!CLERK) return;
    const q = new URLSearchParams(window.location.search);
    const t = q.get('__clerk_ticket');
    if (t) setTicket({ ticket: t, status: q.get('__clerk_status') ?? 'sign_in' });
  }, []);
  const invitations = (userInvitations?.data ?? []) as Invitation[];
  /** Accept one, make its organization the active one, then `after` (a refresh, or a full load). */
  const join = async (inv: Invitation, after: () => void) => {
    setBusy(true);
    try {
      await inv.accept();
      await setActive?.({ organization: inv.publicOrganizationData.id });
      dropTicket();
      after();
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
  return { isLoaded, setActive, invitations, ticket, busy, join, acceptWithInvitedAddress, any: invitations.length > 0 || !!ticket };
}
type Invitation = { id: string; publicOrganizationData: { id: string; name: string }; accept: () => Promise<unknown> };
export type InvitationChoices = ReturnType<typeof useInvitationChoices>;

/** "Join <name>" for each pending invitation; with none but a ticket, a way to accept it with the invited address. */
export function InvitationButtons({ choices, onJoined }: { choices: InvitationChoices; onJoined: () => void }) {
  const { invitations, busy, join, acceptWithInvitedAddress } = choices;
  if (invitations.length) {
    return (
      <ul className='flex flex-col gap-2'>
        {invitations.map((i) => (
          <li key={i.id}>
            <Button className='h-auto min-h-10 w-full justify-between gap-3 py-2 text-left whitespace-normal' disabled={busy} onClick={() => void join(i, onJoined)}>
              <span className='min-w-0 break-words'>Join {i.publicOrganizationData.name}</span><Icons.arrowRight aria-hidden='true' />
            </Button>
          </li>
        ))}
      </ul>
    );
  }
  if (!choices.ticket) return null;
  return (
    <>
      <p className='text-muted-foreground text-sm'>
        This invitation was sent to a different email address than the one you are signed in with. Sign out, then sign
        in with the invited address to accept it.
      </p>
      <div><Button className='h-10' onClick={acceptWithInvitedAddress}>Sign out and accept<Icons.arrowRight aria-hidden='true' /></Button></div>
    </>
  );
}

function Landing({ activeOrgId }: { activeOrgId: string | null }) {
  const router = useRouter();
  const choices = useInvitationChoices();
  const { isLoaded, setActive } = choices;
  const [noAccount, setNoAccount] = useState(false);
  const checked = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !setActive || checked.current === (activeOrgId ?? '')) return;
    checked.current = activeOrgId ?? '';
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

  if (!noAccount || !choices.any) return null;
  return (
    <div role='dialog' aria-labelledby='invitation-landing-title' className='bg-background fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md flex-col gap-3 rounded-lg border p-4 shadow-lg'>
      <h2 id='invitation-landing-title' className='font-semibold'>{choices.invitations.length ? 'You have an invitation' : 'Accept your invitation'}</h2>
      <InvitationButtons choices={choices} onJoined={() => { setNoAccount(false); router.refresh(); }} />
    </div>
  );
}
