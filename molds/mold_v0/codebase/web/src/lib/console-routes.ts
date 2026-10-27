/**
 * Which addresses are pages of this build (mold_v0-155), for web/src/proxy.ts: an address under /app, /admin or /auth
 * that is none is answered with the area's not-found page, a 404 drawn on the server (NOT_FOUND_ROUTE below). (Next 16 draws a page that throws notFound() in the browser only: its HTML is an empty error shell until the
 * scripts run, a blank page on a slow phone or without JavaScript.)
 *
 * Nothing here is a second copy of the routing: the page routes are the app directory's (console-routes.generated.json,
 * scripts/gen-packs.mjs), and each dynamic route asks the same registry its page asks (the packs' pages and tabs, the
 * record areas, the docs, the host pages' routes). A dynamic route whose answer depends on data the build does not have
 * (a record's key, an account) is OPEN: every value is a page here, and the page itself says not found, as before (the
 * thrown notFound(), drawn in the browser). Pure TS with relative imports only: scripts/status-pages-test.ts reads it.
 */
import manifest from '../config/console-routes.generated.json';
import packRoutesJson from '../config/pack-routes.generated.json';
import { landing } from '../config/landing.generated';
import { legal } from '../config/legal.generated';
import { profile } from '../config/profile.generated';
import { ADMIN_DOCS } from '../content/admin-docs.generated';
import { guidePages } from '../content/customer-guide';
import catalog from '../content/mcp-tools.generated.json';
import { findAppPage, findPackPage } from '../features/packs/registry';
import { findRecordArea } from '../features/records/registry';
import { findTab } from '../features/tabs/registry';
import { resolveContext } from '../features/context/config';
import { journeysOn, tipsOn } from '../features/journeys/config';

type Params = Record<string, string[]>;
/** The packs' own URLs (each rewritten to its host page) and their old addresses (redirects); empty with no packs. */
const packRoutes = packRoutesJson as { rewrites: { source: string; destination: string }[]; redirects: { source: string }[] };
const first = (p: Params, k: string) => p[k]?.[0] ?? '';

/** The host pages' routes (pack-routes.generated.json): each host page is the destination of its own URL's rewrite. */
const HOST_PAGES = new Set(packRoutes.rewrites.map((r) => r.destination));
const host = (prefix: string) => (p: Params) => HOST_PAGES.has(`${prefix}/host/${first(p, 'pack')}/${(p.path ?? []).join('/')}`);
const CUSTOMER_DOCS = new Set(guidePages(catalog).map((g) => g.slug));
const ADMIN_DOC_SLUGS = new Set(ADMIN_DOCS.map((d) => d.slug));

/** Each dynamic route the build can answer for: the page's own test, from the same registry. */
export const RESOLVED: Readonly<Record<string, (p: Params) => boolean>> = {
  '/app/[page]': (p) => !!(findAppPage(first(p, 'page')) || findTab(first(p, 'page'))),
  '/app/records/[area]': (p) => !!findRecordArea('app', first(p, 'area')),
  '/app/records/[area]/[key]': (p) => !!findRecordArea('app', first(p, 'area')),
  '/admin/records/[area]': (p) => !!findRecordArea('admin', first(p, 'area')),
  '/admin/records/[area]/[key]': (p) => !!findRecordArea('admin', first(p, 'area')),
  '/admin/packs/[pack]/[page]': (p) => !!findPackPage('admin', first(p, 'pack'), first(p, 'page')),
  '/app/docs/[slug]': (p) => CUSTOMER_DOCS.has(first(p, 'slug')),
  '/admin/docs/[slug]': (p) => ADMIN_DOC_SLUGS.has(first(p, 'slug')),
  '/app/host/[pack]/[...path]': host('/app'),
  '/admin/host/[pack]/[...path]': host('/admin'),
  '/host/[pack]/[...path]': host(''),
  '/declared/[page]': (p) => first(p, 'page') === 'request' && !!landing?.request_page,
  // The account context and memory pages (mold_v0-142): only where a pack turns them on, each page and each old name.
  '/app/context/[[...section]]': (p) => resolveContext(p.section) !== null,
};

/**
 * The page routes the build itself may switch off (the page's own test, from the same generated config): the member
 * keys page when the profile turns member keys off (mold_v0-099), the legal pages without `legal` (mold_v0-109).
 */
