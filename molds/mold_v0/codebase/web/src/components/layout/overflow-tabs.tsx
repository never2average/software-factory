'use client';
// Tabs that show at most a few and put the rest behind a » menu, as a browser's developer tools do: picking one from the
// menu brings it into the strip's last place (operator, 2026-11-10). Only the open tab's content is drawn. mold_v0-293: in
// a record panel expanded to the list's full width (with room), or outside a panel, every tab shows, no » menu.
// mold_v0-295: a tab may be a group, a menu of its own items (the agent session's top bar: its sections grouped), with a mark
// beside its label (a count, a live dot); `strip` draws the tabs alone (no content, no rule under them) and `value` makes the
// open tab the caller's (null: none open). mold_v0-296: a group's entries are two lines (its words, then a plain line under
// them), the open one checked, a quiet one greyed, a line at the menu's foot (a legend); `fit` shows as many tabs as the room
// it is given holds (measured, never overlapping what is beside it) and spills the rest into the » menu.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useInRecordPanel, useRecordPanelFull } from '@/components/layout/detail-panel';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';

/** One entry of a group tab's menu: its words, a plain line under them (`sub`), an icon before them and a mark after them (a
 *  state dot); the open one (`current`) is checked, a quiet one (`dim`: nothing in it yet) greyed. */
export interface OverflowTabItem { id: string; label: string; sub?: ReactNode; icon?: ReactNode; end?: ReactNode; current?: boolean; dim?: boolean; onSelect: () => void; data?: Record<`data-${string}`, string | undefined> }
/** `foot`: one line under a group's menu (a legend for its marks). */
export interface OverflowTab { id: string; label: string; content?: ReactNode; mark?: ReactNode; menu?: OverflowTabItem[]; foot?: ReactNode; data?: Record<`data-${string}`, string | undefined> }

function MenuItems({ items }: { items: OverflowTabItem[] }) {
  const checks = items.some((i) => i.current !== undefined);
  return <>{items.map((i) => (
    <DropdownMenuItem key={i.id} onClick={i.onSelect} aria-current={i.current ? 'true' : undefined} data-current={i.current ? '' : undefined} data-dim={i.dim ? '' : undefined}
      className={cn('flex items-center gap-2 py-1.5', i.current && 'bg-accent text-accent-foreground', i.dim && 'text-muted-foreground')} {...i.data}>
      {i.icon}
      <span className='flex min-w-0 flex-1 flex-col'>
        <span className={cn('truncate', i.current && 'font-medium')}>{i.label}</span>
        {i.sub && <span className='text-muted-foreground truncate text-xs' data-menu-sub=''>{i.sub}</span>}
      </span>
      {i.end}
      {checks && <span className='flex size-4 shrink-0 items-center justify-center' aria-hidden>{i.current && <Icons.check className='size-4' />}</span>}
    </DropdownMenuItem>
  ))}</>;
}

function Foot({ children }: { children: ReactNode }) {
  return <><DropdownMenuSeparator /><div className='text-muted-foreground px-1.5 py-1 text-xs' data-menu-foot=''>{children}</div></>;
}

/** The » button's width and the gaps (gap-4 between tabs, gap-3 before the »), as drawn. */
const TAB_GAP = 16, MORE_W = 24 + 12;

