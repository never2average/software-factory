import type { Metadata } from 'next';
import Link from 'next/link';
import { BrandMark } from '@/components/brand';
import { buttonVariants } from '@/components/ui/button';
import { landing as declared, landingClients, sourceOfferItems } from '@/config/landing.generated';
import { profile } from '@/config/profile.generated';
import { fill } from '@/lib/vocabulary';
import { cn } from '@/lib/utils';
import { AccountButton } from './account-links';
import { AgentLogo, ClientLogo, hasClientMark } from './agent-logos';
import { LandingFaq } from './landing-faq';
import { LANDING_ICONS } from './landing-icons';
import { Visual } from './landing-visuals';
import { SiteHeaderView } from './site-header';
import {
  linkable, sectionIds,
  type AccountsMode, type ConceptSection, type LogosSection, type CtaSection, type FaqSection, type HeroSection, type HowItWorksSection,
  type LandingBlock, type LandingClient, type LandingItem, type LandingLink, type LandingSection, type ProblemSection, type ProofSection,
  type SectionType, type WhereYouWorkSection
} from './landing-types';
import { buildLegal } from './legal';
import { legalLinks } from './legal-types';
import { forAccess, siteCtas, type SiteCtas } from './site-ctas';
import { ogImages, twitterCard } from './share-image-meta';

/**
 * The shell's public landing page (mold_v0-091; a section library picked and placed since mold_v0-122). The build's
 * landing block (a pack's pack.json `landing`, the app's profile.json `landing` over it; src/landing.ts) lists the
 * sections the app picked, in its order; with none the page is the whole wireframe (a hero with a strip of client logos,
 * the problem, the concept, how it works, what you get, where you work, questions and a call to action) in the shell's
 * neutral words, which name the build's own words through fill(). Every section is drawn here from data: a pack brings
 * words, never a page, a component or a picture. Everything is in the build's brand: its name, tagline and mark
 * (web/src/app/icon.svg) and the theme's tokens (primary, card, muted, border), so no colour is written here. Every
 * text is shown as text. The calls to action come from siteCtas (./site-ctas.ts), which knows who may open an account.
 */

/** Each section's entry in the header's navigation, and its eyebrow, when the block gives neither. */
const NAV_LABEL: Record<Exclude<SectionType, 'hero' | 'cta' | 'logos'>, string> = {
  problem: 'Why', concept: 'Overview', how_it_works: 'How it works', proof: 'What you get', where_you_work: 'Where you work', faq: 'FAQ'
};
/** Each section's title when the block gives none. */
const TITLE: Record<Exclude<SectionType, 'hero' | 'logos'>, () => string> = {
  problem: () => 'Why it matters',
  concept: () => fill('What {product} is'),
  how_it_works: () => 'How it works',
  proof: () => 'What you get',
  where_you_work: () => fill('Use {product} where you already work'),
  faq: () => 'Questions',
  cta: () => fill('Start with {product}')
};

