import type { Metadata } from 'next';
import { SetupPage } from '@/features/portal/setup';
import { TabPage } from '@/features/tabs/tab-page';
import { homeTab } from '@/features/tabs/registry';

// The console's home: the Setup page, or the build's home tab (mold_v0-175: an overview tab that includes setup is drawn
// here, at /app itself; its own /app/<id> redirects here, pack-routes.generated.json).
export function generateMetadata(): Metadata {
  return { title: homeTab()?.label ?? 'Setup & training' };
}

export default function Page() {
  const tab = homeTab();
  return tab ? <TabPage tab={tab} /> : <SetupPage />;
}
