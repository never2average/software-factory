import React from 'react';
import { SidebarTrigger } from '../ui/sidebar';
import { Separator } from '../ui/separator';
import { Breadcrumbs } from '../breadcrumbs';
import SearchInput from '../search-input';
import { DocsButton, McpButton } from './docs-button';
import { ThemeSwitcher } from './theme-switcher';

export default function Header() {
  return (
    <header className='bg-background/60 sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between gap-2 backdrop-blur-md md:h-14'>
      <div className='flex items-center gap-2 px-4'>
        <SidebarTrigger className='-ml-1' />
        <Separator orientation='vertical' className='mr-2 h-4 data-vertical:self-center' />
        <Breadcrumbs />
      </div>

      <div className='flex items-center gap-2 px-4'>
        {/* One height for all of them (top-bar.ts): the search box's, a 44px icon on a phone (mold_v0-177). */}
        <SearchInput />
        <McpButton />
        <DocsButton />
        <ThemeSwitcher />
      </div>
    </header>
  );
}
