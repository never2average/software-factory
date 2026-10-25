/**
 * The landing block's shape for the console (mold_v0-091; sections since mold_v0-122). The rules (plain text, lengths,
 * which addresses a link may have, which sections a page may pick and how often) are the server's src/landing.ts,
 * checked by scripts/gen-packs.mjs before it writes src/config/landing.generated.ts, always as sections (an old-style
 * block is converted there); this is only the type the page reads.
 */
export interface LandingLink { label: string; href: string }
export interface LandingItem { title: string; body: string }

interface Head { id?: string; nav_label?: string; nav?: boolean; eyebrow?: string; title?: string; lead?: string }

export type IconName = 'eye-off' | 'git-compare' | 'code' | 'search' | 'message-chatbot' | 'terminal' | 'bolt' | 'shield-check' | 'chart-bar' | 'plug'
  | 'users' | 'lock' | 'file-text' | 'clock' | 'check' | 'alert-triangle' | 'list-check' | 'building' | 'robot' | 'refresh' | 'file-search';

/** The visual templates (src/landing.ts VISUALS): pictures the shell draws from data. */
export interface DecisionGraphVisual { type: 'decision_graph'; label: string; root: string; branches: { logo?: string; label: string; outcome: string; tone?: 'good' | 'bad' | 'neutral' }[] }
export interface TranscriptVisual {
  type: 'transcript'; title: string; lines: { text: string; tone?: 'prompt' | 'agent' | 'command' | 'ok' }[]; highlight?: string;
  aside?: { title?: string; items: { label: string; note?: string; tone?: 'pick' | 'neutral' | 'muted' | 'alert' }[]; note?: string };
}
export interface LoopVisual {
  type: 'loop'; label: string; steps: { label: string; sub: string }[]; question: string; yes_tag?: string; no_tag?: string;
  yes: { label: string; sub: string }; no: { label: string; sub: string }; again: string;
}
export interface PathsVisual {
  type: 'paths'; count_label?: string; done_label?: string; measure_label?: string;
  items: { icon?: IconName; title: string; subtitle?: string; value_label?: string; value: string; path: string[]; highlight?: boolean; measure?: string }[];
}
export interface ScorecardVisual {
  type: 'scorecard';
  bars?: { title: string; rows: { logo?: string; label: string; value: number }[] };
  donut?: { title: string; slices: { label: string; value: number; tone?: 'primary' | 'alert' | 'muted' }[] };
  trend?: { title: string; delta?: string; points: number[]; marker_after?: number; marker_label?: string };
  chips?: { label: string; tone?: 'primary' | 'muted' | 'alert' | 'secondary' }[];
  note?: string;
}
export type ChatMessage = { from: 'person' | 'assistant' | 'tool'; text: string } | { from: 'bars'; rows: { label: string; value: number }[]; low_below?: number };
export interface ChatVisual { type: 'chat'; messages: ChatMessage[]; note?: string }
export type LandingVisual = DecisionGraphVisual | TranscriptVisual | LoopVisual | PathsVisual | ScorecardVisual | ChatVisual;

export interface HeroSection {
  type: 'hero'; id?: string; eyebrow?: string; headline?: string; headline_highlight?: string; subheadline?: string;
  /** A link, or 'account': sign in (or open the console when signed in), with an arrow. */
  primary_cta?: LandingLink | 'account'; secondary_cta?: LandingLink; note?: string;
  /** Up to 3 more links under the calls to action (the app's own: its repository, its docs). */
  links?: LandingLink[];
  visual?: LandingVisual;
  /** Text badges, named logos, or (with neither) the logos of the AI clients the build offers. */
  strip?: { title?: string; label?: string; items?: string[]; logos?: { logo: string; label: string }[]; note?: string };
}
export interface ProblemSection extends Head { type: 'problem'; visual?: LandingVisual; points?: (LandingItem & { icon?: IconName })[] }
export interface ConceptSection extends Head {
  type: 'concept'; visual?: LandingVisual; note?: string;
  items?: { title: string; subtitle?: string; body?: string; chips?: string[]; highlight?: boolean }[];
}
export interface HowItWorksSection extends Head { type: 'how_it_works'; visual?: LandingVisual; steps?: LandingItem[]; layout?: 'steps' | 'flow' | 'loop'; loop_label?: string }
export interface ProofSection extends Head { type: 'proof'; visual?: LandingVisual; metrics?: { value: string; label: string; note?: string }[]; items?: LandingItem[]; note?: string }
export interface WhereYouWorkSection extends Head { type: 'where_you_work'; visual?: LandingVisual; clients?: string[]; note?: string }
export interface FaqSection extends Head { type: 'faq'; items: { question: string; answer: string }[] }
export interface CtaSection { type: 'cta'; id?: string; title?: string; body?: string; primary_cta?: LandingLink; secondary_cta?: LandingLink }

export type LandingSection = HeroSection | ProblemSection | ConceptSection | HowItWorksSection | ProofSection | WhereYouWorkSection | FaqSection | CtaSection;
export type SectionType = LandingSection['type'];

export interface LandingBlock {
  /** The sections in the app's order; absent: the whole wireframe in the shell's neutral words. */
  sections?: LandingSection[];
  /** `sign_in` and `open`: the account button's two states, relabelled or re-addressed (mold_v0-138). */
  header?: { links?: LandingLink[]; account?: 'sign_in_and_start' | 'account'; sign_in?: LandingLink; open?: LandingLink };
  footer?: { note?: string; links?: LandingLink[]; tagline?: string; copyright?: string; shell_links?: boolean };
  seo?: { title?: string; description?: string; card?: 'summary' | 'summary_large_image' };
  request_page?: RequestPage;
}

/**
 * The request page (mold_v0-138; src/landing.ts request_page): a public page asking for access at its own path, with the
 * build's request form (web/src/features/site/request-page.tsx).
 */
export interface RequestPage {
  path: string; eyebrow?: string; title: string; title_highlight?: string; lead?: string;
  benefits?: { icon?: IconName; title: string; body: string }[];
  seo?: { title?: string; description?: string };
  form?: { submit?: string; more?: string; message_label?: string; done?: { title: string; steps?: string[] } };
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
