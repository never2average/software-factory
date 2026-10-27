import { notFound } from 'next/navigation';
import { journeysOn } from '@/features/journeys/config';
import { jw } from '@/features/journeys/words';
import { AdoptionPage } from '@/features/journeys/adoption';

export const metadata = { title: jw('{Guides}') };

// The journeys component's page (mold_v0-143; src/journeys.ts): each use case person by person, with help requests.
// Only where pack.json `journeys` turns the component on; else not found (web/src/lib/console-routes.ts SHOWN).
export default function Page() {
  if (!journeysOn()) notFound();
  return <AdoptionPage />;
}
