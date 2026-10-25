'use client';

import { useEffect } from 'react';
import { profile } from '@/config/profile.generated';
import { STATUS_ACTIONS, statusText } from '@/features/status/words';

// The standard status words (mold_v0-131), here without the stylesheet.
const T = statusText('error');

// global-error replaces the root layout when it errors, so globals.css is not
// loaded here — styles must be inline and self-contained.
export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error); // traces and errors go to New Relic from the API server
  }, [error]);

  return (
    <html lang='en'>
      <head><title>{T.title}</title></head>
      <body
        style={{
          margin: 0,
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif'
        }}
      >
        <main style={{ textAlign: 'center', padding: '1rem' }} data-status-page='error' data-status-code={T.code}>
          <p style={{ fontWeight: 600, marginBottom: '1rem' }}>{profile.name}</p>
          <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>{T.title}</h1>
          <p style={{ color: '#6b7280', marginBottom: '1.25rem' }}>{T.body}</p>
          <button
            onClick={() => reset()}
            style={{
              padding: '0.5rem 1.25rem',
              borderRadius: '0.5rem',
              border: '1px solid #d1d5db',
              background: 'transparent',
              font: 'inherit',
              cursor: 'pointer'
            }}
          >
            {STATUS_ACTIONS.retry}
          </button>
        </main>
      </body>
    </html>
  );
}
