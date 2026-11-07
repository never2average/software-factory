import Link from 'next/link';
import { buildLegal } from '@/features/site/legal';
import { legalLinks } from '@/features/site/legal-types';
import { cn } from '@/lib/utils';
import { legalHref, legalLineParts, type SignInConfig } from '@/lib/access-request.generated';

/**
 * The sign-in pages' legal line (mold_v0-266): staff's words, {terms} and {privacy} as links to the addresses they gave,
 * else the build's own Terms and Privacy (mold_v0-109); with neither, the words alone.
 */
export function LegalLine({ legal, className }: { legal: NonNullable<SignInConfig['legal']>; className?: string }) {
  const own = legalLinks(buildLegal());
  const LABEL = { terms: 'Terms', privacy: 'Privacy' } as const;
  const href = (k: 'terms' | 'privacy') => {
    const given = k === 'terms' ? legal.terms_url : legal.privacy_url;
    return given && legalHref(given) ? given : own.find((l) => l.kind === k)?.href ?? null;
  };
  const link = 'text-foreground underline underline-offset-4';
  return (
    <p className={cn('text-muted-foreground text-center text-xs text-balance', className)} data-testid='auth-legal-line'>
      {legalLineParts(legal.text).map((p, i) => {
        if ('text' in p) return <span key={i}>{p.text}</span>;
        const to = href(p.link), label = own.find((l) => l.kind === p.link)?.label ?? LABEL[p.link];
        if (!to) return <span key={i}>{label}</span>;
        return to.startsWith('/') ? <Link key={i} href={to} className={link}>{label}</Link>
          : <a key={i} href={to} className={link} target='_blank' rel='noopener noreferrer'>{label}</a>;
      })}
    </p>
  );
}