/** `max`: the tabs shown before the » menu; by default 3 in a record panel beside its list, else all of them. */
export function OverflowTabs({ tabs, max, value, onValueChange, strip = false, fit = false, className, label }: {
  tabs: OverflowTab[]; max?: number; value?: string | null; onValueChange?: (id: string) => void; strip?: boolean; fit?: boolean; className?: string; label?: string;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  // Three only where space is short: a record panel beside its list (or a phone's); elsewhere, every tab.
  const narrow = useInRecordPanel() && !useRecordPanelFull();
  // `fit`: every tab's drawn width, measured in a hidden copy of the strip, against the room this strip is given.
  const box = useRef<HTMLDivElement | null>(null), ruler = useRef<HTMLDivElement | null>(null);
  const [room, setRoom] = useState<{ fits: number; natural: number } | null>(null);
  const sizes = tabs.map((t) => `${t.id}:${t.label}`).join('|');
  useLayoutEffect(() => {
    if (!fit) return;
    const b = box.current, r = ruler.current;
    if (!b || !r) return;
    const measure = () => {
      const widths = [...r.querySelectorAll('[role="tab"]')].map((c) => c.getBoundingClientRect().width);
      const natural = Math.ceil(widths.reduce((t, w) => t + w, 0) + TAB_GAP * Math.max(0, widths.length - 1));
      const avail = b.getBoundingClientRect().width;
      let fits = widths.length;
      if (natural > avail + 0.5) {
        fits = 0;
        for (let used = 0; fits < widths.length; fits++) { used += widths[fits]! + (fits ? TAB_GAP : 0); if (used > avail - MORE_W) break; }
      }
      setRoom((o) => (o && o.fits === fits && o.natural === natural ? o : { fits, natural }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(b); ro.observe(r);
    return () => ro.disconnect();
  }, [fit, sizes]);
  const limit = fit ? Math.min(max ?? tabs.length, room?.fits ?? tabs.length) : Math.max(1, max ?? (narrow ? 3 : tabs.length));
  const controlled = value !== undefined;
  const current = controlled ? tabs.find((t) => t.id === value) ?? null : tabs.find((t) => t.id === picked) ?? tabs[0];
  if (!tabs.length || (!controlled && !current)) return null;
  const pick = (id: string) => { if (!controlled) setPicked(id); onValueChange?.(id); };
  const inStrip = tabs.slice(0, limit);
  const shown = !current || inStrip.some((t) => t.id === current.id) ? inStrip : [...inStrip.slice(0, Math.max(0, limit - 1)), current];
  const rest = tabs.filter((t) => !shown.some((s) => s.id === t.id));
  const trigger = (t: OverflowTab, bare = false) => <TabsTrigger key={t.id} value={t.id} className={cn('flex-none px-0', t.menu && 'gap-1.5')} {...(bare ? {} : t.data)}>{t.label}{t.mark}{t.menu && <Icons.chevronDown className='text-muted-foreground size-3.5' aria-hidden />}</TabsTrigger>;
  const strip_ = (
    <Tabs value={current?.id ?? null} onValueChange={(v) => { const t = tabs.find((x) => x.id === String(v)); if (t && !t.menu) pick(t.id); }}
      className={cn(strip ? 'min-w-0 gap-0' : 'w-full min-w-0 gap-4', !fit && className)} data-overflow-tabs='' data-tabs-all={rest.length ? undefined : ''}>
      <div className={cn('flex min-w-0 items-center gap-3', !strip && 'border-b')}>
        <TabsList variant='line' aria-label={label} className='min-w-0 gap-4 p-0'>
          {shown.map((t) => (t.menu
            ? (
              <DropdownMenu key={t.id}>
                <DropdownMenuTrigger render={trigger(t)} />
                <DropdownMenuContent align='start' className='w-auto min-w-64 max-w-[min(24rem,90vw)]' data-tab-menu={t.id}>
                  <MenuItems items={t.menu} />
                  {t.foot && <Foot>{t.foot}</Foot>}
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
            <DropdownMenuContent align={fit ? 'end' : 'start'} className={cn(rest.some((t) => t.menu) && 'w-auto min-w-64 max-w-[min(24rem,90vw)]')} data-tab-menu-more=''>
              {rest.map((t) => (t.menu
                ? <DropdownMenuGroup key={t.id} data-tab-menu-group={t.id}><DropdownMenuLabel>{t.label}</DropdownMenuLabel><MenuItems items={t.menu} /></DropdownMenuGroup>
                : <DropdownMenuItem key={t.id} onClick={() => pick(t.id)}>{t.label}</DropdownMenuItem>))}
              {(() => { const foot = rest.find((t) => t.menu && t.foot)?.foot; return foot ? <Foot>{foot}</Foot> : null; })()}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {!strip && current && <TabsContent value={current.id} className='min-w-0'>{current.content}</TabsContent>}
    </Tabs>
  );
  if (!fit) return strip_;
  // Fit: as wide as every tab when there is room, narrower (down to the » alone) when there is not; the hidden ruler holds
  // every tab at its drawn width.
  return (
    <div ref={box} className={cn('relative flex min-w-9 shrink items-center', className)} style={{ flexBasis: room ? room.natural : 'auto', flexGrow: 0 }} data-overflow-fit={room ? String(room.fits) : ''}>
      {strip_}
      <div ref={ruler} aria-hidden inert className='pointer-events-none invisible absolute top-0 left-0 w-max'>
        <Tabs value={null}><TabsList variant='line' className='w-max gap-4 p-0'>{tabs.map((t) => trigger(t, true))}</TabsList></Tabs>
      </div>
    </div>
  );
}