/** How many client logos a section shows when the block names none. */
const CLIENTS_SHOWN = 8;
/** The clients to show: those named (in that order), else the build's offered clients with a brand mark first. */
function clientsFor(ids: readonly string[] | undefined, all: readonly LandingClient[] = landingClients): LandingClient[] {
  if (ids) return ids.flatMap((id) => all.filter((c) => c.id === id));
  return [...all].sort((a, b) => Number(hasClientMark(b.id)) - Number(hasClientMark(a.id))).slice(0, CLIENTS_SHOWN);
}
const list = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** The whole wireframe in the shell's neutral words: the page with no block (or a block with no sections). */
function neutralSections(): LandingSection[] {
  const names = clientsFor(undefined).map((c) => c.name);
  return [
    { type: 'hero', strip: { title: 'Works in' } },
    {
      type: 'problem',
      title: fill('Your assistant cannot see your {workspace}'),
      lead: 'AI assistants are where work starts now, but the records, files and results your team relies on live somewhere else. Every chat starts by copying them in and ends by copying answers back out.',
      visual: {
        type: 'transcript', title: 'assistant · new chat',
        lines: [{ text: fill('> what changed in our {workspace} this week?'), tone: 'prompt' }, { text: 'assistant ▸ I do not have access to that.' }, { text: 'assistant ▸ Paste the records here and I will take a look.' }],
        highlight: '# what if it could look for itself?'
      },
      points: [
        { icon: 'file-text', title: 'Copied by hand', body: 'Every answer starts with an export and ends with a paste, so nothing stays current.' },
        { icon: 'clock', title: 'Nothing kept', body: 'What the assistant did stays in one chat. Nobody else can review it later.' },
        { icon: 'lock', title: 'Hard to share safely', body: fill("Pasting a {workspace}'s records into a chat leaves them wherever the chat goes.") }
      ]
    },
    {
      type: 'concept',
      title: fill('{product} connects your assistant to your {workspace}'),
      lead: fill('{product} is an MCP server with a console. Your assistant calls its tools to read and change your {workspace}, starts {runs} and reads their results, all under your own sign-in.'),
      items: [
        { title: 'Copy and paste', subtitle: 'Without it', body: 'Four steps, every time.', chips: ['Export', 'Paste', 'Ask', 'Copy back'] },
        { title: 'One-off scripts', subtitle: 'Without it', body: 'Three steps, and a script to keep up.', chips: ['Write', 'Run', 'Check'] },
        { title: profile.name, subtitle: 'With an MCP connection', body: fill('Ask. Your assistant does the rest in your {workspace}.'), chips: ['Ask'], highlight: true }
      ]
    },
    {
      type: 'how_it_works',
      title: fill('From sign-up to your first {run}'),
      layout: 'loop',
      loop_label: 'Ask again',
      steps: [
        { title: fill('Open your {account}'), body: fill('Sign up and open your {workspace} in the console.') },
        { title: 'Connect a client', body: 'Follow the install page for your AI client. It signs you in or gives you a key.' },
        { title: 'Ask your assistant', body: fill('Ask it to use {product}. It reads your {workspace} and starts {runs} for you.') },
        { title: 'Review the results', body: fill('What it did is kept in your {workspace}, where your {members} can review it.') }
      ]
    },
    {
      type: 'proof',
      title: 'Everything your assistant needs, in one place',
      items: [
        { title: 'Your assistant, connected', body: fill('Add {product} to the AI clients your team already uses. The install page gives the exact steps for each one.') },
        { title: 'Agents that report back', body: fill('Start {runs} from your assistant or the console, follow them while they work and read their results when they finish.') },
        { title: fill('Your {workspace} is yours'), body: fill("Each {workspace}'s records, files, {keys} and {runs} are its own. No other {workspace} can read them.") }
      ]
    },
    {
      type: 'where_you_work',
      lead: fill('Add {product} to the AI clients your team uses. The install page gives the exact steps for each one.'),
      clients: clientsFor(undefined).map((c) => c.id),
      visual: {
        type: 'chat',
        messages: [
          { from: 'person', text: fill('What is open in our {workspace}?') },
          { from: 'tool', text: fill('{product} · reading your {workspace}') },
          { from: 'assistant', text: 'Here is what is open, each with a link to it in the console.' }
        ],
        note: 'Illustrative'
      }
    },
    {
      type: 'faq',
      items: [
        { question: fill('What is {product}?'), answer: fill("{product} is a service your AI assistant connects to over MCP. It keeps your {workspace}'s records, files and {runs}, and gives your assistant tools to use them.") },
        { question: 'Which AI clients work with it?', answer: `Any client that speaks MCP${names.length ? `, such as ${list(names)}` : ''}. The install page has the steps for each.` },
        { question: fill('Who can see my {workspace}?'), answer: fill("Only its {members}. Each {workspace}'s records, files, {keys} and {runs} are its own, and no other {workspace} can read them.") },
        { question: 'How do I start?', answer: fill('Open your {account}, connect a client from the install page, then ask your assistant to use {product}.') }
      ]
    },
    { type: 'cta', body: 'Connect your assistant in a few minutes.' }
  ];
}

/** A section with its anchor, its place among the page's bands and its links as the access mode has them. */
export interface Placed { section: LandingSection; id: string }

/** The page this build shows: the block's sections (else the neutral wireframe), each with its anchor; the header's navigation. */
export function resolvedLanding(block: LandingBlock | null = declared, access?: AccountsMode) {
  // The account button's two states as the block's header names them (mold_v0-138), wherever the page shows it.
  const shell = siteCtas(access);
  const ctas: SiteCtas = { ...shell, signIn: block?.header?.sign_in ?? shell.signIn, open: block?.header?.open ?? shell.open };
  const sections = block?.sections?.length ? block.sections : neutralSections();
  const ids = sectionIds(sections);
  const placed: Placed[] = sections.map((section, i) => ({ section, id: ids[i]! }));
  const nav = placed.flatMap(({ section: s, id }) => (s.type === 'hero' || s.type === 'cta' || s.type === 'logos' || s.nav === false ? [] : [{ label: s.nav_label ?? NAV_LABEL[s.type], href: `/#${id}` }]));
  const heroSection = sections.find((s): s is HeroSection => s.type === 'hero');
  // The first screen asks for at most two things (mold_v0-164, src/landing.ts FIRST_SCREEN_CALLS): the header's sign-in and
  // one other. The hero carries the other, so the header shows the start itself only on a page with no hero and no link.
  const startInHeader = !heroSection && !block?.header?.links?.length;
  return {
    placed, nav, ctas, hero: heroOf(heroSection ?? { type: 'hero' }, ctas, access), header: block?.header, footer: block?.footer, seo: block?.seo,
    startInHeader, openSource: block?.open_source
  };
}

