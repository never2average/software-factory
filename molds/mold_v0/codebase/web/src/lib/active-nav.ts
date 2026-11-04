/**
 * The sidebar's one active entry (mold_v0-213): which entry a page belongs to, in the customer console and the staff
 * console alike. Pure, so scripts/console-sidebar-test.ts walks every route of a build through it.
 *
 * An entry is a page (its path) and maybe a query it needs (a files tab's ?store=<pack>). For the page being drawn:
 *   1. a record's own page, <base>/records/<area>[/<key>], belongs to the area's entry when the sidebar has one, else to
 *      the tab that lists the area (`recordHome`: its own tab before a merged or a filtered one), so a finding opened
 *      from Findings keeps Findings lit
 *   2. a page outside the sidebar belongs to the entry it is reached from (`homes`: Journeys to the home page, the
 *      billing limits to Billing, Connected apps to Profile ...)
 *   3. then the entry whose path is the page's, its query a subset of the page's (?tab=, ?overdue=1, ?journey= and the
 *      like keep it: an in-page tab, a filter or a journey is the same page); else the longest entry whose path the
 *      page is under (/admin/accounts/<slug> under Accounts). The area's home (<base> itself) is never a prefix: it is
 *      lit on itself only.
 * At most one entry is returned (the first of equals, in the sidebar's order); none for a page that belongs to none.
 */
import { packTabs } from '@/config/pack-nav.generated';
import type { NavGroup } from '@/types';

export interface ActiveNavOptions {
  /** /app or /admin. */
  base: string;
  /** The page a record area's records belong to (its tab's address), when the sidebar has no entry of its own for it. */
  recordHome?: (area: string) => string | null;
  /** Pages outside the sidebar and the page whose entry they light (paths, or prefixes ending in /). */
  homes?: Readonly<Record<string, string>>;
}

const split = (url: string): { path: string; query: URLSearchParams } => {
  const i = url.indexOf('?');
  const path = (i < 0 ? url : url.slice(0, i)).replace(/(.)\/+$/, '$1');
  return { path, query: new URLSearchParams(i < 0 ? '' : url.slice(i + 1)) };
};

/** The page's own path for matching: a record's page as its list's, a page outside the sidebar as its home's. */
function homeOf(path: string, search: URLSearchParams, urls: readonly string[], o: ActiveNavOptions): { path: string; query: URLSearchParams } {
  const rec = new RegExp(`^${o.base}/records/([^/]+)(?:/.*)?$`).exec(path);
  if (rec) {
    const area = decodeURIComponent(rec[1]!);
    const own = `${o.base}/records/${area}`;
    if (!urls.some((u) => split(u).path === own) && o.recordHome) {
      const home = o.recordHome(area);
      if (home) return split(home);
    }
    return { path: own, query: search };
  }
  for (const [from, to] of Object.entries(o.homes ?? {})) {
    if (from.endsWith('/') ? path.startsWith(from) : path === from) {
      // Only when the sidebar has no entry for the page itself.
      if (!urls.some((u) => split(u).path === path)) return split(to);
    }
  }
  return { path, query: search };
}

export function activeNavUrl(url: string, urls: readonly string[], o: ActiveNavOptions): string | null {
  const page = split(url);
  const at = homeOf(page.path, page.query, urls, o);
  let best: string | null = null, score = -1;
  for (const u of urls) {
    const e = split(u);
    // An entry that needs a query (a files tab's store) is lit only with it.
    if ([...e.query].some(([k, v]) => at.query.get(k) !== v)) continue;
    const s = e.path === at.path ? 100_000 + [...e.query].length
      : e.path !== o.base && at.path.startsWith(`${e.path}/`) ? e.path.length : -1;
    if (s > score) { best = u; score = s; }
  }
  // The area's home with no entry of its own (a sidebar of declared tabs with no home tab): the sidebar's first entry,
  // where a person starts.
  if (best === null && at.path === o.base) return urls[0] ?? null;
  return best;
}

/**
 * Pages of each console outside its sidebar, and the page each belongs to (mold_v0-213). A page that only redirects
 * (/app/team, /app/limits, /admin/emails, /admin/spend) is never drawn and needs none.
 */
const firstTab = (kind: string) => packTabs.find((t) => t.kind === kind)?.url;
export const PORTAL_HOMES: Readonly<Record<string, string>> = {
  '/app/journeys': '/app',
  '/app/connected-apps': '/app/profile',
  // A home tab that includes the notices without their card (mold_v0-216): /app/notices is its own page, reached from Home.
  '/app/notices': '/app',
  // A sidebar of declared tabs without a schedules tab: the schedules belong to the runs they start.
  ...(firstTab('runs') ? { '/app/schedules': firstTab('runs')! } : {}),
  '/app/usage': '/app/activity',
};
export const ADMIN_HOMES: Readonly<Record<string, string>> = {
  '/admin/journeys': '/admin',
  '/admin/connect': '/admin',
};

/**
 * The tab that lists a record area (mold_v0-213): a record's own page lights its entry. The area's own unfiltered tab
 * first, then a filtered one, then one that merges it in; an in-page tab's address is its page's (?tab=).
 */
export function packRecordHome(area: string): string | null {
  const rank = (t: (typeof packTabs)[number]) => (t.area === area ? (t.filtered ? 1 : 0) : 2);
  const tabs = packTabs.filter((t) => t.kind === 'area' && (t.area === area || t.areas?.some((a) => a.area === area))).sort((a, b) => rank(a) - rank(b));
  return tabs[0]?.url ?? null;
}

/** Every entry the sidebar draws (its groups' entries and their sub-entries, then the footer's), in its order. */
export const navUrls = (groups: readonly NavGroup[], footer: readonly string[]): string[] => [
  ...groups.flatMap((g) => g.items.flatMap((i) => (i.external ? [] : [i.url, ...(i.items ?? []).map((x) => x.url)]))),
  ...footer
];

/** Each console's options: the customer console's records lead to their tabs; the staff console's have entries. */
export const navOptions = (area: 'portal' | 'admin'): ActiveNavOptions => area === 'admin'
  ? { base: '/admin', homes: ADMIN_HOMES }
  : { base: '/app', recordHome: packRecordHome, homes: PORTAL_HOMES };
