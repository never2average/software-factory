'use client';
// Accounts' in-page tabs (mold_v0-204): Accounts (every account) and Admins (the platform's staff and their roles),
// held in ?section= like Health's and Compute's (UrlTabs): /admin/accounts and /admin/accounts?section=admins. No
// title above the strip; each tab is one table (RecordView).
import { UrlTabs } from './compute-common';
import { AdminAccounts } from './accounts';
import { AdminAdmins } from './admins';

export const ACCOUNTS_TABS = [['accounts', 'Accounts'], ['admins', 'Admins']] as const;

export function AccountsPage({ section }: { section: string | null }) {
  const tab = section === 'admins' ? 'admins' : 'accounts';
  const tabs = <UrlTabs tabs={ACCOUNTS_TABS} tab={tab} base='/admin/accounts' />;
  return tab === 'admins' ? <AdminAdmins tabs={tabs} /> : <AdminAccounts tabs={tabs} />;
}