/** The hero filled in from the profile where the block leaves it out. */
function heroOf(h: HeroSection, ctas: SiteCtas, access?: AccountsMode) {
  const headline = h.headline ?? profile.short_description;
  return {
    ...h,
    eyebrow: h.eyebrow ?? (h.headline ? undefined : profile.name),
    headline,
    // The console's description, unless it only repeats the headline (a brand's is "<name> — <tagline>").
    subheadline: h.subheadline ?? (profile.console_description.toLowerCase().includes(headline.toLowerCase()) ? undefined : profile.console_description),
    primary_cta: h.primary_cta === 'account' ? 'account' as const : forAccess(h.primary_cta ?? ctas.start, access),
    // No second call by default (mold_v0-164): the install pages are in the footer and the console.
    secondary_cta: forAccess(h.secondary_cta, access),
    links: h.links?.map((k) => forAccess(k, access))
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
    // The share image named here too (mold_v0-148): a page's own openGraph replaces the one app/opengraph-image adds.
    openGraph: { type: 'website', url: '/', siteName: profile.name, title, description, images: ogImages() },
    twitter: twitterCard(title, description, l.seo?.card)
  };
}

// ---------- the parts every section shares ----------

function SmartLink({ link, className }: { link: LandingLink; className?: string }) {
  if (!linkable(link.href)) return <span className={className}>{link.label}</span>;
  if (link.href.startsWith('/')) return <Link href={link.href} className={className}>{link.label}</Link>;
  const external = /^https:/i.test(link.href);
  return <a href={link.href} className={className} {...(external ? { rel: 'noopener noreferrer' } : {})}>{link.label}</a>;
}

function Ctas({ primary, secondary, inverse, className }: { primary?: LandingLink; secondary?: LandingLink; inverse?: boolean; className?: string }) {
  if (!primary && !secondary) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-3', className)}>
      {primary ? <SmartLink link={primary} className={cn(buttonVariants({ size: 'lg' }), 'h-auto min-h-11 px-5 py-2 text-center text-base whitespace-normal', inverse && 'bg-background text-foreground hover:bg-background/90 focus-visible:ring-primary-foreground')} /> : null}
      {secondary ? <SmartLink link={secondary} className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'h-auto min-h-11 px-5 py-2 text-center text-base whitespace-normal', inverse && 'focus-visible:ring-primary-foreground border-primary-foreground/40 bg-transparent text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground dark:border-primary-foreground/40 dark:bg-transparent')} /> : null}
    </div>
  );
}

const Wrap = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cn('mx-auto w-full max-w-6xl px-4 sm:px-6', className)}>{children}</div>
);

/** A section's band (the first product's section wrapper): its anchor, an eyebrow (left out when it only repeats the title), the title and a lead. */
function Band({ id, eyebrow, title, lead, center, children }: {
  id: string; eyebrow?: string; title: string; lead?: string; center?: boolean; children?: React.ReactNode;
}) {
  const hid = `${id}-title`;
  return (
    <section id={id} aria-labelledby={hid} className='scroll-mt-20 border-t py-16 sm:py-24'>
      <div className='mx-auto max-w-6xl px-4 sm:px-6'>
        <div className={cn('max-w-2xl', center && 'sm:mx-auto sm:text-center')}>
          {eyebrow && eyebrow.toLowerCase() !== title.toLowerCase() ? <p className='text-primary font-mono text-xs tracking-wider uppercase'>{eyebrow}</p> : null}
          <h2 id={hid} className='mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl'>{title}</h2>
          {lead ? <p className='text-muted-foreground mt-3 text-lg text-pretty'>{lead}</p> : null}
        </div>
        {children ? <div className='mt-10 sm:mt-14'>{children}</div> : null}
      </div>
    </section>
  );
}

const head = (s: Exclude<LandingSection, HeroSection | CtaSection | LogosSection>) => ({ eyebrow: s.eyebrow ?? NAV_LABEL[s.type], title: s.title ?? TITLE[s.type](), lead: s.lead });
const two = (n: number) => String(n).padStart(2, '0');
const Check = () => <svg aria-hidden='true' viewBox='0 0 16 16' className='text-primary mt-1 size-4 shrink-0'><path d='M3 8.5 6.5 12 13 4.5' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' /></svg>;

