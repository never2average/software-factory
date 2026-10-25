import { redirect } from 'next/navigation';
import { sessionEngine } from '@/features/admin/engine';
import { UsagePage } from '@/features/portal/usage';

export const metadata = { title: 'Usage' };

// The session engine's usage page (its simulations, hit rates): a build without the engine (a host pack's tables) has
// none of that, so its usage is the neutral Activity page (mold_v0-110), where a declared usage tab already leads.
export default function Page() {
  if (!sessionEngine()) redirect('/app/activity');
  return <UsagePage />;
}
