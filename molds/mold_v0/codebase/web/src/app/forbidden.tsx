import { StatusPage } from '@/features/status/status-page';
import { currentPath } from '@/features/status/server';
import { serverApi } from '@/lib/server-api';

// A page the person may not open (forbidden(), mold_v0-131), a 403: the admin console's layout for people who are not
// platform staff (who they are signed in as, and the way to their own account), else the role the page needs.
export default async function Forbidden() {
  const path = await currentPath();
  if (path === '/admin' || path?.startsWith('/admin/')) {
    const s = await serverApi<{ email: string | null }>('/admin/session').catch(() => null);
    return <><title>Platform staff only</title><StatusPage kind='staff_only' area='admin' frame='full' email={s?.body?.email ?? null} /></>;
  }
  return <><title>No access</title><StatusPage kind='denied' frame='full' /></>;
}
