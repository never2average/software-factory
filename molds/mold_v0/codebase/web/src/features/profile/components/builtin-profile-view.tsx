'use client';
// Profile under the built-in sign-in (mold_v0-004): your name, your address, how you sign in, and ending sessions
// (other devices, or everywhere including this one). The API server keeps it all (src/builtin-auth.ts).
// mold_v0-298: the name saves with its own Save (a Saved tick after), and the page links to your API keys and connected apps.
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { IdentityAvatar } from '@/components/identity-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { authPost, useBuiltinSession } from '@/lib/auth/builtin-client';
import { NameField, ProfileLinks } from './profile-parts';

const fail = (e: unknown) => toast.error((e as Error)?.message ?? 'Something went wrong');

export function BuiltinProfileViewPage() {
  const { loaded, session, reload } = useBuiltinSession();
  const user = session?.signed_in ? session.user : null;
  if (!loaded || !user) return <PageContainer pageTitle='Profile'><Skeleton className='h-40 max-w-xl' /></PageContainer>;

  const full = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const saveName = (first: string, last: string) =>
    authPost('/profile', { first_name: first, last_name: last }).then(reload).then(() => { toast.success('Name saved'); }, (e) => { fail(e); throw e; });
  const others = () => authPost<{ ended: number }>('/sign-out/others')
    .then((r) => toast.success(r.ended ? `Signed out of ${r.ended} other device${r.ended === 1 ? '' : 's'}` : 'No other devices were signed in'))
    .catch(fail);
  const everywhere = () => authPost('/sign-out/everywhere').then(() => { window.location.href = '/auth/sign-in'; }).catch(fail);
  const email = user.email ?? '—';

  return (
    <PageContainer pageTitle='Profile'>
      <div className='flex max-w-xl flex-col gap-6'>
        <div className='flex items-center gap-4'>
          <IdentityAvatar className='size-16' textClassName='text-xl' id={user.id} name={full} email={user.email} />
          <div className='min-w-0 flex-1 space-y-1.5'>
            <NameField full={full} save={saveName} />
            <p className='text-muted-foreground truncate px-3 text-sm leading-none'>{email}</p>
          </div>
        </div>

        {(session?.invitations ?? []).length > 0 && (
          <div className='flex flex-col gap-2'>
            <h2 className='text-sm font-medium'>Invitations</h2>
            {session!.invitations!.map((i) => (
              <div key={i.id} className='flex items-center justify-between gap-4 rounded-md border p-3 text-sm'>
                <span>{i.organization.name}</span>
                <Button size='sm' onClick={() => authPost(`/invitations/${encodeURIComponent(i.id)}/accept`).then(reload).then(() => toast.success(`You joined ${i.organization.name}`)).catch(fail)}>Accept</Button>
              </div>
            ))}
          </div>
        )}

        <dl className='divide-y border-y text-sm'>
          <div className='flex items-center justify-between gap-4 py-3 leading-none'>
            <dt className='text-muted-foreground'>Sign in with</dt>
            <dd className='flex flex-wrap justify-end gap-1.5'>
              <Badge variant='outline'>Emailed code</Badge>
              {user.google && <Badge variant='outline'>Google</Badge>}
            </dd>
          </div>
          <div className='flex items-center justify-between gap-4 py-3 leading-none'>
            <dt className='text-muted-foreground'>Other devices</dt>
            <dd><Button variant='outline' size='sm' onClick={others}>Sign out of other devices</Button></dd>
          </div>
          <div className='flex items-center justify-between gap-4 py-3 leading-none'>
            <dt className='text-muted-foreground'>Everywhere</dt>
            <dd><Button variant='outline' size='sm' onClick={everywhere}>Sign out everywhere</Button></dd>
          </div>
          <ProfileLinks />
        </dl>
      </div>
    </PageContainer>
  );
}
