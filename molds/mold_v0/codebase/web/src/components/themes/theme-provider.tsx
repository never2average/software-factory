'use client';

import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  type ColorMode,
  type ResolvedColorMode,
  DEFAULT_COLOR_MODE,
  OUTSIDE_CONSOLE_MODE,
  applyColorMode,
  COLOR_MODE_KEY,
  isConsolePath,
  prefersDarkQuery,
  readColorMode,
  resolveColorMode,
  storeColorMode
} from './color-mode';

type ColorModeContext = {
  /** The choice (Light, Dark or System); null until the browser's stored choice has been read. */
  mode: ColorMode | null;
  /** What the page shows. */
  resolved: ResolvedColorMode;
  /** Whether this page follows the choice (the console) or keeps the one look (every other page). */
  inConsole: boolean;
  setMode: (mode: ColorMode) => void;
};

const Ctx = createContext<ColorModeContext | null>(null);

/**
 * The console's colour mode (mold_v0-177; color-mode.ts says how it fits together). The inline script in <head> has
 * already put the right mode on <html> before the first paint; this keeps it there as the person switches, as the
 * system's preference changes (System follows it live), as another tab switches, and as they navigate in and out of the
 * console without a page load. It writes nothing to <html> until it has read the stored choice, so hydration never
 * flips the page to the default and back.
 */
export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const inConsole = isConsolePath(pathname);
  const [state, setState] = useState<{ mode: ColorMode; prefersDark: boolean } | null>(null);

  useEffect(() => {
    const mq = prefersDarkQuery();
    setState({ mode: readColorMode(), prefersDark: mq?.matches ?? false });
    const onSystem = (e: MediaQueryListEvent) => setState((s) => (s ? { ...s, prefersDark: e.matches } : s));
    const onStorage = (e: StorageEvent) => {
      if (e.key === COLOR_MODE_KEY || e.key === null) setState((s) => (s ? { ...s, mode: readColorMode() } : s));
    };
    mq?.addEventListener('change', onSystem);
    window.addEventListener('storage', onStorage);
    return () => {
      mq?.removeEventListener('change', onSystem);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const resolved: ResolvedColorMode = !inConsole
    ? OUTSIDE_CONSOLE_MODE
    : state
      ? resolveColorMode(state.mode, state.prefersDark)
      : resolveColorMode(DEFAULT_COLOR_MODE, true); // the same on the server and in hydration; <html> is left as the head script set it

  useEffect(() => {
    if (!state) return;
    applyColorMode(inConsole ? state.mode : null, resolved);
  }, [state, inConsole, resolved]);

  const setMode = useCallback((mode: ColorMode) => {
    storeColorMode(mode);
    setState((s) => ({ mode, prefersDark: s?.prefersDark ?? prefersDarkQuery()?.matches ?? false }));
  }, []);

  const value = useMemo(() => ({ mode: state?.mode ?? null, resolved, inConsole, setMode }), [state, resolved, inConsole, setMode]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useColorMode(): ColorModeContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useColorMode must be used within the ThemeProvider');
  return c;
}
