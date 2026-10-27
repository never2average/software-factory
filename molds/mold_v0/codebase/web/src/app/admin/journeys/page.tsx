import { notFound } from 'next/navigation';
import { journeysOn, tipsOn } from '@/features/journeys/config';
import { jw } from '@/features/journeys/words';
import { AdminJourneys } from '@/features/journeys/admin';

export const metadata = { title: journeysOn() ? jw('{Guides}') : 'Tips' };

// The journeys and in-chat tips components' admin page (mold_v0-143; src/journeys.ts, src/tips.ts): the templates and
// the tips, each where pack.json `journeys` or `tips` turns its component on; with both off, not found.
export default function Page() {
  if (!journeysOn() && !tipsOn()) notFound();
  return <AdminJourneys />;
}
