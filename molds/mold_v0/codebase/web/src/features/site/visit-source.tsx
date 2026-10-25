'use client';
/**
 * Where a visit began (mold_v0-110, after the first product's visit source): the first page of the visit and its utm_*
 * tags, kept in sessionStorage (this tab, this visit; nothing is sent until a request for access is), so a request made
 * after clicking through (/request-access, or /app once signed up with no account) still says where the visitor came from.
 *   VisitSource   in the root layout: notes the first page and any utm_* tag not noted yet
 *   visitSource() what was noted: { first_page?, referrer?, utm_* } ({} when storage is blocked)
 */
import { useEffect } from 'react';

const KEY = 'visit:';
export const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
const clip = (v: string) => v.slice(0, 200);

export function VisitSource() {
  useEffect(() => {
    try {
      const s = window.sessionStorage;
      if (!s.getItem(`${KEY}first_page`)) {
        s.setItem(`${KEY}first_page`, clip(window.location.pathname));
        // The page the visitor came from, when it is another site (a click inside this one says nothing new).
        if (document.referrer && new URL(document.referrer).origin !== window.location.origin) s.setItem(`${KEY}referrer`, clip(document.referrer));
      }
      const q = new URLSearchParams(window.location.search);
      for (const k of UTM) { const v = q.get(k); if (v && !s.getItem(KEY + k)) s.setItem(KEY + k, clip(v)); }
    } catch { /* storage blocked: the request then says only what its own page knows */ }
  }, []);
  return null;
}

/** The visit's first page, outside referrer and utm tags, as noted by VisitSource. */
export function visitSource(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const s = window.sessionStorage;
    for (const k of ['first_page', 'referrer', ...UTM]) { const v = s.getItem(KEY + k); if (v) out[k] = v; }
  } catch { /* storage blocked */ }
  return out;
}
