import 'server-only';
import { cache } from 'react';
import { serverApi } from '@/lib/server-api';
import type { AccountsMode } from './landing-types';

/**
 * Who may open an account here (mold_v0-098): the API's /api/auth/config `accounts` (src/auth.ts accountsMode), read
 * once per request. `invite_only` (the shell's default, and the answer when the API cannot be asked): the platform's
 * staff open every account, so the public pages' "get started" leads to the request form; `self_serve`: to sign-up.
 */
export const accountsMode = cache(async (): Promise<AccountsMode> => {
  const r = await serverApi<{ accounts?: string }>('/api/auth/config').catch(() => null);
  return r?.body?.accounts === 'self_serve' ? 'self_serve' : 'invite_only';
});
