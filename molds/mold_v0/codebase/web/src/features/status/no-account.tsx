'use client';
/**
 * The hand-off for a signed-in person in no account here (the API's 403 no_account, src/app.ts customerSession), met
 * by a page's data load (./from-error.tsx). One function, so the portal's own page for people with no account
 * (mold_v0-098, features/portal/no-account.tsx) replaces it in one place when it lands: until then, the standard status
 * page says "You're not in a {product} {account} yet", offers signing out, and the admin console to platform staff.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { StatusPage } from './status-page';

export interface NoAccountHandoff { frame?: 'full' | 'inline'; level?: 1 | 2 }

/** What a page shows when the person is in no account here. */
export function noAccountHandoff({ frame = 'inline', level = 2 }: NoAccountHandoff = {}): ReactNode {
  return <NoAccountStatus frame={frame} level={level} />;
}

function NoAccountStatus({ frame, level }: Required<NoAccountHandoff>) {
  // Platform staff get the admin console as the way on (GET /admin/session says who is staff; nothing else is read).
  const [staff, setStaff] = useState(false);
  useEffect(() => {
    let live = true;
    fetch('/admin/session', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { is_platform_admin?: boolean } | null) => { if (live) setStaff(!!b?.is_platform_admin); }, () => {});
    return () => { live = false; };
  }, []);
  return <StatusPage kind='no_account' area='app' frame={frame} level={level} staff={staff} />;
}
