'use client';
// Profile, kept short: who you are (photo, name, email), how you sign in, and signing out elsewhere. Clerk holds it all.
import { useRef, useState } from 'react';
import { useSession, useUser } from '@clerk/nextjs';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const clerkMessage = (e: unknown) =>
  (e as { errors?: { longMessage?: string; message?: string }[] })?.errors?.[0]?.longMessage ??
  (e as { errors?: { message?: string }[] })?.errors?.[0]?.message ?? (e as Error)?.message ?? 'Something went wrong';
const fail = (e: unknown) => toast.error(clerkMessage(e));
const providerName = (p: string) => p.replace(/^oauth_/, '').replace(/^\w/, (c) => c.toUpperCase());

export default function ProfileViewPage() {
  const { user, isLoaded } = useUser();
  const { session } = useSession();
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  if (!isLoaded || !user) return <PageContainer pageTitle='Profile'><Skeleton className='h-40 max-w-xl' /></PageContainer>;

  const full = [user.firstName, user.lastName].filter(Boolean).join(' ');
  const value = name ?? full;
  const saveName = () => {
    const v = value.trim();
    if (v === full) return setName(null);
    const [first, ...rest] = v.split(/\s+/);
    setBusy(true);
    user.update({ firstName: first ?? '', lastName: rest.join(' ') }).then(() => { toast.success('Name saved'); setName(null); }).catch(fail).finally(() => setBusy(false));
  };
  const upload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const pic = e.target.files?.[0]; if (!pic) return;
    user.setProfileImage({ file: pic }).then(() => user.reload()).then(() => toast.success('Photo updated')).catch(fail);
  };
  const signOutElsewhere = () => user.getSessions()
    .then((all) => Promise.all(all.filter((s) => s.id !== session?.id).map((s) => s.revoke())))
    .then((done) => toast.success(done.length ? `Signed out of ${done.length} other device${done.length === 1 ? '' : 's'}` : 'No other devices were signed in'))
    .catch(fail);
  const email = user.primaryEmailAddress?.emailAddress ?? '—';
  const initials = (full || email).split(/[\s@]+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();

  return (
    <PageContainer pageTitle='Profile'>
      <div className='flex max-w-xl flex-col gap-6'>
        <div className='flex items-center gap-4'>
          <button type='button' onClick={() => file.current?.click()} className='group relative rounded-full' aria-label='Change photo' title='Change photo'>
            <Avatar className='size-16'><AvatarImage src={user.imageUrl} alt='' /><AvatarFallback>{initials}</AvatarFallback></Avatar>
            <span className='bg-background/70 absolute inset-0 hidden items-center justify-center rounded-full text-xs group-hover:flex'>Change</span>
          </button>
          <input ref={file} type='file' accept='image/png,image/jpeg,image/webp,image/gif' className='hidden' onChange={upload} />
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
              <Badge variant='outline'>Email</Badge>
              {user.externalAccounts.map((a) => <Badge key={a.id} variant='outline'>{providerName(a.provider)}</Badge>)}
            </dd>
          </div>
          <div className='flex items-center justify-between gap-4 py-3 leading-none'>
            <dt className='text-muted-foreground'>Other devices</dt>
            <dd><Button variant='outline' size='sm' onClick={signOutElsewhere}>Sign out of other devices</Button></dd>
          </div>
        </dl>
      </div>
    </PageContainer>
  );
}
