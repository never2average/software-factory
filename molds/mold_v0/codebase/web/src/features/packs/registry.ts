// The packs' console pages (mold_v0-038), from the generated web/src/config/pack-nav.generated.ts (scripts/gen-packs.mjs).
import { packPages, type PackPage } from '@/config/pack-nav.generated';

/** The page a pack declares for this area, or null (an unknown pack or page is a 404). */
export function findPackPage(area: 'app' | 'admin', pack: string, page: string): PackPage | null {
  return packPages.find((p) => p.area === area && p.pack === pack && p.id === page) ?? null;
}

/** The customer page at /app/<id> (mold_v0-132: flat; gen-packs refuses two packs' pages at one address), or null. */
export function findAppPage(id: string): PackPage | null {
  return packPages.find((p) => p.area === 'app' && p.id === id) ?? null;
}

/** Every page of an area, for generateStaticParams. */
export const packPageParams = (area: 'app' | 'admin') => packPages.filter((p) => p.area === area).map((p) => ({ pack: p.pack, page: p.id }));

/** Every customer page, for /app/[page]'s generateStaticParams. */
export const appPageParams = () => packPages.filter((p) => p.area === 'app').map((p) => ({ page: p.id }));

/** Where a page's rows come from: the pack's own routes (src/pack-routes.ts), behind the area's sign-in. */
export const packDataUrl = (p: PackPage) => `${p.area === 'admin' ? '/api/admin/packs' : '/api/packs'}/${p.pack}${p.data}`;
