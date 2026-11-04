import { notFound } from 'next/navigation';
import { settingsPage } from '@/config/pack-nav.generated';
import { SettingsPage } from '@/features/settings/settings-page';

export const metadata = { title: 'Settings' };

// Settings (mold_v0-218): the workspace's Credentials and Email as in-page tabs (?tab=credentials, ?tab=email), each
// when the build has it; with neither the page is not found (web/src/lib/console-routes.ts SHOWN) and the sidebar has no
// entry. The old Credentials page and Settings › Email page are gone, with no redirect.
export default function Page() {
  if (!settingsPage.credentials && !settingsPage.email) notFound();
  return <SettingsPage />;
}
