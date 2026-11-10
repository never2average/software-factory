'use client';
import Link from 'next/link';
import { IconDeviceDesktop, IconDots, IconMoon, IconSun } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { type ColorMode, isColorMode } from '@/components/themes/color-mode';
import { useColorMode } from '@/components/themes/theme-provider';
import { Icons } from '../icons';
import { useNav } from './nav-context';
import { TOP_BAR_CONTROL } from './top-bar';

const MODES: { mode: ColorMode; label: string; Icon: typeof IconSun }[] = [
  { mode: 'light', label: 'Light', Icon: IconSun },
  { mode: 'dark', label: 'Dark', Icon: IconMoon },
  { mode: 'system', label: 'System', Icon: IconDeviceDesktop }
];

/** On a phone (mold_v0-289): Docs, admin's MCP and the theme in one menu at the top bar's right, so the page's name is not squeezed. */
export function TopBarMore() {
  const { area } = useNav();
  const { mode, setMode } = useColorMode();
  const item = 'min-h-11';
  return (
    <div className='md:hidden'>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant='outline' className={TOP_BAR_CONTROL} aria-label='More' data-top-bar-more='' />}>
          <IconDots aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' className='min-w-44'>
          <DropdownMenuItem className={item} render={<Link href={area === 'admin' ? '/admin/docs' : '/app/docs'} />}><Icons.book aria-hidden /> Docs</DropdownMenuItem>
          {area === 'admin' && <DropdownMenuItem className={item} render={<Link href='/admin/connect' />}><Icons.plug aria-hidden /> MCP</DropdownMenuItem>}
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup aria-label='Theme' value={mode ?? undefined} onValueChange={(v) => isColorMode(v) && setMode(v)}>
            {MODES.map(({ mode: m, label, Icon }) => (
              <DropdownMenuRadioItem key={m} value={m} closeOnClick className={item}><Icon aria-hidden /> {label}</DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
