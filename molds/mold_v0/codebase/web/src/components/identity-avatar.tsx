'use client';
// A person's or an organisation's avatar (mold_v0-275), everywhere the console shows one: an uploaded picture as it is;
// without one (Clerk's `hasImage` false, the built-in sign-in, every list the API sends), the console's own drawing in
// the app's avatar colours, chosen from the id (web/src/lib/avatar.ts). Never the sign-in provider's generated picture.
import * as React from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { avatarBackground, avatarInitials, avatarLook, uploadedPicture } from '@/lib/avatar';
import { cn } from '@/lib/utils';

export interface IdentityAvatarProps {
  /** person: round; org: a rounded square, like the workspace's tile. */
  kind?: 'person' | 'org';
  /** What the colours are chosen from: the user's or organisation's id (else the email, else the name). */
  id?: string | null;
  name?: string | null;
  email?: string | null;
  /** An uploaded picture: shown only when `hasImage` (Clerk's generated pictures have it false). */
  imageUrl?: string | null;
  hasImage?: boolean | null;
  className?: string;
  /** The initials' size: the avatar's own class sets its box. */
  textClassName?: string;
}

/** The drawn avatar's face: the marble and the initials (also the uploaded picture's fallback while it loads). */
function Drawn({ k, name, email, textClassName }: { k: string; name?: string | null; email?: string | null; textClassName?: string }) {
  const look = avatarLook(k);
  return (
    <span
      data-avatar-drawn=''
      className={cn('flex size-full items-center justify-center rounded-[inherit] font-semibold tracking-tight text-white select-none', textClassName ?? 'text-[0.6875rem]')}
      style={{ backgroundImage: avatarBackground(look), backgroundColor: look.from, textShadow: '0 1px 1px rgb(0 0 0 / 0.18)' }}
    >
      {avatarInitials(name, email)}
    </span>
  );
}

export function IdentityAvatar({ kind = 'person', id, name, email, imageUrl, hasImage, className, textClassName }: IdentityAvatarProps) {
  const picture = uploadedPicture(imageUrl, hasImage);
  const key = id || email || name || '';
  const shape = kind === 'org' ? 'rounded-md after:rounded-md' : 'rounded-full';
  return (
    <Avatar
      className={cn('size-8 after:hidden', shape, className)}
      data-avatar-kind={kind}
      data-avatar-picture={picture ? 'uploaded' : 'drawn'}
      // Decorative: every place that shows an avatar shows the name beside it (or names its control).
      aria-hidden
    >
      {picture ? (
        <>
          <AvatarImage src={picture} alt='' className='rounded-[inherit]' />
          <AvatarFallback className='rounded-[inherit] bg-transparent'><Drawn k={key} name={name} email={email} textClassName={textClassName} /></AvatarFallback>
        </>
      ) : (
        <Drawn k={key} name={name} email={email} textClassName={textClassName} />
      )}
    </Avatar>
  );
}

/** A name with its avatar beside it, for a list's cell (members, staff, accounts): block content, for a table cell. */
export function IdentityName({ children, className, ...avatar }: IdentityAvatarProps & { children: React.ReactNode }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)} data-identity-name=''>
      <IdentityAvatar className='size-6 shrink-0' textClassName='text-[0.625rem]' {...avatar} />
      <div className='min-w-0'>{children}</div>
    </div>
  );
}
