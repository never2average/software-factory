import type { Metadata } from 'next';
import Link from 'next/link';
import { legal as configured } from '@/config/legal.generated';
import { profile } from '@/config/profile.generated';
import { fill } from '@/lib/vocabulary';
import { cn } from '@/lib/utils';
import { LEGAL_TOKEN, PRIVACY, TERMS, type LegalDoc, type LegalParagraph } from './legal-text';
import { LEGAL_PAGES, legalDate, legalLinks, ownUrl, type Legal, type LegalKind, type LegalLink } from './legal-types';
import { ogImages, twitterCard } from './share-image-meta';

/**
 * The legal pages and links (mold_v0-109; src/legal.ts): /terms and /privacy from the shell's neutral template
 * (./legal-text.ts) in the build's words and the app's profile.json `legal`, and the Terms and Privacy links the
 * landing page's footer, the sign-in and sign-up pages show. Without `legal` there is no page and no link. A page whose
 * own address the company set (terms_url, privacy_url) is that address: the console's page redirects there.
 */

const DOCS: Record<LegalKind, LegalDoc> = { terms: TERMS, privacy: PRIVACY };

/** The build's legal block (null: no legal pages). */
export const buildLegal = (): Legal | null => configured;

/** One paragraph: the build's words filled in first, then the facts, each as text (the contact a mailto: link). */
function Facts({ text, legal }: { text: string; legal: Legal }) {
  const filled = fill(text);
  const parts: React.ReactNode[] = [];
  let last = 0;
  const link = 'text-foreground underline underline-offset-4 break-words';
  for (const m of filled.matchAll(LEGAL_TOKEN)) {
    if (m.index! > last) parts.push(filled.slice(last, m.index));
    const k = m[1] as 'company' | 'contact' | 'jurisdiction' | 'effective_date' | 'terms' | 'privacy';
    const key = `${k}-${m.index}`;
    if (k === 'company') parts.push(<span key={key} className='break-words'>{legal.company_name}</span>);
    else if (k === 'jurisdiction') parts.push(<span key={key}>{legal.jurisdiction ?? ''}</span>);
    else if (k === 'effective_date') parts.push(<time key={key} dateTime={legal.effective_date}>{legalDate(legal.effective_date)}</time>);
    else if (k === 'contact') parts.push(<a key={key} href={`mailto:${legal.contact_email}`} className={link}>{legal.contact_email}</a>);
    else {
      const page = LEGAL_PAGES.find((x) => x.kind === k)!;
      parts.push(<SmartLegalLink key={key} link={{ kind: k, label: `${page.title.charAt(0).toLowerCase()}${page.title.slice(1)}`, href: ownUrl(legal, k) ?? page.path }} className={link} />);
    }
    last = m.index! + m[0].length;
  }
  if (last < filled.length) parts.push(filled.slice(last));
  return <>{parts}</>;
}

const shown = (legal: Legal) => (x: LegalParagraph) => !x.needs || Boolean(legal[x.needs]);

/** /terms or /privacy, in the build's words. */
export function LegalPage({ kind, legal = configured }: { kind: LegalKind; legal?: Legal | null }) {
  if (!legal) return null;
  const doc = DOCS[kind];
  const ok = shown(legal);
  const sections = doc.sections
    .map((s) => ({ ...s, paragraphs: (s.paragraphs ?? []).filter(ok), items: (s.items ?? []).filter(ok) }))
    .filter((s) => s.paragraphs.length || s.items.length);
  return (
    <article aria-labelledby='legal-title' className='mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-12 sm:px-6 sm:py-16'>
      <header className='flex flex-col gap-3'>
        <h1 id='legal-title' className='text-3xl font-semibold tracking-tight text-balance break-words sm:text-4xl'>{doc.title}</h1>
        <p className='text-muted-foreground text-sm'>
          {profile.name} · <span className='break-words'>{legal.company_name}</span> · Effective <time dateTime={legal.effective_date}>{legalDate(legal.effective_date)}</time>
        </p>
        {doc.intro.filter(ok).map((x, i) => <p key={i} className='text-base leading-relaxed break-words sm:text-lg'><Facts text={x.text} legal={legal} /></p>)}
      </header>
      {sections.map((s, i) => (
        <section key={i} aria-labelledby={`legal-${i}`} className='flex flex-col gap-3'>
          <h2 id={`legal-${i}`} className='text-xl font-semibold tracking-tight break-words'>{fill(s.heading)}</h2>
          {s.items.length ? (
            <ul className='flex list-disc flex-col gap-2 pl-6 leading-relaxed'>
              {s.items.map((x, j) => <li key={j} className='break-words'><Facts text={x.text} legal={legal} /></li>)}
            </ul>
          ) : null}
          {s.paragraphs.map((x, j) => <p key={j} className='leading-relaxed break-words'><Facts text={x.text} legal={legal} /></p>)}
        </section>
      ))}
    </article>
  );
}

/** A legal page's title and description for search results; its canonical address is its own path. */
export function legalMetadata(kind: LegalKind): Metadata {
  const page = LEGAL_PAGES.find((p) => p.kind === kind)!;
  const description = `${page.title} of ${profile.name}.`;
  // The share image named here too (mold_v0-148): a page's own openGraph replaces the one app/opengraph-image adds.
  return { title: page.title, description, alternates: { canonical: page.path },
    openGraph: { type: 'website', url: page.path, siteName: profile.name, title: page.title, description, images: ogImages() },
    twitter: twitterCard(page.title, description) };
}

/** A legal link: a path of this site through next/link, the company's own https:// page with no opener. */
export function SmartLegalLink({ link, className }: { link: LegalLink; className?: string }) {
  if (link.href.startsWith('/')) return <Link href={link.href} className={className}>{link.label}</Link>;
  return <a href={link.href} className={className} rel='noopener noreferrer'>{link.label}</a>;
}

/** Terms and Privacy, for a footer or under a form; nothing without `legal`. */
export function LegalLinks({ className, legal = configured }: { className?: string; legal?: Legal | null }) {
  const links = legalLinks(legal);
  if (!links.length) return null;
  return (
    <nav aria-label='Legal' className={cn('text-muted-foreground text-xs', className)}>
      <ul className='flex flex-wrap items-center justify-center gap-x-4 gap-y-1'>
        {links.map((l) => (
          <li key={l.kind}><SmartLegalLink link={l} className='hover:text-foreground inline-flex min-h-6 items-center underline-offset-4 hover:underline' /></li>
        ))}
      </ul>
    </nav>
  );
}
