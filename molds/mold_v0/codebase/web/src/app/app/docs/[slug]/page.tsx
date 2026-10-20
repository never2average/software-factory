import type { Metadata } from 'next';
import { CustomerDocPage, customerDocSlugs, findCustomerDoc } from '@/features/docs/customer-docs';

export const dynamicParams = false;
export function generateStaticParams() {
  return customerDocSlugs().map((slug) => ({ slug }));
}
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: findCustomerDoc(slug)?.title ?? 'Docs' };
}
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <CustomerDocPage slug={slug} />;
}
