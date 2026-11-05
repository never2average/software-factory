import React from 'react';
import { SidebarTrigger } from '../ui/sidebar';
import { Separator } from '../ui/separator';
import { Breadcrumbs } from '../breadcrumbs';
import SearchInput from '../search-input';
import { DocsButton, McpButton } from './docs-button';
import { ThemeSwitcher } from './theme-switcher';
import { AgentButton } from './agent-button';

export default function Header() {
  return (
    <header className='bg-background/60 sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between gap-2 backdrop-blur-md md:h-14'>
      {/* The way back shrinks (its breadcrumbs cut) before a control is pushed past the bar's right edge (mold_v0-243). */}
      <div className='flex min-w-0 items-center gap-2 overflow-hidden px-4'>
        <SidebarTrigger className='-ml-1' />
        <Separator orientation='vertical' className='mr-2 h-4 data-vertical:self-center' />
        <Breadcrumbs />
      </div>

      <div className='flex shrink-0 items-center gap-2 px-4'>
        {/* One height for all of them (top-bar.ts): the search box's, a 44px icon on a phone (mold_v0-177). */}
        <SearchInput />
        <McpButton />
        <DocsButton />
        <ThemeSwitcher />
        {/* The workspace agent (mold_v0-243): the last item, at the top bar's right edge; only with its flag on. */}
        <AgentButton />
      </div>
    </header>
  );
}
