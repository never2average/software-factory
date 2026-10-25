import { StatusPage } from '@/features/status/status-page';

// A page of this area the person's role may not open (forbidden(), mold_v0-131): the standard status page, a 403.
export default function Forbidden() {
  return <><title>No access</title><StatusPage kind='denied' area='admin' frame='inline' level={1} /></>;
}
