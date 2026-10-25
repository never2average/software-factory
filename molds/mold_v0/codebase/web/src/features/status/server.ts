import 'server-only';
/**
 * The status pages' server side (mold_v0-131): pages that look a record up ask the API first, so an address that names
 * nothing is a real 404 (Next's notFound(), the route's not-found.tsx), a page the person may not open a real 403
 * (forbidden(), forbidden.tsx), and a session that ended goes to sign-in and back.
 *
 * The address being drawn comes from the console's proxy (src/proxy.ts sets x-console-path on the pages it sees), since a
 * server component is not told its own URL.
 */
import { headers } from 'next/headers';
import { forbidden, notFound, redirect } from 'next/navigation';
import { serverApi } from '@/lib/server-api';
import { signInHref } from './words';

/** The request header the console's proxy puts the page's path (and query) in. */
export const PATH_HEADER = 'x-console-path';

/** The path of the page being drawn, when the proxy saw it. */
export async function currentPath(): Promise<string | null> {
  const p = (await headers()).get(PATH_HEADER);
  return p && p.startsWith('/') && !p.startsWith('//') ? p : null;
}

/** On to the sign-in page, back to this page after. */
export async function toSignIn(): Promise<never> {
  redirect(signInHref(await currentPath()));
}

/**
 * Ask the API for what a page shows (`path`, with the person's cookie) and stop the page when it is refused: 404 is not
 * found, 401 sign in, 403 for a role is forbidden. A 403 for no account or a suspended person, a server error or no
 * answer is left to the page, whose own load shows the right status page with the server's words.
 */
export async function requireFound(path: string): Promise<void> {
  const r = await serverApi<{ code?: string }>(path).catch(() => null);
  if (!r) return;
  if (r.status === 404) notFound();
  if (r.status === 401) await toSignIn();
  if (r.status === 403 && r.body?.code !== 'no_account' && r.body?.code !== 'suspended') forbidden();
}
