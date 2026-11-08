import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { findRecordGroup } from '@/features/records/registry';
import { StaffRecordGroupPage } from '@/features/records/staff-record-group';

// A staff Records entry that holds several lists as in-page tabs (mold_v0-281, console.admin_records `tabs`): the
// console's in-page tab strip, the selected member's own list below it (?tab=<member>). Unknown entries are a 404.
export async function generateMetadata({ params }: { params: Promise<{ group: string }> }): Promise<Metadata> {
  const { group } = await params;
  return { title: findRecordGroup(group)?.title ?? 'Not found' };
}
export default async function Page({ params }: { params: Promise<{ group: string }> }) {
  const { group } = await params;
  if (!findRecordGroup(group)) notFound();
  return <StaffRecordGroupPage group={group} />;
}
