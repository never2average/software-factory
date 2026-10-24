import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { buildLegal, LegalPage, legalMetadata } from '@/features/site/legal';
import { ownUrl } from '@/features/site/legal-types';

// The Terms of use (mold_v0-109): the shell's neutral template in the build's words and the app's profile.json `legal`;
// the company's own page when it set terms_url; no page at all without `legal`.
export function generateMetadata(): Metadata {
  return buildLegal() ? legalMetadata('terms') : {};
}

export default function TermsPage() {
  const legal = buildLegal();
  if (!legal) notFound();
  const own = ownUrl(legal, 'terms');
  if (own) redirect(own);
  return <LegalPage kind='terms' legal={legal} />;
}
