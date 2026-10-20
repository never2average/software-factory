import { Outfit } from 'next/font/google';

import { cn } from '@/lib/utils';

// The Supabase theme's font is the only one the app uses (code is the system monospace stack). The starter shipped 16
// Google fonts for its theme picker; each is fetched at build time, and any one failing to download fails the deploy.
const fontOutfit = Outfit({
  subsets: ['latin'],
  variable: '--font-outfit'
});

export const fontVariables = cn(fontOutfit.variable);
