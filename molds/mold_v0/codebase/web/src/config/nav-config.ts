import { NavGroup } from '@/types';
import { hiddenConsoleUrls, repositoryCount, workspacePortalNav, packAdminNav, packPortalNav, recordAdminNav, recordPortalNav, tabPortalNav, usageAdminNav, usagePortalNav } from './pack-nav.generated';
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
        // The packs' data repositories (mold_v0-129): their pins, index state and Index now, in a build that has one.
        ...(repositoryCount ? [{ title: 'Data repositories', url: '/admin/repositories', icon: 'book' as const, items: [] }] : []),
        { title: 'Key vault', url: '/admin/keys', icon: 'lock', shortcut: ['g', 'k'], items: [] },
        { title: 'Admins', url: '/admin/admins', icon: 'teams', items: [] }
      ]
    }
  ]),
  // The packs' pages (scripts/gen-packs.mjs, mold_v0-038), after the shell's own; then their shared record areas (mold_v0-047).
  ...packAdminNav,
  ...recordAdminNav,
  // Usage in neutral words (mold_v0-008), when the build has a pack.
  ...usageAdminNav
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
export const portalNav: NavGroup[] = tabPortalNav.length ? tabPortalNav : shellPortalNav;
