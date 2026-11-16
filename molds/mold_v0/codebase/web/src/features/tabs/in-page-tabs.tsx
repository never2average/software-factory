'use client';
// The console's in-page tab strip (mold_v0-175, shared since mold_v0-281): a line-variant strip of 2 or more tabs above
// the selected one's body, the selection kept in the address (?tab=<id>, the first tab when absent or unknown). Both
// consoles draw it: a customer sections tab (./tab-page.tsx SectionsTab) and a staff Records entry of in-page tabs
// (web/src/features/records/staff-record-group.tsx). Past 6 tabs the strip scrolls sideways on its own (mold_v0-260).
// mold_v0-296: a caller may keep the selection itself (`value`, `onValueChange`: the agent dock's panel, whose open section is
// ?section=<id>), draw the strip alone (no `children`) and draw it small (`size='sm'`: a panel's header).
// mold_v0-298: a strip wider than its room (a phone) says so: a soft edge and an arrow button at each side that has more
// tabs, and the selected tab is scrolled into view (on load and on every change), so no tab is ever cut off unseen.
// mold_v0-315: a caller may hand the strip to the list it shows (`handOff`: a customer sections tab): a list (RecordView)
// at the top of the selected tab draws the strip at the top of its own column (useTabStrip), so a panel opened beside the
// list (a row's record, Ask AI) starts level with the tab strip; with no such list the strip stays where it was.
import { createContext, useCallback, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { useQueryState } from 'nuqs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Icons, type Icon as IconType } from '@/components/icons';
import { cn } from '@/lib/utils';

export interface InPageTab { id: string; label: string; icon?: ReactNode; data?: Record<`data-${string}`, string | undefined> }

/** mold_v0-300: a tab's icon as drawn: a node as given; an icon NAME (a pack tab spec's `icon`, as the sidebar takes it)
 *  resolved to its icon the way the sidebar does (Icons[name]), and an unknown name draws none, never the name as text. */
export function tabIcon(icon: ReactNode): ReactNode {
  if (typeof icon !== 'string') return icon;
  const Icon = (Icons as Record<string, IconType | undefined>)[icon];
  return Icon ? <Icon aria-hidden /> : null;
}

/** mold_v0-315: the strip a list may take into its own column: `claimed` once a list has (see useTabStrip). */
interface StripSlot { strip: ReactNode; claimed: boolean; claim: () => () => void }
const StripSlotContext = createContext<StripSlot | null>(null);

/**
 * mold_v0-315: inside an InPageTabs that hands its strip off, the strip for the caller to draw at the top of its own
 * column (null otherwise, and until the claim lands: the strip is drawn once, by one of the two, on every render).
 * The caller keeps it from anything inside it (<NoTabStrip>), so only the outermost list takes it.
 */
export function useTabStrip(): ReactNode {
  const slot = useContext(StripSlotContext);
  const claim = slot?.claim;
  useLayoutEffect(() => claim?.(), [claim]);
  return slot?.claimed ? slot.strip : null;
}

/** mold_v0-315: what is inside never takes the strip (content above the list, a list inside a panel). */
export function NoTabStrip({ children }: { children: ReactNode }) {
  return <StripSlotContext.Provider value={null}>{children}</StripSlotContext.Provider>;
}

export function InPageTabs<T extends InPageTab>({ tabs, children, value, onValueChange, size = 'default', label, className, handOff = false }: {
  tabs: readonly T[]; children?: (tab: T) => ReactNode; value?: string; onValueChange?: (id: string) => void; size?: 'default' | 'sm'; label?: string; className?: string;
  /** mold_v0-315: a list at the top of the selected tab may draw the strip in its own column (useTabStrip). */
  handOff?: boolean;
}) {
  const [selected, setSelected] = useQueryState('tab', { defaultValue: tabs[0]?.id ?? '' });
  const controlled = value !== undefined;
  const current = tabs.find((t) => t.id === (controlled ? value : selected)) ?? tabs[0];
  const { ref, more, nudge } = useStripScroll(current?.id ?? '', tabs.length);
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => { setClaims((n) => n + 1); return () => setClaims((n) => n - 1); }, []);
  const claimed = handOff && claims > 0;
  const wide = tabs.length > 6;
  const sm = size === 'sm';
  const triggers = tabs.map((t) => <TabsTrigger key={t.id} value={t.id} className={cn('flex-none px-0', sm && 'text-[13px] [&_svg]:size-3.5')} {...t.data}>{tabIcon(t.icon)}{t.label}</TabsTrigger>);
  // mold_v0-289: the strip always scrolls sideways on its own when wider than the page: it never widens the page (a phone).
  const strip = (
      <div className='relative w-full min-w-0 max-w-full' data-in-page-strip=''>
        <div ref={ref} className='-mx-1 w-full min-w-0 max-w-full overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
          data-wide-strip={wide ? '' : undefined} data-strip-more={more.left || more.right ? [more.left && 'left', more.right && 'right'].filter(Boolean).join(' ') : undefined}>
          <TabsList variant='line' aria-label={label} className={cn('w-max p-0', sm ? 'gap-4' : 'gap-6')}>{triggers}</TabsList>
        </div>
        {/* mold_v0-298: the cue at an edge with more tabs past it: a fade and a small arrow that scrolls the strip that way. */}
        {more.left && <StripCue side='left' onClick={() => nudge(-1)} />}
        {more.right && <StripCue side='right' onClick={() => nudge(1)} />}
      </div>
  );
  const slot: StripSlot | null = handOff ? { strip, claimed, claim } : null;
  if (!current) return null;
  return (
    <Tabs value={current.id} onValueChange={(v) => (controlled ? onValueChange?.(String(v)) : void setSelected(String(v)))} className={cn('w-full min-w-0', sm ? 'gap-0' : 'gap-6', className)}>
      {!claimed && strip}
      {children && (
        <TabsContent value={current.id} className='min-w-0'>
          <StripSlotContext.Provider value={slot}>{children(current)}</StripSlotContext.Provider>
        </TabsContent>
      )}
    </Tabs>
  );
}