export const SHOWN: Readonly<Record<string, () => boolean>> = {
  '/app/keys': () => (profile as Readonly<Record<string, unknown>>).member_keys !== false,
  '/privacy': () => !!legal,
  '/terms': () => !!legal,
  // The journeys and in-chat tips components' pages (mold_v0-143): only where a pack turns them on.
  '/app/journeys': () => journeysOn(),
  '/admin/journeys': () => journeysOn() || tipsOn(),
};

/**
 * The dynamic routes whose answer depends on data: an account's slug, and Clerk's own sign-in and sign-up steps. (A
 * record's key is the other: its area is checked above, the record by its page.)
 */
export const OPEN: readonly string[] = ['/admin/accounts/[slug]', '/auth/sign-in/[[...sign-in]]', '/auth/sign-up/[[...sign-up]]'];

type Seg = { kind: 'static'; name: string } | { kind: 'one' | 'many' | 'any'; name: string };
const seg = (s: string): Seg => {
  let m = /^\[\[\.\.\.(.+)\]\]$/.exec(s);
  if (m) return { kind: 'any', name: m[1]! };
  m = /^\[\.\.\.(.+)\]$/.exec(s);
  if (m) return { kind: 'many', name: m[1]! };
  m = /^\[(.+)\]$/.exec(s);
  if (m) return { kind: 'one', name: m[1]! };
  // A next.config source's parameters (the packs' redirects): :name, :name* and :name+.
  m = /^:([A-Za-z0-9_]+)([*+]?)$/.exec(s);
  if (m) return { kind: m[2] === '*' ? 'any' : m[2] === '+' ? 'many' : 'one', name: m[1]! };
  return { kind: 'static', name: s };
};
const split = (p: string) => p.split('/').filter(Boolean);

interface Route { route: string; segs: Seg[]; dynamic: boolean }
const route = (r: string): Route => {
  const segs = split(r).map(seg);
  return { route: r, segs, dynamic: segs.some((s) => s.kind !== 'static') };
};
/** The app directory's pages, then the packs' own URLs (rewritten to the host pages) and their old addresses (redirects). */
const PAGES: Route[] = (manifest.routes as string[]).map(route);
const SOURCES: Route[] = [...packRoutes.rewrites, ...packRoutes.redirects].map((r) => ({ ...route(r.source), dynamic: false }));

function match(segs: Seg[], parts: string[]): Params | null {
  const out: Params = {};
  let i = 0;
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k]!;
    if (s.kind === 'static') { if (parts[i] !== s.name) return null; i++; continue; }
    if (s.kind === 'one') { if (i >= parts.length) return null; out[s.name] = [parts[i]!]; i++; continue; }
    // A catch-all takes the rest (Next allows it last only).
    const rest = parts.slice(i);
    if (s.kind === 'many' && !rest.length) return null;
    out[s.name] = rest;
    i = parts.length;
  }
  return i === parts.length ? out : null;
}

/** Is `pathname` a page of this build? Unsure (an address that is not valid percent-encoding) counts as yes. */
export function isConsoleAddress(pathname: string): boolean {
  let parts: string[];
  try { parts = split(pathname).map((s) => decodeURIComponent(s)); } catch { return true; }
  for (const r of [...SOURCES, ...PAGES]) {
    const m = match(r.segs, parts);
    if (!m) continue;
    if (!r.dynamic) { if (SHOWN[r.route]?.() === false) continue; return true; }
    if (OPEN.includes(r.route)) return true;
    const known = RESOLVED[r.route];
    // A dynamic route nobody decided for here: left to its page, as before (status-pages-test fails on one).
    if (!known || known(m)) return true;
  }
  return false;
}

/**
 * Where an unknown address is drawn (mold_v0-155): Next's own not-found route, the one route Next draws on the server
 * with its 404 (a rewrite's own status is not kept), with the area it was in named in this request header; app/not-found.tsx
 * draws that area's not-found page in the area's frame. web/src/proxy.ts sets the header, and drops one a browser sent.
 */
export const NOT_FOUND_ROUTE = '/_not-found';
export const NOT_FOUND_AREA_HEADER = 'x-console-not-found';
export type NotFoundArea = 'app' | 'admin' | 'auth' | 'site';
/** The console-status pages (the API relays /console-status/not-found): no page of the build, so a 404 as well. */
export const STATUS_PAGES: readonly string[] = manifest.status_pages as string[];

export function notFoundAreaFor(pathname: string): NotFoundArea {
  const area = split(pathname)[0];
  return area === 'app' || area === 'admin' || area === 'auth' ? area : 'site';
}
