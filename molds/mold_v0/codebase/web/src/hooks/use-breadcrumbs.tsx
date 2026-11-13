'use client';

import { useConsolePathname } from '@/lib/console-path';
import { useMemo } from 'react';
import { packPages, packTabs, recordAreas } from '@/config/pack-nav.generated';
import { settingsGroups, settingsTabUrl } from '@/config/settings';
import { useBreadcrumbLeaf, useBreadcrumbTitleAt } from '@/lib/breadcrumb-leaf';
import { placeOfEntry, useActiveNavEntry } from '@/hooks/use-active-nav-entry';
import { usePageNotFound } from '@/lib/page-not-found';

type BreadcrumbItem = {
  title: string;
  /** None for a sidebar group's name (mold_v0-298): a heading, no page of its own. */
  link?: string;
  /** Shown on a phone too, where only the last crumb is otherwise (mold_v0-290: it is the way back from an open session). */
  keep?: boolean;
};

// Readable names for path segments; anything else is capitalised (a host pack's own pages: its words).
const TITLES: Record<string, string> = {
  admin: 'Admin', app: 'Account', requests: 'Access requests', keys: 'Key vault', agents: 'Harness mix', configuration: 'Agent configuration', 'agent-profiles': 'Agent profiles', accounts: 'Accounts',
  analytics: 'Analytics', health: 'Health', usage: 'Usage', context: 'Context', limits: 'Limits', team: 'Team', billing: 'Billing', profile: 'Profile', company: 'Company', users: 'Users', adoption: 'Adoption', products: 'Products', docs: 'Docs',
  'connected-apps': 'Connected apps', agent: 'Agents', settings: 'Settings', 'run-analytics': 'Run analytics'
};
const routeMapping: Record<string, BreadcrumbItem[]> = {};

/**
 * A pack's page or tab by its address (mold_v0-132: /app/<id>, flat): its own label, so the trail reads "<group> /
 * Home", not the id. A tab that opens a shell page (Usage, Billing) is named by the tab too; /app is named by its sidebar entry (mold_v0-298).
 */
const PACK_TITLES = new Map<string, string>([
  ...packPages.map((p) => [p.url, p.title] as [string, string]),
  // Settings' group pages past 5 tabs (mold_v0-219): Access, Connections, Automation, Data & trust.
  ...settingsGroups().map((g) => [g.url, g.label] as [string, string]),
  // A credentials tab opens Settings (mold_v0-218): that page is Settings, whatever the tab's label.
  ...packTabs.filter((t) => t.url !== '/app' && !t.url.includes('?') && t.kind !== 'credentials').map((t) => [t.url, t.label] as [string, string]),
  // A record area's pages (mold_v0-170): named by the area's label, as the sidebar names them ("Control library", not
  // "Controls"); /admin/records and /app/records have no page of their own, so they are no crumb.
  ...recordAreas.flatMap((a) => [[`/admin/records/${a.name}`, a.label], [`/app/records/${a.name}`, a.label]] as [string, string][])
]);
const RECORDS = /^\/(admin|app)\/records$/;
const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

const AGENT_PAGE = /^\/(app|admin)\/agent$/;

/**
 * The trail of the page being drawn. `search` is the page's query (useNavSearch, drawn by the caller), so the group named
 * first is the group of the entry the sidebar lights (mold_v0-298: the same hook, the same groups, address and rule).
 */
export function useBreadcrumbs(search = '') {
  const pathname = useConsolePathname();
  const leaf = useBreadcrumbLeaf();
  const ownTitle = useBreadcrumbTitleAt(pathname);
  const notFound = usePageNotFound();
  const { groups, activeUrl } = useActiveNavEntry(search);

  const breadcrumbs = useMemo((): BreadcrumbItem[] => {
    // mold_v0-298: a 404 has no trail (the address is no page, so nothing to name and nowhere it sits).
    if (notFound) return [];
    // Check if we have a custom mapping for this exact path
    if (routeMapping[pathname]) {
      return routeMapping[pathname];
    }

    // If no exact match, fall back to generating breadcrumbs from the path
    const segments = pathname.split('/').filter(Boolean);
    const crumbs = segments.flatMap((segment, index): BreadcrumbItem[] => {
      const path = `/${segments.slice(0, index + 1).join('/')}`;
      if (RECORDS.test(path)) return [];
      // mold_v0-259: a team's page (/app/settings/teams/<id>): Teams is Settings' tab (no page of its own), the team by its id.
      if (path === '/app/settings/teams') return [{ title: 'Teams', link: settingsTabUrl('teams') ?? '/app/settings' }];
      if (path.startsWith('/app/settings/teams/') && index === 3) return [{ title: `Team ${decode(segment)}`, link: path }];
      // A record's key (/admin/records/<area>/<key>) reads as it is written, never capitalised or encoded.
      if (segments[index - 2] === 'records' && index === 3) return [{ title: decode(segment), link: path }];
      // A doc's slug (/admin/docs/budget-rules-spec) reads as words.
      const name = segments[index - 1] === 'docs' ? segment.replace(/-/g, ' ') : segment;
      return [{
        title: PACK_TITLES.get(path) ?? TITLES[segment] ?? name.charAt(0).toUpperCase() + name.slice(1),
        link: path
      }];
    });
    // mold_v0-298: the trail starts at the page's place in the sidebar, not at the area ("Account", "Admin"): the area's
    // own crumb goes, the group's name leads (a heading, no link; none when the group has no name or is named like the
    // entry), and the area's home is named by its entry ("Overview"). A page outside the sidebar starts at its own name.
    const place = placeOfEntry(groups, activeUrl);
    let trail = crumbs.slice(1);
    if (!trail.length) trail = place ? [{ title: place.title, link: place.url }] : crumbs.slice(0, 1);
    // A page that names its own crumb (a record's page: the record's title, not the key in the address).
    if (ownTitle && trail.length) trail = [...trail.slice(0, -1), { ...trail.at(-1)!, title: ownTitle }];
    // mold_v0-290: an open session is the trail's last level, its short number; the page before it links back to the list.
    if (leaf && AGENT_PAGE.test(pathname) && trail.length) trail = [...trail.slice(0, -1), { ...trail.at(-1)!, keep: true }, { title: leaf, link: `${pathname}#${leaf}` }];
    // The group's name only where the sidebar shows it as a heading (placeOfEntry), and never twice in a row.
    const group = place?.group;
    return group && group !== trail[0]?.title ? [{ title: group }, ...trail] : trail;
  }, [pathname, leaf, ownTitle, notFound, groups, activeUrl]);

  return breadcrumbs;
}
