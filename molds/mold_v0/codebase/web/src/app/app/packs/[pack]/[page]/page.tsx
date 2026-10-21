import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PackPage } from '@/features/packs/pack-page';
import { findPackPage, packPageParams } from '@/features/packs/registry';
import { TabPage } from '@/features/tabs/tab-page';
import { findTab, tabPageParams } from '@/features/tabs/registry';

// A page a pack declares in pack.json (mold_v0-038), or one of its tabs (mold_v0-058: overview, area, runs, reports).
// Only declared pages and tabs exist; with no packs every path here is a 404.
export const dynamicParams = false;
export function generateStaticParams() {
  // Next needs at least one entry for a route with dynamicParams off: a placeholder that is never a declared page (a 404).
  const params = [...packPageParams('app'), ...tabPageParams()];
  return params.length ? params : [{ pack: '_', page: '_' }];
}
export async function generateMetadata({ params }: { params: Promise<{ pack: string; page: string }> }): Promise<Metadata> {
  const { pack, page } = await params;
  return { title: findPackPage('app', pack, page)?.title ?? findTab(pack, page)?.label ?? 'Not found' };
}
export default async function Page({ params }: { params: Promise<{ pack: string; page: string }> }) {
  const { pack, page } = await params;
  const spec = findPackPage('app', pack, page);
  if (spec) return <PackPage spec={spec} />;
  const tab = findTab(pack, page);
  if (!tab) notFound();
  return <TabPage tab={tab} />;
}
