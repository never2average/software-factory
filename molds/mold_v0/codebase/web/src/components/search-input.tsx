'use client';
import { useKBar } from 'kbar';
import { Icons } from '@/components/icons';
import { TOP_BAR_CONTROL } from '@/components/layout/top-bar';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';

/** The top bar's search (Cmd+K): a box from tablet width up, an icon button on a phone (mold_v0-177). */
export default function SearchInput() {
  const { query } = useKBar();
  return (
    <>
      <Button variant='outline' className={cn(TOP_BAR_CONTROL, 'md:hidden')} onClick={query.toggle} aria-label='Search'>
        <Icons.search className='h-4 w-4' />
      </Button>
      <Button
        variant='outline'
        className={cn(
          TOP_BAR_CONTROL,
          'bg-background text-muted-foreground relative hidden justify-start font-normal sm:pr-12 md:flex md:w-40 md:px-3 lg:w-64'
        )}
        onClick={query.toggle}
      >
        <Icons.search className='mr-2 h-4 w-4' />
        Search...
        <kbd className='bg-muted pointer-events-none absolute top-[0.3rem] right-[0.3rem] hidden h-6 items-center gap-1 rounded border px-1.5 font-mono text-[10px] font-medium opacity-100 select-none sm:flex'>
          <span className='text-xs'>⌘</span>K
        </kbd>
      </Button>
    </>
  );
}
