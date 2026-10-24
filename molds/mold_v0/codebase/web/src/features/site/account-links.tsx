'use client';
/**
 * The header's account-aware calls to action (mold_v0-122, after the host pack's account button): signed out, "Sign in"
 * and the start call (sign-up or a request for access, from siteCtas); signed in, one call into the console. The page is
 * prerendered for everyone, so it renders signed out until the browser's sign-in has loaded (and without script).
 */
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { linkable, type LandingLink } from './landing-types';

function Go({ link, className }: { link: LandingLink; className: string }) {
  return linkable(link.href) ? <Link href={link.href} className={className}>{link.label}</Link> : <span className={className}>{link.label}</span>;
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
