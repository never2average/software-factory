/**
 * The console's own address (mold_v0-109): where its pages are opened, for absolute URLs (icons, the share image,
 * robots.txt's sitemap line and the sitemap's entries). Read when asked, so a running console takes its environment's:
 *   APP_CONSOLE_URL                 the console's address the factory names (a custom domain once one is switched to)
 *   NEXT_PUBLIC_APP_URL             the public address a server of its own builds with (PUBLIC_URL)
 *   VERCEL_PROJECT_PRODUCTION_URL   Vercel's production address for the project (its custom domain when it has one)
 *   http://localhost:3400           local development
 * Only an http(s) origin is taken (a path, query or anything else is dropped); a value that is not one is skipped.
 */
const origin = (v: string | undefined, scheme = ''): string | null => {
  const s = (v ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(scheme && !/^https?:\/\//i.test(s) ? `${scheme}${s}` : s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname && !u.username && !u.password ? u.origin : null;
  } catch {
    return null;
  }
};

export function siteUrl(env: Record<string, string | undefined> = process.env): string {
  return origin(env.APP_CONSOLE_URL) ?? origin(env.NEXT_PUBLIC_APP_URL) ?? origin(env.VERCEL_PROJECT_PRODUCTION_URL, 'https://') ?? 'http://localhost:3400';
}
