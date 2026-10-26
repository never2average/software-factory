import type { NavGroup, NavItem } from '@/types';
import { HOST_NAV } from '@/config/pack-host-nav.generated';

/**
 * A host pack's sidebar entries and the shell components its routes serve (mold_v0-039; config since mold_v0-140:
 * pack.json console.nav and console.components, written by scripts/gen-packs.mjs to src/config/pack-host-nav.generated.ts).
 * Data apart from its pages (host-registry.ts) so the sidebar and the client components that ask for one never bundle
 * the pack's pages.
 */
export interface HostNavItem { title: string; url: string; icon: NonNullable<NavItem['icon']>; shortcut?: [string, string] }
/**
 * Where entries go: a new group before or after the group with that label (`label`), or entries put into a group before
 * or after the entry with that url (`into`). No anchor, or one this sidebar lacks: at the end (of the sidebar, or of the
 * group); entries for a group this sidebar lacks go nowhere.
 */
export interface HostNavPlacement { label?: string; into?: string; before?: string; after?: string; items: HostNavItem[] }
export interface HostNav {
  pack: string;
  /** The /app and /admin sidebars' placements, applied in order to the shell's groups. */
  app?: HostNavPlacement[];
  admin?: HostNavPlacement[];
  /** The shell's console components its routes serve (src/console-pages.ts CONSOLE_COMPONENTS: tips, journeys, research). */
  components?: readonly string[];
}

const navs = HOST_NAV as readonly HostNav[];
/** Whether a host pack serves one of the shell's console components (the shell's own pages show it only then). */
export const hostFeature = (f: string) => navs.some((n) => n.components?.includes(f));

/** Placements applied to the sidebar's groups, in order; each item as the sidebar's own: {title, url, icon, shortcut?, items: []}. */
export function placeNav(groups: NavGroup[], placements: readonly HostNavPlacement[]): NavGroup[] {
  let out = groups;
  for (const p of placements) {
    const items: NavItem[] = p.items.map((i) => ({ title: i.title, url: i.url, icon: i.icon, ...(i.shortcut ? { shortcut: [i.shortcut[0], i.shortcut[1]] as [string, string] } : {}), items: [] }));
    const anchor = p.after ?? p.before;
    if (p.into !== undefined) {
      out = out.map((g) => {
        if (g.label !== p.into) return g;
        const i = anchor === undefined ? -1 : g.items.findIndex((x) => x.url === anchor);
        const at = i < 0 ? g.items.length : p.after !== undefined ? i + 1 : i;
        return { ...g, items: [...g.items.slice(0, at), ...items, ...g.items.slice(at)] };
      });
      continue;
    }
    const i = anchor === undefined ? -1 : out.findIndex((g) => g.label === anchor);
    const at = i < 0 ? out.length : p.after !== undefined ? i + 1 : i;
    out = [...out.slice(0, at), { label: p.label ?? '', items }, ...out.slice(at)];
  }
  return out;
}

/** The sidebars with every host pack's entries (each pack's placed where it says). */
export const withHostPortalNav = (groups: NavGroup[]) => navs.reduce((g, n) => placeNav(g, n.app ?? []), groups);
export const withHostAdminNav = (groups: NavGroup[]) => navs.reduce((g, n) => placeNav(g, n.admin ?? []), groups);
