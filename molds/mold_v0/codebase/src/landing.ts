/**
 * The landing block (mold_v0-091, pick and place since mold_v0-122): an app's public landing page at `/`, declared as
 * settings instead of written as code. A declarative pack declares it in pack.json `landing`; the app's own profile.json
 * `landing` comes over it. At most one pack of a build declares one. scripts/gen-packs.mjs checks both with this module and
 * writes the result, with the build's source offer (src/source-offer.ts) and the AI clients its install pages offer, into
 * web/src/config/landing.generated.ts, which the console's `/` renders (web/src/features/site/landing.tsx) in the build's
 * brand (its name, tagline, mark and theme colours). A host pack declares it the same way (mold_v0-138: the first
 * product's own site moved here); one that still names a landing page in its console code (web/src/packs/<id>/index.ts,
 * mold_v0-039) keeps that page. A pack never brings a page, a component or a picture for it: every section is the shell's,
 * drawn from the block's words (the operator's rule: app packs are JSON, not pages).
 *
 * PICK AND PLACE. The page is a list of sections, `sections: [{type, ...fields}]`, in the order the app wants them. The
 * section library is the shell's: faithful, data-driven generalisations of the first product's landing page (its section
 * wrapper, hero, header, footer and questions, with the same spacing and type), so that page's own words reproduce it
 * (scripts/fixtures/landing-reference.json). The app picks which sections it shows, in which order, with which words.
 * With no `sections` the page is the whole wireframe, in that order, in the shell's neutral words.
 *
 *   hero            eyebrow, headline (default: the profile's tagline) and headline_highlight (in the primary colour),
 *                   subheadline, primary_cta (a link, or "account": sign in or open the console, with an arrow; default:
 *                   start, which is sign-up or a request for access), secondary_cta (default: connect an AI client), up
 *                   to 3 more `links` {label, href} (the app's own: its repository, its docs), note, a `visual` beside it,
 *                   and a strip under it: text names in the logos' type (`items`), named `logos`, or the logos of the AI clients offered
 *   problem         points {title, body, icon} under a visual
 *   concept         cards {title, subtitle, body, chips (a path drawn as chips), highlight} under a visual, a note
 *   how_it_works    steps {title, body} drawn as numbered cards (`layout: steps`), a flow (`flow`, the default) or a
 *                   flow that returns to its first step (`loop`, with `loop_label`), under a visual
 *   proof           metrics {value, label, note} and/or items {title, body} under a visual, a note
 *   where_you_work  the AI clients to show (`clients`: ids the build's install pages offer), beside a visual (a chat)
 *   faq             1 to 15 {question, answer}, an accordion
 *   cta             title, body, primary_cta, secondary_cta (the only type a page may pick more than once, up to 3)
 * Every section but hero and cta may carry `id` (its anchor, a slug), `nav_label` or `nav: false` (its entry in the
 * header's navigation, which lists the picked sections in order), `eyebrow`, `title`, `lead` and a `visual`, one of the
 * templates below (VISUALS: decision_graph, transcript, loop, paths, scorecard, chat). Beside `sections`:
 *   header          up to 2 links beside the ways in (default: the install pages) and which ways in ("sign_in_and_start",
 *                   the default, or "account": one account button); `sign_in` and `open` relabel or re-address the account
 *                   button's two states (signed out: sign in; signed in: into the console) wherever the page shows it
 *   footer          a tagline, a note, up to 8 links, a copyright line, and `shell_links: false` to leave out the shell's
 *                   own ways in (the sections, the legal pages and the source offer are always there)
 *   seo             title and description for search results and link previews (Open Graph; `card`: the X card's size,
 *                   summary or summary_large_image, the default); default from the hero. With seo, they are every public
 *                   page's default title, description and link preview too (mold_v0-138)
 *   request_page    a public page asking for access (mold_v0-138) at its own `path` (such as /early-access): an eyebrow, a
 *                   title with a highlighted end, a lead and up to 6 benefits {icon, title, body} beside the request form
 *                   (the build's access_request fields, src/access-request.ts), its own seo, and its form (`form`: the
 *                   submit label, the message's label, the fields it asks above the fold by key, a fold {label, fields}
 *                   that also holds the name and the message, and what it says once sent, where {company} and {email}
 *                   are the sender's)
 *
 * THE OLD BLOCK (mold_v0-091: hero, coverage, value_points, how_it_works, features, faq, closing at the top level) is
 * still read, and converted to sections (toSections) when gen-packs writes the build: hero (coverage becomes its strip),
 * value_points as the concept's cards, how_it_works, features as proof's items, faq, closing as a cta. So no build that
 * declared one breaks; a block may not mix the two (old-style keys beside `sections` are refused, with what to move).
 *
 * Every value is PLAIN TEXT, shown as text (React escapes it; nothing is parsed as HTML or Markdown), on one line, with no
 * control or invisible characters (bidirectional overrides, zero-width and tag characters are refused). A link's address
 * is a path of this site (`/install`, `/auth/sign-up`), an https:// address or a mailto: address: never javascript:,
 * data: or a protocol-relative `//host`. Every list and every text has a ceiling, so a block cannot make the page unusable.
 */
