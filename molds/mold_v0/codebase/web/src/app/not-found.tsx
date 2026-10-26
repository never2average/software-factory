import { headers } from 'next/headers';
import { AdminFrame } from '@/components/layout/admin-frame';
import { PortalFrame } from '@/components/layout/portal-frame';
import { StatusPage } from '@/features/status/status-page';
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
export default async function NotFound() {
  const area = (await headers()).get(NOT_FOUND_AREA_HEADER);
  if (area === 'app') return <PortalFrame><PortalNotFound /></PortalFrame>;
  if (area === 'admin') return <AdminFrame><AdminNotFound /></AdminFrame>;
  if (area === 'auth') return <AuthNotFound />;
  return <><title>Page not found</title><StatusPage kind='not_found' frame='full' /></>;
}
