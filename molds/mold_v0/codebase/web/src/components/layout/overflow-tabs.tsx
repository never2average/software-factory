'use client';
// Tabs that show at most a few and put the rest behind a » menu, as a browser's developer tools do: picking one from the
// menu brings it into the strip's last place (operator, 2026-11-10). Only the open tab's content is drawn. mold_v0-293: in
// a record panel expanded to the list's full width (with room), or outside a panel, every tab shows, no » menu.
// mold_v0-295: a tab may be a group, a menu of its own items (the agent session's top bar: its sections grouped), with a mark
// beside its label (a count, a live dot); `strip` draws the tabs alone (no content, no rule under them) and `value` makes the
// open tab the caller's (null: none open).
import { useState, type ReactNode } from 'react';
import { useInRecordPanel, useRecordPanelFull } from '@/components/layout/detail-panel';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';

/** One entry of a group tab's menu: its words, an icon before them and a mark after them (a count). */
export interface OverflowTabItem { id: string; label: string; icon?: ReactNode; end?: ReactNode; current?: boolean; onSelect: () => void; data?: Record<`data-${string}`, string | undefined> }
export interface OverflowTab { id: string; label: string; content?: ReactNode; mark?: ReactNode; menu?: OverflowTabItem[]; data?: Record<`data-${string}`, string | undefined> }

function MenuItems({ items }: { items: OverflowTabItem[] }) {
  return <>{items.map((i) => (
    <DropdownMenuItem key={i.id} onClick={i.onSelect} aria-current={i.current ? 'true' : undefined} className={cn('flex items-center gap-2', i.current && 'bg-accent/60')} {...i.data}>
      {i.icon}<span className='min-w-0 flex-1 truncate'>{i.label}</span>{i.end}
    </DropdownMenuItem>
  ))}</>;
}

/** `max`: the tabs shown before the » menu; by default 3 in a record panel beside its list, else all of them. */
export function OverflowTabs({ tabs, max, value, onValueChange, strip = false, className, label }: {
  tabs: OverflowTab[]; max?: number; value?: string | null; onValueChange?: (id: string) => void; strip?: boolean; className?: string; label?: string;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  // Three only where space is short: a record panel beside its list (or a phone's); elsewhere, every tab.
  const narrow = useInRecordPanel() && !useRecordPanelFull();
  const limit = Math.max(1, max ?? (narrow ? 3 : tabs.length));
  const controlled = value !== undefined;
  const current = controlled ? tabs.find((t) => t.id === value) ?? null : tabs.find((t) => t.id === picked) ?? tabs[0];
  if (!tabs.length || (!controlled && !current)) return null;
  const pick = (id: string) => { if (!controlled) setPicked(id); onValueChange?.(id); };
  const inStrip = tabs.slice(0, limit);
  const shown = !current || inStrip.some((t) => t.id === current.id) ? inStrip : [...inStrip.slice(0, limit - 1), current];
  const rest = tabs.filter((t) => !shown.some((s) => s.id === t.id));
  const trigger = (t: OverflowTab) => <TabsTrigger key={t.id} value={t.id} className={cn('flex-none px-0', t.menu && 'gap-1.5')} {...t.data}>{t.label}{t.mark}{t.menu && <Icons.chevronDown className='text-muted-foreground size-3.5' aria-hidden />}</TabsTrigger>;
  return (
    <Tabs value={current?.id ?? null} onValueChange={(v) => { const t = tabs.find((x) => x.id === String(v)); if (t && !t.menu) pick(t.id); }}
      className={cn(strip ? 'min-w-0 gap-0' : 'w-full min-w-0 gap-4', className)} data-overflow-tabs='' data-tabs-all={rest.length ? undefined : ''}>
      <div className={cn('flex min-w-0 items-center gap-3', !strip && 'border-b')}>
        <TabsList variant='line' aria-label={label} className='min-w-0 gap-4 p-0'>
          {shown.map((t) => (t.menu
            ? (
              <DropdownMenu key={t.id}>
                <DropdownMenuTrigger render={trigger(t)} />
                <DropdownMenuContent align='start' className='w-auto min-w-56' data-tab-menu={t.id}>
                  <MenuItems items={t.menu} />
                </DropdownMenuContent>
              </DropdownMenu>
            )
            : trigger(t)))}
        </TabsList>
        {rest.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type='button' variant='outline' size='icon-xs' aria-label={`${rest.length} more tabs`} title='More tabs' className={cn('shrink-0', !strip && 'mb-1')} />}>
              <Icons.chevronsRight aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align='start' className={cn(rest.some((t) => t.menu) && 'w-auto min-w-56')}>
              {rest.map((t) => (t.menu
                ? <DropdownMenuGroup key={t.id}><DropdownMenuLabel>{t.label}</DropdownMenuLabel><MenuItems items={t.menu} /></DropdownMenuGroup>
                : <DropdownMenuItem key={t.id} onClick={() => pick(t.id)}>{t.label}</DropdownMenuItem>))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {!strip && current && <TabsContent value={current.id} className='min-w-0'>{current.content}</TabsContent>}
    </Tabs>
  );
}
