import { Logo } from '@/features/site/logo';
import { HeroBackdrop } from '@/features/site/sections';

/** Sign-in and sign-up: the logo and Clerk's form, centred on the landing page's backdrop. */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className='relative flex min-h-screen flex-col items-center justify-center gap-8 overflow-hidden px-4 py-12'>
      <HeroBackdrop />
      <Logo className='relative text-lg' />
      <div className='relative'>{children}</div>
    </main>
  );
}
