import type { Metadata } from 'next';
import Link from 'next/link';
import { BrandMark } from '@/components/brand';
import { buttonVariants } from '@/components/ui/button';
import { landing as declared, sourceOfferItems } from '@/config/landing.generated';
import { profile } from '@/config/profile.generated';
import { cn } from '@/lib/utils';
import { linkable, type LandingBlock, type LandingItem, type LandingLink } from './landing-types';

/**
 * The shell's public landing page (mold_v0-091): the build's declared landing block (a pack's pack.json `landing`, the
 * app's profile.json `landing` over it; src/landing.ts), else a neutral page in the profile's words. Everything is in the
 * build's brand: its name, tagline and mark (web/src/app/icon.svg) and the theme's tokens (primary, card, muted, border:
 * the brand step sets primary and ring in light and dark), so no colour is written here. Every text is shown as text.
 */

const SIGN_UP: LandingLink = { label: 'Get started', href: '/auth/sign-up' };
const SIGN_IN: LandingLink = { label: 'Sign in', href: '/app' };
const INSTALL: LandingLink = { label: 'Connect an MCP client', href: '/install' };

/** What the page shows with no block: the profile's words and what every build of the shell does. */
const NEUTRAL: LandingBlock = {
  value_points: {
    title: 'What you get',
    items: [
      { title: 'Your assistant, connected', body: 'Add this service to Claude, ChatGPT, Cursor, VS Code or any other MCP client. The install page gives the exact steps and a key for each one.' },
      { title: 'Agents that report back', body: 'Start runs from your assistant or the console, follow them while they work and read their results when they finish.' },
      { title: 'Your workspace is yours', body: "Each workspace's records, files, keys and runs are its own. No other workspace can read them." }
    ]
  },
  how_it_works: {
    title: 'How it works',
    steps: [
      { title: 'Create an account', body: 'Sign up and open your workspace in the console.' },
      { title: 'Connect a client', body: 'Follow the install page for your MCP client and paste in the key it gives you.' },
      { title: 'Work from your assistant', body: 'Ask your assistant to use the workspace. What it does is kept in your workspace, where you can review it.' }
    ]
  }
};

/** The block this build shows, with the hero filled in from the profile where the block leaves it out. */
export function resolvedLanding(block: LandingBlock | null = declared) {
  const b = block ?? NEUTRAL;
  const hero = b.hero ?? {};
  const headline = hero.headline ?? profile.short_description;
  return {
    ...b,
    hero: {
      eyebrow: hero.eyebrow ?? (hero.headline ? undefined : profile.name),
      headline,
      // The console's description, unless it only repeats the headline (a brand's is "<name> — <tagline>").
      subheadline: hero.subheadline ?? (profile.console_description.toLowerCase().includes(headline.toLowerCase()) ? undefined : profile.console_description),
      primary_cta: hero.primary_cta ?? SIGN_UP,
      secondary_cta: hero.secondary_cta ?? INSTALL,
      note: hero.note
    }
  };
}

/** Search results and link previews: the block's seo, else the hero's words. */
export function landingMetadata(): Metadata {
  const l = resolvedLanding();
  const title = l.seo?.title ?? (l.hero.headline === profile.name ? profile.name : `${profile.name}: ${l.hero.headline}`);
  const description = l.seo?.description ?? l.hero.subheadline ?? profile.short_description;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: '/' },
    openGraph: { type: 'website', url: '/', siteName: profile.name, title, description },
    twitter: { card: 'summary', title, description }
  };
}

function SmartLink({ link, className }: { link: LandingLink; className?: string }) {
  if (!linkable(link.href)) return <span className={className}>{link.label}</span>;
  if (link.href.startsWith('/')) return <Link href={link.href} className={className}>{link.label}</Link>;
  const external = /^https:/i.test(link.href);
  return <a href={link.href} className={className} {...(external ? { rel: 'noopener noreferrer' } : {})}>{link.label}</a>;
}

function Ctas({ primary, secondary, inverse }: { primary?: LandingLink; secondary?: LandingLink; inverse?: boolean }) {
  if (!primary && !secondary) return null;
  return (
    <div className='flex flex-wrap items-center gap-3'>
      {primary ? <SmartLink link={primary} className={cn(buttonVariants({ size: 'lg' }), 'h-auto min-h-11 px-5 py-2 text-center text-base whitespace-normal', inverse && 'bg-background text-foreground hover:bg-background/90 focus-visible:ring-primary-foreground')} /> : null}
      {secondary ? <SmartLink link={secondary} className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'h-auto min-h-11 px-5 py-2 text-center text-base whitespace-normal', inverse && 'focus-visible:ring-primary-foreground border-primary-foreground/40 bg-transparent text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground dark:border-primary-foreground/40 dark:bg-transparent')} /> : null}
    </div>
  );
}

const Wrap = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cn('mx-auto w-full max-w-6xl px-4 sm:px-6', className)}>{children}</div>
);

