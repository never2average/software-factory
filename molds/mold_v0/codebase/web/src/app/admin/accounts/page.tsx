import { redirect } from 'next/navigation';
import { AccountsPage } from '@/features/admin/accounts-tabs';

export const metadata = { title: 'Accounts' };

// Old links used /admin/accounts/?slug=x; the account now has its own page. ?section=admins is the Admins tab
// (mold_v0-204: the platform's staff, an in-page tab of Accounts; the old /admin/admins page is gone).
export default async function Page({ searchParams }: { searchParams: Promise<{ slug?: string; section?: string }> }) {
  const { slug, section } = await searchParams;
  if (slug) redirect(`/admin/accounts/${encodeURIComponent(slug)}`);
  return <AccountsPage section={section ?? null} />;
}
