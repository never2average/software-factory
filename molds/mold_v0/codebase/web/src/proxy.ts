import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest } from 'next/server';
import { BUILTIN_SESSION_COOKIES, CLERK } from '@/lib/auth/provider';

// The admin panel and the portal need a signed-in Clerk user; who may see /admin is checked by the API server
// (platform admins), and the portal's account by the user's Clerk organization.
// /admin/session is the API server's (it says who is signed in), not a page: leave it alone. So is /admin/mcp, the admin
// MCP server (src/admin-mcp.ts), which checks its own OAuth access tokens.
const isProtected = createRouteMatcher(['/admin', '/admin/((?!session$|mcp$).*)', '/app', '/app/(.*)']);

/**
 * Clerk's invitation link lands on /app/?__clerk_ticket=…&__clerk_status=sign_in|sign_up. Signed out, the ticket goes to
 * Clerk's own sign-in (or sign-up) page, which accepts the invitation with it; a plain auth.protect() redirect would
 * bury it in redirect_url, where nothing reads it. Signed in, the page lands it (src/features/portal/invitation-landing.tsx).
 */
const clerk = clerkMiddleware(async (auth, req) => {
  if (!isProtected(req)) return;
  const ticket = req.nextUrl.searchParams.get('__clerk_ticket'), status = req.nextUrl.searchParams.get('__clerk_status');
  // "complete": the invitation was already accepted; signing in plainly is all that is left.
  if (ticket && status !== 'complete' && !(await auth()).userId) {
    const url = new URL(status === 'sign_up' ? '/auth/sign-up' : '/auth/sign-in', req.url);
    url.searchParams.set('__clerk_ticket', ticket);
    if (status) url.searchParams.set('__clerk_status', status);
    url.searchParams.set('redirect_url', '/app');
    return NextResponse.redirect(url);
  }
  await auth.protect();
});

/**
 * The built-in sign-in (mold_v0-004): a protected page without a session cookie goes to the sign-in page, which brings
 * the person back here. Whether the cookie is still good is the API server's to say: the pages read /api/auth/session
 * and /admin/session with it (src/lib/auth/server.ts), and every API call checks it.
 */
function builtin(req: NextRequest) {
  if (!isProtected(req) || BUILTIN_SESSION_COOKIES.some((c) => req.cookies.has(c))) return NextResponse.next();
  const url = new URL('/auth/sign-in', req.url);
  url.searchParams.set('redirect_url', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export default CLERK ? clerk : builtin;

export const config = {
  // Only the web app's own pages; /mcp, /api and the rest go straight to the API server (next.config.ts).
  matcher: ['/admin', '/admin/((?!session$|mcp$).*)', '/app', '/app/(.*)', '/auth(.*)', '/__clerk/(.*)']
};
