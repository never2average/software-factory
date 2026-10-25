'use client';
/**
 * The public pages' header (mold_v0-122, after the first product's): sticky, the build's mark and name, the picked
 * sections as navigation on wide screens and in a side sheet on small ones, the block's header links, and the ways in
 * (siteCtas: "Sign in" and the start call, or one account button).
 */
import Link from 'next/link';
import { useState } from 'react';
import { IconMenu2 } from '@tabler/icons-react';
import { buttonVariants } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { AccountButton, AccountLinks, useAccountLink } from './account-links';
import type { LandingLink } from './landing-types';
import type { SiteCtas } from './site-ctas';

export function SiteHeaderView({ name, mark, nav, links, account, ctas }: {
  name: string; mark: React.ReactNode; nav: LandingLink[]; links: LandingLink[]; account: 'sign_in_and_start' | 'account'; ctas: SiteCtas;
}) {
  const acct = useAccountLink(ctas.signIn, ctas.open);
  const [open, setOpen] = useState(false);
  const menu = [...nav, ...links, ...(account === 'account' ? (acct.ready ? [acct] : []) : [ctas.signIn, ctas.start])];
  return (
    <header className='bg-background/80 supports-backdrop-filter:bg-background/60 sticky top-0 z-40 border-b backdrop-blur'>
      <div className='mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6'>
        <Link href='/' className='flex min-w-0 items-center gap-2 font-semibold tracking-tight' aria-label={`${name} home`}>
          {mark}
          <span className='truncate'>{name}</span>
        </Link>
        {nav.length ? (
          <nav aria-label='Sections' className='hidden items-center gap-1 lg:flex'>
            {nav.map((s) => (
              <Link key={s.href} href={s.href} className='text-muted-foreground hover:text-foreground rounded-md px-3 py-2 text-sm transition-colors'>
                {s.label}
              </Link>
            ))}
          </nav>
        ) : null}
        <div className='ml-auto flex shrink-0 items-center gap-2'>
          {links.map((l) => <Link key={l.href} href={l.href} className={cn(buttonVariants({ variant: 'ghost' }), 'hidden sm:inline-flex')}>{l.label}</Link>)}
          {account === 'account' ? <AccountButton signIn={ctas.signIn} open={ctas.open} /> : <AccountLinks start={ctas.start} signIn={ctas.signIn} open={ctas.open} compact={nav.length > 0} />}
          {nav.length ? (
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'lg:hidden')} aria-label='Open menu'>
                <IconMenu2 />
              </SheetTrigger>
              <SheetContent side='right' className='w-72'>
                <SheetHeader>
                  <SheetTitle>{name}</SheetTitle>
                </SheetHeader>
                <nav aria-label='Menu' className='flex flex-col gap-1 px-4 pb-6'>
                  {menu.map((s) => (
                    <Link key={s.href + s.label} href={s.href} onClick={() => setOpen(false)} className='hover:bg-muted rounded-md px-3 py-2 text-sm'>
                      {s.label}
                    </Link>
                  ))}
                </nav>
              </SheetContent>
            </Sheet>
          ) : null}
        </div>
      </div>
    </header>
  );
}
