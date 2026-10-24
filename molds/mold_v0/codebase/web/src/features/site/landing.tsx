import type { Metadata } from 'next';
import Link from 'next/link';
import { BrandMark } from '@/components/brand';
import { buttonVariants } from '@/components/ui/button';
import { landing as declared, landingClients, sourceOfferItems } from '@/config/landing.generated';
import { profile } from '@/config/profile.generated';
import { fill } from '@/lib/vocabulary';
import { cn } from '@/lib/utils';
import { AccountLinks } from './account-links';
import { ClientLogo, hasClientMark } from './agent-logos';
import {
  linkable, sectionIds,
  type AccountsMode, type CompareTone, type ConceptSection, type CtaSection, type FaqSection, type HeroSection, type HowItWorksSection,
  type LandingBlock, type LandingClient, type LandingItem, type LandingLink, type LandingSection, type ProblemSection, type ProofSection,
  type SectionType, type WhereYouWorkSection
} from './landing-types';
import { buildLegal } from './legal';
import { legalLinks } from './legal-types';
import { forAccess, siteCtas, type SiteCtas } from './site-ctas';

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
const NAV_LABEL: Record<Exclude<SectionType, 'hero' | 'cta'>, string> = {
  problem: 'Why', concept: 'Overview', how_it_works: 'How it works', proof: 'What you get', where_you_work: 'Where you work', faq: 'FAQ'
};
/** Each section's title when the block gives none. */
const TITLE: Record<Exclude<SectionType, 'hero'>, () => string> = {
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
      visual: { title: 'assistant · new chat', lines: [fill('> what changed in our {workspace} this week?'), 'assistant ▸ I do not have access to that.', 'assistant ▸ Paste the records here and I will take a look.'], highlight: '# what if it could look for itself?' },
      points: [
        { title: 'Copied by hand', body: 'Every answer starts with an export and ends with a paste, so nothing stays current.' },
        { title: 'Nothing kept', body: 'What the assistant did stays in one chat. Nobody else can review it later.' },
        { title: 'Hard to share safely', body: fill("Pasting a {workspace}'s records into a chat leaves them wherever the chat goes.") }
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
      chat: {
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
export interface Placed { section: LandingSection; id: string; tint: boolean }

/** The page this build shows: the block's sections (else the neutral wireframe), each with its anchor; the header's navigation. */
export function resolvedLanding(block: LandingBlock | null = declared, access?: AccountsMode) {
  const ctas = siteCtas(access);
  const sections = block?.sections?.length ? block.sections : neutralSections();
  const ids = sectionIds(sections);
  let band = 0;
  const placed: Placed[] = sections.map((section, i) => ({ section, id: ids[i]!, tint: section.type !== 'hero' && section.type !== 'cta' && band++ % 2 === 1 }));
  const nav = placed.flatMap(({ section: s, id }) => (s.type === 'hero' || s.type === 'cta' ? [] : [{ label: s.nav_label ?? NAV_LABEL[s.type], href: `/#${id}` }]));
  const heroSection = sections.find((s): s is HeroSection => s.type === 'hero');
  return { placed, nav, ctas, hero: heroOf(heroSection ?? { type: 'hero' }, ctas, access), footer: block?.footer, seo: block?.seo };
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
    primary_cta: forAccess(h.primary_cta ?? ctas.start, access),
    secondary_cta: forAccess(h.secondary_cta ?? ctas.install, access),
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
    openGraph: { type: 'website', url: '/', siteName: profile.name, title, description },
    twitter: { card: 'summary', title, description }
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

/** A section's band: its anchor, an eyebrow (left out when it only repeats the title), the title and a lead; every other band tinted. */
function Band({ id, eyebrow, title, lead, center, tint, children }: {
  id: string; eyebrow?: string; title: string; lead?: string; center?: boolean; tint?: boolean; children?: React.ReactNode;
}) {
  const hid = `${id}-title`;
  return (
    <section id={id} aria-labelledby={hid} className={cn('scroll-mt-20 border-t py-16 sm:py-24', tint && 'bg-muted/30')}>
      <Wrap>
        <div className={cn('max-w-2xl', center && 'sm:mx-auto sm:text-center')}>
          {eyebrow && eyebrow.toLowerCase() !== title.toLowerCase() ? <p className='text-primary font-mono text-xs font-medium tracking-wider break-words uppercase'>{eyebrow}</p> : null}
          <h2 id={hid} className='mt-2 text-3xl font-semibold tracking-tight text-balance break-words sm:text-4xl'>{title}</h2>
          {lead ? <p className='text-muted-foreground mt-3 text-lg text-pretty break-words'>{lead}</p> : null}
        </div>
        {children ? <div className='mt-10 sm:mt-14'>{children}</div> : null}
      </Wrap>
    </section>
  );
}

const head = (s: Exclude<LandingSection, HeroSection | CtaSection>) => ({ eyebrow: s.eyebrow ?? NAV_LABEL[s.type], title: s.title ?? TITLE[s.type](), lead: s.lead });
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

// ---------- the sections ----------

/** The grid and glow behind the top of the page, in the theme's border and primary. */
function Backdrop() {
  return (
    <>
      <div aria-hidden='true' className='pointer-events-none absolute inset-0 -z-10 [mask-image:radial-gradient(70%_60%_at_50%_0%,black,transparent)] bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[size:56px_56px] opacity-60' />
      <div aria-hidden='true' className='pointer-events-none absolute -top-40 left-1/2 -z-10 h-[520px] w-[900px] max-w-full -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--primary)_22%,transparent),transparent)] blur-2xl' />
    </>
  );
}

function Hero({ id, hero }: { id: string; hero: ReturnType<typeof heroOf> }) {
  const strip = hero.strip;
  const logos = strip && !strip.items ? clientsFor(undefined) : [];
  const stripId = `${id}-strip`;
  return (
    <section id={id} aria-labelledby={`${id}-title`} className='relative isolate scroll-mt-20 overflow-hidden'>
      <Backdrop />
      <Wrap className='pt-16 pb-14 sm:pt-24 sm:pb-20'>
        <div className='max-w-3xl'>
          {hero.eyebrow ? <p className='text-primary font-mono text-xs font-medium tracking-wider break-words uppercase'>{hero.eyebrow}</p> : null}
          <h1 id={`${id}-title`} className='mt-3 text-4xl font-semibold tracking-tight text-balance break-words sm:text-5xl lg:leading-[1.1]'>{hero.headline}</h1>
          {hero.subheadline ? <p className='text-muted-foreground mt-5 max-w-2xl text-lg text-pretty break-words sm:text-xl'>{hero.subheadline}</p> : null}
          <Ctas primary={hero.primary_cta} secondary={hero.secondary_cta} className='mt-8' />
          {hero.links ? (
            <ul aria-label='More links' className='mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm'>
              {hero.links.map((k, i) => <li key={i}><SmartLink link={k} className='text-foreground inline-flex min-h-6 items-center gap-1 font-medium underline underline-offset-4' /></li>)}
            </ul>
          ) : null}
          {hero.note ? <p className='text-muted-foreground mt-5 text-sm break-words'>{hero.note}</p> : null}
        </div>
        {strip && (strip.items || logos.length) ? (
          <div className='mt-14 sm:mt-16'>
            {strip.title ? <p id={stripId} className='text-muted-foreground font-mono text-xs tracking-wider break-words uppercase'>{strip.title}</p> : null}
            {strip.items ? (
              <ul aria-labelledby={strip.title ? stripId : undefined} className='mt-4 flex flex-wrap gap-2'>
                {strip.items.map((c, i) => <li key={i} className='bg-card rounded-full border px-3 py-1 text-sm font-medium break-words'>{c}</li>)}
              </ul>
            ) : (
              <ul aria-labelledby={strip.title ? stripId : undefined} aria-label={strip.title ? undefined : 'AI clients'} className='text-foreground/80 mt-4 flex flex-wrap gap-x-8 gap-y-3 font-mono text-sm'>
                {logos.map((c) => <li key={c.id} className='flex items-center gap-2'><ClientLogo id={c.id} size={18} aria-hidden='true' />{c.name}</li>)}
              </ul>
            )}
            {strip.note ? <p className='text-muted-foreground mt-4 max-w-3xl text-sm break-words'>{strip.note}</p> : null}
          </div>
        ) : null}
      </Wrap>
    </section>
  );
}

const TONE: Record<CompareTone, string> = {
  good: 'border-primary/50 bg-primary/10 text-foreground',
  // The red is the frame, not the text: red text on its own tint can fall short of 4.5:1.
  bad: 'border-destructive/40 bg-destructive/10 text-foreground',
  neutral: 'text-foreground',
  muted: 'text-muted-foreground'
};

function Problem({ p, s }: { p: Placed; s: ProblemSection }) {
  const both = s.visual && s.compare;
  return (
    <Band id={p.id} tint={p.tint} {...head(s)}>
      {s.visual || s.compare ? (
        <div className={cn('grid gap-6', both && 'lg:grid-cols-[1.25fr_1fr]')}>
          {s.visual ? (
            <figure className='bg-card min-w-0 overflow-hidden rounded-xl border'>
              <figcaption className='flex items-center gap-1.5 border-b px-4 py-3'>
                <span aria-hidden='true' className='bg-foreground/15 size-2.5 rounded-full' /><span aria-hidden='true' className='bg-foreground/15 size-2.5 rounded-full' /><span aria-hidden='true' className='bg-foreground/15 size-2.5 rounded-full' />
                <span className='text-muted-foreground ml-2 font-mono text-xs break-words'>{s.visual.title ?? 'Transcript'}</span>
              </figcaption>
              <div className='flex flex-col gap-1 p-5 font-mono text-[13px] leading-6'>
                {s.visual.lines.map((line, i) => <p key={i} className={cn('break-words', line.startsWith('>') ? 'text-foreground' : 'text-foreground/80')}>{line}</p>)}
                {s.visual.highlight ? <p className='border-primary text-foreground mt-3 border-l-2 pl-3 break-words'>{s.visual.highlight}</p> : null}
              </div>
            </figure>
          ) : null}
          {s.compare ? (
            <div className='bg-card/40 flex min-w-0 flex-col justify-center gap-3 rounded-xl border p-5'>
              {s.compare.title ? <p className='text-muted-foreground font-mono text-xs tracking-wide break-words uppercase'>{s.compare.title}</p> : null}
              <ul className='flex flex-col gap-2'>
                {s.compare.items.map((c, i) => (
                  <li key={i} className={cn('flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border px-3.5 py-3', TONE[c.tone ?? 'neutral'])}>
                    <span className='font-medium break-words'>{c.label}</span>
                    {c.note ? <span className={cn('text-xs break-words', c.tone === 'good' || c.tone === 'bad' ? '' : 'text-muted-foreground')}>{c.note}</span> : null}
                  </li>
                ))}
              </ul>
              {s.compare.note ? <p className='text-muted-foreground text-sm break-words'>{s.compare.note}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {s.points ? (
        <ul className={cn('grid gap-8', (s.visual || s.compare) && 'mt-12', s.points.length >= 3 ? 'sm:grid-cols-3' : s.points.length === 2 ? 'sm:grid-cols-2' : '', s.points.length === 4 && 'sm:grid-cols-2 lg:grid-cols-4')}>
          {s.points.map((pt, i) => (
            <li key={i} className='flex flex-col gap-2'>
              <span aria-hidden='true' className='text-primary font-mono text-sm font-medium'>{two(i + 1)}</span>
              <h3 className='text-lg font-semibold break-words'>{pt.title}</h3>
              <p className='text-muted-foreground text-sm leading-relaxed break-words'>{pt.body}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </Band>
  );
}

function Concept({ p, s }: { p: Placed; s: ConceptSection }) {
  const n = s.items?.length ?? 0;
  return (
    <Band id={p.id} tint={p.tint} {...head(s)}>
      {s.items ? (
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
      ) : null}
      {s.note ? <p className={cn('text-muted-foreground text-sm break-words', s.items && 'mt-8')}>{s.note}</p> : null}
    </Band>
  );
}

/** An arrow from one step to the next: down on a phone, across on a wide screen. */
const Next = () => (
  <svg aria-hidden='true' viewBox='0 0 24 24' className='text-primary mx-auto my-1 size-5 shrink-0 rotate-90 lg:mx-2 lg:my-0 lg:rotate-0'>
    <path d='M4 12h14m-5-5 5 5-5 5' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
  </svg>
);

function HowItWorks({ p, s }: { p: Placed; s: HowItWorksSection }) {
  const layout = s.layout ?? 'flow';
  const n = s.steps.length;
  const StepText = ({ st, i }: { st: LandingItem; i: number }) => (
    <>
      <h3 className='font-semibold break-words'><span className='sr-only'>Step {i + 1}: </span>{st.title}</h3>
      <p className='text-muted-foreground text-sm leading-relaxed break-words'>{st.body}</p>
    </>
  );
  return (
    <Band id={p.id} tint={p.tint} {...head(s)}>
      {layout === 'steps' ? (
        <ol className={cn('grid gap-6', cols(n))}>
          {s.steps.map((st, i) => (
            <li key={i} className='flex gap-4'>
              <span aria-hidden='true' className='bg-primary text-primary-foreground flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold'>{i + 1}</span>
              <div className='flex min-w-0 flex-col gap-1'><StepText st={st} i={i} /></div>
            </li>
          ))}
        </ol>
      ) : (
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
      )}
    </Band>
  );
}

function Proof({ p, s }: { p: Placed; s: ProofSection }) {
  return (
    <Band id={p.id} tint={p.tint} {...head(s)}>
      {s.metrics ? (
        <dl className={cn('grid gap-x-10 gap-y-10', cols(s.metrics.length))}>
          {s.metrics.map((m, i) => (
            <div key={i} className='flex flex-col gap-1 border-t pt-5'>
              <dt className='order-2 font-medium break-words'>{m.label}</dt>
              <dd className='order-1 text-4xl font-semibold tracking-tight break-words tabular-nums'>{m.value}</dd>
              {m.note ? <dd className='text-muted-foreground order-3 text-sm break-words'>{m.note}</dd> : null}
            </div>
          ))}
        </dl>
      ) : null}
      {s.items ? <div className={cn(s.metrics && 'mt-12')}><Cards items={s.items} columns={cols(s.items.length)} /></div> : null}
      {s.note ? <p className='text-muted-foreground mt-8 text-sm break-words'>{s.note}</p> : null}
    </Band>
  );
}

const SPEAKER = { person: 'You', assistant: 'Assistant', tool: 'Tool call' } as const;

function WhereYouWork({ p, s, ctas }: { p: Placed; s: WhereYouWorkSection; ctas: SiteCtas }) {
  const clients = clientsFor(s.clients);
  return (
    <Band id={p.id} tint={p.tint} {...head(s)}>
      <div className={cn('grid gap-10', s.chat && 'lg:grid-cols-2 lg:items-start')}>
        <div className='min-w-0'>
          {clients.length ? (
            <ul aria-label='AI clients' className='grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3'>
              {clients.map((c) => (
                <li key={c.id} className='bg-card flex min-w-0 items-center gap-3 rounded-xl border px-4 py-3 text-sm font-medium'>
                  <ClientLogo id={c.id} size={20} aria-hidden='true' className='shrink-0' /><span className='min-w-0 break-words'>{c.name}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className='mt-6'><SmartLink link={{ label: 'See the steps for each client', href: ctas.install.href }} className='text-foreground inline-flex min-h-6 items-center font-medium underline underline-offset-4' /></p>
          {s.note ? <p className='text-muted-foreground mt-4 text-sm break-words'>{s.note}</p> : null}
        </div>
        {s.chat ? (
          <figure className='flex min-w-0 flex-col gap-4'>
            {s.chat.messages.map((m, i) => (
              m.from === 'person' ? (
                <p key={i} className='bg-muted ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm break-words'><span className='sr-only'>{SPEAKER.person}: </span>{m.text}</p>
              ) : m.from === 'tool' ? (
                <p key={i} className='text-muted-foreground flex w-fit max-w-full items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-xs break-words'>
                  <svg aria-hidden='true' viewBox='0 0 24 24' className='text-primary size-3.5 shrink-0'><path d='M13 3 4 14h7l-1 7 9-11h-7z' fill='currentColor' /></svg>
                  <span className='sr-only'>{SPEAKER.tool}: </span>{m.text}
                </p>
              ) : (
                <p key={i} className='border-primary/40 border-l-2 pl-4 text-sm leading-relaxed break-words'><span className='sr-only'>{SPEAKER.assistant}: </span>{m.text}</p>
              )
            ))}
            {s.chat.note ? <figcaption className='text-muted-foreground pt-2 text-center text-xs break-words'>{s.chat.note}</figcaption> : null}
          </figure>
        ) : null}
      </div>
    </Band>
  );
}

function Faq({ p, s }: { p: Placed; s: FaqSection }) {
  return (
    <Band id={p.id} tint={p.tint} center {...head(s)}>
      <div className='mx-auto flex max-w-3xl flex-col divide-y border-y'>
        {s.items.map((q, i) => (
          <details key={i} className='group'>
            <summary className='focus-visible:ring-ring/50 flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 rounded-md py-4 text-left text-base font-medium outline-none focus-visible:ring-3 [&::-webkit-details-marker]:hidden'>
              <span className='break-words'>{q.question}</span>
              <svg aria-hidden='true' viewBox='0 0 16 16' className='text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-180'><path d='M4 6l4 4 4-4' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' /></svg>
            </summary>
            <p className='text-muted-foreground pb-4 text-sm leading-relaxed break-words'>{q.answer}</p>
          </details>
        ))}
      </div>
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
          case 'hero': return <Hero key={p.id} id={p.id} hero={heroOf(s, l.ctas, access)} />;
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

const Mark = () => (
  <Link href='/' className='flex min-w-0 items-center gap-2 font-semibold tracking-tight' aria-label={`${profile.name} home`}>
    <BrandMark />
    <span className='truncate'>{profile.name}</span>
  </Link>
);

/** The public pages' header: the build's mark and name, the picked sections, and the ways in (account-aware). */
export function SiteHeader({ access }: { access?: AccountsMode } = {}) {
  const l = resolvedLanding(declared, access);
  const menu = [...l.nav, { label: 'Install', href: l.ctas.install.href }];
  return (
    <header className='bg-background/85 supports-[backdrop-filter]:bg-background/70 sticky top-0 z-40 border-b backdrop-blur'>
      <Wrap className='flex min-h-16 items-center gap-4 py-3'>
        <Mark />
        {l.nav.length ? (
          <nav aria-label='Sections' className='hidden items-center gap-1 lg:flex'>
            {l.nav.map((n) => <a key={n.href} href={n.href} className='text-muted-foreground hover:text-foreground rounded-md px-3 py-2 text-sm transition-colors'>{n.label}</a>)}
          </nav>
        ) : null}
        <div className='ml-auto flex shrink-0 items-center gap-1 sm:gap-2'>
          <Link href={l.ctas.install.href} className={cn(buttonVariants({ variant: 'ghost' }), 'hidden h-10 sm:inline-flex')}>Install</Link>
          <AccountLinks start={l.ctas.start} signIn={l.ctas.signIn} open={l.ctas.open} />
          {l.nav.length ? (
            <details className='group relative lg:hidden'>
              <summary className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'size-10 list-none [&::-webkit-details-marker]:hidden')}>
                <span className='sr-only'>Menu</span>
                <svg aria-hidden='true' viewBox='0 0 24 24' className='size-5'><path d='M4 7h16M4 12h16M4 17h16' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' /></svg>
              </summary>
              <nav aria-label='Menu' className='bg-popover text-popover-foreground absolute top-12 right-0 z-50 flex w-64 flex-col gap-1 rounded-xl border p-2 shadow-lg'>
                {menu.map((n) => <a key={n.href} href={n.href} className='hover:bg-muted flex min-h-11 items-center rounded-md px-3 text-sm'>{n.label}</a>)}
              </nav>
            </details>
          ) : null}
        </div>
      </Wrap>
    </header>
  );
}

/** The public pages' footer: the name and tagline, the block's note, the sections and the ways in, the block's links, the legal pages (mold_v0-109) and the source offer. */
export function SiteFooter({ access }: { access?: AccountsMode } = {}) {
  const l = resolvedLanding(declared, access);
  const links: LandingLink[] = [...l.nav, l.ctas.install, l.ctas.signIn, access === 'invite_only' ? l.ctas.start : { label: 'Create an account', href: l.ctas.start.href }, ...(l.footer?.links ?? []).map((k) => forAccess(k, access))];
  const legal = buildLegal();
  // The app's Terms and Privacy (mold_v0-109), when its profile.json has `legal`.
  const legalNav = legalLinks(legal);
  const linkClass = 'text-muted-foreground hover:text-foreground inline-flex min-h-6 items-center underline-offset-4 hover:underline';
  return (
    <footer className='border-t'>
      <Wrap className='flex flex-col gap-8 py-10'>
        <div className='flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between'>
          <div className='flex max-w-sm flex-col gap-2'>
            <p className='flex items-center gap-2 font-semibold'><BrandMark className='size-6' /><span className='break-words'>{profile.name}</span></p>
            <p className='text-muted-foreground text-sm break-words'>{profile.short_description}</p>
            {l.footer?.note ? <p className='text-muted-foreground text-sm break-words'>{l.footer.note}</p> : null}
          </div>
          <nav aria-label='Footer'>
            <ul className='grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:flex sm:max-w-xl sm:flex-wrap sm:justify-end sm:gap-x-6'>
              {links.map((k, i) => <li key={i}><SmartLink link={k} className={linkClass} /></li>)}
            </ul>
          </nav>
        </div>
        <div className='text-muted-foreground flex flex-col gap-3 border-t pt-6 text-xs sm:flex-row sm:items-center sm:justify-between'>
          <p className='break-words'>{legal ? `© ${legal.company_name}` : profile.name}</p>
          {legalNav.length ? (
            <nav aria-label='Legal'>
              <ul className='flex flex-wrap gap-x-6 gap-y-2'>
                {legalNav.map(({ label, href }) => <li key={href}><SmartLink link={{ label, href }} className={linkClass} /></li>)}
              </ul>
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
      </Wrap>
    </footer>
  );
}
