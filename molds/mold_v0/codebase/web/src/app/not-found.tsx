import { headers } from 'next/headers';
import { AdminFrame } from '@/components/layout/admin-frame';
import { PortalFrame } from '@/components/layout/portal-frame';
import { StatusPage } from '@/features/status/status-page';
import { PATH_HEADER } from '@/features/status/server';
import { ConsolePathProvider } from '@/lib/console-path';
import { NOT_FOUND_AREA_HEADER } from '@/lib/console-routes';
import AdminNotFound from './admin/not-found';
import PortalNotFound from './app/not-found';
import AuthNotFound from './auth/not-found';

// An address that is no page of the console's (mold_v0-131): the standard status page, a 404. Also what the API server
// answers a browser with for an address that is none of its own either (src/status-pages.ts reads /console-status/not-found).
// Drawn on the server (mold_v0-155): web/src/proxy.ts rewrites an address that is no page of the build to this page
// (Next's own not-found route, /_not-found, the one route Next draws on the server with its 404), naming the area it
// was in, and the page is that area's: in its frame, as the area's not-found.tsx draws it. (A page that throws
// notFound() is drawn in the browser only, Next 16: its HTML is an empty error shell until the scripts run.) The
// frames check what the areas' layouts check: signed out, sign-in; the admin console for someone not staff, a 403.
// Drawn for the address the browser shows (mold_v0-206): on the server Next's usePathname() is this route's, /_not-found,
// in the browser the address itself, so the frame reads the proxy's x-console-path through ConsolePathProvider
// (lib/console-path.tsx), and the trail, the sidebar and Docs hydrate as they were drawn (no React #418).
export default async function NotFound() {
  const h = await headers();
  const area = h.get(NOT_FOUND_AREA_HEADER);
  const asked = h.get(PATH_HEADER)?.split(/[?#]/)[0];
  const path = asked && asked.startsWith('/') && !asked.startsWith('//') ? asked : null;
  return <ConsolePathProvider path={path}>{page(area)}</ConsolePathProvider>;
}

function page(area: string | null) {
  if (area === 'app') return <PortalFrame><PortalNotFound /></PortalFrame>;
  if (area === 'admin') return <AdminFrame><AdminNotFound /></AdminFrame>;
  if (area === 'auth') return <AuthNotFound />;
  return <><title>Page not found</title><StatusPage kind='not_found' frame='full' /></>;
}
