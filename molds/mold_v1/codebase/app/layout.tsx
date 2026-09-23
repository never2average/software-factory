import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEPLOYMENT_PROFILE, PRODUCT_NAME, fillProfileText } from "@/lib/deployment-profile.generated";
import { LEGACY_STORAGE_KEYS, STORAGE_KEYS } from "@/lib/browser-storage";
import { cn } from "@/lib/utils";
import "./globals.css";

const sans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
});

const mono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: PRODUCT_NAME,
    template: `%s · ${PRODUCT_NAME}`,
  },
  description: fillProfileText(DEPLOYMENT_PROFILE.product.description),
  applicationName: PRODUCT_NAME,
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
    apple: "/icon.svg",
  },
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html className={cn(sans.variable, mono.variable)} lang="en" suppressHydrationWarning>
      <head>
        {/*
          Set the theme BEFORE first paint.
          
          React can only apply a stored preference after hydration, which is
          long enough to see the wrong palette flash. This runs synchronously
          in <head>, before any pixels, and only touches an attribute — the
          CSS in globals.css does the rest. Kept deliberately tiny and
          dependency-free; anything that can throw here blanks the page.
          
          The keys must match THEME_KEY in _components/theme-toggle.tsx. BOTH are
          read: the key used to be `fde-theme`, and a person who chose dark before
          the rename would otherwise get a light flash on every load forever —
          this script runs before any React code that could migrate the value.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              `try{var s=localStorage,t=s.getItem(${JSON.stringify(STORAGE_KEYS.theme)})||s.getItem(${JSON.stringify(LEGACY_STORAGE_KEYS[STORAGE_KEYS.theme])});if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`,
          }}
        />
      </head>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
