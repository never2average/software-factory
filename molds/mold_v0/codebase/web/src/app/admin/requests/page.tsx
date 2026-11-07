import { AccessRequestsPage } from '@/features/admin/access-pages';

export const metadata = { title: 'Access requests' };
// mold_v0-266: in-page tabs, ?section= like Accounts': Requests (the list), Request form (the early-access form's editor),
// Sign-in page (the sign-in and sign-up pages' words).
export default async function Page({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  const { section } = await searchParams;
  return <AccessRequestsPage section={section ?? null} />;
}
