import { AccessRequestsPage } from '@/features/admin/access-pages';

export const metadata = { title: 'Access requests' };
// mold_v0-289: two in-page tabs, ?section= like Accounts': Requests (the list) and Early access form (the field table).
export default async function Page({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  const { section } = await searchParams;
  return <AccessRequestsPage section={section ?? null} />;
}
