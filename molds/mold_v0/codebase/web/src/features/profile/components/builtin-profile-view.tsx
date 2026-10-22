'use client';
// Profile under the built-in sign-in (mold_v0-004): your name, your address, how you sign in, and ending sessions
// (other devices, or everywhere including this one). The API server keeps it all (src/builtin-auth.ts).
import { useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { authPost, useBuiltinSession } from '@/lib/auth/builtin-client';

const fail = (e: unknown) => toast.error((e as Error)?.message ?? 'Something went wrong');

export function BuiltinProfileViewPage() {
  const { loaded, session, reload } = useBuiltinSession();
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const user = session?.signed_in ? session.user : null;
  if (!loaded || !user) return <PageContainer pageTitle='Profile'><Skeleton className='h-40 max-w-xl' /></PageContainer>;

  const full = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const value = name ?? full;
  const saveName = () => {
    const v = value.trim();
    if (v === full) return setName(null);
    const [first, ...rest] = v.split(/\s+/);
    setBusy(true);
    authPost('/profile', { first_name: first ?? '', last_name: rest.join(' ') }).then(reload).then(() => { toast.success('Name saved'); setName(null); }).catch(fail).finally(() => setBusy(false));
  };
  const others = () => authPost<{ ended: number }>('/sign-out/others')
    .then((r) => toast.success(r.ended ? `Signed out of ${r.ended} other device${r.ended === 1 ? '' : 's'}` : 'No other devices were signed in'))
    .catch(fail);
  const everywhere = () => authPost('/sign-out/everywhere').then(() => { window.location.href = '/auth/sign-in'; }).catch(fail);
  const email = user.email ?? '—';
  const initials = (full || email).split(/[\s@]+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();

  return (
    <PageContainer pageTitle='Profile'>
      <div className='flex max-w-xl flex-col gap-6'>
        <div className='flex items-center gap-4'>
          <Avatar className='size-16'><AvatarFallback>{initials}</AvatarFallback></Avatar>
          <div className='min-w-0 flex-1 space-y-1.5'>
            <Input value={value} onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              placeholder='Your name' aria-label='Your name' maxLength={120} disabled={busy} className='h-9 text-base font-medium' />
            <p className='text-muted-foreground truncate px-3 text-sm leading-none'>{email}</p>
          </div>
        </div>

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
        </dl>
      </div>
    </PageContainer>
  );
}
