import { redirect } from 'next/navigation';
import { settingsTabs } from '@/config/pack-nav.generated';
import { settingsTabUrl } from '@/config/settings';

// The team (mold_v0-298): Settings' tab when a pack puts the Team page inside Settings (the build's redirect usually
// gets there first), else Billing's People tab, its first (no ?tab=).
export default function Page() {
  const inSettings = settingsTabs.find((t) => (t.kind as string) === 'team');
  redirect(inSettings ? settingsTabUrl(inSettings.id) ?? '/app/settings' : '/app/billing');
}
