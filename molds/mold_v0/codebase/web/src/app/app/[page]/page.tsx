import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PackPage } from '@/features/packs/pack-page';
import { appPageParams, findAppPage } from '@/features/packs/registry';
import { TabPage } from '@/features/tabs/tab-page';
import { findTab, tabPageParams } from '@/features/tabs/registry';

// A page a pack declares in pack.json (mold_v0-038), or one of its tabs (mold_v0-058: overview, area, runs, reports), at
// /app/<id> (mold_v0-132: flat; the nested /app/packs/<pack>/<id> it had redirects here, pack-routes.generated.json).
// The shell's own pages (/app/billing, /app/records/...) are folders beside this one and win; gen-packs refuses a pack
// id that would take one. Only declared pages and tabs exist; with no packs every path here is a 404.
export const dynamicParams = false;
export function generateStaticParams() {
  // Next needs at least one entry for a route with dynamicParams off: a placeholder that is never a declared page (a 404).
  const params = [...appPageParams(), ...tabPageParams()];
  return params.length ? params : [{ page: '_' }];
}
export async function generateMetadata({ params }: { params: Promise<{ page: string }> }): Promise<Metadata> {
  const { page } = await params;
  return { title: findAppPage(page)?.title ?? findTab(page)?.label ?? 'Not found' };
}
export default async function Page({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  const spec = findAppPage(page);
  if (spec) return <PackPage spec={spec} />;
  const tab = findTab(page);
  if (!tab) notFound();
  return <TabPage tab={tab} />;
}
