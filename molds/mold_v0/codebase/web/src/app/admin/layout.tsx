import type { Metadata } from 'next';
import { profile } from '@/config/profile.generated';
import { AdminFrame } from '@/components/layout/admin-frame';

export const metadata: Metadata = { title: { default: 'Admin', template: `%s | ${profile.console_title} Admin` } };

/** Platform staff only: every page in the admin console's frame (components/layout/admin-frame.tsx). */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminFrame>{children}</AdminFrame>;
}
