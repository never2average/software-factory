import { StatusPage } from '@/features/status/status-page';

// Not found under this area (mold_v0-131): an unknown address, a hidden or switched-off page, a record that is not there
// or not the person's. The standard status page, a 404.
export default function NotFound() {
  return <><title>Page not found</title><StatusPage kind='not_found' area='admin' frame='inline' level={1} /></>;
}
