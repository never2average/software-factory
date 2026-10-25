import { notFound } from 'next/navigation';

// Always a 404 with the console's not-found page (mold_v0-131): the page the API server sends a browser for an address
// that is neither the console's nor its own (src/status-pages.ts), so every unknown address looks the same.
// Drawn on each request, so the page's HTML carries the status page itself (a static 404 is drawn in the browser only).
export const dynamic = 'force-dynamic';

export default function Page() {
  notFound();
}
