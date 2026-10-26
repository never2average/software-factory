import type { ComponentType, ReactNode } from 'react';

/** How a host page is rendered: as the component its module's default export is. */
export type HostPageComponent = ComponentType<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>;
import type { Metadata } from 'next';

/**
 * A host pack's console code (mold_v0-039; src/host.ts on the server): web/src/packs/<id>/index.ts, listed by
 * scripts/gen-packs.mjs in src/config/pack-web.generated.ts. Its pages keep their own URLs: next.config rewrites each
 * (from src/config/pack-routes.generated.json, written from the pack's routes.json) to the shell's host page routes,
 * app/{app,admin}/host/[pack]/[...path] and app/(site)/host/[pack]/[...path], which render the page module named here.
 * Its sidebar entries and the shell components it serves are its pack.json console (mold_v0-140; features/packs/host-nav.ts). With zero packs none
 * of this exists: the sidebar, the landing page and every route are the shell's.
 */

/** A page module, as a Next page file is: its default component (given the search params) and its metadata. */
export interface HostPageModule {
  /** As a Next page's default export: given its search params, it renders (or redirects, never returning). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a page's own props (its search params, typed by the page)
  default: (props: any) => unknown;
  metadata?: Metadata;
}

export interface HostWeb {
  id: string;
  /** Pages under /app, by path after /app/ ("pick-rate", "context/company"). */
  app?: Record<string, HostPageModule>;
  /** Pages under /admin, by path after /admin/. */
  admin?: Record<string, HostPageModule>;
  /** Public pages at the root, by path ("early-access"). */
  site?: Record<string, HostPageModule>;
  /** The landing page at / (else the shell's neutral one), and the public pages' layout and metadata. */
  landing?: HostPageModule;
  siteLayout?: ComponentType<{ children: ReactNode }>;
  siteMetadata?: Metadata;
}

export type HostArea = 'app' | 'admin' | 'site';
