import type { Metadata } from 'next';
import { AdminDocPage, findAdminDoc } from '@/features/docs/admin-docs';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: findAdminDoc(decodeURIComponent(slug))?.title ?? 'Docs' };
}
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <AdminDocPage slug={decodeURIComponent(slug)} />;
}
