import Link from 'next/link';
import { OctillionMark } from './logo';

export function SiteFooter() {
  return (
    <footer className='border-t'>
      <div className='text-muted-foreground mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm sm:flex-row sm:items-center sm:px-6'>
        <div className='flex items-center gap-2'>
          <OctillionMark className='size-5' />
          <span>© 2026 Octillion · Agentic Preference Optimization</span>
        </div>
        <nav aria-label='Footer' className='flex flex-wrap gap-x-5 gap-y-2 sm:ml-auto'>
          <Link href='/#apo' className='hover:text-foreground'>What is APO</Link>
          <Link href='/#faq' className='hover:text-foreground'>FAQ</Link>
          <Link href='/early-access' className='hover:text-foreground'>Early access</Link>
        </nav>
      </div>
    </footer>
  );
}
