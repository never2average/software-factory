import { BrandLogo } from '@/components/brand';
import { LegalLinks } from '@/features/site/legal';
import type { SignInConfig } from '@/lib/access-request.generated';
import { Backdrop } from './backdrop';
import { LegalLine } from './legal-line';

/**
 * Sign-in and sign-up: the logo and Clerk's form, centred on a backdrop; the app's Terms and Privacy under it when it has
 * them (mold_v0-109). mold_v0-266: a legal line staff wrote (Admin › Access requests › Sign-in page) under the form.
 */
export function AuthShell({ children, legal }: { children: React.ReactNode; legal?: SignInConfig['legal'] }) {
  return (
    <main className='relative flex min-h-screen flex-col items-center justify-center gap-8 overflow-hidden px-4 py-12'>
      <Backdrop />
      <BrandLogo className='relative text-lg' />
      <div className='relative'>{children}</div>
      {legal ? <LegalLine legal={legal} className='relative max-w-sm' /> : null}
      <LegalLinks className='relative' />
    </main>
  );
}
