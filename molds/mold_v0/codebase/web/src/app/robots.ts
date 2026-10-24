import type { MetadataRoute } from 'next';
import { DISALLOWED } from '@/features/site/public-pages';
import { siteUrl } from '@/lib/site-url';

// robots.txt (mold_v0-109): the public pages (the landing page, /install, request and legal pages) may be crawled; the
// console (/app, /admin), the API (/api) and sign-in (/auth) may not. The sitemap is on the console's own address
// (web/src/lib/site-url.ts), read when asked, so a console moved to a custom domain says so without a rebuild.
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const base = siteUrl();
  return { rules: [{ userAgent: '*', allow: '/', disallow: [...DISALLOWED] }], sitemap: `${base}/sitemap.xml`, host: base };
}
