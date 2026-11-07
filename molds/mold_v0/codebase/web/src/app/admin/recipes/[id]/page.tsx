import { notFound } from 'next/navigation';
import { featureOn } from '@/config/features';
import { RecipePage } from '@/features/agent/recipes-page';

// One workspace recipe (mold_v0-271): its files, versions and the agents' proposals.
export const metadata = { title: 'Recipe' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  if (!featureOn('workspace_recipes') || !featureOn('agent_harness')) notFound();
  const { id } = await params;
  return <RecipePage id={decodeURIComponent(id)} />;
}
