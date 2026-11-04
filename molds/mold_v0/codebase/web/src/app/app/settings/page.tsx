import { notFound } from 'next/navigation';
import { settingsLayout } from '@/config/settings';
import { SettingsPage } from '@/features/settings/settings-page';

export const metadata = { title: 'Settings' };

// Settings (mold_v0-218; from the features registry since mold_v0-219, web/src/config/settings.ts): the tabs the
// build's capabilities and packs contribute, ?tab=<id> each. With none the page is not found (console-routes SHOWN)
// and the sidebar has no entry; past 5 tabs this address leads to the tab's group page (/app/settings/<group>).
export default function Page() {
  if (settingsLayout() === 'none') notFound();
  return <SettingsPage />;
}
