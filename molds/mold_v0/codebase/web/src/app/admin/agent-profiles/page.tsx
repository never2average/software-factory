import { notFound } from 'next/navigation';
import { featureOn } from '@/config/features';
import { AgentProfilesPage } from '@/features/agent/profiles-page';

// Admin › Agent profiles (mold_v0-261): named sets of what a workspace agent session runs with, edited, versioned and
// archived by staff. A page of the build only with agent_harness on (off: not found, as before the flag).
export const metadata = { title: 'Agent profiles' };

export default function Page() {
  if (!featureOn('agent_harness')) notFound();
  return <AgentProfilesPage />;
}
