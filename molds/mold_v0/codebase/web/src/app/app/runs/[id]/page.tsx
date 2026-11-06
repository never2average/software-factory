import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { featureOn } from '@/config/features';
import { RunPage } from '@/features/runs/run-page';
import { requireFound } from '@/features/status/server';

// A run's own page (mold_v0-256, flag record_pages): its header, its live timeline and its tabs. Off, it does not exist
// (a 404, as before the flag); a run of another workspace, or none, is a 404 from its API.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: featureOn('record_pages') ? `Run ${decodeURIComponent(id)}` : 'Not found' };
}
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  if (!featureOn('record_pages')) notFound();
  const { id } = await params;
  if (!/^run_[A-Za-z0-9_-]{1,80}$/.test(decodeURIComponent(id))) notFound();
  // Not there, or another workspace's: a 404 (as a record's page, mold_v0-131).
  await requireFound(`/api/runs/${encodeURIComponent(decodeURIComponent(id))}/page`);
  return <RunPage id={decodeURIComponent(id)} />;
}
