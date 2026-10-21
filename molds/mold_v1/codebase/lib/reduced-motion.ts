/**
 * The reader's `prefers-reduced-motion` setting, for the client components that MOVE something on their own (the
 * streamed reply's reveal, app/_components/agent-message.tsx useSmoothText). CSS reads the same setting with
 * `@media (prefers-reduced-motion: reduce)`; this is the script's reading of it, live: a reader who turns the setting on
 * mid-stream gets the full text at once from then on.
 *
 * No window (the server's render, a test without one), or a browser without matchMedia: false, the motion the page had
 * before the setting was read.
 */
import { useSyncExternalStore } from "react";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

type MediaWindow = { matchMedia?: (query: string) => MediaQueryList | undefined } | undefined;

const windowOf = (): MediaWindow => (typeof window === "undefined" ? undefined : (window as MediaWindow));

/** Whether the reader asked for reduced motion (`win` defaults to the page's window). */
export function prefersReducedMotion(win: MediaWindow = windowOf()): boolean {
  try {
    return win?.matchMedia?.(REDUCED_MOTION_QUERY)?.matches === true;
  } catch {
    return false;
  }
}

/** Call `onChange` whenever the setting changes; returns the unsubscribe. Safe with no window or no matchMedia. */
export function subscribeReducedMotion(onChange: () => void, win: MediaWindow = windowOf()): () => void {
  let list: MediaQueryList | undefined;
  try {
    list = win?.matchMedia?.(REDUCED_MOTION_QUERY);
  } catch {
    list = undefined;
  }
  if (!list) return () => {};
  if (typeof list.addEventListener === "function") {
    list.addEventListener("change", onChange);
    return () => list!.removeEventListener("change", onChange);
  }
  // Older Safari: the deprecated listener pair.
  const legacy = list as unknown as { addListener?: (cb: () => void) => void; removeListener?: (cb: () => void) => void };
  legacy.addListener?.(onChange);
  return () => legacy.removeListener?.(onChange);
}

const subscribe = (onChange: () => void) => subscribeReducedMotion(onChange);
const snapshot = () => prefersReducedMotion();
const serverSnapshot = () => false;

/** The setting, live (re-renders when the reader changes it). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
