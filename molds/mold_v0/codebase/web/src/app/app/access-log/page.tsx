import { notFound } from 'next/navigation';
import { auditOn } from '@/features/audit/config';
import { WorkspaceAccessLogPage } from '@/features/audit/access-log';

export const metadata = { title: 'Access log' };

// The workspace's audit trails (mold_v0-197; src/audit-trail.ts): its owners only, and only where the profile turns a
// trail on; else not found (web/src/lib/console-routes.ts SHOWN).
export default function Page() {
  if (!auditOn()) notFound();
  return <WorkspaceAccessLogPage />;
}
