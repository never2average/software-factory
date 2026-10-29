'use client';
import { IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { type ColorMode, isColorMode } from '@/components/themes/color-mode';
import { useColorMode } from '@/components/themes/theme-provider';
import { cn } from '@/lib/utils';
import { TOP_BAR_CONTROL } from './top-bar';

const MODES: { mode: ColorMode; label: string; Icon: typeof IconSun }[] = [
  { mode: 'light', label: 'Light', Icon: IconSun },
  { mode: 'dark', label: 'Dark', Icon: IconMoon },
  { mode: 'system', label: 'System', Icon: IconDeviceDesktop }
];

/**
 * The theme switcher, right of Docs (mold_v0-177): an icon button opening Light / Dark / System, the chosen one checked.
 * Kept per browser; System follows the device's setting live (components/themes/color-mode.ts). The button's icon is the
 * choice, picked by CSS from <html data-color-mode>, which the head script sets before the first paint, so it is right
 * from the first frame too.
 */
export function ThemeSwitcher() {
  const { mode, setMode } = useColorMode();
  const current = MODES.find((m) => m.mode === mode);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant='outline' className={TOP_BAR_CONTROL} aria-label={current ? `Theme: ${current.label}` : 'Theme'} />}
      >
        {MODES.map(({ mode: m, Icon }) => (
          <Icon key={m} aria-hidden className={cn('hidden', { light: 'in-data-[color-mode=light]:block', dark: 'in-data-[color-mode=dark]:block', system: 'in-data-[color-mode=system]:block' }[m])} />
        ))}
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='min-w-36'>
        <DropdownMenuRadioGroup aria-label='Theme' value={mode ?? undefined} onValueChange={(v) => isColorMode(v) && setMode(v)}>
          {MODES.map(({ mode: m, label, Icon }) => (
            <DropdownMenuRadioItem key={m} value={m} closeOnClick className='min-h-11 md:min-h-8'>
              <Icon aria-hidden /> {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
