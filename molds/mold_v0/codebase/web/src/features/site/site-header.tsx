'use client';
/**
 * The public pages' header (mold_v0-122, after the first product's): sticky, the build's mark and name, the picked
 * sections as navigation on wide screens and in a side sheet on small ones, the block's header link, and the ways in
 * (siteCtas: "Sign in", with the start call only when the page has no hero to carry it, or one account button: the first
 * screen asks for at most two things, mold_v0-164). An open-source app's repository is a GitHub button here on every width.
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

/** GitHub's mark (its Octicon, mark-github), drawn in the text colour. */
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden='true' viewBox='0 0 16 16' className={className} fill='currentColor'>
      <path d='M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z' />
    </svg>
  );
}

export function SiteHeaderView({ name, mark, nav, links, account, ctas, start = true, repo }: {
  name: string; mark: React.ReactNode; nav: LandingLink[]; links: LandingLink[]; account: 'sign_in_and_start' | 'account'; ctas: SiteCtas;
  /** Whether the header shows the start call beside "Sign in" (only when the page's hero does not). */
  start?: boolean;
  /** An open-source app's repository (landing block open_source): a GitHub button, `label` its accessible name. */
  repo?: LandingLink;
}) {
  const acct = useAccountLink(ctas.signIn, ctas.open);
  const [open, setOpen] = useState(false);
  const menu = [...nav, ...links, ...(account === 'account' ? (acct.ready ? [acct] : []) : [ctas.signIn, ...(start ? [ctas.start] : [])])];
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
        <div className='ml-auto flex shrink-0 items-center gap-1 sm:gap-2'>
          {links.map((l) => <Link key={l.href} href={l.href} className={cn(buttonVariants({ variant: 'ghost' }), 'hidden sm:inline-flex')}>{l.label}</Link>)}
          {account === 'account' ? <AccountButton signIn={ctas.signIn} open={ctas.open} />
            : <AccountLinks start={start ? ctas.start : undefined} signIn={ctas.signIn} open={ctas.open} compact={nav.length > 0 && start} />}
          {repo ? (
            <a href={repo.href} aria-label={repo.label} title={repo.label} rel='noopener noreferrer'
              className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'size-11 shrink-0')}>
              <GitHubMark className='size-5' />
            </a>
          ) : null}
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
