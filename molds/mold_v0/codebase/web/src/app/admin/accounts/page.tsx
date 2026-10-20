import { redirect } from 'next/navigation';
import { AdminAccounts } from '@/features/admin/accounts';

export const metadata = { title: 'Accounts' };

// Old links used /admin/accounts/?slug=x; the account now has its own page.
export default async function Page({ searchParams }: { searchParams: Promise<{ slug?: string }> }) {
  const { slug } = await searchParams;
  if (slug) redirect(`/admin/accounts/${encodeURIComponent(slug)}`);
  return <AdminAccounts />;
}
