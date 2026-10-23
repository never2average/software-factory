import { notFound } from 'next/navigation';
import { profile } from '@/config/profile.generated';
import { KeysPage } from '@/features/keys/keys-page';

// A person's own MCP keys (mold_v0-007; src/member-keys.ts): named, expiring, revocable, header-only, with their role.
// Not in a build whose profile turns member keys off (mold_v0-099): the page is not found, as the API refuses them.
export const metadata = { title: 'API keys' };

export default function Page() {
  if ((profile as Readonly<Record<string, unknown>>).member_keys === false) notFound();
  return <KeysPage />;
}
