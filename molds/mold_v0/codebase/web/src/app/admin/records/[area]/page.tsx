import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { StaffRecordListPage } from '@/features/records/staff-records';
import { findRecordArea } from '@/features/records/registry';

// A shared record area's staff list (mold_v0-047; mold_v0-212: the console's standard list, no title above it, its
// cards, search row and table, New record and Edit where staff may write). Unknown areas are a 404.
export async function generateMetadata({ params }: { params: Promise<{ area: string }> }): Promise<Metadata> {
  const { area } = await params;
  return { title: findRecordArea('admin', area)?.label ?? 'Not found' };
}
export default async function Page({ params }: { params: Promise<{ area: string }> }) {
  const { area } = await params;
  const spec = findRecordArea('admin', area);
  if (!spec) notFound();
  return <StaffRecordListPage area={spec} />;
}
