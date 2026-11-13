'use client';
// One more level for the top bar's breadcrumb, named by the page that knows it (mold_v0-290: an open agent session's short
// number). A page's state, not the address: the trail reads it from here, and the page clears it when it goes.
import { useEffect, useSyncExternalStore } from 'react';
import { useConsolePathname } from '@/lib/console-path';

let leaf: string | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function setBreadcrumbLeaf(next: string | null) { if (leaf === next) return; leaf = next; notify(); }
export function useBreadcrumbLeaf(): string | null {
  return useSyncExternalStore(subscribe, () => leaf, () => null);
}

/**
 * mold_v0-298: the page's own last crumb, named by the page (a record's page: the record's title, not its key from the
 * address). Kept per address, so a name never outlives its page: the trail of another address does not read it.
 */
const titles = new Map<string, string>();
export function setBreadcrumbTitle(path: string, title: string | null) {
  if ((titles.get(path) ?? null) === title) return;
  if (title) titles.set(path, title); else titles.delete(path);
  notify();
}
/** The name a page gave its own crumb at this address, if any. */
export function useBreadcrumbTitleAt(path: string): string | null {
  return useSyncExternalStore(subscribe, () => titles.get(path) ?? null, () => null);
}
/** For a page: name its own crumb (null or empty: the address's own word stays) while it is shown. */
export function useBreadcrumbTitle(title: string | null | undefined) {
  const path = useConsolePathname();
  useEffect(() => {
    if (!title) return;
    setBreadcrumbTitle(path, title);
    return () => setBreadcrumbTitle(path, null);
  }, [path, title]);
}
