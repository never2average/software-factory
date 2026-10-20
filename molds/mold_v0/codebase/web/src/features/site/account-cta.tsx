'use client';
import Link from 'next/link';
import { useAuth } from '@clerk/nextjs';
import { IconArrowRight } from '@tabler/icons-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Where the account button goes: sign in, or straight into the dashboard when already signed in. The page is
 * prerendered for everyone, so until Clerk has loaded in the browser we don't know which: `ready` is false then, and
 * the button holds its place without a label instead of saying "Sign in" and flipping to "Open dashboard".
 */
export function useAccountLink() {
  const { isLoaded, isSignedIn } = useAuth();
  const link = isSignedIn ? { href: '/app', label: 'Open dashboard' } : { href: '/auth/sign-in', label: 'Sign in' };
  return { ...link, ready: isLoaded };
}

/** The site's primary call to action. */
export function AccountButton({ size, className }: { size?: 'default' | 'lg'; className?: string }) {
  const a = useAccountLink();
  return (
    <Link href={a.href} aria-hidden={!a.ready || undefined} tabIndex={a.ready ? undefined : -1}
      className={cn(buttonVariants({ size }), !a.ready && 'invisible', className)}>
      {a.label} <IconArrowRight />
    </Link>
  );
}
