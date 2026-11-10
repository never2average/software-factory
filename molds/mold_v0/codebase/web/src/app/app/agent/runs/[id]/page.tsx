import { notFound } from 'next/navigation';
import { featureOn } from '@/config/features';
import { ActiveRunPage } from '@/features/agent/dock/active-runs-page';

// One run (mold_v0-292): the same view as its panel, at full width.
export const metadata = { title: 'Run' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  if (!featureOn('nested_runs') || !featureOn('agent_harness')) notFound();
  const { id } = await params;
  return <ActiveRunPage id={id} />;
}
