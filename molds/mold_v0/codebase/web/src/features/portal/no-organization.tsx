'use client';
import { SignOutButton, useOrganizationList, useUser } from '@/lib/auth';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { profile } from '@/config/profile.generated';

/**
 * Signed in, but no account picked: choose one of your accounts, or ask for an invitation. Accounts are
 * created by the platform's staff (invite-only), so there is no "create organization" here.
 */
export function NoOrganization({ platformAdmin = false }: { platformAdmin?: boolean }) {
  const { user } = useUser();
  const router = useRouter();
  const { isLoaded, setActive, userMemberships, userInvitations } = useOrganizationList({ userMemberships: true, userInvitations: true });
  const email = user?.primaryEmailAddress?.emailAddress ?? 'you';
  const memberships = userMemberships.data ?? [], invitations = userInvitations.data ?? [];
  const open = (id: string) => void setActive?.({ organization: id }).then(() => router.push('/app'));
  return (
    <main className='flex min-h-screen flex-col items-center justify-center gap-6 p-6'>
      <div className='max-w-md text-center'>
        <h1 className='text-2xl font-semibold'>{memberships.length ? 'Choose your account' : `No ${profile.name} account yet`}</h1>
        <p className='text-muted-foreground mt-2'>
          {memberships.length
            ? `Pick the ${profile.name} account to open.`
            : `${profile.name} is invite-only for now. Ask your account admin, or your ${profile.name} contact, to invite ${email}.`}
        </p>
      </div>
      {!isLoaded ? <Icons.spinner className='text-muted-foreground size-5 animate-spin' /> : (
        <ul className='flex w-full max-w-sm flex-col gap-2'>
          {memberships.map((m) => (
            <li key={m.id}>
              <Button variant='outline' className='w-full justify-between' onClick={() => open(m.organization.id)}>
                {m.organization.name}<Icons.arrowRight />
              </Button>
            </li>
          ))}
          {invitations.map((i) => (
            <li key={i.id}>
              <Button className='w-full justify-between' onClick={() => void i.accept().then(() => open(i.publicOrganizationData.id))}>
                Join {i.publicOrganizationData.name}<Icons.arrowRight />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {platformAdmin && <Button onClick={() => router.push('/admin')}><Icons.arrowRight /> Open admin panel</Button>}
      <SignOutButton redirectUrl='/auth/sign-in'><button className='text-muted-foreground text-sm underline'>Sign out</button></SignOutButton>
    </main>
  );
}
