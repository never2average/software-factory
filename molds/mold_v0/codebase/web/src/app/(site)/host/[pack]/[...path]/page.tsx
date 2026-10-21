import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { hostPageModule, hostPageParams } from '@/features/packs/host-registry';
import type { HostPageComponent } from '@/features/packs/host-web';

// A host pack's public page (at the site's root) (mold_v0-039): next.config rewrites its own URL here (src/config/pack-routes.generated.json).
// Only the pages a host pack names exist; with zero packs every path here is a 404.
export const dynamicParams = false;
export const generateStaticParams = () => hostPageParams('site');
type Props = { params: Promise<{ pack: string; path: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { pack, path } = await params;
  return hostPageModule('site', pack, path)?.metadata ?? { title: 'Not found' };
}
export default async function Page({ params, searchParams }: Props) {
  const { pack, path } = await params;
  const m = hostPageModule('site', pack, path);
  if (!m) notFound();
  const Host = m.default as HostPageComponent;
  return <Host searchParams={searchParams} />;
}
