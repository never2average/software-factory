import { featureOn } from './features';
import { isSettingsUrl, settingsNavItem, SETTINGS_URL, type SettingsTabSpec } from './settings';
import { settingsTabs } from './pack-nav.generated';
import { NavGroup } from '@/types';
import { hiddenConsoleUrls, repositoryCount, workspacePortalNav, packAdminNav, packPortalNav, packTabs, recordAdminNav, recordPortalNav, tabPortalNav, usagePortalNav } from './pack-nav.generated';
import { withHostAdminNav, withHostPortalNav } from '@/features/packs/host-nav';

/**
 * The modules of each area, shown in the left sidebar and in the Cmd+K bar.
 * /admin: platform staff across every account. /app: one account's people (account admins see management controls).
 * A host pack (mold_v0-039) puts its own entries among these (withHost*Nav); the declarative packs' come after.
 */
export const adminNav: NavGroup[] = [
  ...withHostAdminNav([
    {
      label: 'Onboarding',
      items: [
        { title: 'Overview', url: '/admin', icon: 'dashboard', shortcut: ['g', 'o'], items: [] },
        { title: 'Access requests', url: '/admin/requests', icon: 'inbox', shortcut: ['g', 'r'], items: [] },
        { title: 'Accounts', url: '/admin/accounts', icon: 'building', shortcut: ['g', 'a'], items: [] }
      ]
    },
    {
      label: 'Insights',
      items: [
        { title: 'Analytics', url: '/admin/analytics', icon: 'chartBar', shortcut: ['g', 'n'], items: [] },
        { title: 'Health', url: '/admin/health', icon: 'gauge', shortcut: ['g', 'h'], items: [] }
      ]
    },
    {
      label: 'Operations',
      items: [
        { title: 'Compute', url: '/admin/compute', icon: 'adjustments', shortcut: ['g', 'c'], items: [] },
        { title: 'FinOps', url: '/admin/finops', icon: 'trendingUp', items: [] },
        { title: 'Agent configuration', url: '/admin/configuration', icon: 'settings', items: [] },
        // mold_v0-261: the workspace agent's profiles, with agent_harness on.
        ...(featureOn('agent_harness') ? [{ title: 'Agent profiles', url: '/admin/agent-profiles', icon: 'userPen' as const, items: [] }] : []),
        // The packs' data repositories (mold_v0-129): their pins, index state and Index now, in a build that has one.
        ...(repositoryCount ? [{ title: 'Data repositories', url: '/admin/repositories', icon: 'book' as const, items: [] }] : []),
        // The platform's staff are Accounts' Admins tab (/admin/accounts?section=admins, mold_v0-204), not an entry here.
        { title: 'Key vault', url: '/admin/keys', icon: 'lock', shortcut: ['g', 'k'], items: [] }
      ]
    }
  ]),
  // The packs' pages (scripts/gen-packs.mjs, mold_v0-038), after the shell's own; then their shared record areas (mold_v0-047).
  ...packAdminNav,
  ...recordAdminNav
];

/** A shell page the build hides (mold_v0-130, src/console-pages.ts), or one under it: left out of the sidebar. */
const hidden = (url: string) => hiddenConsoleUrls.some((h) => url === h || url.startsWith(`${h}/`) || url.startsWith(`${h}?`));
const withoutHidden = (groups: NavGroup[]): NavGroup[] =>
  hiddenConsoleUrls.length ? groups.map((g) => ({ ...g, items: g.items.filter((i) => !hidden(i.url)) })).filter((g) => g.items.length > 0) : groups;

/**
 * One group per heading and one entry per page (mold_v0-133): a pack's group named like one of the shell's joins it, and
 * an entry whose page the sidebar already has is left out, so the shell's groups never repeat the packs'.
 */
export function mergeNav(groups: NavGroup[]): NavGroup[] {
  const out: NavGroup[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    const items = g.items.filter((i) => { if (seen.has(i.url)) return false; seen.add(i.url); return true; });
    const same = out.find((x) => x.label === g.label);
    if (same) same.items.push(...items);
    else if (items.length) out.push({ ...g, items });
  }
  return out;
}

