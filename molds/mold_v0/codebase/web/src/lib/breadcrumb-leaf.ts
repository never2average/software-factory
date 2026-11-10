'use client';
// One more level for the top bar's breadcrumb, named by the page that knows it (mold_v0-290: an open agent session's short
// number). A page's state, not the address: the trail reads it from here, and the page clears it when it goes.
import { useSyncExternalStore } from 'react';

let leaf: string | null = null;
const listeners = new Set<() => void>();
export function setBreadcrumbLeaf(next: string | null) { if (leaf === next) return; leaf = next; listeners.forEach((l) => l()); }
export function useBreadcrumbLeaf(): string | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => leaf, () => null);
}
