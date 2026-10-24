'use client';
import * as React from 'react';

/**
 * Whether an element scrolls sideways (its content is wider than it), watched on resize of the element and of its
 * content, so one that grows into a scroll (rows loaded later, a narrower window) is seen. While it scrolls, a container
 * with no control inside must itself be reachable by the keyboard to be scrolled (WCAG 2.1.1; axe
 * `scrollable-region-focusable`, mold_v0-114): `scrollRegion(label)` gives it tabindex 0, the region role and a name.
 */
export function useScrollsSideways<T extends HTMLElement>() {
  const ref = React.useRef<T>(null);
  const [scrolls, setScrolls] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const check = () => setScrolls(el.scrollWidth > el.clientWidth + 1);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    check();
    return () => ro.disconnect();
  }, []);
  const scrollRegion = (label: string) => (scrolls ? { tabIndex: 0, role: 'region' as const, 'aria-label': label } : {});
  return { ref, scrolls, scrollRegion };
}
