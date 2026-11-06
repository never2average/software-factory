import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { featureOn } from '@/config/features';
import { TeamPage } from '@/features/teams/team-page';
import { requireFound } from '@/features/status/server';

// A team's page (mold_v0-259, flag teams): its header, its people, the records shared with it and its history. Off, it
// does not exist (a 404, as before the flag); another workspace's team, or none, is a 404 from its API.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  await params;
  return { title: featureOn('teams') ? 'Team' : 'Not found' };
}
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  if (!featureOn('teams')) notFound();
  const { id } = await params;
  if (!/^\d{1,15}$/.test(decodeURIComponent(id))) notFound();
  await requireFound(`/api/teams/${encodeURIComponent(decodeURIComponent(id))}`);
  return <TeamPage id={decodeURIComponent(id)} />;
}
