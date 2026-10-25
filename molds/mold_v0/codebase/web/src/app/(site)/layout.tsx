import type { Metadata } from 'next';
import { landing } from '@/config/landing.generated';
import { profile } from '@/config/profile.generated';
import { hostLanding, hostSiteLayout, hostSiteMetadata } from '@/features/packs/host-registry';
import { SiteFooter, SiteHeader } from '@/features/site/landing';
import { accountsMode } from '@/features/site/accounts-mode';

// The public pages' layout and metadata: a host pack's (mold_v0-039), else the shell's in the profile's words. When the
// landing block has `seo` (mold_v0-138, after the first product's site layout), its title and description are every
// public page's default and its link preview (Open Graph and the X card of seo.card's size); the share image is the one
// app/opengraph-image and app/twitter-image add (mold_v0-093), which a layout's own Open Graph keeps. A page with its own
// (the landing page, the legal pages) says its own.
export async function generateMetadata(): Promise<Metadata> {
  const host = hostSiteMetadata();
  if (host) return host;
  const template = `%s · ${profile.name}`;
  const robots = { index: true, follow: true };
  const seo = landing?.seo;
  if (!seo) return { title: { default: profile.name, template }, description: profile.short_description, robots };
  const title = seo.title ?? profile.name, description = seo.description ?? profile.short_description;
  return {
    title: { default: title, template }, description, robots,
    openGraph: { title, description, siteName: profile.name, type: 'website' },
    twitter: { card: seo.card ?? 'summary_large_image', title, description }
  };
}

/** The public site (landing and the host pack's public pages): no sidebar, same theme as the panel; a header and footer in the build's brand (mold_v0-091). */
export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const Host = hostSiteLayout();
  if (Host) return <Host>{children}</Host>;
  const access = hostLanding() ? undefined : await accountsMode();
  return (
    <div className='flex min-h-screen flex-col'>
      <a href='#main' className='bg-background ring-ring sr-only rounded-md text-sm focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:ring-2'>Skip to content</a>
      {hostLanding() ? null : <SiteHeader access={access} />}
      <main id='main' className='flex-1'>{children}</main>
      {hostLanding() ? null : <SiteFooter access={access} />}
    </div>
  );
}
