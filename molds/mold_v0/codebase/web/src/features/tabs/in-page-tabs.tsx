'use client';
// The console's in-page tab strip (mold_v0-175, shared since mold_v0-281): a line-variant strip of 2 or more tabs above
// the selected one's body, the selection kept in the address (?tab=<id>, the first tab when absent or unknown). Both
// consoles draw it: a customer sections tab (./tab-page.tsx SectionsTab) and a staff Records entry of in-page tabs
// (web/src/features/records/staff-record-group.tsx). Past 6 tabs the strip scrolls sideways on its own (mold_v0-260).
import type { ReactNode } from 'react';
import { useQueryState } from 'nuqs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export interface InPageTab { id: string; label: string }

export function InPageTabs<T extends InPageTab>({ tabs, children }: { tabs: readonly T[]; children: (tab: T) => ReactNode }) {
  const [selected, setSelected] = useQueryState('tab', { defaultValue: tabs[0]?.id ?? '' });
  const current = tabs.find((t) => t.id === selected) ?? tabs[0];
  if (!current) return null;
  const wide = tabs.length > 6;
  const triggers = tabs.map((t) => <TabsTrigger key={t.id} value={t.id} className='flex-none px-0'>{t.label}</TabsTrigger>);
  return (
    <Tabs value={current.id} onValueChange={(v) => void setSelected(String(v))} className={wide ? 'w-full min-w-0 gap-6' : 'gap-6'}>
      {wide ? (
        // mold_v0-260: 7 or 8 in-page tabs: the strip scrolls sideways on its own when it is wider than the page (a phone).
        <div className='-mx-1 w-full min-w-0 max-w-full overflow-x-auto px-1 pb-1' data-wide-strip=''>
          <TabsList variant='line' className='w-max gap-6 p-0'>{triggers}</TabsList>
        </div>
      ) : (
        <TabsList variant='line' className='gap-6 p-0'>{triggers}</TabsList>
      )}
      <TabsContent value={current.id} className={wide ? 'min-w-0' : undefined}>{children(current)}</TabsContent>
    </Tabs>
  );
}
