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

/**
 * mold_v0-318: the records a record's page crumbs through (nearest first; the server's `parents`, src/record-crumbs.ts),
 * kept per address as its title is: <group> › <parent's entry> › <its sub-tab> › <parent record> › <record>.
 */
export type CrumbParent = { area: string; key: string; title: string | null };
const parentsAt = new Map<string, readonly CrumbParent[]>();
const NONE: readonly CrumbParent[] = [];
const parentsKey = (p: readonly CrumbParent[] | null | undefined) => (p ?? []).map((x) => `${x.area}\u0000${x.key}\u0000${x.title ?? ''}`).join('\u0001');
export function setBreadcrumbParents(path: string, parents: readonly CrumbParent[] | null) {
  if (parentsKey(parentsAt.get(path)) === parentsKey(parents)) return;
  if (parents?.length) parentsAt.set(path, parents); else parentsAt.delete(path);
  notify();
}
/** The parents a page named for its crumbs at this address (none: an empty list, the same one each time). */
export function useBreadcrumbParentsAt(path: string): readonly CrumbParent[] {
  return useSyncExternalStore(subscribe, () => parentsAt.get(path) ?? NONE, () => NONE);
}
/** For a record's page: its parents while it is shown (null or empty: it crumbs as its area's). */
export function useBreadcrumbParents(parents: readonly CrumbParent[] | null | undefined) {
  const path = useConsolePathname();
  const key = parentsKey(parents);
  useEffect(() => {
    if (!parents?.length) return;
    setBreadcrumbParents(path, parents);
    return () => setBreadcrumbParents(path, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key]);
}
