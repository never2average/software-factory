import { AdminAnalytics } from '@/features/admin/analytics';
import { RepositoryNotice } from '@/features/admin/repositories';
import { repositoryCount } from '@/config/pack-nav.generated';

export const metadata = { title: 'Health' };
export default function Page() {
  // An upstream catalog that could not be indexed at its pin (mold_v0-128) is said first, in a build that has one.
  return <>{repositoryCount > 0 && <RepositoryNotice />}<AdminAnalytics view='health' /></>;
}
