import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

// The admin panel and the portal need a signed-in Clerk user; who may see /admin is checked by the API server
// (platform admins), and the portal's account by the user's Clerk organization.
// /admin/session is the API server's (it says who is signed in), not a page: leave it alone. So is /admin/mcp, the admin
// MCP server (src/admin-mcp.ts), which checks its own OAuth access tokens.
const isProtected = createRouteMatcher(['/admin', '/admin/((?!session$|mcp$).*)', '/app', '/app/(.*)']);

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) await auth.protect();
});

export const config = {
  // Only the web app's own pages; /mcp, /api and the rest go straight to the API server (next.config.ts).
  matcher: ['/admin', '/admin/((?!session$|mcp$).*)', '/app', '/app/(.*)', '/auth(.*)', '/__clerk/(.*)']
};