/** mold_v0-298: exported so every scrolling tab strip (the record panel's, team, run, programs) shows the same cue.
 *  The strip's scroller: whether tabs are hidden past either edge, kept in step with scrolling and resizing; the selected
 *  tab (`current`) scrolled into view within the strip only (never the page); `nudge` scrolls most of a width that way. */
export function useStripScroll(current: string, count: number) {
  // mold_v0-315: the scroller as state (a callback ref), so a strip that moves (handed to a list's column) is followed.
  const [el, ref] = useState<HTMLDivElement | null>(null);
  const [more, setMore] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    if (!el) return;
    const left = el.scrollLeft > 2, right = el.scrollWidth - el.clientWidth - el.scrollLeft > 2;
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
  }, [el]);
  useLayoutEffect(() => {
    if (!el) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => { el.removeEventListener('scroll', measure); ro.disconnect(); };
  }, [el, measure, count]);
  useLayoutEffect(() => {
    const tab = el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!el || !tab || el.scrollWidth <= el.clientWidth) return;
    const box = el.getBoundingClientRect(), r = tab.getBoundingClientRect();
    const pad = 32; // clear of the edge's fade
    if (r.left < box.left + pad) el.scrollLeft += r.left - box.left - pad;
    else if (r.right > box.right - pad) el.scrollLeft += r.right - box.right + pad;
    measure();
  }, [el, current, count, measure]);
  const nudge = (dir: 1 | -1) => {
    if (!el) return;
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: dir * Math.max(80, el.clientWidth * 0.7), behavior: reduce ? 'auto' : 'smooth' });
  };
  return { ref, more, nudge };
}

/** The cue at one edge: a fade over the last tab's edge and an arrow button (a mouse's way to scroll; touch swipes). */
export function StripCue({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const left = side === 'left';
  return (
    <div className={cn('from-background pointer-events-none absolute top-0 bottom-1 z-[1] flex w-10 items-center', left ? 'left-0 justify-start bg-gradient-to-r to-transparent' : 'right-0 justify-end bg-gradient-to-l to-transparent')}
      data-strip-cue={side}>
      <button type='button' tabIndex={-1} aria-hidden onClick={onClick}
        className='bg-background text-muted-foreground hover:text-foreground pointer-events-auto flex size-6 items-center justify-center rounded-full border shadow-sm'>
        {left ? <IconChevronLeft className='size-3.5' /> : <IconChevronRight className='size-3.5' />}
      </button>
    </div>
  );
}
