/**
 * The public site's crawl lists (mold_v0-109; web/src/app/robots.ts, sitemap.ts). scripts/legal-test.ts checks every
 * public page under web/src/app/(site) is in PUBLIC_PAGES or is a legal page, so a new public page is listed when it lands.
 */

/** The shell's public pages, in sitemap order (paths of this site); the legal pages are added when the build has them. */
export const PUBLIC_PAGES = ['/', '/install', '/request-access'] as const;

/** What robots.txt keeps crawlers out of: the console, the API and sign-in. */
export const DISALLOWED = ['/app', '/admin', '/api', '/auth'] as const;
