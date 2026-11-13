'use client';
/**
 * mold_v0-298: the sidebar's lit entry, worked out once for the sidebar and the top bar's trail alike, so the trail's
 * group is always the group of the entry the sidebar lights: the same groups (filtered by role and flag), the same
 * address (the page's query too: a files tab's ?store=), the same footer (API keys only when the sidebar shows them
 * there) and the same rule (src/lib/active-nav.ts). A 404 lights nothing.
 */
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { useConsolePathname } from '@/lib/console-path';
import { useNav } from '@/components/layout/nav-context';
import { useFilteredNavGroups } from '@/hooks/use-nav';
import { profile } from '@/config/profile.generated';
import { hiddenConsoleUrls, settingsTabs } from '@/config/pack-nav.generated';
import { activeNavUrl, navOptions, navUrls } from '@/lib/active-nav';
import { usePageNotFound } from '@/lib/page-not-found';
import type { NavGroup } from '@/types';

/** mold_v0-280: the person's API keys are a tab of Settings (a pack's keys tab declared inside: settings). */
const keysInSettings = settingsTabs.some((t) => (t.kind as string) === 'keys');
/**
 * Member API keys (mold_v0-099, profile `member_keys`): false removes the API keys page and its link; a build that hides
 * the page (console.hide: ["keys"], mold_v0-171) loses the link and the page, the keys themselves unchanged.
 */
export const memberKeysOn = (profile as Readonly<Record<string, unknown>>).member_keys !== false && !hiddenConsoleUrls.includes('/app/keys');

/** The page's query, read below a Suspense boundary (useSearchParams), so the frame renders the same on the server. */
function SearchProbe({ onChange }: { onChange: (search: string) => void }) {
  const params = useSearchParams();
  const search = params?.toString() ?? '';
  React.useEffect(() => onChange(search), [search, onChange]);
  return null;
}

/** The page's query and the element that reads it (draw the element anywhere in the component using the query). */
export function useNavSearch(): [string, React.ReactNode] {
  const [search, setSearch] = React.useState('');
  return [search, <React.Suspense key='nav-search' fallback={null}><SearchProbe onChange={setSearch} /></React.Suspense>];
}

export interface ActiveNavEntry {
  /** The groups the sidebar draws (role and flags applied). */
  groups: NavGroup[];
  /** Every entry the sidebar draws, its footer's last. */
  urls: string[];
  /** The footer's entries (API keys when shown there, Profile). */
  footer: string[];
  /** The lit entry; none on a 404 or a page that belongs to no entry. */
  activeUrl: string | null;
}

export function useActiveNavEntry(search: string): ActiveNavEntry {
  const pathname = useConsolePathname();
  const { area, groups } = useNav();
  const filteredGroups = useFilteredNavGroups(groups);
  // A declared sidebar that lists API keys (mold_v0-133, a keys tab) has it in its group: not again in the footer; nor
  // when a keys tab puts the page inside Settings (mold_v0-280: Settings' tab is its one place).
  const keysInNav = keysInSettings || groups.some((g) => g.items.some((i) => i.url === '/app/keys'));
  const base = area === 'admin' ? '/admin' : '/app';
  const footerKey = [...(area === 'portal' && memberKeysOn && !keysInNav ? ['/app/keys'] : []), `${base}/profile`].join(' ');
  const footer = React.useMemo(() => footerKey.split(' '), [footerKey]);
  const urls = React.useMemo(() => navUrls(filteredGroups, footer), [filteredGroups, footer]);
  // mold_v0-298: a 404 lights nothing (an address that is no page belongs to no entry, even one under the home's).
  const notFound = usePageNotFound();
  const activeUrl = notFound ? null : activeNavUrl(search ? `${pathname}?${search}` : pathname, urls, navOptions(area === 'admin' ? 'admin' : 'portal'));
  return { groups: filteredGroups, urls, footer, activeUrl };
}

/**
 * The lit entry's place (mold_v0-298): its words, its address and its group's name as the sidebar shows it: none when the
 * sidebar draws no heading for the group (no name, or named like its first entry: "Overview" over Overview, even with
 * Settings joined below it). Null for an entry outside the groups (the footer's) or no lit entry.
 */
export function placeOfEntry(groups: readonly NavGroup[], url: string | null): { group: string | null; title: string; url: string } | null {
  if (!url) return null;
  for (const g of groups) {
    const heading = g.label?.trim() && g.items[0]?.title !== g.label ? g.label.trim() : null;
    for (const i of g.items) {
      if (i.external) continue;
      const hit = i.url === url ? i : i.items?.find((x) => x.url === url);
      if (hit) return { group: heading, title: hit.title, url: hit.url };
    }
  }
  return null;
}
