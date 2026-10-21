import { KeysPage } from '@/features/keys/keys-page';

// A person's own MCP keys (mold_v0-007; src/member-keys.ts): named, expiring, revocable, header-only, with their role.
export const metadata = { title: 'API keys' };

export default function Page() {
  return <KeysPage />;
}
