import { StatusPage } from '@/features/status/status-page';

// An address that is no page of the console's (mold_v0-131): the standard status page, a 404. Also what the API server
// answers a browser with for an address that is none of its own either (src/status-pages.ts reads /console-status/not-found).
export default function NotFound() {
  return <><title>Page not found</title><StatusPage kind='not_found' frame='full' /></>;
}
