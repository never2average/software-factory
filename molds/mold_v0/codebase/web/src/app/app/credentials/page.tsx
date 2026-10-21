import { CredentialsPage } from '@/features/credentials/credentials-page';

// The workspace credential vault (mold_v0-034): the fields the packs declare. With no field the sidebar has no entry and
// the API answers 404, so the page says there is nothing to set.
export const metadata = { title: 'Credentials' };

export default function Page() {
  return <CredentialsPage />;
}
