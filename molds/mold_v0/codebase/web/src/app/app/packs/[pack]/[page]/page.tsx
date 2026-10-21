import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PackPage } from '@/features/packs/pack-page';
import { findPackPage, packPageParams } from '@/features/packs/registry';

// A page a pack declares in pack.json (mold_v0-038). Only declared pages exist; with no packs every path here is a 404.
export const dynamicParams = false;
export function generateStaticParams() {
  // Next needs at least one entry for a route with dynamicParams off: a placeholder that is never a declared page (a 404).
  const params = packPageParams('app');
  return params.length ? params : [{ pack: '_', page: '_' }];
}
export async function generateMetadata({ params }: { params: Promise<{ pack: string; page: string }> }): Promise<Metadata> {
  const { pack, page } = await params;
  return { title: findPackPage('app', pack, page)?.title ?? 'Not found' };
}
export default async function Page({ params }: { params: Promise<{ pack: string; page: string }> }) {
  const { pack, page } = await params;
  const spec = findPackPage('app', pack, page);
  if (!spec) notFound();
  return <PackPage spec={spec} />;
}
