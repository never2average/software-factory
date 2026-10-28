import type { MetadataRoute } from 'next';
import { landing } from '@/config/landing.generated';
import { legal } from '@/config/legal.generated';
import { ownLegalPaths } from '@/features/site/legal-types';
import { PUBLIC_PAGES } from '@/features/site/public-pages';
import { siteUrl } from '@/lib/site-url';
import packRoutes from '@/config/pack-routes.generated.json';

// sitemap.xml (mold_v0-109): the public pages on the console's own address (web/src/lib/site-url.ts): the landing page, the
// install pages, the public request page, the build's declared request page (mold_v0-138: the landing block's
// request_page) when it has one, and the legal pages the console serves itself (none
// without profile.json `legal`; a page the company keeps on its own site is not listed). scripts/legal-test.ts checks
// every public page of web/src/app/(site) is here (features/site/public-pages.ts). A public page the build redirects
// elsewhere (a pack's console.redirects: the shell's /request-access to the app's own request page, mold_v0-171) is not.
export const dynamic = 'force-dynamic';

/** The addresses this build redirects (next.config's redirects, from pack-routes.generated.json). */
const REDIRECTED = new Set((packRoutes.redirects as { source: string }[]).map((r) => r.source));

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const at = (path: string) => (path === '/' ? `${base}/` : `${base}${path}`);
  return [
    ...PUBLIC_PAGES.filter((path) => !REDIRECTED.has(path)).map((path) => ({ url: at(path), changeFrequency: 'weekly' as const, priority: path === '/' ? 1 : 0.8 })),
    ...(landing?.request_page ? [{ url: at(landing.request_page.path), changeFrequency: 'weekly' as const, priority: 0.8 }] : []),
    ...ownLegalPaths(legal).map((path) => ({ url: at(path), lastModified: legal!.effective_date, changeFrequency: 'yearly' as const, priority: 0.3 }))
  ];
}
