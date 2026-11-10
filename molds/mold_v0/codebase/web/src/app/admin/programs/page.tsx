import { notFound } from 'next/navigation';
import { featureOn } from '@/config/features';
import { ProgramsPage } from '@/features/agent/programs-page';

// Admin › Programs (mold_v0-291): typed, versioned definitions of what an agent session may spawn, and what the guardian
// decided about the candidates they produced. A page of the build only with nested_runs on; off: not found.
export const metadata = { title: 'Programs' };

export default function Page() {
  if (!featureOn('nested_runs') || !featureOn('agent_harness')) notFound();
  return <ProgramsPage />;
}
