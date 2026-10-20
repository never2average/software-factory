import type { Metadata } from 'next';
import { SiteFooter } from '@/features/site/site-footer';
import { SiteHeader } from '@/features/site/site-header';
import { VisitSource } from '@/features/site/visit-source';

const DESCRIPTION =
  'APO (Agentic Preference Optimization) is how dev-tool companies get chosen by AI coding agents. Octillion runs real coding tasks through sandboxed agents, measures whether they adopt, recommend or skip your product, and shows the transcript evidence so you know what to fix.';

export const metadata: Metadata = {
  title: { default: 'Octillion · Agentic Preference Optimization', template: '%s · Octillion' },
  description: DESCRIPTION,
  robots: { index: true, follow: true },
  openGraph: { title: 'Octillion · Agentic Preference Optimization', description: DESCRIPTION, siteName: 'Octillion', type: 'website' },
  twitter: { card: 'summary', title: 'Octillion · Agentic Preference Optimization', description: DESCRIPTION }
};

/** The public site (landing, connect): no sidebar, same theme as the panel. */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className='flex min-h-screen flex-col'>
      <a href='#main' className='bg-background ring-ring sr-only rounded-md px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:ring-2'>Skip to content</a>
      <VisitSource />
      <SiteHeader />
      <main id='main' className='flex-1'>{children}</main>
      <SiteFooter />
    </div>
  );
}
