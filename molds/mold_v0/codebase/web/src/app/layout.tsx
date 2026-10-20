import Providers from '@/components/layout/providers';
import { Toaster } from '@/components/ui/sonner';
import { fontVariables } from '@/components/themes/font.config';
import { DEFAULT_THEME, THEMES } from '@/components/themes/theme.config';
import ThemeProvider from '@/components/themes/theme-provider';
import { cn } from '@/lib/utils';
import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import NextTopLoader from 'nextjs-toploader';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import '../styles/globals.css';

// One look everywhere: Supabase dark. No light mode, no toggle.
const THEME_COLOR = '#171717';

// Absolute URLs for icons and the share image (Vercel sets the production host; NEXT_PUBLIC_APP_URL overrides it).
const host = process.env.NEXT_PUBLIC_APP_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3400');

export const metadata: Metadata = {
  metadataBase: new URL(host),
  applicationName: 'Octillion',
  title: { default: 'Octillion', template: '%s | Octillion' },
  description: 'Octillion: measure and improve how often AI coding agents pick your developer tool.',
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
      <body
        className={cn(
          'bg-background overflow-x-hidden overscroll-none font-sans antialiased',
          fontVariables
        )}
      >
        <NextTopLoader color='var(--primary)' showSpinner={false} />
        <NuqsAdapter>
          <ThemeProvider
            attribute='class'
            defaultTheme='dark'
            forcedTheme='dark'
            enableSystem={false}
            disableTransitionOnChange
          >
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
