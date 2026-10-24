import type { MetadataRoute } from 'next';
import { legal } from '@/config/legal.generated';
import { ownLegalPaths } from '@/features/site/legal-types';
import { PUBLIC_PAGES } from '@/features/site/public-pages';
import { siteUrl } from '@/lib/site-url';

// sitemap.xml (mold_v0-109): the public pages on the console's own address (web/src/lib/site-url.ts): the landing page, the
// install pages, the public request page when the build has one, and the legal pages the console serves itself (none
// without profile.json `legal`; a page the company keeps on its own site is not listed). scripts/legal-test.ts checks
// every public page of web/src/app/(site) is here (features/site/public-pages.ts).
export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const at = (path: string) => (path === '/' ? `${base}/` : `${base}${path}`);
  return [
    ...PUBLIC_PAGES.map((path) => ({ url: at(path), changeFrequency: 'weekly' as const, priority: path === '/' ? 1 : 0.8 })),
    ...ownLegalPaths(legal).map((path) => ({ url: at(path), lastModified: legal!.effective_date, changeFrequency: 'yearly' as const, priority: 0.3 }))
  ];
}