/** The shell's own /app sidebar (with a host pack's entries among its own), and what the declarative packs add after it. */
const shellPortalNav: NavGroup[] = mergeNav(withoutHidden([
  ...withHostPortalNav([
    {
      label: 'Get started',
      items: [{ title: 'Setup & training', url: '/app', icon: 'rocket', shortcut: ['g', 's'], items: [] }]
    },
    {
      label: 'Insights',
      items: [
        { title: 'Usage', url: '/app/usage', icon: 'chartLine', shortcut: ['g', 'u'], items: [] }
      ]
    },
    {
      label: 'Operational',
      items: [
        { title: 'Billing', url: '/app/billing', icon: 'billing', shortcut: ['g', 'b'], items: [] },
        { title: 'Profile', url: '/app/profile', icon: 'account', items: [] },
        // The AI apps each person signed in to /mcp, with Revoke (mold_v0-087); hideable (console.hide: connected-apps).
        { title: 'Connected apps', url: '/app/connected-apps', icon: 'plug', items: [] }
      ]
    }
  ]),
  // The packs' pages (scripts/gen-packs.mjs, mold_v0-038), after the shell's own; then their record areas (mold_v0-047)
  // and the Workspace group: Credentials (mold_v0-034), Schedules and Notices (mold_v0-035), each when the build has one.
  ...packPortalNav,
  ...recordPortalNav,
  ...workspacePortalNav,
  ...usagePortalNav
]));

/**
 * The /app sidebar: when packs declare tabs (mold_v0-058), exactly those, in their order and groups (each tab limited to
 * the roles that may read what it shows), or the whole sidebar the app's profile declares (mold_v0-133: profile.json
 * console.sidebar, its groups, the packs' tabs and the shell's pages in its order); otherwise the shell's own.
 */
// The developer surface's console is Settings' API keys, Allowed origins, Webhooks and Integrations tabs since mold_v0-219.
const basePortalNav: NavGroup[] = tabPortalNav.length ? tabPortalNav : shellPortalNav;

export { SETTINGS_URL };
/**
 * The Settings entry, directly below Overview (mold_v0-218; laid out by its tab count since mold_v0-219,
 * web/src/config/settings.ts): the console's home (/app) or a pack's overview tab, else the sidebar's first entry. None
 * with no tab; one entry up to 5 tabs; past 5 a collapsible entry with one item per group. A pack's credentials tab or a
 * declared sidebar's `credentials` (both open /app/settings) leave their own place for it, its roles kept.
 */
export function withSettings(groups: NavGroup[], tabs: readonly SettingsTabSpec[] = settingsTabs): NavGroup[] {
  const own = groups.flatMap((g) => g.items).find((i) => isSettingsUrl(i.url));
  const rest = groups.map((g) => ({ ...g, items: g.items.filter((i) => !isSettingsUrl(i.url)) })).filter((g) => g.items.length > 0);
  const item = settingsNavItem(tabs);
  if (!item) return rest;
  const entry = { ...item, ...(own?.roles ? { roles: own.roles } : {}) };
  const overviews = new Set(['/app', ...packTabs.filter((t) => t.kind === 'overview').map((t) => t.url)]);
  const gi = rest.findIndex((g) => g.items.some((i) => overviews.has(i.url)));
  if (gi < 0) return rest.length ? [{ ...rest[0]!, items: [entry, ...rest[0]!.items] }, ...rest.slice(1)] : [{ label: '', items: [entry] }];
  return rest.map((g, i) => {
    if (i !== gi) return g;
    const at = g.items.findIndex((x) => overviews.has(x.url));
    return { ...g, items: [...g.items.slice(0, at + 1), entry, ...g.items.slice(at + 1)] };
  });
}
export const portalNav: NavGroup[] = withSettings(basePortalNav);
