import Providers from '@/components/layout/providers';
import { profile } from '@/config/profile.generated';
import { Toaster } from '@/components/ui/sonner';
import { fontVariables } from '@/components/themes/font.config';
import { DEFAULT_THEME, THEMES } from '@/components/themes/theme.config';
import ThemeProvider from '@/components/themes/theme-provider';
import { colorModeScript } from '@/components/themes/color-mode';
import { siteUrl } from '@/lib/site-url';
import { cn } from '@/lib/utils';
import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import NextTopLoader from 'nextjs-toploader';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import '../styles/globals.css';
import { VisitSource } from '@/features/site/visit-source';

// One look (Supabase), dark everywhere by default. The console (/app, /admin) has a Light / Dark / System switcher in its
// top bar (mold_v0-177, components/themes/color-mode.ts); every other page stays dark.
const THEME_COLOR = '#171717';

// Absolute URLs for icons and the share image: the console's own address (web/src/lib/site-url.ts, as robots.txt and the sitemap).
const host = siteUrl();

export const metadata: Metadata = {
  metadataBase: new URL(host),
  // The profile's names (profile.json, scripts/gen-packs.mjs), never a product word in the code.
  applicationName: profile.name,
  title: { default: profile.console_title, template: `%s | ${profile.console_title}` },
  description: profile.console_description,
  robots: { index: false, follow: false }
};

export const viewport: Viewport = {
  themeColor: THEME_COLOR,
  colorScheme: 'dark'
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const activeThemeValue = cookieStore.get('active_theme')?.value;
  const isValidTheme = THEMES.some((t) => t.value === activeThemeValue);
  const themeToApply = isValidTheme ? activeThemeValue! : DEFAULT_THEME;

  return (
    <html lang='en' suppressHydrationWarning data-theme={themeToApply} className='dark' style={{ colorScheme: 'dark' }}>
      <head>
        {/* Before the body is parsed: the console's stored mode on <html>, so its first paint is never the wrong one. */}
        <script dangerouslySetInnerHTML={{ __html: colorModeScript }} />
      </head>
      <body
        className={cn(
          'bg-background overflow-x-hidden overscroll-none font-sans antialiased',
          fontVariables
        )}
      >
        <NextTopLoader color='var(--primary)' showSpinner={false} />
        {/* Where a visit began, for a request for access made later in it (mold_v0-110). */}
        <VisitSource />
        <NuqsAdapter>
          <ThemeProvider>
            <Providers activeThemeValue={themeToApply}>
              <Toaster />
              {children}
            </Providers>
          </ThemeProvider>
        </NuqsAdapter>
      </body>
    </html>
  );
}
