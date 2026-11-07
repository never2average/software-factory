import 'server-only';
import { cache } from 'react';
import { serverApi } from '@/lib/server-api';
import type { LiveAccessPages } from './access-form';

/**
 * The early-access form and the sign-in words staff saved (mold_v0-266; the API's GET /api/access-pages,
 * src/access-pages.ts), read once per request so a save shows on the next page load, without a redeploy. Nothing saved,
 * or the API cannot be asked: both null, and every page is the build's own.
 */
export const accessPagesLive = cache(async (): Promise<LiveAccessPages> => {
  const r = await serverApi<Partial<LiveAccessPages>>('/api/access-pages').catch(() => null);
  return { request_form: r?.status === 200 ? r.body?.request_form ?? null : null, sign_in: r?.status === 200 ? r.body?.sign_in ?? null : null };
});
