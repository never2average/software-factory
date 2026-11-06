import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { featureOn } from '@/config/features';
import { AgentProfilePage } from '@/features/agent/profiles-page';

// One agent profile's page (mold_v0-261): its header, its tabs, Edit (a new version), Archive or Restore. Only with
// agent_harness on; an id that is not a profile's is a 404 from its API.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: featureOn('agent_harness') ? `Agent profile ${decodeURIComponent(id)}` : 'Not found' };
}
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  if (!featureOn('agent_harness')) notFound();
  const { id } = await params;
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(decodeURIComponent(id))) notFound();
  return <AgentProfilePage id={decodeURIComponent(id)} />;
}
