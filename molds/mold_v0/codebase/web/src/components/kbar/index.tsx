'use client';
import { useNav } from '@/components/layout/nav-context';
import { KBarAnimator, KBarPortal, KBarPositioner, KBarProvider, KBarSearch } from 'kbar';
import { Kbd } from '@/components/ui/kbd';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import RenderResults from './render-result';
import { useFilteredNavGroups } from '@/hooks/use-nav';
import type { DocNavGroup } from '@/features/docs/docs-data';
import { AskAiAction, AskAiProvider } from './ask-ai';

/**
 * The Cmd+K bar: the area's modules, its docs (a "Docs" entry to browse the pages; typing finds pages and their h2/h3
 * sections, which open at the section), and "Ask AI" for a question (./ask-ai.tsx). `docs` is the current area's docs
 * index, titles and headings only, passed down from the area's layout: the admin docs index reaches admins only.
 */
export default function KBar({ docs = [], children }: { docs?: DocNavGroup[]; children: React.ReactNode }) {
  const router = useRouter();
  const { groups } = useNav();
  const filteredGroups = useFilteredNavGroups(groups);

  // These action are for the navigation
  const actions = useMemo(() => {
    // Define navigateTo inside the useMemo callback to avoid dependency array issues
    const navigateTo = (url: string) => {
      router.push(url);
    };

    const allItems = filteredGroups.flatMap((group) => group.items);

    return allItems.flatMap((navItem) => {
      // Only include base action if the navItem has a real URL and is not just a container
      const baseAction =
        navItem.url !== '#'
          ? {
              id: `${navItem.title.toLowerCase()}Action`,
              name: navItem.title,
              shortcut: navItem.shortcut,
              keywords: navItem.title.toLowerCase(),
              section: 'Navigation',
              subtitle: `Go to ${navItem.title}`,
              perform: () => (navItem.external ? window.open(navItem.url, '_blank', 'noopener') : navigateTo(navItem.url))
            }
          : null;

      // Map child items into actions
      const childActions =
        navItem.items?.map((childItem) => ({
          id: `${childItem.title.toLowerCase()}Action`,
          name: childItem.title,
          shortcut: childItem.shortcut,
          keywords: childItem.title.toLowerCase(),
          section: navItem.title,
          subtitle: `Go to ${childItem.title}`,
          perform: () => navigateTo(childItem.url)
        })) ?? [];

      // Return only valid actions (ignoring null base actions for containers)
      return baseAction ? [baseAction, ...childActions] : childActions;
    });
  }, [router, filteredGroups]);

  // Docs: pages under one "Docs" entry, each page's sections under the page (shown as "page › section" when found).
  const docActions = useMemo(() => {
    if (!docs.length) return [];
    const seen = new Set<string>();
    const once = <T extends { id: string }>(a: T) => (seen.has(a.id) ? [] : (seen.add(a.id), [a]));
    return [
      { id: 'docs', name: 'Docs', section: 'Docs', keywords: 'docs documentation help guide', subtitle: 'Browse the documentation' },
      ...docs.flatMap((g) => g.pages.flatMap((p) => [
        ...once({ id: `doc:${p.href}`, parent: 'docs', name: p.title, section: 'Docs', keywords: g.title.toLowerCase(), subtitle: g.title, perform: () => router.push(p.href) }),
        ...p.headings.flatMap((h) => once({ id: `doc:${p.href}#${h.id}`, parent: `doc:${p.href}`, name: h.text, section: 'Docs', keywords: p.title.toLowerCase(),
          perform: () => router.push(`${p.href}#${h.id}`) }))
      ]))
    ];
  }, [docs, router]);
  const all = useMemo(() => [...actions, ...docActions], [actions, docActions]);

  return (
    <KBarProvider actions={all}>
      <AskAiProvider>
        <AskAiAction />
        <KBarComponent>{children}</KBarComponent>
      </AskAiProvider>
    </KBarProvider>
  );
}
const KBarComponent = ({ children }: { children: React.ReactNode }) => {

  return (
    <>
      <KBarPortal>
        <KBarPositioner className='bg-black/10 supports-backdrop-filter:backdrop-blur-xs fixed inset-0 z-99999 flex items-start! justify-center p-4! pt-[14vh]!'>
          <KBarAnimator className='bg-popover text-popover-foreground ring-foreground/10 relative mx-auto w-full max-w-[600px] overflow-hidden rounded-xl shadow-lg ring-1'>
            <div className='bg-popover sticky top-0 z-10 border-b'>
              <KBarSearch className='placeholder:text-muted-foreground w-full border-none bg-transparent px-4 py-3.5 text-sm outline-hidden focus:ring-0 focus:outline-hidden' />
            </div>
            <div className='h-[400px]'>
              <RenderResults />
            </div>
            <div className='text-muted-foreground flex items-center gap-3 border-t px-3 py-2 text-xs'>
              <span className='flex items-center gap-1'>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> navigate
              </span>
              <span className='flex items-center gap-1'>
                <Kbd>↵</Kbd> open
              </span>
              <span className='flex items-center gap-1'>
                <Kbd>esc</Kbd> close
              </span>
            </div>
          </KBarAnimator>
        </KBarPositioner>
      </KBarPortal>
      {children}
    </>
  );
};
