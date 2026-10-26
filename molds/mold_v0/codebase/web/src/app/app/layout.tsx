import type { Metadata } from 'next';
import { profile } from '@/config/profile.generated';
import { PortalFrame } from '@/components/layout/portal-frame';

export const metadata: Metadata = { title: { default: 'Account', template: `%s | ${profile.console_title}` } };

/** The customer portal: every page in its frame (components/layout/portal-frame.tsx: the account gate, the sidebar). */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <PortalFrame>{children}</PortalFrame>;
}
