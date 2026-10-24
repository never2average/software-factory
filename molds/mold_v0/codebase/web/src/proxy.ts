import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest } from 'next/server';
import { BUILTIN_SESSION_COOKIES, CLERK } from '@/lib/auth/provider';

// The admin panel and the portal need a signed-in Clerk user; who may see /admin is checked by the API server
// (platform admins), and the portal's account by the user's Clerk organization.
// /admin/session is the API server's (it says who is signed in), not a page: leave it alone. So is /admin/mcp, the admin
// MCP server (src/admin-mcp.ts), which checks its own OAuth access tokens.
const isProtected = createRouteMatcher(['/admin', '/admin/((?!session$|mcp$).*)', '/app', '/app/(.*)']);

/**
 * The page's own path for its server components (mold_v0-131, features/status/server.ts): a status page names the
 * address to come back to after signing in, and the right refusal for the area it is in.
 */
function withPath(req: NextRequest) {
  const h = new Headers(req.headers);
  h.set('x-console-path', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.next({ request: { headers: h } });
}

const clerk = clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) await auth.protect();
  return withPath(req);
});

/**
 * The built-in sign-in (mold_v0-004): a protected page without a session cookie goes to the sign-in page, which brings
 * the person back here. Whether the cookie is still good is the API server's to say: the pages read /api/auth/session
 * and /admin/session with it (src/lib/auth/server.ts), and every API call checks it.
 */
function builtin(req: NextRequest) {
  if (!isProtected(req) || BUILTIN_SESSION_COOKIES.some((c) => req.cookies.has(c))) return withPath(req);
  const url = new URL('/auth/sign-in', req.url);
  url.searchParams.set('redirect_url', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export default CLERK ? clerk : builtin;

export const config = {
  // Only the web app's own pages; /mcp, /api and the rest go straight to the API server (next.config.ts).
  matcher: ['/admin', '/admin/((?!session$|mcp$).*)', '/app', '/app/(.*)', '/auth(.*)', '/__clerk/(.*)']
};
