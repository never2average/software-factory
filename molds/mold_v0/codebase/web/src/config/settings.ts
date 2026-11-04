// Settings, assembled from the features registry (mold_v0-218, mold_v0-219): each capability that is on contributes its
// tabs (scripts/gen-packs.mjs settingsTabs), and a pack's record area declared `settings: { group, label }` adds its own.
// Four fixed groups, in this order: Access (Credentials, API keys, Allowed origins), Connections (Email, Webhooks,
// Integrations), Automation (Alerts), Data & trust (Signing), each followed by the packs' tabs of that group. Billing is
// not part of Settings.
//
// How the sidebar and the page lay them out, by how many tabs there are:
//   0      no Settings entry and no page
//   1      one Settings entry; /app/settings is that table alone, with no strip
//   2..5   one Settings entry directly below Overview; /app/settings has one in-page strip
//   >5     Settings is a collapsible sidebar group, one entry per group that has a tab, each at /app/settings/<group>
//          (access, connections, automation, data-trust) with its own strip
// Addresses: a tab is ?tab=<id> on its page, the page's first tab with none (/app/settings?tab=email,
// /app/settings/connections?tab=webhooks). /app/settings?tab=<id> always works: past 5 tabs it leads to the tab's group
// page, and /app/settings alone to the first group's.
import type { NavGroup, NavItem } from '@/types';
import { settingsTabs as GENERATED, type SettingsTabSpec } from './pack-nav.generated';

export type { SettingsTabSpec };
export type SettingsGroupId = SettingsTabSpec['group'];
export const SETTINGS_URL = '/app/settings';
/** The most tabs one strip shows; past it, a page per group. */
export const MAX_STRIP_TABS = 5;
export const SETTINGS_GROUPS: readonly { id: SettingsGroupId; label: string; slug: string; icon: NonNullable<NavItem['icon']> }[] = [
  { id: 'access', label: 'Access', slug: 'access', icon: 'lock' },
  { id: 'connections', label: 'Connections', slug: 'connections', icon: 'plug' },
  { id: 'automation', label: 'Automation', slug: 'automation', icon: 'calendar' },
  { id: 'data_trust', label: 'Data & trust', slug: 'data-trust', icon: 'shield' }
];

export type SettingsLayout = 'none' | 'single' | 'strip' | 'groups';
export const settingsLayout = (tabs: readonly SettingsTabSpec[] = GENERATED): SettingsLayout =>
  tabs.length === 0 ? 'none' : tabs.length === 1 ? 'single' : tabs.length <= MAX_STRIP_TABS ? 'strip' : 'groups';

/** The groups that have a tab, in order, each with its tabs and its page. */
export function settingsGroups(tabs: readonly SettingsTabSpec[] = GENERATED) {
  return SETTINGS_GROUPS.map((g) => ({ ...g, url: `${SETTINGS_URL}/${g.slug}`, tabs: tabs.filter((t) => t.group === g.id) })).filter((g) => g.tabs.length > 0);
}
export const groupBySlug = (slug: string, tabs: readonly SettingsTabSpec[] = GENERATED) => settingsGroups(tabs).find((g) => g.slug === slug) ?? null;

/** The tabs one Settings page shows: every tab (up to 5), or one group's (past 5). */
export function pageTabs(group: string | null, tabs: readonly SettingsTabSpec[] = GENERATED): SettingsTabSpec[] {
  if (settingsLayout(tabs) !== 'groups') return group ? [] : [...tabs];
  return group ? groupBySlug(group, tabs)?.tabs ?? [] : [];
}

/** A tab's address: its page, with ?tab= unless it is the page's first. */
export function settingsTabUrl(id: string, tabs: readonly SettingsTabSpec[] = GENERATED): string | null {
  const t = tabs.find((x) => x.id === id);
  if (!t) return null;
  if (settingsLayout(tabs) === 'groups') {
    const g = settingsGroups(tabs).find((x) => x.id === t.group)!;
    return g.tabs[0]!.id === id ? g.url : `${g.url}?tab=${id}`;
  }
  return tabs[0]!.id === id ? SETTINGS_URL : `${SETTINGS_URL}?tab=${id}`;
}

/** The sidebar's Settings entry: none, one entry, or (past 5 tabs) one with an entry per group. */
export function settingsNavItem(tabs: readonly SettingsTabSpec[] = GENERATED): NavItem | null {
  const layout = settingsLayout(tabs);
  if (layout === 'none') return null;
  if (layout !== 'groups') return { title: 'Settings', url: SETTINGS_URL, icon: 'settings', items: [] };
  const groups = settingsGroups(tabs);
  // The entry itself is /app/settings (which leads to the first group's page); its items are the groups' pages.
  return { title: 'Settings', url: SETTINGS_URL, icon: 'settings', items: groups.map((g) => ({ title: g.label, url: g.url, items: [] })) };
}

/** Whether an address is Settings' (the page, a group's page, or a tab of either). */
export const isSettingsUrl = (url: string) => url === SETTINGS_URL || url.startsWith(`${SETTINGS_URL}?`) || url.startsWith(`${SETTINGS_URL}/`);
export type { NavGroup };
