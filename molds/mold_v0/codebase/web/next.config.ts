import type { NextConfig } from 'next';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The web app: the admin panel (/admin), the customer portal (/app), sign-in (/auth) and the public pages. Everything
 * else (/mcp, /api, /.well-known, the gateway, /healthz, /install) is the API server, reached through a fallback
 * rewrite so the browser sees one origin: Clerk's session cookie goes along with /api calls.
 *   OCTILLION_API_URL  the API server's origin (default http://127.0.0.1:3333)
 * A host pack's pages keep their own URLs (mold_v0-039): src/config/pack-routes.generated.json (scripts/gen-packs.mjs,
 * from the pack's routes.json) rewrites each to the shell's host page routes, and carries the pack's redirects.
 */
const API = (process.env.OCTILLION_API_URL ?? 'http://127.0.0.1:3333').replace(/\/$/, '');

interface PackRoutes {
  rewrites: { source: string; destination: string }[];
  redirects: { source: string; destination: string; permanent: boolean }[];
}
/**
 * Which sign-in the console runs (mold_v0-004; src/lib/auth/provider.ts), fixed at build time: AUTH_PROVIDER (or
 * NEXT_PUBLIC_AUTH_PROVIDER) when it says builtin or clerk, else clerk when a Clerk publishable key is set (an app already
 * on Clerk keeps it), else builtin. The API server applies the same rule to its own environment (src/auth-provider.ts).
 */
const AUTH_PROVIDER = (() => {
  const v = (process.env.NEXT_PUBLIC_AUTH_PROVIDER || process.env.AUTH_PROVIDER || '').trim().toLowerCase();
  if (v === 'clerk' || v === 'builtin') return v;
  return process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? 'clerk' : 'builtin';
})();
const packRoutes = JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'config', 'pack-routes.generated.json'), 'utf8')) as PackRoutes;

const config: NextConfig = {
  output: process.env.BUILD_STANDALONE === 'true' ? 'standalone' : undefined,
  env: { NEXT_PUBLIC_AUTH_PROVIDER: AUTH_PROVIDER },
  images: { remotePatterns: [{ protocol: 'https', hostname: 'img.clerk.com' }] },
  compiler: { removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error'] } : false },
  async redirects() {
    return packRoutes.redirects;
  },
  async rewrites() {
    return { beforeFiles: [], afterFiles: packRoutes.rewrites, fallback: [{ source: '/:path*', destination: `${API}/:path*` }] };
  }
};

export default config;
