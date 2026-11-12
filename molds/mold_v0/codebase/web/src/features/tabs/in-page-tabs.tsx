'use client';
// The console's in-page tab strip (mold_v0-175, shared since mold_v0-281): a line-variant strip of 2 or more tabs above
// the selected one's body, the selection kept in the address (?tab=<id>, the first tab when absent or unknown). Both
// consoles draw it: a customer sections tab (./tab-page.tsx SectionsTab) and a staff Records entry of in-page tabs
// (web/src/features/records/staff-record-group.tsx). Past 6 tabs the strip scrolls sideways on its own (mold_v0-260).
// mold_v0-296: a caller may keep the selection itself (`value`, `onValueChange`: the agent dock's panel, whose open section is
// ?section=<id>), draw the strip alone (no `children`) and draw it small (`size='sm'`: a panel's header).
import type { ReactNode } from 'react';
import { useQueryState } from 'nuqs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

export interface InPageTab { id: string; label: string; icon?: ReactNode; data?: Record<`data-${string}`, string | undefined> }

export function InPageTabs<T extends InPageTab>({ tabs, children, value, onValueChange, size = 'default', label, className }: {
  tabs: readonly T[]; children?: (tab: T) => ReactNode; value?: string; onValueChange?: (id: string) => void; size?: 'default' | 'sm'; label?: string; className?: string;
}) {
  const [selected, setSelected] = useQueryState('tab', { defaultValue: tabs[0]?.id ?? '' });
  const controlled = value !== undefined;
  const current = tabs.find((t) => t.id === (controlled ? value : selected)) ?? tabs[0];
  if (!current) return null;
  const wide = tabs.length > 6;
  const sm = size === 'sm';
  const triggers = tabs.map((t) => <TabsTrigger key={t.id} value={t.id} className={cn('flex-none px-0', sm && 'text-[13px] [&_svg]:size-3.5')} {...t.data}>{t.icon}{t.label}</TabsTrigger>);
  return (
    <Tabs value={current.id} onValueChange={(v) => (controlled ? onValueChange?.(String(v)) : void setSelected(String(v)))} className={cn('w-full min-w-0', sm ? 'gap-0' : 'gap-6', className)}>
      {/* mold_v0-289: the strip always scrolls sideways on its own when wider than the page: it never widens the page (a phone). */}
      <div className='-mx-1 w-full min-w-0 max-w-full overflow-x-auto px-1 pb-1' data-wide-strip={wide ? '' : undefined}>
        <TabsList variant='line' aria-label={label} className={cn('w-max p-0', sm ? 'gap-4' : 'gap-6')}>{triggers}</TabsList>
      </div>
      {children && <TabsContent value={current.id} className='min-w-0'>{children(current)}</TabsContent>}
    </Tabs>
  );
}
