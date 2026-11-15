'use client';
/**
 * mold_v0-298: the page being drawn is the not-found page. The console's frame (the top bar's trail, the sidebar's lit
 * entry) reads it, so a 404 has no trail and no lit entry: an address that is no page belongs to no entry, even when
 * it starts like one (a hidden page under the home's address lit the home's entry before).
 *
 * Two ways it is known, the same on the server and in the browser:
 *   - the root not-found page (app/not-found.tsx, drawn on the server for an address the proxy rewrote) wraps the
 *     area's frame in NotFoundProvider, so the frame knows from its first paint (no hydration mismatch);
 *   - a page that throws notFound() is drawn inside the area's layout (app/app/not-found.tsx, app/admin/not-found.tsx),
 *     which drew the frame before it: the status page marks itself while it is shown (useMarkNotFound), and the frame
 *     redraws. mold_v0-308: from the first paint, never after it: the mark is a layout effect (the redraw lands before
 *     the browser paints), and the status page carries NotFoundFrameStyle, which unlights the frame's entry and hides
 *     its trail wherever its HTML is painted before the scripts run (a server's HTML, a slow hydration).
 */
import { createContext, useContext, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';

const Ctx = createContext(false);

/** Wraps a frame drawn for an address that is no page. */
export function NotFoundProvider({ children }: { children: ReactNode }) {
  return <Ctx.Provider value={true}>{children}</Ctx.Provider>;
}

// Status pages showing a 404 right now (a count: one going while another comes never clears the other's mark).
let shown = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/**
 * Called by the not-found status page while it is on screen: a layout effect (mold_v0-308), so the frame's redraw is
 * committed before the browser paints; never on the server (NotFoundFrameStyle covers a page painted before hydration).
 */
export function useMarkNotFound(on: boolean) {
  useLayoutEffect(() => {
    if (!on) return;
    shown++; notify();
    return () => { shown--; notify(); };
  }, [on]);
}

/** True while the page drawn is the not-found page. */
export function usePageNotFound(): boolean {
  const inFrame = useContext(Ctx);
  const marked = useSyncExternalStore(subscribe, () => shown > 0, () => false);
  return inFrame || marked;
}

/**
 * mold_v0-308: the frame of a page that is a 404, unlit by its own style: the top bar's trail hidden, and a sidebar entry
 * marked active drawn as any other (hover as usual). The status page draws it while it is shown, in place, so it goes with
 * it, and it is unlayered CSS, so it wins over the utilities' layer. It matters only before the frame's own redraw
 * (useMarkNotFound): a frame drawn by the server or before hydration. The selectors are the components' own slots
 * (components/ui/breadcrumb.tsx, components/ui/sidebar.tsx); scripts/status-pages-test.ts checks they still exist.
 */
export const NOT_FOUND_FRAME_CSS =
  'header [data-slot="breadcrumb"]{visibility:hidden}' +
  '[data-slot="sidebar-menu-button"][data-active]:not(:hover),[data-slot="sidebar-menu-sub-button"][data-active]:not(:hover){background-color:transparent;color:inherit;font-weight:inherit}';
export function NotFoundFrameStyle() {
  return <style data-page-not-found=''>{NOT_FOUND_FRAME_CSS}</style>;
}
