'use client';
// Remembers the first page and utm_* tags of a visit (sessionStorage), so the access request knows where the visitor
// came from even after they clicked through to /early-access.
import { useEffect } from 'react';

export function VisitSource() {
  useEffect(() => {
    try {
      if (!sessionStorage.getItem('oc:landing')) sessionStorage.setItem('oc:landing', window.location.pathname);
      const p = new URLSearchParams(window.location.search);
      for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) { const v = p.get(k); if (v && !sessionStorage.getItem(`oc:${k}`)) sessionStorage.setItem(`oc:${k}`, v.slice(0, 200)); }
    } catch { /* storage blocked */ }
  }, []);
  return null;
}
