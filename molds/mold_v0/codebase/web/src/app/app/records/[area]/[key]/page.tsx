import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RecordDetailPage } from '@/features/records/record-pages';
import { findRecordArea } from '@/features/records/registry';

// A record's detail page (mold_v0-047): its fields and the records its links name. Unknown areas are a 404.
export async function generateMetadata({ params }: { params: Promise<{ area: string; key: string }> }): Promise<Metadata> {
  const { area, key } = await params;
  return { title: findRecordArea('app', area) ? decodeURIComponent(key) : 'Not found' };
}
export default async function Page({ params }: { params: Promise<{ area: string; key: string }> }) {
  const { area, key } = await params;
  const spec = findRecordArea('app', area);
  if (!spec) notFound();
  return <RecordDetailPage area={spec} recordKey={decodeURIComponent(key)} base='app' />;
}
