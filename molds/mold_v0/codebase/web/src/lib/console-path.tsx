'use client';
/**
 * The page's own address, the same on the server and in the browser (mold_v0-206).
 *
 * An address that is no page of the build is rewritten by the proxy (src/proxy.ts) to Next's not-found route,
 * /_not-found, and drawn there on the server in the area's frame (app/not-found.tsx). Next's usePathname() then answers
 * /_not-found on the server and the address the browser shows (/app/no-such-page) in the browser, so anything drawn
 * from it (the trail, the sidebar's active entry, Docs) differed between the two and React threw #418, a hydration
 * mismatch. app/not-found.tsx names the address the browser asked for (the proxy's x-console-path) with
 * ConsolePathProvider, and the console reads its path with useConsolePathname(), never usePathname() directly.
 */
import { usePathname } from 'next/navigation';
import { createContext, useContext } from 'react';

const Ctx = createContext<string | null>(null);

/** The address being drawn, when it is not the route Next renders (the root not-found page for a rewritten address). */
export function ConsolePathProvider({ path, children }: { path: string | null; children: React.ReactNode }) {
  return <Ctx.Provider value={path}>{children}</Ctx.Provider>;
}

/** The page's path: the address the browser shows, on the server as in the browser. */
export function useConsolePathname(): string {
  const routed = usePathname();
  return useContext(Ctx) ?? routed;
}
