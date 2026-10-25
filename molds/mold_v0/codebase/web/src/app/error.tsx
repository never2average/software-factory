'use client';
import { useEffect } from 'react';
import { StatusPage } from '@/features/status/status-page';

// A page that failed to draw (mold_v0-131): the standard status page, with Try again.
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <><title>Something went wrong</title><StatusPage kind='error' frame='full' onRetry={reset} /></>;
}
