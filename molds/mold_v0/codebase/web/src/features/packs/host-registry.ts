import { HOST_WEB } from '@/config/pack-web.generated';
import type { HostArea, HostPageModule } from './host-web';

/** A host pack's page module for an area and path, or null (mold_v0-039). */
export const hostPageModule = (area: HostArea, pack: string, path: string[]): HostPageModule | null =>
  HOST_WEB.find((w) => w.id === pack)?.[area]?.[path.join('/')] ?? null;

/** Every host page of an area, as route params; a placeholder (never a page: a 404) when there is none, as Next needs one. */
export function hostPageParams(area: HostArea): { pack: string; path: string[] }[] {
  const params = HOST_WEB.flatMap((w) => Object.keys(w[area] ?? {}).map((p) => ({ pack: w.id, path: p.split('/') })));
  return params.length ? params : [{ pack: '_', path: ['_'] }];
}

/** The landing page and the public pages' layout and metadata a host pack brings, if any. */
export const hostLanding = () => HOST_WEB.find((w) => w.landing)?.landing ?? null;
export const hostSiteLayout = () => HOST_WEB.find((w) => w.siteLayout)?.siteLayout ?? null;
export const hostSiteMetadata = () => HOST_WEB.find((w) => w.siteMetadata)?.siteMetadata ?? null;