function SectionHead({ id, title, intro }: { id: string; title: string; intro?: string }) {
  return (
    <div className='mb-8 flex max-w-3xl flex-col gap-3'>
      <h2 id={id} className='text-2xl font-semibold tracking-tight text-balance break-words sm:text-3xl'>{title}</h2>
      {intro ? <p className='text-muted-foreground text-base sm:text-lg'>{intro}</p> : null}
    </div>
  );
}

function Cards({ items, columns }: { items: LandingItem[]; columns: string }) {
  return (
    <ul className={cn('grid gap-4', columns)}>
      {items.map((it, i) => (
        <li key={i} className='bg-card text-card-foreground flex flex-col gap-2 rounded-xl border p-5'>
          <h3 className='flex items-start gap-2 font-semibold break-words'>
            <svg aria-hidden='true' viewBox='0 0 16 16' className='text-primary mt-1 size-4 shrink-0'><path d='M3 8.5 6.5 12 13 4.5' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' /></svg>
            <span>{it.title}</span>
          </h3>
          <p className='text-muted-foreground text-sm leading-relaxed break-words'>{it.body}</p>
        </li>
      ))}
    </ul>
  );
}

/** The page's sections, in order. Each section is a labelled region, so a screen reader can jump between them. */
export function LandingSections() {
  const l = resolvedLanding();
  return (
    <>
      <section aria-labelledby='landing-hero' className='relative isolate overflow-hidden border-b'>
        <div aria-hidden='true' className='pointer-events-none absolute -top-40 left-1/2 -z-10 h-[480px] w-[900px] max-w-full -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--primary)_20%,transparent),transparent)] blur-2xl' />
        <Wrap className='flex flex-col gap-6 py-16 sm:py-24'>
          {l.hero.eyebrow ? <p className='text-foreground text-sm font-semibold tracking-wide break-words uppercase'>{l.hero.eyebrow}</p> : null}
          <h1 id='landing-hero' className='max-w-4xl text-4xl font-semibold tracking-tight text-balance break-words sm:text-5xl'>{l.hero.headline}</h1>
          {l.hero.subheadline ? <p className='text-muted-foreground max-w-3xl text-lg break-words sm:text-xl'>{l.hero.subheadline}</p> : null}
          <Ctas primary={l.hero.primary_cta} secondary={l.hero.secondary_cta} />
          {l.hero.note ? <p className='text-muted-foreground text-sm break-words'>{l.hero.note}</p> : null}
        </Wrap>
      </section>

      {l.coverage ? (
        <section aria-labelledby='landing-coverage' className='border-b'>
          <Wrap className='flex flex-col gap-4 py-10'>
            <h2 id='landing-coverage' className='text-muted-foreground text-sm font-semibold tracking-wide uppercase'>{l.coverage.title ?? 'Coverage'}</h2>
            <ul className='flex flex-wrap gap-2'>
              {l.coverage.items.map((c, i) => (
                <li key={i} className='bg-card rounded-full border px-3 py-1 text-sm font-medium break-words'>{c}</li>
              ))}
            </ul>
            {l.coverage.note ? <p className='text-muted-foreground max-w-3xl text-sm break-words'>{l.coverage.note}</p> : null}
          </Wrap>
        </section>
      ) : null}

      {l.value_points ? (
        <section aria-labelledby='landing-value' className='py-16 sm:py-20'>
          <Wrap>
            <SectionHead id='landing-value' title={l.value_points.title ?? 'Why ' + profile.name} />
            <Cards items={l.value_points.items} columns='sm:grid-cols-2 lg:grid-cols-3' />
          </Wrap>
        </section>
      ) : null}

      {l.how_it_works ? (
        <section id='how-it-works' aria-labelledby='landing-how' className='bg-muted/40 border-y py-16 sm:py-20'>
          <Wrap>
            <SectionHead id='landing-how' title={l.how_it_works.title ?? 'How it works'} />
            <ol className='grid gap-6 sm:grid-cols-2 lg:grid-cols-3'>
              {l.how_it_works.steps.map((s, i) => (
                <li key={i} className='flex gap-4'>
                  <span aria-hidden='true' className='bg-primary text-primary-foreground flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold'>{i + 1}</span>
                  <div className='flex min-w-0 flex-col gap-1'>
                    <h3 className='font-semibold break-words'><span className='sr-only'>Step {i + 1}: </span>{s.title}</h3>
                    <p className='text-muted-foreground text-sm leading-relaxed break-words'>{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Wrap>
        </section>
      ) : null}

      {l.features ? (
        <section id='features' aria-labelledby='landing-features' className='py-16 sm:py-20'>
          <Wrap>
            <SectionHead id='landing-features' title={l.features.title ?? 'Features'} intro={l.features.intro} />
            <Cards items={l.features.items} columns='sm:grid-cols-2 lg:grid-cols-3' />
          </Wrap>
        </section>
      ) : null}

      {l.faq ? (
        <section id='faq' aria-labelledby='landing-faq' className='bg-muted/40 border-y py-16 sm:py-20'>
          <Wrap className='max-w-4xl'>
            <SectionHead id='landing-faq' title={l.faq.title ?? 'Questions'} />
            <div className='flex flex-col gap-3'>
              {l.faq.items.map((q, i) => (
                <details key={i} className='group bg-card rounded-xl border'>
                  <summary className='focus-visible:ring-ring/50 flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 rounded-xl px-5 py-3 font-medium outline-none focus-visible:ring-3 [&::-webkit-details-marker]:hidden'>
                    <span className='break-words'>{q.question}</span>
                    <svg aria-hidden='true' viewBox='0 0 16 16' className='text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-180'><path d='M4 6l4 4 4-4' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' /></svg>
                  </summary>
                  <p className='text-muted-foreground px-5 pb-4 text-sm leading-relaxed break-words'>{q.answer}</p>
                </details>
              ))}
            </div>
          </Wrap>
        </section>
      ) : null}

      {l.closing ? (
        <section aria-labelledby='landing-closing' className='py-16 sm:py-20'>
          <Wrap>
            <div className='bg-primary text-primary-foreground flex flex-col gap-5 rounded-2xl px-6 py-10 sm:px-10'>
              <h2 id='landing-closing' className='text-2xl font-semibold tracking-tight text-balance break-words sm:text-3xl'>{l.closing.title}</h2>
              {l.closing.body ? <p className='max-w-3xl text-base break-words sm:text-lg'>{l.closing.body}</p> : null}
              <Ctas primary={l.closing.primary_cta ?? SIGN_UP} secondary={l.closing.secondary_cta} inverse />
            </div>
          </Wrap>
        </section>
      ) : null}
    </>
  );
}

/** The public pages' header: the build's mark and name, and the ways in. */
export function SiteHeader() {
  const l = resolvedLanding();
  return (
    <header className='border-b'>
      <Wrap className='flex min-h-16 items-center justify-between gap-3 py-3'>
        <Link href='/' className='flex min-w-0 items-center gap-2 font-semibold tracking-tight' aria-label={`${profile.name} home`}>
          <BrandMark />
          <span className='truncate'>{profile.name}</span>
        </Link>
        <nav aria-label='Site' className='flex shrink-0 items-center gap-1 sm:gap-2'>
          {l.how_it_works ? <a href='#how-it-works' className={cn(buttonVariants({ variant: 'ghost' }), 'hidden h-10 md:inline-flex')}>How it works</a> : null}
          {l.faq ? <a href='#faq' className={cn(buttonVariants({ variant: 'ghost' }), 'hidden h-10 md:inline-flex')}>FAQ</a> : null}
          <Link href={INSTALL.href} className={cn(buttonVariants({ variant: 'ghost' }), 'hidden h-10 sm:inline-flex')}>Install</Link>
          <SmartLink link={SIGN_IN} className={cn(buttonVariants({ variant: 'ghost' }), 'h-10')} />
          <SmartLink link={SIGN_UP} className={cn(buttonVariants(), 'h-10 px-4')} />
        </nav>
      </Wrap>
    </header>
  );
}

/** The public pages' footer: the name and tagline, the block's note and links, the shell's own links and the source offer. */
export function SiteFooter() {
  const l = resolvedLanding();
  const links: LandingLink[] = [INSTALL, SIGN_IN, { label: 'Create an account', href: SIGN_UP.href }, ...(l.footer?.links ?? [])];
  const linkClass = 'text-muted-foreground hover:text-foreground inline-flex min-h-6 items-center underline-offset-4 hover:underline';
  return (
    <footer className='border-t'>
      <Wrap className='flex flex-col gap-8 py-10'>
        <div className='flex flex-col justify-between gap-8 sm:flex-row'>
          <div className='flex max-w-md flex-col gap-2'>
            <p className='flex items-center gap-2 font-semibold'><BrandMark className='size-6' /><span className='break-words'>{profile.name}</span></p>
            <p className='text-muted-foreground text-sm break-words'>{profile.short_description}</p>
            {l.footer?.note ? <p className='text-muted-foreground text-sm break-words'>{l.footer.note}</p> : null}
          </div>
          <nav aria-label='Footer'>
            <ul className='flex flex-col gap-2 text-sm'>
              {links.map((k, i) => <li key={i}><SmartLink link={k} className={linkClass} /></li>)}
            </ul>
          </nav>
        </div>
        {sourceOfferItems.length ? (
          <section id='source-code' aria-labelledby='landing-source-code' className='text-muted-foreground border-t pt-6 text-xs'>
            <h2 id='landing-source-code' className='text-foreground mb-2 text-sm font-semibold'>Source code</h2>
            <ul className='flex flex-col gap-2'>
              {sourceOfferItems.map((it, i) => (
                <li key={i} className='break-words'>
                  {it.text}
                  {it.commit ? <> <code className='break-all'>{it.commit}</code></> : null}
                  {it.link ? <>: <SmartLink link={it.link} className='text-foreground inline-flex min-h-6 items-center underline underline-offset-4' /></> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </Wrap>
    </footer>
  );
}
