import { AdminAnalytics } from '@/features/admin/analytics';

export const metadata = { title: 'Health' };
export default function Page() {
  // A catalog that could not be indexed is said on Data repositories only, never above Health (operator, 2026-11-08).
  return <AdminAnalytics view='health' />;
}
