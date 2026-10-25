import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { landing } from '@/config/landing.generated';
import { RequestPageView, requestPageMetadata } from '@/features/site/request-page';

// A public page the build declares instead of writing (mold_v0-138): the landing block's request_page, at its own path,
// which next.config rewrites here (src/config/pack-routes.generated.json). Without one every path here is a 404.
export const dynamicParams = false;
export const generateStaticParams = () => [{ page: 'request' }];
type Props = { params: Promise<{ page: string }> };
const declared = async ({ params }: Props) => ((await params).page === 'request' ? landing?.request_page ?? null : null);

export async function generateMetadata(props: Props): Promise<Metadata> {
  const page = await declared(props);
  return page ? requestPageMetadata(page) : { title: 'Not found' };
}

export default async function DeclaredPage(props: Props) {
  const page = await declared(props);
  if (!page) notFound();
  return <RequestPageView page={page} />;
}
