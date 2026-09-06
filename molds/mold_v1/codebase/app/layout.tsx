import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
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
    default: "Delivered",
    template: "%s · Delivered",
  },
  description:
    "Delivered — the FDE operations console: an eve-powered agent that runs customer onboarding, deployments, and the data room for the forward-deployed team.",
  applicationName: "Delivered",
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
          
          The key must match THEME_KEY in _components/theme-toggle.tsx.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('fde-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}",
          }}
        />
      </head>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
