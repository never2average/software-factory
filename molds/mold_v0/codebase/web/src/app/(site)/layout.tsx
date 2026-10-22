import type { Metadata } from 'next';
import { profile } from '@/config/profile.generated';
import { hostSiteLayout, hostSiteMetadata } from '@/features/packs/host-registry';

// The public pages' layout and metadata: a host pack's (mold_v0-039), else the shell's plain one in the profile's words.
export async function generateMetadata(): Promise<Metadata> {
  return hostSiteMetadata() ?? {
    title: { default: profile.name, template: `%s · ${profile.name}` },
    description: profile.short_description,
    robots: { index: true, follow: true },
  };
}

/** The public site (landing and the host pack's public pages): no sidebar, same theme as the panel. */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  const Host = hostSiteLayout();
  if (Host) return <Host>{children}</Host>;
  return (
    <div className='flex min-h-screen flex-col'>
      <a href='#main' className='bg-background ring-ring sr-only rounded-md text-sm focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:ring-2'>Skip to content</a>
      <main id='main' className='flex-1'>{children}</main>
    </div>
  );
}
