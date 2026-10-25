'use client';
/**
 * The hand-off for a signed-in person in no account here (the API's 403 no_account, src/app.ts customerSession), met
 * by a page's data load (./from-error.tsx): the portal's own page for people with no account (mold_v0-098,
 * features/portal/no-account.tsx), as its in-page notice, which leads to /app (where the portal's layout shows the full
 * page: the accounts to open, invitations, the request form, the admin console for staff). One function, so every
 * status path reaches the same place. The wrapper carries the status page's marker for tests and the lanes.
 */
import type { ReactNode } from 'react';
import { NoAccountNotice } from '@/features/portal/no-account';

export interface NoAccountHandoff { frame?: 'full' | 'inline'; level?: 1 | 2 }

/** What a page shows when the person is in no account here. */
export function noAccountHandoff(_o: NoAccountHandoff = {}): ReactNode {
  return <div data-status-page='no_account' data-status-code='403' className='w-full'><NoAccountNotice /></div>;
}
