import type { NavGroup } from '@/types';
import { HOST_NAV } from '@/config/pack-host-nav.generated';

/**
 * A host pack's sidebar entries and the shell features it enables (mold_v0-039): web/src/packs/<id>/nav.ts, listed by
 * scripts/gen-packs.mjs in src/config/pack-host-nav.generated.ts. Kept apart from its pages (host-registry.ts) so the
 * sidebar and the client components that ask for a feature never bundle the pack's pages.
 */
export interface HostNav {
  /** The /app and /admin sidebars: the shell's groups in, the product's out (its entries added where they belong). */
  portalNav?(groups: NavGroup[]): NavGroup[];
  adminNav?(groups: NavGroup[]): NavGroup[];
  /** Console features of the shell that need this product's routes ('tips': in-chat tips; 'journeys': Setup's journeys). */
  features?: readonly string[];
  /** The sign-up form's subtitle (else the profile's short description). */
  signUpSubtitle?: string;
}

const navs = HOST_NAV as readonly HostNav[];
/** Whether a host pack offers a console feature the shell's own pages show only then. */
export const hostFeature = (f: string) => navs.some((n) => n.features?.includes(f));
/** The sign-up form's subtitle a host pack gives, if any. */
export const hostSignUpSubtitle = () => navs.find((n) => n.signUpSubtitle)?.signUpSubtitle ?? null;
/** The sidebars with every host pack's entries (each pack adds its own where they belong). */
export const withHostPortalNav = (groups: NavGroup[]) => navs.reduce((g, n) => (n.portalNav ? n.portalNav(g) : g), groups);
export const withHostAdminNav = (groups: NavGroup[]) => navs.reduce((g, n) => (n.adminNav ? n.adminNav(g) : g), groups);
