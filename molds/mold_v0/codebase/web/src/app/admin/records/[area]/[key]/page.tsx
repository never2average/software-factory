import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { StaffRecordDetailPage } from '@/features/records/staff-records';
import { findRecordArea, recordsApi } from '@/features/records/registry';
import { requireFound } from '@/features/status/server';

// A shared record's staff page (mold_v0-047; mold_v0-212: one details card, Edit where staff may write). Unknown areas
// and records are a 404.
export async function generateMetadata({ params }: { params: Promise<{ area: string; key: string }> }): Promise<Metadata> {
  const { area, key } = await params;
  return { title: findRecordArea('admin', area) ? decodeURIComponent(key) : 'Not found' };
}
export default async function Page({ params }: { params: Promise<{ area: string; key: string }> }) {
  const { area, key } = await params;
  const spec = findRecordArea('admin', area);
  if (!spec) notFound();
  // A record that is not there, or not this person's, is a 404 (mold_v0-131); one the role may not read, a 403.
  await requireFound(`${recordsApi('admin')}/${spec.name}/${encodeURIComponent(decodeURIComponent(key))}`);
  return <StaffRecordDetailPage area={spec} recordKey={decodeURIComponent(key)} />;
}
