'use client';
/**
 * The public pages' account-aware calls to action (mold_v0-122, after the first product's account button). The page is
 * prerendered for everyone, so until the browser's sign-in has loaded we don't know who is looking.
 *   AccountLinks   signed out: "Sign in" and the start call (sign-up or a request for access, from siteCtas); signed in:
 *                  one call into the console. Rendered signed out until loaded (and without script).
 *   AccountButton  one button: sign in, or open the console when signed in, with an arrow. Until the sign-in has loaded
 *                  it holds its place without a label instead of saying "Sign in" and flipping.
 */
import Link from 'next/link';
import { IconArrowRight } from '@tabler/icons-react';
import { useAuth } from '@/lib/auth';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { linkable, type LandingLink } from './landing-types';

function Go({ link, className }: { link: LandingLink; className: string }) {
  return linkable(link.href) ? <Link href={link.href} className={className}>{link.label}</Link> : <span className={className}>{link.label}</span>;
}

/** Where the account button goes: sign in, or into the console when already signed in; `ready` once the sign-in has loaded. */
export function useAccountLink(signIn: LandingLink, open: LandingLink) {
  const { isLoaded, isSignedIn } = useAuth();
  return { ...(isLoaded && isSignedIn ? open : signIn), ready: isLoaded };
}

export function AccountLinks({ start, signIn, open }: { start: LandingLink; signIn: LandingLink; open: LandingLink }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (isLoaded && isSignedIn) return <Go link={open} className={cn(buttonVariants(), 'h-10 px-4')} />;
  return (
    <>
      <Go link={signIn} className={cn(buttonVariants({ variant: 'ghost' }), 'h-10')} />
      <Go link={start} className={cn(buttonVariants(), 'h-10 px-4')} />
    </>
  );
}

export function AccountButton({ signIn, open, size, className }: { signIn: LandingLink; open: LandingLink; size?: 'default' | 'lg'; className?: string }) {
  const a = useAccountLink(signIn, open);
  return (
    <Link href={a.href} aria-hidden={!a.ready || undefined} tabIndex={a.ready ? undefined : -1}
      className={cn(buttonVariants({ size }), !a.ready && 'invisible', className)}>
      {a.label} <IconArrowRight />
    </Link>
  );
}
