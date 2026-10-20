import Link from 'next/link';
import { Logo } from './logo';
import { SECTIONS } from './nav';

const LINKS = [...SECTIONS, { href: '/early-access', label: 'Early access' }];

export function SiteFooter() {
  return (
    <footer className='border-t'>
      <div className='mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6'>
        <div className='flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between'>
          <div className='flex max-w-xs flex-col gap-2'>
            <Logo />
            <p className='text-muted-foreground text-sm'>Agentic Preference Optimization: get picked by coding agents.</p>
          </div>
          <nav aria-label='Footer' className='grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:flex sm:flex-wrap sm:gap-x-6'>
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} className='text-muted-foreground hover:text-foreground transition-colors'>{l.label}</Link>
            ))}
          </nav>
        </div>
        <p className='text-muted-foreground border-t pt-6 text-xs'>© 2026 Octillion</p>
      </div>
    </footer>
  );
}
