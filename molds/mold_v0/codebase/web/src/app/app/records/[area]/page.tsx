import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RecordListPage } from '@/features/records/record-pages';
import { findRecordArea } from '@/features/records/registry';

// A record area's list page (mold_v0-047): any area a pack declares, with no pack code. Unknown areas are a 404.
export async function generateMetadata({ params }: { params: Promise<{ area: string }> }): Promise<Metadata> {
  const { area } = await params;
  return { title: findRecordArea('app', area)?.label ?? 'Not found' };
}
export default async function Page({ params }: { params: Promise<{ area: string }> }) {
  const { area } = await params;
  const spec = findRecordArea('app', area);
  if (!spec) notFound();
  return <RecordListPage area={spec} base='app' />;
}
