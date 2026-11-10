import { notFound } from 'next/navigation';
import { featureOn } from '@/config/features';
import { ActiveRunsPage } from '@/features/agent/dock/active-runs-page';

// Active runs (mold_v0-292): a page of the build only with nested_runs on.
export const metadata = { title: 'Active runs' };

export default function Page() {
  if (!featureOn('nested_runs') || !featureOn('agent_harness')) notFound();
  return <ActiveRunsPage />;
}
