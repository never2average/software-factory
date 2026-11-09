import { AdminAnalytics } from '@/features/admin/analytics';

export const metadata = { title: 'Health' };
export default function Page() {
  return <AdminAnalytics view='health' />;
}
