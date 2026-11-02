import { notFound } from 'next/navigation';
import { auditOn } from '@/features/audit/config';
import { OperatorAccessLogPage } from '@/features/audit/access-log';

export const metadata = { title: 'Access log' };

// The platform trail fleet-wide and a workspace's data trail, for platform staff (mold_v0-197); only where the profile
// turns a trail on.
export default function Page() {
  if (!auditOn()) notFound();
  return <OperatorAccessLogPage />;
}
