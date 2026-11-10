'use client';
// Tabs that show at most a few and put the rest behind a » menu, as a browser's developer tools do: picking one from the
// menu brings it into the strip's last place (operator, 2026-11-10). Only the open tab's content is drawn.
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Icons } from '@/components/icons';

export interface OverflowTab { id: string; label: string; content: ReactNode }

export function OverflowTabs({ tabs, max = 3 }: { tabs: OverflowTab[]; max?: number }) {
  const [picked, setPicked] = useState<string | null>(null);
  const current = tabs.find((t) => t.id === picked) ?? tabs[0];
  if (!current) return null;
  const inStrip = tabs.slice(0, max);
  const shown = inStrip.some((t) => t.id === current.id) ? inStrip : [...inStrip.slice(0, max - 1), current];
  const rest = tabs.filter((t) => !shown.some((s) => s.id === t.id));
  return (
    <Tabs value={current.id} onValueChange={(v) => setPicked(String(v))} className='w-full min-w-0 gap-4' data-overflow-tabs=''>
      <div className='flex min-w-0 items-center gap-3 border-b'>
        <TabsList variant='line' className='min-w-0 gap-4 p-0'>
          {shown.map((t) => <TabsTrigger key={t.id} value={t.id} className='flex-none px-0'>{t.label}</TabsTrigger>)}
        </TabsList>
        {rest.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type='button' variant='outline' size='icon-xs' aria-label={`${rest.length} more tabs`} title='More tabs' className='mb-1 shrink-0' />}>
              <Icons.chevronsRight aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align='start'>
              {rest.map((t) => <DropdownMenuItem key={t.id} onClick={() => setPicked(t.id)}>{t.label}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <TabsContent value={current.id} className='min-w-0'>{current.content}</TabsContent>
    </Tabs>
  );
}
