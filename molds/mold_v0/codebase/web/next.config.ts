import type { NextConfig } from 'next';

/**
 * The Octillion web app: the admin panel (/admin), the customer portal (/app) and sign-in (/auth). Everything else
 * (the landing page, /mcp, /api, /.well-known, the gateway, /healthz) is the Octillion API server, reached through a
 * fallback rewrite so the browser sees one origin: Clerk's session cookie goes along with /api calls.
 *   OCTILLION_API_URL  the API server's origin (default http://127.0.0.1:3333)
 */
const API = (process.env.OCTILLION_API_URL ?? 'http://127.0.0.1:3333').replace(/\/$/, '');

const config: NextConfig = {
  output: process.env.BUILD_STANDALONE === 'true' ? 'standalone' : undefined,
  images: { remotePatterns: [{ protocol: 'https', hostname: 'img.clerk.com' }] },
  compiler: { removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error'] } : false },
  // /connect was a public setup guide; the connection box now lives on the setup page. Adoption is now Journeys (under Context); Visibility is now Pick rate:
  // its links (filters in the query string, which a redirect keeps) open the new page.
  async redirects() {
    return [
      { source: '/connect', destination: '/app', permanent: true },
      { source: '/app/adoption', destination: '/app/journeys', permanent: true },
      { source: '/app/visibility', destination: '/app/pick-rate', permanent: true },
      { source: '/app/visibility/:path*', destination: '/app/pick-rate/:path*', permanent: true }
    ];
  },
  async rewrites() {
    return { beforeFiles: [], afterFiles: [], fallback: [{ source: '/:path*', destination: `${API}/:path*` }] };
  }
};

export default config;
