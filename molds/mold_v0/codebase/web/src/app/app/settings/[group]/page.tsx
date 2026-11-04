import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { groupBySlug, settingsLayout } from '@/config/settings';
import { SettingsPage } from '@/features/settings/settings-page';

// One group of Settings (mold_v0-219): past 5 tabs, Access, Connections, Automation and Data & trust are pages of their
// own (/app/settings/access, /connections, /automation, /data-trust), each with its strip. Up to 5 tabs, or a group
// with no tab, not found.
export async function generateMetadata({ params }: { params: Promise<{ group: string }> }): Promise<Metadata> {
  const { group } = await params;
  return { title: groupBySlug(group) ? `Settings: ${groupBySlug(group)!.label}` : 'Not found' };
}
export default async function Page({ params }: { params: Promise<{ group: string }> }) {
  const { group } = await params;
  if (settingsLayout() !== 'groups' || !groupBySlug(group)) notFound();
  return <SettingsPage group={group} />;
}
