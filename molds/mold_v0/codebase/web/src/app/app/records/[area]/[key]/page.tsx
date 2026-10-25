import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RecordDetailPage } from '@/features/records/record-pages';
import { findRecordArea, recordsApi } from '@/features/records/registry';
import { requireFound } from '@/features/status/server';

// A record's detail page (mold_v0-047): its fields and the records its links name. Unknown areas and records are a 404.
export async function generateMetadata({ params }: { params: Promise<{ area: string; key: string }> }): Promise<Metadata> {
  const { area, key } = await params;
  return { title: findRecordArea('app', area) ? decodeURIComponent(key) : 'Not found' };
}
export default async function Page({ params }: { params: Promise<{ area: string; key: string }> }) {
  const { area, key } = await params;
  const spec = findRecordArea('app', area);
  if (!spec) notFound();
  // A record that is not there, or not this person's, is a 404 (mold_v0-131); one the role may not read, a 403.
  await requireFound(`${recordsApi('app')}/${spec.name}/${encodeURIComponent(decodeURIComponent(key))}`);
  return <RecordDetailPage area={spec} recordKey={decodeURIComponent(key)} base='app' />;
}
