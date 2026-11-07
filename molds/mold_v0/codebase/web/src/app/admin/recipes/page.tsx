import { notFound } from 'next/navigation';
import { featureOn } from '@/config/features';
import { RecipesPage } from '@/features/agent/recipes-page';

// Admin › Recipes (mold_v0-271): reusable agent workspace recipes, versioned, with agents' proposals. A page of the build
// only with workspace_recipes on (it needs agent_harness); off: not found, as before the flag.
export const metadata = { title: 'Recipes' };

export default function Page() {
  if (!featureOn('workspace_recipes') || !featureOn('agent_harness')) notFound();
  return <RecipesPage />;
}