import { z } from "zod";

/** Characters a plain-text line may not hold: C0 and C1 controls (line breaks included), zero-width, bidirectional and tag characters, variation selectors. */
export const NOT_PLAIN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;

const text = (max: number) => z.string()
  .refine((s) => s.trim().length > 0, "text is required")
  .refine((s) => s.length <= max, `at most ${max} characters`)
  .refine((s) => !NOT_PLAIN.test(s), "plain text on one line: no line breaks, control or invisible characters");

/** A link's address: a path of this site, an https:// address or a mailto: address. */
export function hrefProblem(href: unknown): string | null {
  if (typeof href !== "string" || !href) return "an address is required";
  if (href.length > 500) return "at most 500 characters";
  if (!/^[!-~]+$/.test(href) || /["'<>\\`]/.test(href)) return "an address is printable ASCII with no spaces, quotes, angle brackets or backslashes";
  if (href.startsWith("/")) return /\/\/|\/\.\.?(\/|$|[?#])|%2f|%5c/i.test(href) ? "a path of this site has no //, /./, /../ or encoded / and \\ (they can lead to another site)" : null;
  if (/^https:\/\//i.test(href)) {
    try { const u = new URL(href); return u.protocol === "https:" && u.hostname && !u.username && !u.password ? null : "an https:// address with a host and no user name or password"; }
    catch { return "not a valid https:// address"; }
  }
  if (/^mailto:[^@/?#]+@[^@/?#]+(\?[^#]*)?$/i.test(href)) return null;
  return "a path of this site (/install), an https:// address or a mailto: address";
}
const Href = z.string().superRefine((h, ctx) => { const p = hrefProblem(h); if (p) ctx.addIssue({ code: "custom", message: p }); });

const Cta = z.object({ label: text(40), href: Href }).strict();
const Item = z.object({ title: text(80), body: text(400) }).strict();
const Faq = z.object({ title: text(120).optional(), items: z.array(z.object({ question: text(200), answer: text(1200) }).strict()).min(1).max(15) }).strict();
/**
 * The footer: a note and up to 8 links. `tagline` replaces the profile's short description beside the mark, `copyright`
 * is the bottom line (default: the legal company's name, else the product's), and `shell_links: false` leaves out the
 * shell's own ways in (install, sign in, create an account); the sections, the legal pages and the source offer stay.
 */
const Footer = z.object({
  note: text(300).optional(), links: z.array(Cta).max(8).optional(),
  tagline: text(200).optional(), copyright: text(120).optional(), shell_links: z.boolean().optional(),
}).strict();
/**
 * The header (mold_v0-122): up to 2 links beside the ways in (default: the install pages), and which ways in:
 * "sign_in_and_start" (default: sign in, and the start call) or "account" (one account button: sign in, or open the
 * console when signed in, with an arrow).
 */
const Header = z.object({
  links: z.array(Cta).max(2).optional(), account: z.enum(["sign_in_and_start", "account"]).optional(),
  sign_in: Cta.optional(), open: Cta.optional(),
}).strict();
/** Search results and link previews: a title, a description, and the X card's size (default the large image card). */
const Seo = z.object({ title: text(70).optional(), description: text(320).optional(), card: z.enum(["summary", "summary_large_image"]).optional() }).strict();

// ---------- the old block (mold_v0-091), still read and converted ----------

const LegacySchema = z.object({
  $comment: z.string().max(2000).optional(),
  hero: z.object({
    eyebrow: text(80).optional(),
    headline: text(120).optional(),
    subheadline: text(300).optional(),
    primary_cta: Cta.optional(),
    secondary_cta: Cta.optional(),
    note: text(200).optional(),
  }).strict().optional(),
  coverage: z.object({ title: text(80).optional(), items: z.array(text(40)).min(1).max(30), note: text(300).optional() }).strict().optional(),
  value_points: z.object({ title: text(120).optional(), items: z.array(Item).min(1).max(6) }).strict().optional(),
  how_it_works: z.object({ title: text(120).optional(), steps: z.array(Item).min(1).max(6) }).strict().optional(),
  features: z.object({ title: text(120).optional(), intro: text(300).optional(), items: z.array(Item).min(1).max(12) }).strict().optional(),
  faq: Faq.optional(),
  closing: z.object({ title: text(120), body: text(300).optional(), primary_cta: Cta.optional(), secondary_cta: Cta.optional() }).strict().optional(),
  footer: Footer.optional(),
  seo: Seo.optional(),
}).strict();
export type LegacyLanding = z.infer<typeof LegacySchema>;

/** The old block's sections, in its page order (also the keys an old profile block replaced one by one). */
export const LEGACY_SECTIONS = ["hero", "coverage", "value_points", "how_it_works", "features", "faq", "closing", "footer", "seo"] as const;
/** The old block's keys that are sections (footer and seo stay beside `sections`). */
const LEGACY_PAGE_KEYS = ["hero", "coverage", "value_points", "how_it_works", "features", "faq", "closing"] as const;

// ---------- the section library (mold_v0-122) ----------

/** The section types, in the wireframe's order: with no `sections`, the page shows every one of them in this order. */
export const SECTION_TYPES = ["hero", "problem", "concept", "how_it_works", "proof", "where_you_work", "faq", "cta"] as const;
export type SectionType = (typeof SECTION_TYPES)[number];
/** At most this many sections on a page; each type at most once, but a call to action up to MAX_CTAS times. */
export const MAX_SECTIONS = 10;
export const MAX_CTAS = 3;

/** An anchor: lower-case letters, digits and dashes, starting with a letter. Not one the page itself uses. */
const RESERVED_IDS = new Set(["main", "top", "source-code", "site-menu"]);
const Id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "an anchor: lower-case letters, digits and dashes, starting with a letter, at most 40")
  .refine((s) => !RESERVED_IDS.has(s), `not one the page uses itself (${[...RESERVED_IDS].join(", ")})`);
/** A client id of src/connect-catalog.ts (gen-packs checks it is one the build's install pages offer). */
const ClientId = z.string().regex(/^[a-z0-9-]{1,40}$/, "a client id of the install pages (src/connect-catalog.ts), such as claude or cursor");

const head = {
  id: Id.optional(), nav_label: text(24).optional(), nav: z.boolean().optional(),
  eyebrow: text(60).optional(), title: text(120).optional(), lead: text(600).optional(),
};

/** A logo the shell draws: an AI client's or agent's id (web/src/features/site/agent-logos.tsx; others get a terminal glyph). */
const LogoId = z.string().regex(/^[a-z0-9-]{1,40}$/, "a logo id, such as claude-code or cursor");
/** An icon the shell draws, by name (web/src/features/site/landing-icons.tsx). */
export const ICONS = ["eye-off", "git-compare", "code", "search", "message-chatbot", "terminal", "bolt", "shield-check", "chart-bar", "plug",
  "users", "lock", "file-text", "clock", "check", "alert-triangle", "list-check", "building", "robot", "refresh", "file-search"] as const;
const Icon = z.enum(ICONS);
const Percent = z.number().min(0).max(100);

/**
 * The visual templates (mold_v0-122): pictures the shell draws from data, after the first product's landing page, each in
 * the build's theme tokens. A section may carry one as `visual`.
 *   decision_graph  one prompt branching to 2-4 outcomes (a logo, a label, an outcome with a tone)
 *   transcript      a terminal card of lines (prompt, agent, command, ok), a highlight, and an aside list of options weighed
 *   loop            1-4 steps, a yes/no question, a "yes" box and a "no" box that runs the last step again
 *   paths           1-4 cards: an icon, a title, a value, a path of chips to a goal (the highlighted card reaches it at once)
 *   scorecard       bars by row, a donut of shares, a trend line with a marker, and a row of chips
 *   chat            a sample chat: the person's messages, a tool call, the assistant's text and bars, a note
 */
const VISUALS = {
  decision_graph: z.object({
    type: z.literal("decision_graph"), label: text(300), root: text(24),
    branches: z.array(z.object({ logo: LogoId.optional(), label: text(16), outcome: text(16), tone: z.enum(["good", "bad", "neutral"]).optional() }).strict()).min(2).max(4),
  }).strict(),
  transcript: z.object({
    type: z.literal("transcript"), title: text(60),
    lines: z.array(z.object({ text: text(160), tone: z.enum(["prompt", "agent", "command", "ok"]).optional() }).strict()).min(1).max(10),
    highlight: text(160).optional(),
    aside: z.object({
      title: text(40).optional(),
      items: z.array(z.object({ label: text(30), note: text(40).optional(), tone: z.enum(["pick", "neutral", "muted", "alert"]).optional() }).strict()).min(1).max(6),
      note: text(200).optional(),
    }).strict().optional(),
  }).strict(),
  loop: z.object({
    type: z.literal("loop"), label: text(300),
    steps: z.array(z.object({ label: text(22), sub: text(34) }).strict()).min(1).max(4),
    question: text(14), yes_tag: text(6).optional(), no_tag: text(6).optional(),
    yes: z.object({ label: text(16), sub: text(24) }).strict(), no: z.object({ label: text(14), sub: text(24) }).strict(), again: text(16),
  }).strict(),
  paths: z.object({
    type: z.literal("paths"),
    items: z.array(z.object({
      icon: Icon.optional(), title: text(12), subtitle: text(30).optional(), value_label: text(20).optional(), value: text(24),
      path: z.array(text(14)).min(1).max(6), highlight: z.boolean().optional(), measure: text(30).optional(),
    }).strict()).min(1).max(4),
    count_label: text(40).refine((s) => s.includes("{n}"), "says {n} where the number of steps goes").optional(),
    done_label: text(30).optional(), measure_label: text(20).optional(),
  }).strict(),
  scorecard: z.object({
    type: z.literal("scorecard"),
    bars: z.object({ title: text(30), rows: z.array(z.object({ logo: LogoId.optional(), label: text(16), value: Percent }).strict()).min(1).max(8) }).strict().optional(),
    donut: z.object({ title: text(30), slices: z.array(z.object({ label: text(16), value: Percent, tone: z.enum(["primary", "alert", "muted"]).optional() }).strict()).min(1).max(4) }).strict().optional(),
    trend: z.object({ title: text(30), delta: text(12).optional(), points: z.array(Percent).min(2).max(12), marker_after: z.number().int().min(0).optional(), marker_label: text(16).optional() }).strict().optional(),
    chips: z.array(z.object({ label: text(20), tone: z.enum(["primary", "muted", "alert", "secondary"]).optional() }).strict()).min(1).max(8).optional(),
    note: text(120).optional(),
  }).strict().refine((v) => v.bars || v.donut || v.trend, "a scorecard shows bars, a donut, a trend or more"),
  chat: z.object({
    type: z.literal("chat"),
    messages: z.array(z.union([
      z.object({ from: z.enum(["person", "assistant", "tool"]), text: text(300) }).strict(),
      z.object({ from: z.literal("bars"), rows: z.array(z.object({ label: text(16), value: Percent }).strict()).min(1).max(6), low_below: Percent.optional() }).strict(),
    ])).min(1).max(8),
    note: text(120).optional(),
  }).strict(),
} as const;
export const VISUAL_TYPES = Object.keys(VISUALS) as (keyof typeof VISUALS)[];
const Visual = z.discriminatedUnion("type", Object.values(VISUALS) as unknown as [z.ZodObject, ...z.ZodObject[]]);
export type VisualOf<K extends keyof typeof VISUALS> = z.infer<(typeof VISUALS)[K]>;

/** A hero's first call to action: a link, or "account" (sign in, or open the console when signed in, with an arrow). */
const HeroCta = z.union([z.literal("account"), Cta]);

/**
 * Where a declared public page may live (mold_v0-138): one segment of lower-case letters, digits and dashes, never one
 * of the console's own (gen-packs also refuses a path a host pack's routes.json claims).
 */
export const RESERVED_PAGE_SEGMENTS = ["app", "admin", "auth", "api", "install", "request-access", "privacy", "terms", "host", "declared",
  "mcp", "healthz", "console-status", "oauth", "consent", "sitemap", "robots", "manifest", "icon", "opengraph-image", "twitter-image"] as const;
const PagePath = z.string().regex(/^\/[a-z0-9][a-z0-9-]{0,39}$/, "a path of one segment: / then lower-case letters, digits and dashes, at most 40")
  .refine((p) => !(RESERVED_PAGE_SEGMENTS as readonly string[]).includes(p.slice(1)), `not one of the console's own (${RESERVED_PAGE_SEGMENTS.join(", ")})`);
/** A line said once a request is sent: {company} and {email} are the sender's, no other braces. */
const DoneLine = text(200).refine((s) => !/[{}]/.test(s.replace(/\{(company|email)\}/g, "")), "plain text; {company} and {email} are the only placeholders");

/**
 * The request page (mold_v0-138): a public page asking for access, after the first product's early-access page. The
 * form is the shell's (web/src/features/site/request-page-form.tsx): a work email and the company, then the build's
 * access_request fields (src/access-request.ts) the page picks by key: `form.fields` above the fold (default: every
 * declared field not in the fold), `form.more.fields` in the fold `form.more.label` opens, with the name and the message.
 * gen-packs checks each key is a declared field, and that every required field is asked.
 */
const FieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "an access_request field's key");
const RequestPage = z.object({
  path: PagePath,
  eyebrow: text(60).optional(), title: text(120), title_highlight: text(80).optional(), lead: text(300).optional(),
  benefits: z.array(z.object({ icon: Icon.optional(), title: text(60), body: text(200) }).strict()).min(1).max(6).optional(),
  seo: Seo.optional(),
  form: z.object({
    submit: text(40).optional(), message_label: text(80).optional(),
    fields: z.array(FieldKey).max(20).optional(),
    more: z.object({ label: text(40), fields: z.array(FieldKey).max(20).optional() }).strict().optional(),
    done: z.object({ title: text(80), steps: z.array(DoneLine).min(1).max(5).optional() }).strict().optional(),
  }).strict().refine((f) => { const k = [...(f.fields ?? []), ...(f.more?.fields ?? [])]; return new Set(k).size === k.length; }, "each field once, above the fold or in it").optional(),
}).strict();

const SECTION_SCHEMAS = {
  hero: z.object({
    type: z.literal("hero"), id: Id.optional(),
    eyebrow: text(80).optional(), headline: text(120).optional(), headline_highlight: text(80).optional(), subheadline: text(300).optional(),
    primary_cta: HeroCta.optional(), secondary_cta: Cta.optional(), note: text(200).optional(),
    links: z.array(Cta).min(1).max(3).optional(),
    visual: Visual.optional(),
    strip: z.object({
      title: text(80).optional(), label: text(60).optional(),
      items: z.array(text(40)).min(1).max(30).optional(),
      logos: z.array(z.object({ logo: LogoId, label: text(30) }).strict()).min(1).max(12).optional(),
      note: text(300).optional(),
    }).strict().refine((s) => !(s.items && s.logos), "a strip shows text badges (items) or logos, not both").optional(),
  }).strict(),
  problem: z.object({
    type: z.literal("problem"), ...head,
    visual: Visual.optional(),
    points: z.array(z.object({ title: text(80), body: text(400), icon: Icon.optional() }).strict()).min(1).max(4).optional(),
  }).strict(),
  concept: z.object({
    type: z.literal("concept"), ...head,
    visual: Visual.optional(),
    items: z.array(z.object({
      title: text(80), subtitle: text(80).optional(), body: text(400).optional(),
      chips: z.array(text(30)).min(1).max(6).optional(), highlight: z.boolean().optional(),
    }).strict()).min(1).max(6).optional(),
    note: text(300).optional(),
  }).strict(),
  how_it_works: z.object({
    type: z.literal("how_it_works"), ...head,
    visual: Visual.optional(),
    steps: z.array(Item).min(1).max(6).optional(),
    layout: z.enum(["steps", "flow", "loop"]).optional(),
    loop_label: text(40).optional(),
  }).strict().refine((s) => s.steps || s.visual, "how it works shows steps, a visual or both"),
  proof: z.object({
    type: z.literal("proof"), ...head,
    visual: Visual.optional(),
    metrics: z.array(z.object({ value: text(16), label: text(80), note: text(160).optional() }).strict()).min(1).max(6).optional(),
    items: z.array(Item).min(1).max(12).optional(),
    note: text(300).optional(),
  }).strict().refine((s) => s.metrics || s.items || s.visual, "proof shows metrics, items, a visual or more: give at least one"),
  where_you_work: z.object({
    type: z.literal("where_you_work"), ...head,
    visual: Visual.optional(),
    clients: z.array(ClientId).min(1).max(12).refine((a) => new Set(a).size === a.length, "each client once").optional(),
    note: text(300).optional(),
  }).strict(),
  faq: z.object({ type: z.literal("faq"), ...head, items: Faq.shape.items }).strict(),
  cta: z.object({ type: z.literal("cta"), id: Id.optional(), title: text(120).optional(), body: text(300).optional(), primary_cta: Cta.optional(), secondary_cta: Cta.optional() }).strict(),
} as const;

export type Section = { [K in SectionType]: z.infer<(typeof SECTION_SCHEMAS)[K]> }[SectionType];
export type SectionOf<K extends SectionType> = z.infer<(typeof SECTION_SCHEMAS)[K]>;

/** The block a build shows (what gen-packs writes): sections (absent: the whole wireframe, neutral), footer, seo. */
export interface Landing {
  sections?: Section[]; header?: z.infer<typeof Header>; footer?: z.infer<typeof Footer>; seo?: z.infer<typeof Seo>;
  request_page?: z.infer<typeof RequestPage>;
}

/** Each section's anchor when it names none (a second call to action gets -2, a third -3). */
export const DEFAULT_IDS: Record<SectionType, string> = {
  hero: "intro", problem: "problem", concept: "overview", how_it_works: "how-it-works", proof: "what-you-get",
  where_you_work: "where-you-work", faq: "faq", cta: "get-started",
};

/** Every section's anchor, in order: its own id, else its type's (numbered for a repeated call to action). */
export function sectionIds(sections: readonly { type: string; id?: string }[]): string[] {
  const seen: Record<string, number> = {};
  return sections.map((s) => {
    if (s.id) return s.id;
    const base = DEFAULT_IDS[s.type as SectionType] ?? s.type;
    seen[base] = (seen[base] ?? 0) + 1;
    return seen[base] === 1 ? base : `${base}-${seen[base]}`;
  });
}

const NewSchema = z.object({
  $comment: z.string().max(2000).optional(),
  sections: z.array(z.unknown()).min(1, "at least one section (leave sections out for the whole wireframe)").max(MAX_SECTIONS, `at most ${MAX_SECTIONS} sections`).optional(),
  header: Header.optional(),
  footer: Footer.optional(),
  seo: Seo.optional(),
  request_page: RequestPage.optional(),
}).strict();

interface Issue { path: (string | number)[]; message: string }
const issuesOf = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }, prefix: (string | number)[] = []): Issue[] =>
  r.success ? [] : r.error!.issues.map((i) => ({ path: [...prefix, ...(i.path as (string | number)[])], message: i.message }));

/** Whether a block is the old shape (mold_v0-091): a section key at the top level and no `sections`. */
export const isLegacy = (json: unknown): boolean =>
  !!json && typeof json === "object" && !Array.isArray(json) && !("sections" in json) && LEGACY_PAGE_KEYS.some((k) => k in (json as object));

function landingIssues(json: unknown): Issue[] {
  if (!json || typeof json !== "object" || Array.isArray(json)) return [{ path: [], message: "an object: {sections: [{type, ...}], footer, seo}" }];
  const o = json as Record<string, unknown>;
  if ("sections" in o) {
    const mixed = LEGACY_PAGE_KEYS.filter((k) => k in o);
    if (mixed.length) return [{ path: [], message: `${mixed.join(", ")} beside sections: an old-style block (mold_v0-091) and sections cannot be mixed; put each into sections as {"type": ...} (coverage is the hero's strip, value_points a concept's items, features proof's items, closing a cta)` }];
  }
  if (isLegacy(o)) return issuesOf(LegacySchema.safeParse(o));
  const top = issuesOf(NewSchema.safeParse(o));
  if (top.length || !Array.isArray(o.sections)) return top;
  const out: Issue[] = [];
  const count: Record<string, number> = {};
  o.sections.forEach((s, i) => {
    const t = s && typeof s === "object" && !Array.isArray(s) ? (s as { type?: unknown }).type : undefined;
    if (typeof t !== "string" || !(SECTION_TYPES as readonly string[]).includes(t)) {
      out.push({ path: ["sections", i, "type"], message: `one of ${SECTION_TYPES.join(", ")}` });
      return;
    }
    out.push(...issuesOf(SECTION_SCHEMAS[t as SectionType].safeParse(s), ["sections", i]));
    count[t] = (count[t] ?? 0) + 1;
    if (t === "cta" ? count[t] === MAX_CTAS + 1 : count[t] === 2) out.push({ path: ["sections", i], message: t === "cta" ? `at most ${MAX_CTAS} cta sections` : `a page shows ${t} once: pick it once` });
    if (t === "hero" && i > 0) out.push({ path: ["sections", i], message: "the hero is the first section when a page picks it" });
  });
  if (!out.length) {
    const ids = sectionIds(o.sections as { type: string; id?: string }[]);
    ids.forEach((id, i) => { if (ids.indexOf(id) !== i) out.push({ path: ["sections", i, "id"], message: `the anchor ${id} is another section's: give each its own id` }); });
  }
  return out;
}

const where = (path: readonly PropertyKey[]) => path.reduce<string>((s, p) => (typeof p === "number" ? `${s}[${p}]` : s ? `${s}.${String(p)}` : String(p)), "");

/** Every problem of a landing block as "landing.path: message"; [] when it is well formed (either shape). */
export function landingProblems(json: unknown): string[] {
  return landingIssues(json).map((i) => `landing${i.path.length ? "." : ""}${where(i.path)}: ${i.message}`);
}

/** The block's check for pack.json (src/pack-manifest.ts): each problem at its path under `landing`. */
export const LandingSchema = z.unknown().superRefine((v, ctx) => {
  for (const i of landingIssues(v)) ctx.addIssue({ code: "custom", message: i.message, path: i.path });
});

/**
 * The block's shape for pack.json's JSON Schema (packs/pack.schema.json, editors' completion): sections as a list of the
 * section types, or the old block. The build checks with landingProblems, which also counts the types and the anchors.
 */
export const LandingDocSchema = z.union([
  NewSchema.extend({ sections: z.array(z.discriminatedUnion("type", Object.values(SECTION_SCHEMAS) as unknown as [z.ZodObject, ...z.ZodObject[]])).min(1).max(MAX_SECTIONS).optional() }),
  LegacySchema,
]);

/** An old block (checked) as sections: the page it showed, section for section. footer and seo stay beside them. */
export function toSections(old: LegacyLanding, opts: { hero?: "always" | "named" } = {}): Landing {
  const s: Section[] = [];
  // The old page always opened with a hero (the profile's words where the block left it out); coverage was its badges.
  // ("named": only when the block names one, for an old profile block that replaces a pack's sections one by one.)
  if (opts.hero !== "named" || old.hero || old.coverage) s.push({ type: "hero", ...(old.hero ?? {}), ...(old.coverage ? { strip: old.coverage } : {}) });
  if (old.value_points) s.push({ type: "concept", ...(old.value_points.title ? { title: old.value_points.title } : {}), items: old.value_points.items });
  if (old.how_it_works) s.push({ type: "how_it_works", ...old.how_it_works });
  if (old.features) s.push({ type: "proof", ...(old.features.title ? { title: old.features.title } : {}), ...(old.features.intro ? { lead: old.features.intro } : {}), items: old.features.items });
  if (old.faq) s.push({ type: "faq", ...old.faq });
  if (old.closing) s.push({ type: "cta", ...old.closing });
  return { sections: s, ...(old.footer ? { footer: old.footer } : {}), ...(old.seo ? { seo: old.seo } : {}) };
}

const strip = (b: object): Record<string, unknown> => { const { $comment: _c, ...rest } = b as Record<string, unknown>; return rest; };
const asNew = (b: object | null | undefined): Landing | null => (!b ? null : isLegacy(b) ? toSections(strip(b) as LegacyLanding) : (strip(b) as Landing));

/**
 * The block a build shows: the pack's, with the app profile's over it, always as sections. A profile's `sections`
 * replace the pack's (the app picks); its header, footer, seo and request_page replace the pack's one by one. An old-style profile block
 * replaces the pack's sections of the same kind one by one, as it did before (over an old pack block: merged as before,
 * then converted). null when neither declares one. Both must have been checked (landingProblems) first. `$comment` is dropped.
 */
export function mergeLanding(fromPack: object | null | undefined, fromProfile: object | null | undefined): Landing | null {
  if (!fromPack && !fromProfile) return null;
  if (fromPack && fromProfile && isLegacy(fromPack) && isLegacy(fromProfile)) {
    const out: Record<string, unknown> = {};
    for (const k of LEGACY_SECTIONS) {
      const v = (fromProfile as Record<string, unknown>)[k] ?? (fromPack as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = v;
    }
    return toSections(out as LegacyLanding);
  }
  const pack = asNew(fromPack);
  const oldOverNew = !!(fromProfile && isLegacy(fromProfile) && pack?.sections);
  const prof = oldOverNew ? toSections(strip(fromProfile!) as LegacyLanding, { hero: "named" }) : asNew(fromProfile);
  let sections = pack?.sections;
  if (oldOverNew && prof?.sections && sections) {
    // Old-style over new: each of the profile's sections replaces the pack's of its type, or joins in wireframe order.
    const next = [...sections];
    for (const s of prof.sections) {
      const at = next.findIndex((x) => x.type === s.type);
      if (at >= 0) next[at] = s;
      else {
        const rank = SECTION_TYPES.indexOf(s.type);
        const before = next.findIndex((x) => SECTION_TYPES.indexOf(x.type) > rank);
        next.splice(before < 0 ? next.length : before, 0, s);
      }
    }
    sections = next;
  } else if (prof?.sections) sections = prof.sections;
  const header = prof?.header ?? pack?.header, footer = prof?.footer ?? pack?.footer, seo = prof?.seo ?? pack?.seo;
  const request_page = prof?.request_page ?? pack?.request_page;
  return { ...(sections ? { sections } : {}), ...(header ? { header } : {}), ...(footer ? { footer } : {}), ...(seo ? { seo } : {}), ...(request_page ? { request_page } : {}) };
}
