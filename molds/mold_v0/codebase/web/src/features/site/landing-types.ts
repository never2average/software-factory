/**
 * The landing block's shape for the console (mold_v0-091; sections since mold_v0-122). The rules (plain text, lengths,
 * which addresses a link may have, which sections a page may pick and how often) are the server's src/landing.ts,
 * checked by scripts/gen-packs.mjs before it writes src/config/landing.generated.ts, always as sections (an old-style
 * block is converted there); this is only the type the page reads.
 */
export interface LandingLink { label: string; href: string }
export interface LandingItem { title: string; body: string }

interface Head { id?: string; nav_label?: string; eyebrow?: string; title?: string; lead?: string }

export interface HeroSection {
  type: 'hero'; id?: string; eyebrow?: string; headline?: string; subheadline?: string;
  primary_cta?: LandingLink; secondary_cta?: LandingLink; note?: string;
  /** Up to 3 more links under the calls to action (the app's own: its repository, its docs). */
  links?: LandingLink[];
  /** Text badges, or (without items) the logos of the AI clients the build offers. */
  strip?: { title?: string; items?: string[]; note?: string };
}
export type CompareTone = 'good' | 'bad' | 'neutral' | 'muted';
export interface ProblemSection extends Head {
  type: 'problem'; points?: LandingItem[];
  visual?: { title?: string; lines: string[]; highlight?: string };
  compare?: { title?: string; items: { label: string; note?: string; tone?: CompareTone }[]; note?: string };
}
export interface ConceptSection extends Head {
  type: 'concept'; note?: string;
  items?: { title: string; subtitle?: string; body?: string; chips?: string[]; highlight?: boolean }[];
}
export interface HowItWorksSection extends Head { type: 'how_it_works'; steps: LandingItem[]; layout?: 'steps' | 'flow' | 'loop'; loop_label?: string }
export interface ProofSection extends Head { type: 'proof'; metrics?: { value: string; label: string; note?: string }[]; items?: LandingItem[]; note?: string }
export interface WhereYouWorkSection extends Head {
  type: 'where_you_work'; clients?: string[]; note?: string;
  chat?: { messages: { from: 'person' | 'assistant' | 'tool'; text: string }[]; note?: string };
}
export interface FaqSection extends Head { type: 'faq'; items: { question: string; answer: string }[] }
export interface CtaSection { type: 'cta'; id?: string; title?: string; body?: string; primary_cta?: LandingLink; secondary_cta?: LandingLink }

export type LandingSection = HeroSection | ProblemSection | ConceptSection | HowItWorksSection | ProofSection | WhereYouWorkSection | FaqSection | CtaSection;
export type SectionType = LandingSection['type'];

export interface LandingBlock {
  /** The sections in the app's order; absent: the whole wireframe in the shell's neutral words. */
  sections?: LandingSection[];
  footer?: { note?: string; links?: LandingLink[] };
  seo?: { title?: string; description?: string };
}

/** An AI client the build's install pages offer (src/connect-catalog.ts id, its short name, its group). */
export interface LandingClient { id: string; name: string; group: 'chat' | 'agent' | 'editor' }

/**
 * Who may open an account (mold_v0-098; the API's /api/auth/config `accounts`): under `invite_only` every call to action
 * that leads to sign-up (/auth/sign-up) leads to the request form (/request-access) instead.
 */
export type AccountsMode = 'invite_only' | 'self_serve';

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

/** Each section's anchor when it names none (the same as src/landing.ts DEFAULT_IDS; scripts/landing-test.ts checks). */
export const DEFAULT_IDS: Record<SectionType, string> = {
  hero: 'intro', problem: 'problem', concept: 'overview', how_it_works: 'how-it-works', proof: 'what-you-get',
  where_you_work: 'where-you-work', faq: 'faq', cta: 'get-started'
};

/** Every section's anchor, in order: its own id, else its type's (numbered for a repeated call to action). */
export function sectionIds(sections: readonly { type: SectionType; id?: string }[]): string[] {
  const seen: Record<string, number> = {};
  return sections.map((s) => {
    if (s.id) return s.id;
    const base = DEFAULT_IDS[s.type];
    seen[base] = (seen[base] ?? 0) + 1;
    return seen[base] === 1 ? base : `${base}-${seen[base]}`;
  });
}
