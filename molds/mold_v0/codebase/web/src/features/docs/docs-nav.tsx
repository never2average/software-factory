'use client';
// The docs' page navigation, in the right column: numbered, collapsible groups of pages (1, 1.1, …), the current one
// highlighted, flat on the page (no rules or tinted boxes). It gets
// only titles and hrefs as props (features/docs/docs-data.ts), never a page's body. Searching is the platform search.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { IconChevronRight, IconMenu2 } from '@tabler/icons-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DocNavGroup } from './docs-data';

function NavTree({ groups, onNavigate }: { groups: DocNavGroup[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const toggle = (title: string, open: boolean) =>
    setClosed((s) => {
      const n = new Set(s);
      if (open) n.delete(title);
      else n.add(title);
      return n;
    });
  return (
    <nav aria-label='Docs pages' className='flex flex-col gap-3'>
      {groups.map((g, gi) => {
        const open = !closed.has(g.title);
        return (
          <Collapsible key={g.title} open={open} onOpenChange={(o) => toggle(g.title, o)}>
            <CollapsibleTrigger className='text-muted-foreground hover:text-foreground flex w-full items-center justify-between py-1 text-xs font-semibold tracking-wide uppercase transition-colors'>
              <span><span className='tabular-nums'>{gi + 1}.</span> {g.title}</span>
              <IconChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className='mt-1 flex flex-col gap-0.5'>
                {g.pages.map((page, pi) => {
                  const active = pathname === page.href;
                  return (
                    <li key={page.href}>
                      <Link href={page.href} onClick={onNavigate} aria-current={active ? 'page' : undefined}
                        className={cn('flex gap-2 py-1 text-sm transition-colors', active ? 'text-primary font-medium' : 'text-muted-foreground hover:text-foreground')}>
                        <span className='shrink-0 tabular-nums opacity-70'>{gi + 1}.{pi + 1}</span>
                        <span>{page.title}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </nav>
  );
}

/** The page tree in the right column, from lg up. */
export function DocsSidebar({ groups }: { groups: DocNavGroup[] }) {
  return <NavTree groups={groups} />;
}

/** Below lg: a button above the article that opens the same pages in a drawer from the right. */
export function DocsMobileNav({ groups, current }: { groups: DocNavGroup[]; current: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant='outline' size='sm' className='w-full justify-start gap-2 lg:hidden' />}>
        <IconMenu2 className='size-4' />
        <span className='text-muted-foreground'>Docs</span>
        <IconChevronRight className='text-muted-foreground size-3.5' />
        <span className='truncate'>{current}</span>
      </SheetTrigger>
      <SheetContent side='right' className='w-80 max-w-[85vw] gap-0 p-0'>
        <SheetHeader className='border-b'>
          <SheetTitle>Docs</SheetTitle>
        </SheetHeader>
        <div className='flex-1 overflow-y-auto p-4'>
          <NavTree groups={groups} onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
