import 'server-only';
import { headers } from 'next/headers';
import { readEnv } from './env-names';

const API = (readEnv('APP_API_URL') ?? 'http://127.0.0.1:3333').replace(/\/$/, '');

/** Call the API server from a server component, as the signed-in user (their Clerk session cookie goes along). */
export async function serverApi<T>(path: string): Promise<{ status: number; body: T | null }> {
  const h = await headers();
  const r = await fetch(`${API}${path}`, { headers: { cookie: h.get('cookie') ?? '', 'x-forwarded-host': h.get('host') ?? '' }, cache: 'no-store' });
  return { status: r.status, body: (await r.json().catch(() => null)) as T | null };
}
