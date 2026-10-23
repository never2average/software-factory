import type { Metadata } from 'next';
import Link from 'next/link';
import { fill } from '@/lib/vocabulary';
import { RequestAccessForm } from '@/features/site/request-access-form';

export const metadata: Metadata = {
  title: 'Request access',
  description: fill('Ask for access to {product}.'),
  alternates: { canonical: '/request-access' }
};

/**
 * The public request form (mold_v0-098): where the landing page's "get started" leads when accounts are invite-only
 * (web/src/features/site/accounts-mode.ts). The request goes to the platform's staff (/admin, Requests).
 */
export default function RequestAccessPage() {
  return (
    <div className='mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-12 sm:px-6 sm:py-16'>
      <div className='flex flex-col gap-3'>
        <h1 className='text-3xl font-semibold tracking-tight text-balance break-words sm:text-4xl'>{fill('Request access to {product}')}</h1>
        <p className='text-muted-foreground text-base break-words sm:text-lg'>
          {fill('{product} {accounts} are opened by invitation. Tell us who you are and the team will get back to you by email.')}
        </p>
        <p className='text-muted-foreground text-sm'>
          Already invited?{' '}
          <Link href='/app' className='text-foreground inline-flex min-h-6 items-center underline underline-offset-4'>Sign in</Link>{' '}
          with the address the invitation went to.
        </p>
      </div>
      <RequestAccessForm from='/request-access' />
    </div>
  );
}
