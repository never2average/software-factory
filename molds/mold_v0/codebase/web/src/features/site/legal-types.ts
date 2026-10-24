/**
 * The legal block's shape and links for the console (mold_v0-109). The rules (plain text, an address, a date, an own
 * page's https:// address) are the server's src/legal.ts, checked by scripts/gen-packs.mjs before it writes
 * src/config/legal.generated.ts; this is the type the pages read and the same links src/legal.ts legalLinks gives the
 * install pages (scripts/legal-test.ts checks the two agree).
 */
import { linkable } from './landing-types';

export interface Legal {
  company_name: string;
  contact_email: string;
  effective_date: string;
  jurisdiction?: string;
  terms_url?: string;
  privacy_url?: string;
}

export type LegalKind = 'terms' | 'privacy';
export interface LegalLink { kind: LegalKind; label: string; href: string }

/** The two legal pages: their paths on the console and the field of the company's own address that replaces each. */
export const LEGAL_PAGES = [
  { kind: 'terms', label: 'Terms', title: 'Terms of use', path: '/terms', own: 'terms_url' },
  { kind: 'privacy', label: 'Privacy', title: 'Privacy notice', path: '/privacy', own: 'privacy_url' }
] as const;

/** A page's own address, when the company set one and it is an https:// address the page may link (a second check). */
export function ownUrl(legal: Legal, kind: LegalKind): string | null {
  const page = LEGAL_PAGES.find((p) => p.kind === kind)!;
  const v = legal[page.own];
  return typeof v === 'string' && /^https:\/\//i.test(v) && linkable(v) ? v : null;
}

/** Terms and Privacy, each the company's own address when set, else the console's page. [] without `legal`. */
export function legalLinks(legal: Legal | null): LegalLink[] {
  if (!legal) return [];
  return LEGAL_PAGES.map((p) => ({ kind: p.kind, label: p.label, href: ownUrl(legal, p.kind) ?? p.path }));
}

/** The console's own legal pages (the sitemap lists them): those whose own address is not set. */
export function ownLegalPaths(legal: Legal | null): string[] {
  if (!legal) return [];
  return LEGAL_PAGES.filter((p) => !ownUrl(legal, p.kind)).map((p) => p.path);
}

/** "2026-10-23" -> "23 October 2026" (the date as written, never shifted by a time zone). */
export function legalDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}
