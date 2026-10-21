import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { hostPageModule, hostPageParams } from '@/features/packs/host-registry';
import type { HostPageComponent } from '@/features/packs/host-web';

// A host pack's /admin page (mold_v0-039): next.config rewrites its own URL here (src/config/pack-routes.generated.json).
// Only the pages a host pack names exist; with zero packs every path here is a 404.
export const dynamicParams = false;
export const generateStaticParams = () => hostPageParams('admin');
type Props = { params: Promise<{ pack: string; path: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { pack, path } = await params;
  return hostPageModule('admin', pack, path)?.metadata ?? { title: 'Not found' };
}
export default async function Page({ params, searchParams }: Props) {
  const { pack, path } = await params;
  const m = hostPageModule('admin', pack, path);
  if (!m) notFound();
  const Host = m.default as HostPageComponent;
  return <Host searchParams={searchParams} />;
}