function Cards({ items, columns }: { items: LandingItem[]; columns: string }) {
  return (
    <ul className={cn('grid gap-4', columns)}>
      {items.map((it, i) => (
        <li key={i} className='bg-card text-card-foreground flex flex-col gap-2 rounded-xl border p-5'>
          <h3 className='flex items-start gap-2 font-semibold break-words'><Check /><span className='min-w-0'>{it.title}</span></h3>
          <p className='text-muted-foreground text-sm leading-relaxed break-words'>{it.body}</p>
        </li>
      ))}
    </ul>
  );
}

const cols = (n: number) => (n >= 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : n === 2 ? 'sm:grid-cols-2' : '');
/** Children one after another, the second and later 3rem below (a visual, then the section's own list). */
const Stack = ({ parts }: { parts: React.ReactNode[] }) => {
  const shown = parts.filter(Boolean);
  return shown.length ? <>{shown.map((p, i) => <div key={i} className={i ? 'mt-12' : undefined}>{p}</div>)}</> : null;
};

// ---------- the sections ----------

/** The grid and glow behind the top of a public page, in the theme's border and primary (the landing hero's and the request page's). */
export function Backdrop() {
  return (
    <>
      <div aria-hidden='true' className='pointer-events-none absolute inset-0 [mask-image:radial-gradient(70%_60%_at_50%_0%,black,transparent)] bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[size:56px_56px] opacity-60' />
      <div aria-hidden='true' className='pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] max-w-full -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--primary)_22%,transparent),transparent)] blur-2xl' />
    </>
  );
}

