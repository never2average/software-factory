/**
 * The landing block's shape for the console (mold_v0-091). The rules (plain text, lengths, which addresses a link may
 * have) are the server's src/landing.ts, checked by scripts/gen-packs.mjs before it writes
 * src/config/landing.generated.ts; this is only the type the page reads.
 */
export interface LandingLink { label: string; href: string }
export interface LandingItem { title: string; body: string }

export interface LandingBlock {
  hero?: { eyebrow?: string; headline?: string; subheadline?: string; primary_cta?: LandingLink; secondary_cta?: LandingLink; note?: string };
  coverage?: { title?: string; items: string[]; note?: string };
  value_points?: { title?: string; items: LandingItem[] };
  how_it_works?: { title?: string; steps: LandingItem[] };
  features?: { title?: string; intro?: string; items: LandingItem[] };
  faq?: { title?: string; items: { question: string; answer: string }[] };
  closing?: { title: string; body?: string; primary_cta?: LandingLink; secondary_cta?: LandingLink };
  footer?: { note?: string; links?: LandingLink[] };
  seo?: { title?: string; description?: string };
}

/** One sentence of the source offer (src/source-offer.ts offerFooterItems): the commit it names and its link, if any. */
export interface OfferFooterItem { text: string; commit?: string; link?: { href: string; label: string } }

/**
 * Whether the page may make an address a link (a second check after gen-packs' src/landing.ts hrefProblem, which refuses
 * the build): a path of this site (one /, no backslash), an https:// address or a mailto: address, with no space, quote,
 * angle bracket or backslash anywhere. Anything else is shown as plain text, never as a link.
 */
export function linkable(href: string): boolean {
  if (typeof href !== 'string' || !/^[!-~]+$/.test(href) || /["'<>\\`]/.test(href)) return false;
  if (href.startsWith('/')) return !/\/\/|\/\.\.?(\/|$|[?#])|%2f|%5c/i.test(href);
  return /^https:\/\/[^/?#@]+([/?#].*)?$/i.test(href) || /^mailto:[^@/?#]+@[^@/?#]+(\?[^#]*)?$/i.test(href);
}
