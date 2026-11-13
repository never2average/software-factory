import { isSettingsUrl, settingsNavItem, SETTINGS_URL, type SettingsTabSpec } from './settings';
import { settingsTabs } from './pack-nav.generated';
import { NavGroup } from '@/types';
import { hiddenConsoleUrls, repositoryCount, workspacePortalNav, packAdminNav, packPortalNav, packTabs, recordAdminNav, recordPortalNav, tabPortalNav, usagePortalNav } from './pack-nav.generated';
import { withHostAdminNav, withHostPortalNav } from '@/features/packs/host-nav';
import { featureOn } from './features';
import { sessionEngine } from '@/features/admin/engine';

/**
 * mold_v0-284: Agent configuration's in-page tabs, with agent_harness on: Configuration (the settings) and Profiles (the
 * workspace agent's profiles, /admin/agent-profiles leading there: scripts/gen-packs.mjs). None when the agent is off,
 * or when the staff Records group lists the profiles (console.admin_records `agent-profiles`): they stay there alone.
 */
export const AGENT_CONFIG_URL = '/admin/configuration';
export const AGENT_PROFILES_URL = '/admin/agent-profiles';
const profilesInRecords = recordAdminNav.some((g) => g.items.some((i) => i.url === AGENT_PROFILES_URL || i.inPageTabs?.some((t) => t.url === AGENT_PROFILES_URL)));
export const agentConfigTabs: { id: 'configuration' | 'profiles'; label: string; url: string }[] = featureOn('agent_harness') && !profilesInRecords
  ? [{ id: 'configuration', label: 'Configuration', url: AGENT_CONFIG_URL }, { id: 'profiles', label: 'Profiles', url: AGENT_PROFILES_URL }]
  : [];

/**
 * The modules of each area, shown in the left sidebar and in the Cmd+K bar.
 * /admin: platform staff across every account. /app: one account's people (account admins see management controls).
 * A host pack (mold_v0-039) puts its own entries among these (withHost*Nav); the declarative packs' come after.
 */
export const adminNav: NavGroup[] = withRecordsPlaced([
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
        // mold_v0-260 (flag run_analytics): the runs across the workspaces, broken down.
        ...(featureOn('run_analytics') ? [{ title: 'Run analytics', url: '/admin/run-analytics', icon: 'trendingUp' as const, items: [] }] : []),
        { title: 'Health', url: '/admin/health', icon: 'gauge', shortcut: ['g', 'h'], items: [] }
      ]
    },
    {
      label: 'Operations',
      items: [
        { title: 'Compute', url: '/admin/compute', icon: 'adjustments', shortcut: ['g', 'c'], items: [] },
        { title: 'FinOps', url: '/admin/finops', icon: 'trendingUp', items: [] },
        // mold_v0-284: with agent_harness on, the workspace agent's profiles (mold_v0-261) are its Profiles tab (agentConfigTabs).
        { title: 'Agent configuration', url: AGENT_CONFIG_URL, icon: 'settings', items: [], ...(agentConfigTabs.length ? { inPageTabs: agentConfigTabs } : {}) },
        // The packs' data repositories (mold_v0-129): only in a build with a workspace_files repository (mold_v0-283).
        ...(repositoryCount ? [{ title: 'Data repositories', url: '/admin/repositories', icon: 'book' as const, items: [] }] : []),
        // The platform's staff are Accounts' Admins tab (/admin/accounts?section=admins, mold_v0-204), not an entry here.
        { title: 'Key vault', url: '/admin/keys', icon: 'lock', shortcut: ['g', 'k'], items: [] }
      ]
    }
  ]),
  // The packs' pages (scripts/gen-packs.mjs, mold_v0-038), after the shell's own; then their shared record areas (mold_v0-047).
  ...packAdminNav,
  ...recordAdminNav
]);

/**
 * mold_v0-271: a shell staff page the Records group lists (profile.json or pack.json console.admin_records: Journeys,
 * Recipes, Agent profiles, Data repositories) is there only: it leaves the group it is otherwise in (a group left empty
 * goes), at the same address. Nothing moves when the group lists record areas alone. mold_v0-281: a shell page that is an
 * in-page tab of one of its entries leaves its group the same way (its address then leads to that tab).
 */
function withRecordsPlaced(groups: NavGroup[]): NavGroup[] {
  // mold_v0-281: an entry of in-page tabs places each of its members (a shell page among them leaves its group too).
  const placed = new Set(recordAdminNav.flatMap((g) => g.items).flatMap((i) => (i.inPageTabs?.length ? i.inPageTabs.map((t) => t.url) : [i.url])).filter((u) => !u.startsWith('/admin/records/')));
  if (!placed.size) return groups;
  return groups.map((g) => (g.label === 'Records' && recordAdminNav.includes(g) ? g : { ...g, items: g.items.filter((i) => !placed.has(i.url)) })).filter((g) => g.items.length > 0);
}

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

/** Whether /app/usage only leads on to the Activity page the packs already put in the sidebar (mold_v0-298). */
const usageLeadsToActivity = !sessionEngine() && usagePortalNav.some((g) => g.items.some((i) => i.url === '/app/activity'));

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
        // mold_v0-298: without the session engine /app/usage only leads on to /app/activity, so when the packs' Activity
        // entry is in the sidebar, Activity takes Usage's place (one entry for the page; its own entry below is merged away).
        usageLeadsToActivity ? { title: 'Activity', url: '/app/activity', icon: 'chartLine' as const, items: [] }
          : { title: 'Usage', url: '/app/usage', icon: 'chartLine' as const, shortcut: ['g', 'u'] as [string, string], items: [] },
        // mold_v0-260 (flag run_analytics): the workspace's runs broken down (a declared sidebar reaches it from Activity).
        ...(featureOn('run_analytics') ? [{ title: 'Run analytics', url: '/app/run-analytics', icon: 'trendingUp' as const, items: [] }] : [])
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
  // mold_v0-280: when every tab is one a pack narrows to some roles (a team or keys tab inside Settings), the entry is
  // those roles' too.
  const narrowed = tabs.every((t) => (t as { roles?: string[] }).roles) ? [...new Set(tabs.flatMap((t) => (t as { roles?: string[] }).roles!))] : null;
  const entry = { ...item, ...(own?.roles ? { roles: own.roles } : narrowed ? { roles: narrowed } : {}) };
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