function Hero({ id, hero, ctas }: { id: string; hero: ReturnType<typeof heroOf>; ctas: SiteCtas }) {
  const strip = hero.strip;
  const logos = strip && !strip.items ? (strip.logos ?? clientsFor(undefined).map((c) => ({ logo: c.id, label: c.name, client: true }))) : [];
  const stripId = `${id}-strip`;
  const primary = hero.primary_cta;
  return (
    <section id={id} aria-labelledby={`${id}-title`} className='relative scroll-mt-20 overflow-hidden'>
      <Backdrop />
      <div className='relative mx-auto max-w-6xl px-4 pt-16 pb-14 sm:px-6 sm:pt-24 sm:pb-20'>
        <div className={cn(hero.visual && 'grid gap-12 lg:grid-cols-[1fr_1.1fr] lg:items-center')}>
          <div className='min-w-0'>
            {hero.eyebrow ? <p className='text-primary mb-3 font-mono text-xs tracking-wider uppercase'>{hero.eyebrow}</p> : null}
            <h1 id={`${id}-title`} className='text-3xl font-semibold tracking-tight text-balance sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]'>
              {hero.headline}{hero.headline_highlight ? <> <span className='text-primary'>{hero.headline_highlight}</span></> : null}
            </h1>
            {hero.subheadline ? <p className={cn('text-muted-foreground mt-4 text-base text-pretty sm:text-lg', hero.visual ? 'max-w-md' : 'max-w-2xl')}>{hero.subheadline}</p> : null}
            <div className='mt-8 flex flex-wrap gap-3'>
              {primary === 'account' ? <AccountButton size='lg' signIn={ctas.signIn} open={ctas.open} />
                : primary ? <SmartLink link={primary} className={buttonVariants({ size: 'lg' })} /> : null}
              {hero.secondary_cta ? <SmartLink link={hero.secondary_cta} className={buttonVariants({ size: 'lg', variant: 'outline' })} /> : null}
            </div>
            {hero.links ? (
              <ul aria-label='More links' className='mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm'>
                {hero.links.map((k, i) => <li key={i}><SmartLink link={k} className='text-foreground inline-flex min-h-6 items-center gap-1 font-medium underline underline-offset-4' /></li>)}
              </ul>
            ) : null}
            {hero.note ? <p className='text-muted-foreground mt-5 text-sm'>{hero.note}</p> : null}
          </div>
          {hero.visual ? <Visual v={hero.visual} /> : null}
        </div>
        {strip && (strip.items || logos.length) ? (
          <div className='mt-16'>
            {strip.title ? <p id={stripId} className='text-muted-foreground mb-4 font-mono text-xs tracking-wider uppercase'>{strip.title}</p> : null}
            {strip.items ? (
              // Text names in the logo row's type (the first product's strip), not pills: a row of names, not a row of badges.
              <ul aria-labelledby={strip.title ? stripId : undefined} aria-label={strip.title ? undefined : strip.label} className='text-foreground/60 flex flex-wrap gap-x-8 gap-y-3 font-mono text-sm'>
                {strip.items.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            ) : (
              <ul aria-labelledby={strip.title ? stripId : undefined} aria-label={strip.title ? undefined : (strip.label ?? 'AI clients')} className='text-foreground/60 flex flex-wrap gap-x-8 gap-y-3 font-mono text-sm'>
                {logos.map((c) => (
                  <li key={c.logo} className='flex items-center gap-2'>
                    {'client' in c ? <ClientLogo id={c.logo} size={18} aria-hidden='true' /> : <AgentLogo id={c.logo} size={18} aria-hidden='true' />}{c.label}
                  </li>
                ))}
              </ul>
            )}
            {strip.note ? <p className='text-muted-foreground mt-4 max-w-3xl text-sm'>{strip.note}</p> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * A row of logos (mold_v0-164): each in a light tile of one fixed height, its image as wide as its own proportions say
 * (gen-packs measured it, so the row never shifts while images load), grey until pointed at or focused; an item with no
 * image is its name in the same tile. The name is each image's text alternative. The row wraps on a phone.
 */
function Logos({ p, s }: { p: Placed; s: LogosSection }) {
  const hid = `${p.id}-title`;
  const tile = 'flex h-14 items-center justify-center rounded-lg border bg-white px-4 text-neutral-800';
  const img = 'h-8 w-auto max-w-40 object-contain opacity-80 grayscale transition duration-200 group-hover:opacity-100 group-hover:grayscale-0 group-focus-visible:opacity-100 group-focus-visible:grayscale-0 motion-reduce:transition-none';
  return (
    <section id={p.id} aria-labelledby={s.title ? hid : undefined} aria-label={s.title ? undefined : (s.label ?? 'Logos')} className='scroll-mt-20 border-t py-12 sm:py-16'>
      <Wrap>
        {s.title ? <h2 id={hid} className='text-muted-foreground mb-6 font-mono text-xs tracking-wider uppercase'>{s.title}</h2> : null}
        <ul aria-label={s.title ? s.label : undefined} className='flex flex-wrap gap-3'>
          {s.items.map((it, i) => {
            const body = it.image
              ? <img src={it.image.src} alt={it.name} width={it.image.width} height={it.image.height} loading='lazy' decoding='async' className={img} style={{ aspectRatio: `${it.image.width} / ${it.image.height}` }} />
              : <span className='text-sm font-semibold tracking-tight whitespace-nowrap opacity-80 transition group-hover:opacity-100'>{it.name}</span>;
            return (
              <li key={i}>
                {it.href && linkable(it.href)
                  ? <a href={it.href} title={it.name} className={cn('group focus-visible:ring-ring outline-none focus-visible:ring-2', tile)} {...(/^https:/i.test(it.href) ? { rel: 'noopener noreferrer' } : {})}>{body}</a>
                  : <span title={it.name} className={cn('group', tile)}>{body}</span>}
              </li>
            );
          })}
        </ul>
        {s.note ? <p className='text-muted-foreground mt-4 max-w-3xl text-sm'>{s.note}</p> : null}
      </Wrap>
    </section>
  );
}

function Problem({ p, s }: { p: Placed; s: ProblemSection }) {
  return (
    <Band id={p.id} {...head(s)}>
      <Stack parts={[
        s.visual ? <Visual v={s.visual} /> : null,
        s.points ? (
          <ul className={cn('grid gap-8', s.points.length >= 3 ? 'sm:grid-cols-3' : s.points.length === 2 ? 'sm:grid-cols-2' : '', s.points.length === 4 && 'sm:grid-cols-2 lg:grid-cols-4')}>
            {s.points.map((pt, i) => {
              const Icon = pt.icon ? LANDING_ICONS[pt.icon] : null;
              return (
                <li key={i} className='flex flex-col gap-3'>
                  {Icon ? <Icon className='text-primary size-7' stroke={1.5} aria-hidden='true' /> : <span aria-hidden='true' className='text-primary font-mono text-sm font-medium'>{two(i + 1)}</span>}
                  <h3 className='text-lg font-semibold'>{pt.title}</h3>
                  <p className='text-muted-foreground text-sm leading-relaxed'>{pt.body}</p>
                </li>
              );
            })}
          </ul>
        ) : null
      ]} />
    </Band>
  );
}

function ConceptCards({ s }: { s: ConceptSection }) {
  const n = s.items?.length ?? 0;
  if (!s.items) return null;
  return (
    <ul className={cn('grid gap-4', n >= 3 ? 'md:grid-cols-3' : n === 2 ? 'md:grid-cols-2' : '', n === 4 && 'md:grid-cols-2 lg:grid-cols-4', n > 4 && 'md:grid-cols-2 lg:grid-cols-3')}>
      {s.items.map((it, i) => (
        <li key={i} className={cn('flex flex-col gap-4 rounded-2xl border p-5', it.highlight ? 'border-primary/50 bg-primary/10 shadow-primary/40 shadow-[0_0_40px_-12px]' : 'bg-card/40')}>
          <div className='flex flex-col gap-0.5'>
            <h3 className='text-lg leading-tight font-semibold break-words'>{it.title}</h3>
            {it.subtitle ? <p className='text-muted-foreground text-xs break-words'>{it.subtitle}</p> : null}
          </div>
          {it.body ? <p className='text-muted-foreground text-sm leading-relaxed break-words'>{it.body}</p> : null}
          {it.chips ? (
            <ol aria-label={`${it.title}: ${it.chips.join(', then ')}`} className='mt-auto flex flex-wrap items-center gap-1.5'>
              {it.chips.map((c, k) => {
                const last = k === it.chips!.length - 1;
                return (
                  <li key={k} className='flex items-center gap-1.5'>
                    {k > 0 ? <span aria-hidden='true' className='text-muted-foreground text-xs'>→</span> : null}
                    <span className={cn('rounded-full px-2.5 py-1 text-xs break-words',
                      last && it.highlight ? 'bg-primary text-primary-foreground font-medium' : k === 0 ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground border border-dashed')}>{c}</span>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Concept({ p, s }: { p: Placed; s: ConceptSection }) {
  return (
    <Band id={p.id} {...head(s)}>
      <Stack parts={[
        s.visual ? <Visual v={s.visual} /> : null,
        s.items ? <ConceptCards s={s} /> : null,
        s.note ? <p className='text-muted-foreground text-sm break-words'>{s.note}</p> : null
      ]} />
    </Band>
  );
}

/** An arrow from one step to the next: down on a phone, across on a wide screen. */
const Next = () => (
  <svg aria-hidden='true' viewBox='0 0 24 24' className='text-primary mx-auto my-1 size-5 shrink-0 rotate-90 lg:mx-2 lg:my-0 lg:rotate-0'>
    <path d='M4 12h14m-5-5 5 5-5 5' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
  </svg>
);

function Steps({ s }: { s: HowItWorksSection & { steps: LandingItem[] } }) {
  const layout = s.layout ?? 'flow';
  const n = s.steps.length;
  const StepText = ({ st, i }: { st: LandingItem; i: number }) => (
    <>
      <h3 className='font-semibold break-words'><span className='sr-only'>Step {i + 1}: </span>{st.title}</h3>
      <p className='text-muted-foreground text-sm leading-relaxed break-words'>{st.body}</p>
    </>
  );
  if (layout === 'steps') return (
    <ol className={cn('grid gap-6', cols(n))}>
      {s.steps.map((st, i) => (
        <li key={i} className='flex gap-4'>
          <span aria-hidden='true' className='bg-primary text-primary-foreground flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold'>{i + 1}</span>
          <div className='flex min-w-0 flex-col gap-1'><StepText st={st} i={i} /></div>
        </li>
      ))}
    </ol>
  );
  return (
    <div>
      <ol className='flex flex-col lg:flex-row lg:items-stretch'>
        {s.steps.map((st, i) => (
          <li key={i} className='flex min-w-0 flex-col lg:flex-1 lg:flex-row lg:items-center'>
            {i > 0 ? <Next /> : null}
            <div className='bg-card border-primary/40 flex h-full min-w-0 flex-1 flex-col gap-1.5 rounded-2xl border p-5'>
              <span aria-hidden='true' className='text-primary font-mono text-xs font-medium'>{two(i + 1)}</span>
              <StepText st={st} i={i} />
            </div>
          </li>
        ))}
      </ol>
      {layout === 'loop' ? (
        <>
          {/* The way back, drawn from the steps: from under the last step to under the first. */}
          <div aria-hidden='true' className='relative hidden lg:block' style={{ marginLeft: `${50 / n}%`, marginRight: `${50 / n}%` }}>
            <div className='border-primary/50 h-8 rounded-b-2xl border-x-2 border-b-2 border-dashed' />
            <svg viewBox='0 0 12 8' className='text-primary absolute -top-1.5 -left-[5px] h-2 w-3'><path d='M6 0 12 8H0Z' fill='currentColor' /></svg>
          </div>
          <p className='text-muted-foreground mt-3 flex items-center justify-center gap-2 text-sm'>
            <svg aria-hidden='true' viewBox='0 0 24 24' className='text-primary size-4 shrink-0'><path d='M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' /></svg>
            <span className='break-words'>{s.loop_label ?? 'Repeat'}: back to step 1</span>
          </p>
        </>
      ) : null}
    </div>
  );
}

function HowItWorks({ p, s }: { p: Placed; s: HowItWorksSection }) {
  return (
    <Band id={p.id} {...head(s)}>
      <Stack parts={[s.visual ? <Visual v={s.visual} /> : null, s.steps ? <Steps s={{ ...s, steps: s.steps }} /> : null]} />
    </Band>
  );
}

function Proof({ p, s }: { p: Placed; s: ProofSection }) {
  return (
    <Band id={p.id} {...head(s)}>
      <Stack parts={[
        s.visual ? <Visual v={s.visual} /> : null,
        s.metrics ? (
          <dl className={cn('grid gap-x-10 gap-y-10', cols(s.metrics.length))}>
            {s.metrics.map((m, i) => (
              <div key={i} className='flex flex-col gap-1 border-t pt-5'>
                <dt className='order-2 font-medium break-words'>{m.label}</dt>
                <dd className='order-1 text-4xl font-semibold tracking-tight break-words tabular-nums'>{m.value}</dd>
                {m.note ? <dd className='text-muted-foreground order-3 text-sm break-words'>{m.note}</dd> : null}
              </div>
            ))}
          </dl>
        ) : null,
        s.items ? <Cards items={s.items} columns={cols(s.items.length)} /> : null,
        s.note ? <p className='text-muted-foreground text-sm break-words'>{s.note}</p> : null
      ]} />
    </Band>
  );
}

function WhereYouWork({ p, s, ctas }: { p: Placed; s: WhereYouWorkSection; ctas: SiteCtas }) {
  // The clients' grid when the block names clients, or has no visual; the visual (a sample chat) beside it.
  const clients = s.clients || !s.visual ? clientsFor(s.clients) : [];
  const grid = clients.length ? (
    <div className='min-w-0'>
      <ul aria-label='AI clients' className='grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3'>
        {clients.map((c) => (
          <li key={c.id} className='bg-card flex min-w-0 items-center gap-3 rounded-xl border px-4 py-3 text-sm font-medium'>
            <ClientLogo id={c.id} size={20} aria-hidden='true' className='shrink-0' /><span className='min-w-0 break-words'>{c.name}</span>
          </li>
        ))}
      </ul>
      <p className='mt-6'><SmartLink link={{ label: 'See the steps for each client', href: ctas.install.href }} className='text-foreground inline-flex min-h-6 items-center font-medium underline underline-offset-4' /></p>
      {s.note ? <p className='text-muted-foreground mt-4 text-sm break-words'>{s.note}</p> : null}
    </div>
  ) : null;
  return (
    <Band id={p.id} {...head(s)}>
      {grid && s.visual ? <div className='grid gap-10 lg:grid-cols-2 lg:items-start'>{grid}<div className='min-w-0'><Visual v={s.visual} /></div></div>
        : grid ?? (s.visual ? <Visual v={s.visual} /> : null)}
      {!grid && s.note ? <p className='text-muted-foreground mt-6 text-center text-sm break-words'>{s.note}</p> : null}
    </Band>
  );
}

function Faq({ p, s }: { p: Placed; s: FaqSection }) {
  return (
    <Band id={p.id} center {...head(s)}>
      <div className='mx-auto max-w-3xl'><LandingFaq items={s.items} /></div>
    </Band>
  );
}

function Cta({ p, s, ctas, access }: { p: Placed; s: CtaSection; ctas: SiteCtas; access?: AccountsMode }) {
  return (
    <section id={p.id} aria-labelledby={`${p.id}-title`} className='scroll-mt-20 border-t py-16 sm:py-20'>
      <Wrap>
        <div className='bg-primary text-primary-foreground flex flex-col gap-5 rounded-2xl px-6 py-10 sm:px-10'>
          <h2 id={`${p.id}-title`} className='text-2xl font-semibold tracking-tight text-balance break-words sm:text-3xl'>{s.title ?? TITLE.cta()}</h2>
          {s.body ? <p className='max-w-3xl text-base break-words sm:text-lg'>{s.body}</p> : null}
          <Ctas primary={forAccess(s.primary_cta ?? ctas.start, access)} secondary={forAccess(s.secondary_cta ?? (s.primary_cta ? undefined : ctas.install), access)} inverse />
        </div>
      </Wrap>
    </section>
  );
}

/** The page's sections, in the block's order. Each is a labelled region with its anchor, so the header and a screen reader can jump to it. */
export function LandingSections({ access }: { access?: AccountsMode } = {}) {
  const l = resolvedLanding(declared, access);
  return (
    <>
      {l.placed.map((p) => {
        const s = p.section;
        switch (s.type) {
          case 'hero': return <Hero key={p.id} id={p.id} hero={heroOf(s, l.ctas, access)} ctas={l.ctas} />;
          case 'logos': return <Logos key={p.id} p={p} s={s} />;
          case 'problem': return <Problem key={p.id} p={p} s={s} />;
          case 'concept': return <Concept key={p.id} p={p} s={s} />;
          case 'how_it_works': return <HowItWorks key={p.id} p={p} s={s} />;
          case 'proof': return <Proof key={p.id} p={p} s={s} />;
          case 'where_you_work': return <WhereYouWork key={p.id} p={p} s={s} ctas={l.ctas} />;
          case 'faq': return <Faq key={p.id} p={p} s={s} />;
          case 'cta': return <Cta key={p.id} p={p} s={s} ctas={l.ctas} access={access} />;
        }
      })}
    </>
  );
}

// ---------- header and footer ----------

/** The build's mark and name, linking home (the header's and the footer's). */
const Logo = () => (
  <Link href='/' className='flex items-center gap-2 font-semibold tracking-tight' aria-label={`${profile.name} home`}>
    <BrandMark />
    <span>{profile.name}</span>
  </Link>
);

/** The public pages' header: the build's mark and name, the picked sections, the block's header links and the ways in (account-aware). */
export function SiteHeader({ access }: { access?: AccountsMode } = {}) {
  const l = resolvedLanding(declared, access);
  return (
    <SiteHeaderView name={profile.name} mark={<BrandMark />} nav={l.nav} links={l.header?.links ?? []}
      account={l.header?.account ?? 'sign_in_and_start'} ctas={l.ctas} start={l.startInHeader}
      repo={l.openSource ? { href: l.openSource.repo, label: `${profile.name} on GitHub` } : undefined} />
  );
}

/**
 * The public pages' footer: the mark and the tagline (the block's, else the profile's short description) with the block's
 * note; the sections, the shell's ways in (unless the block says shell_links: false) and the block's links; the bottom
 * line (the block's copyright, else the legal company's name, else the product's) with the legal pages (mold_v0-109);
 * and the source offer whenever the install pages carry it.
 */
export function SiteFooter({ access }: { access?: AccountsMode } = {}) {
  const l = resolvedLanding(declared, access);
  const own = l.footer?.shell_links === false ? [] : [l.ctas.install, l.ctas.signIn, access === 'invite_only' ? l.ctas.start : { label: 'Create an account', href: l.ctas.start.href }];
  const declaredLinks = (l.footer?.links ?? []).map((k) => forAccess(k, access));
  // An open-source app's repository (mold_v0-164): a footer link too, unless the block's footer already has one to it.
  const repo = l.openSource && !declaredLinks.some((k) => k.href === l.openSource!.repo) ? [{ label: l.openSource.label ?? 'Open source on GitHub', href: l.openSource.repo }] : [];
  const links: LandingLink[] = [...l.nav, ...own, ...declaredLinks, ...repo];
  const legal = buildLegal();
  // The app's Terms and Privacy (mold_v0-109), when its profile.json has `legal`.
  const legalNav = legalLinks(legal);
  const linkClass = 'text-muted-foreground hover:text-foreground inline-flex min-h-6 items-center transition-colors';
  return (
    <footer className='border-t'>
      <div className='mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6'>
        <div className='flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between'>
          <div className='flex max-w-xs flex-col gap-2'>
            <Logo />
            <p className='text-muted-foreground text-sm'>{l.footer?.tagline ?? profile.short_description}</p>
            {l.footer?.note ? <p className='text-muted-foreground text-sm'>{l.footer.note}</p> : null}
          </div>
          <nav aria-label='Footer' className='grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:flex sm:flex-wrap sm:gap-x-6'>
            {links.map((k, i) => <SmartLink key={i} link={k} className={linkClass} />)}
          </nav>
        </div>
        <div className='text-muted-foreground flex flex-col gap-3 border-t pt-6 text-xs sm:flex-row sm:items-center sm:justify-between'>
          <p>{l.footer?.copyright ?? (legal ? `© ${legal.company_name}` : profile.name)}</p>
          {legalNav.length ? (
            <nav aria-label='Legal' className='flex flex-wrap gap-x-6 gap-y-2'>
              {legalNav.map(({ label, href }) => <SmartLink key={href} link={{ label, href }} className={linkClass} />)}
            </nav>
          ) : null}
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
      </div>
    </footer>
  );
}
