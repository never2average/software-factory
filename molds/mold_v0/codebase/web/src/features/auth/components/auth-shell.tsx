import { BrandLogo } from '@/components/brand';
import { LegalLinks } from '@/features/site/legal';
import { Backdrop } from './backdrop';

/** Sign-in and sign-up: the logo and Clerk's form, centred on a backdrop; the app's Terms and Privacy under it when it has them (mold_v0-109). */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className='relative flex min-h-screen flex-col items-center justify-center gap-8 overflow-hidden px-4 py-12'>
      <Backdrop />
      <BrandLogo className='relative text-lg' />
      <div className='relative'>{children}</div>
      <LegalLinks className='relative' />
    </main>
  );
}
