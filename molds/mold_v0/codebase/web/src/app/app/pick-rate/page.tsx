import { Suspense } from 'react';
import { PickRatePage } from '@/features/portal/pick-rate';

export const metadata = { title: 'Pick rate' };

export default function Page() {
  // The filters are in the URL (nuqs reads the search params, which needs a Suspense boundary for the static render).
  return <Suspense><PickRatePage /></Suspense>;
}
