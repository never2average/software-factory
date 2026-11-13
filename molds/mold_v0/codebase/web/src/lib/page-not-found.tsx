'use client';
/**
 * mold_v0-298: the page being drawn is the not-found page. The console's frame (the top bar's trail, the sidebar's lit
 * entry) reads it, so a 404 has no trail and no lit entry: an address that is no page belongs to no entry, even when
 * it starts like one (a hidden page under the home's address lit the home's entry before).
 *
 * Two ways it is known, the same on the server and in the browser:
 *   - the root not-found page (app/not-found.tsx, drawn on the server for an address the proxy rewrote) wraps the
 *     area's frame in NotFoundProvider, so the frame knows from its first paint (no hydration mismatch);
 *   - a page that throws notFound() is drawn in the browser only, inside the area's layout: the status page marks
 *     itself while it is shown (useMarkNotFound), and the frame redraws.
 */
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';

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

/** Called by the not-found status page while it is on screen (an effect: never on the server). */
export function useMarkNotFound(on: boolean) {
  useEffect(() => {
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
