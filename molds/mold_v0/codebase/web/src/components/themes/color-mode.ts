/**
 * The console's colour mode (mold_v0-177): Light, Dark or System, chosen in the top bar's theme switcher and kept per
 * browser (localStorage). Only the signed-in console (/app and /admin) follows the choice; every other page (the landing
 * page, sign-in, the status pages) keeps the one look it always had, dark.
 *
 * How a page gets its mode without a flash: the root layout renders <html class="dark"> and, first thing in <head>,
 * colorModeScript, which reads the stored choice and the system's preference and sets the class, the `color-scheme` and
 * `data-color-mode` on <html> before the body is parsed. The provider (theme-provider.tsx) then keeps them in step with
 * the switcher, the system's preference (live) and client-side navigation in and out of the console.
 *
 * The default is what every app's console showed before the switcher existed: dark, whatever the system prefers.
 */
export const COLOR_MODES = ['light', 'dark', 'system'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];
export type ResolvedColorMode = 'light' | 'dark';

/** Where the choice is kept, per browser. */
export const COLOR_MODE_KEY = 'console-color-mode';
/** A console that has never been switched shows this. */
export const DEFAULT_COLOR_MODE: ColorMode = 'dark';
/** Pages outside the console. */
export const OUTSIDE_CONSOLE_MODE: ResolvedColorMode = 'dark';
/** The console's pages: /app and /admin and everything under them. */
export const CONSOLE_PATH = /^\/(app|admin)(\/|$)/;

export const isColorMode = (v: unknown): v is ColorMode => typeof v === 'string' && (COLOR_MODES as readonly string[]).includes(v);
export const isConsolePath = (path: string | null | undefined) => CONSOLE_PATH.test(path ?? '');

export function resolveColorMode(mode: ColorMode, prefersDark: boolean): ResolvedColorMode {
  return mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
}

/** The stored choice; the default when there is none, it is not a mode, or storage cannot be read (private mode, blocked). */
export function readColorMode(): ColorMode {
  try {
    const v = window.localStorage.getItem(COLOR_MODE_KEY);
    return isColorMode(v) ? v : DEFAULT_COLOR_MODE;
  } catch {
    return DEFAULT_COLOR_MODE;
  }
}

/** Keep the choice; false when the browser refuses (the mode still applies until the page is left). */
export function storeColorMode(mode: ColorMode): boolean {
  try {
    window.localStorage.setItem(COLOR_MODE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

export const prefersDarkQuery = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

/** Put a mode on <html>: the `dark` class the theme's tokens key on, the browser's own colour scheme, and the choice. */
export function applyColorMode(mode: ColorMode | null, resolved: ResolvedColorMode) {
  const el = document.documentElement;
  el.classList.toggle('dark', resolved === 'dark');
  el.style.colorScheme = resolved;
  if (mode) el.setAttribute('data-color-mode', mode);
  else el.removeAttribute('data-color-mode');
}

/**
 * The same as readColorMode + resolveColorMode + applyColorMode, as one inline script for <head>: it runs before the body
 * is parsed, so the first paint already has the right mode. Self-contained (no imports reach it) and wrapped in try, so
 * a browser that blocks storage or lacks matchMedia gets the default and never an error.
 */
export const colorModeScript = `(function(){try{var d=document.documentElement,c=${CONSOLE_PATH}.test(location.pathname),m=null,r;if(c){try{m=localStorage.getItem(${JSON.stringify(COLOR_MODE_KEY)})}catch(e){}if(${JSON.stringify(COLOR_MODES)}.indexOf(m)<0)m=${JSON.stringify(DEFAULT_COLOR_MODE)};r=m==='system'?(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):m;d.setAttribute('data-color-mode',m)}else{r=${JSON.stringify(OUTSIDE_CONSOLE_MODE)}}d.classList.toggle('dark',r==='dark');d.style.colorScheme=r}catch(e){}})();`;
