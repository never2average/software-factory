import { notFound } from 'next/navigation';

// Always a 404 with the console's not-found page (mold_v0-131): the page the API server sends a browser for an address
// that is neither the console's nor its own (src/status-pages.ts), so every unknown address looks the same.
// web/src/proxy.ts answers this address with the not-found page drawn on the server (mold_v0-155: app/not-found.tsx
// through Next's own not-found route; a page that throws notFound() is drawn in the browser only), so the page's HTML
// carries the status page itself.
export const dynamic = 'force-dynamic';

export default function Page() {
  notFound();
}
