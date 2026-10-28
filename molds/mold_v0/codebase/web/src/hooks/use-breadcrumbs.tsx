'use client';

import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { packPages, packTabs, recordAreas } from '@/config/pack-nav.generated';

type BreadcrumbItem = {
  title: string;
  link: string;
};

// Readable names for path segments; anything else is capitalised (a host pack's own pages: its words).
const TITLES: Record<string, string> = {
  admin: 'Admin', app: 'Account', requests: 'Access requests', keys: 'Key vault', agents: 'Harness mix', configuration: 'Agent configuration', accounts: 'Accounts',
  analytics: 'Analytics', health: 'Health', usage: 'Usage', context: 'Context', limits: 'Limits', team: 'Team', billing: 'Billing', profile: 'Profile', company: 'Company', users: 'Users', adoption: 'Adoption', products: 'Products', docs: 'Docs',
  'connected-apps': 'Connected apps'
};
const routeMapping: Record<string, BreadcrumbItem[]> = {};

/**
 * A pack's page or tab by its address (mold_v0-132: /app/<id>, flat): its own label, so the trail reads "Account /
 * Home", not the id. A tab that opens a shell page (Usage, Billing) is named by the tab too; /app stays Account.
 */
const PACK_TITLES = new Map<string, string>([
  ...packPages.map((p) => [p.url, p.title] as [string, string]),
  ...packTabs.filter((t) => t.url !== '/app' && !t.url.includes('?')).map((t) => [t.url, t.label] as [string, string]),
  // A record area's pages (mold_v0-170): named by the area's label, as the sidebar names them ("Control library", not
  // "Controls"); /admin/records and /app/records have no page of their own, so they are no crumb.
  ...recordAreas.flatMap((a) => [[`/admin/records/${a.name}`, a.label], [`/app/records/${a.name}`, a.label]] as [string, string][])
]);
const RECORDS = /^\/(admin|app)\/records$/;
const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

export function useBreadcrumbs() {
  const pathname = usePathname();

  const breadcrumbs = useMemo(() => {
    // Check if we have a custom mapping for this exact path
    if (routeMapping[pathname]) {
      return routeMapping[pathname];
    }

    // If no exact match, fall back to generating breadcrumbs from the path
    const segments = pathname.split('/').filter(Boolean);
    return segments.flatMap((segment, index) => {
      const path = `/${segments.slice(0, index + 1).join('/')}`;
      if (RECORDS.test(path)) return [];
      // A record's key (/admin/records/<area>/<key>) reads as it is written, never capitalised or encoded.
      if (segments[index - 2] === 'records' && index === 3) return [{ title: decode(segment), link: path }];
      // A doc's slug (/admin/docs/budget-rules-spec) reads as words.
      const name = segments[index - 1] === 'docs' ? segment.replace(/-/g, ' ') : segment;
      return [{
        title: PACK_TITLES.get(path) ?? TITLES[segment] ?? name.charAt(0).toUpperCase() + name.slice(1),
        link: path
      }];
    });
  }, [pathname]);

  return breadcrumbs;
}
