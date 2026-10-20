import { AdminAccountDetail } from '@/features/admin/account-detail';

export const metadata = { title: 'Account' };
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <AdminAccountDetail slug={decodeURIComponent(slug)} />;
}
