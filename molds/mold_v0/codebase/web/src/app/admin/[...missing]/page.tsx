import { notFound } from 'next/navigation';

// Any address under this area that is no page (mold_v0-131): the area's not-found page, a 404, instead of the API
// server's answer (next.config.ts sends what the console does not serve to the API).
export default function Page() {
  notFound();
}
