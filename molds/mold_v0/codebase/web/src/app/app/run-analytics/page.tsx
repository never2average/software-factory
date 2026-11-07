import { notFound } from 'next/navigation';
import { featureOn } from '@/config/features';
import { RunAnalyticsView } from '@/features/runs/run-analytics';

// A workspace's run analytics (mold_v0-260): a page of the build only while the profile turns run_analytics on
// (scripts/gen-packs.mjs leaves it out of the routes otherwise).
export const metadata = { title: 'Run analytics' };

export default function Page() {
  if (!featureOn('run_analytics')) notFound();
  return <RunAnalyticsView />;
}
