'use client';
// Profile, kept short: who you are (photo, name, email), how you sign in, and signing out elsewhere. Clerk holds it all.
// mold_v0-298: the name saves with its own Save (a Saved tick after, never silently on leaving the field), Change photo is
// always shown (a phone has no hover), and the page links to your API keys and connected apps where the build shows them.
import { useRef } from 'react';
import { useSession, useUser } from '@clerk/nextjs';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { IdentityAvatar } from '@/components/identity-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CLERK } from '@/lib/auth/provider';
import { BuiltinProfileViewPage } from './builtin-profile-view';
import { NameField, ProfileLinks } from './profile-parts';

const clerkMessage = (e: unknown) =>
  (e as { errors?: { longMessage?: string; message?: string }[] })?.errors?.[0]?.longMessage ??
  (e as { errors?: { message?: string }[] })?.errors?.[0]?.message ?? (e as Error)?.message ?? 'Something went wrong';
const fail = (e: unknown) => toast.error(clerkMessage(e));
const providerName = (p: string) => p.replace(/^oauth_/, '').replace(/^\w/, (c) => c.toUpperCase());

function ClerkProfileViewPage() {
  const { user, isLoaded } = useUser();
  const { session } = useSession();
  const file = useRef<HTMLInputElement>(null);
  if (!isLoaded || !user) return <PageContainer pageTitle='Profile'><Skeleton className='h-40 max-w-xl' /></PageContainer>;

  const full = [user.firstName, user.lastName].filter(Boolean).join(' ');
  const saveName = (first: string, last: string) =>
    user.update({ firstName: first, lastName: last }).then(() => { toast.success('Name saved'); }, (e) => { fail(e); throw e; });
  const upload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const pic = e.target.files?.[0]; if (!pic) return;
    user.setProfileImage({ file: pic }).then(() => user.reload()).then(() => toast.success('Photo updated')).catch(fail);
  };
  const signOutElsewhere = () => user.getSessions()
    .then((all) => Promise.all(all.filter((s) => s.id !== session?.id).map((s) => s.revoke())))
    .then((done) => toast.success(done.length ? `Signed out of ${done.length} other device${done.length === 1 ? '' : 's'}` : 'No other devices were signed in'))
    .catch(fail);
  const email = user.primaryEmailAddress?.emailAddress ?? '—';

  return (
    <PageContainer pageTitle='Profile'>
      <div className='flex max-w-xl flex-col gap-6'>
        <div className='flex items-center gap-4'>
          <div className='flex shrink-0 flex-col items-center gap-1.5'>
            {/* mold_v0-298: the photo is a mouse shortcut only; the visible Change photo button is the one named control. */}
            <button type='button' onClick={() => file.current?.click()} className='border-border rounded-full border p-0.5' tabIndex={-1} aria-hidden='true'>
              <IdentityAvatar className='size-16' textClassName='text-xl' id={user.id} name={full} email={user.primaryEmailAddress?.emailAddress} imageUrl={user.imageUrl} hasImage={user.hasImage} />
            </button>
            <Button variant='outline' size='sm' className='h-7 px-2 text-xs' onClick={() => file.current?.click()} data-profile-photo=''>Change photo</Button>
          </div>
          <input ref={file} type='file' accept='image/png,image/jpeg,image/webp,image/gif' className='hidden' onChange={upload} />
          <div className='min-w-0 flex-1 space-y-1.5'>
            <NameField full={full} save={saveName} />
            <p className='text-muted-foreground truncate px-3 text-sm leading-none'>{email}</p>
          </div>
        </div>

        <dl className='divide-y border-y text-sm'>
          <div className='flex items-center justify-between gap-4 py-3 leading-none'>
            <dt className='text-muted-foreground'>Sign in with</dt>
            <dd className='flex flex-wrap justify-end gap-1.5'>
              <Badge variant='outline'>Email</Badge>
              {user.externalAccounts.map((a) => <Badge key={a.id} variant='outline'>{providerName(a.provider)}</Badge>)}
            </dd>
          </div>
          <div className='flex items-center justify-between gap-4 py-3 leading-none'>
            <dt className='text-muted-foreground'>Other devices</dt>
            <dd><Button variant='outline' size='sm' onClick={signOutElsewhere}>Sign out of other devices</Button></dd>
          </div>
          <ProfileLinks />
        </dl>
      </div>
    </PageContainer>
  );
}

/** Clerk's profile under Clerk; the built-in sign-in's own page otherwise (mold_v0-004). */
export default function ProfileViewPage() {
  return CLERK ? <ClerkProfileViewPage /> : <BuiltinProfileViewPage />;
}
