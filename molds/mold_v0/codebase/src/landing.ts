/**
 * The landing block (mold_v0-091, pick and place since mold_v0-122): an app's public landing page at `/`, declared as
 * settings instead of written as code. A declarative pack declares it in pack.json `landing`; the app's own profile.json
 * `landing` comes over it. At most one pack of a build declares one. scripts/gen-packs.mjs checks both with this module and
 * writes the result, with the build's source offer (src/source-offer.ts) and the AI clients its install pages offer, into
 * web/src/config/landing.generated.ts, which the console's `/` renders (web/src/features/site/landing.tsx) in the build's
 * brand (its name, tagline, mark and theme colours). A host pack's own landing page (code, mold_v0-039) stays its own: the
 * block is for packs that bring no code. A pack never brings a page, a component or a picture for it: every section is
 * the shell's, drawn from the block's words (the operator's rule: app packs are JSON, not pages).
 *
 * PICK AND PLACE. The page is a list of sections, `sections: [{type, ...fields}]`, in the order the app wants them. The
 * section library (one wireframe: a hero with a strip of logos or badges, the problem, the concept, how it works, proof,
 * where you work, questions and a call to action) is the shell's; the app picks which sections it shows, in which order,
 * with which words. With no `sections` the page is the whole wireframe, in that order, in the shell's neutral words.
 *
 *   hero            eyebrow, headline (default: the profile's tagline), subheadline, primary_cta (default: start, which
 *                   is sign-up or a request for access), secondary_cta (default: connect an AI client), up to 3 more
 *                   `links` {label, href} under them (the app's own: its repository, its docs), note, and a
 *                   strip under it: text badges (`items`), or, without items, the logos of the AI clients the build offers
 *   problem         title, lead, up to 4 points {title, body}, a transcript card (`visual`: lines of text, a highlight)
 *                   and a list of options weighed (`compare`: {label, note, tone good|bad|neutral|muted})
 *   concept         title, lead, up to 6 cards {title, subtitle, body, chips (a path drawn as chips), highlight}, note
 *   how_it_works    title, lead, 1 to 6 steps {title, body}, drawn as numbered cards (`layout: steps`), a flow (`flow`,
 *                   the default) or a flow that returns to its first step (`loop`, with `loop_label`)
 *   proof           title, lead, up to 6 metrics {value, label, note} and/or up to 12 items {title, body}, note
 *   where_you_work  title, lead, the AI clients to show (`clients`: ids the build's install pages offer, default the
 *                   first 8 of them), a sample chat (`chat.messages`: {from person|assistant|tool, text}), note
 *   faq             title, lead, 1 to 15 {question, answer}, each a disclosure that opens without script
 *   cta             title, body, primary_cta, secondary_cta (the only type a page may pick more than once, up to 3)
 * Every section but cta may carry `id` (its anchor, a slug) and `nav_label` (its entry in the header's navigation, which
 * lists the picked sections in order); every section but hero and cta an `eyebrow`. Beside `sections`:
 *   footer          a note and up to 8 links (the shell's own links, the legal pages and the source offer are always added)
 *   seo             title and description for search results and link previews (Open Graph); default from the hero
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
const Footer = z.object({ note: text(300).optional(), links: z.array(Cta).max(8).optional() }).strict();
const Seo = z.object({ title: text(70).optional(), description: text(200).optional() }).strict();

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

const head = { id: Id.optional(), nav_label: text(24).optional(), eyebrow: text(60).optional(), title: text(120).optional(), lead: text(600).optional() };

const SECTION_SCHEMAS = {
  hero: z.object({
    type: z.literal("hero"), id: Id.optional(),
    eyebrow: text(80).optional(), headline: text(120).optional(), subheadline: text(300).optional(),
    primary_cta: Cta.optional(), secondary_cta: Cta.optional(), note: text(200).optional(),
    links: z.array(Cta).min(1).max(3).optional(),
    strip: z.object({ title: text(80).optional(), items: z.array(text(40)).min(1).max(30).optional(), note: text(300).optional() }).strict().optional(),
  }).strict(),
  problem: z.object({
    type: z.literal("problem"), ...head,
    points: z.array(Item).min(1).max(4).optional(),
    visual: z.object({ title: text(60).optional(), lines: z.array(text(160)).min(1).max(8), highlight: text(160).optional() }).strict().optional(),
    compare: z.object({
      title: text(60).optional(),
      items: z.array(z.object({ label: text(40), note: text(60).optional(), tone: z.enum(["good", "bad", "neutral", "muted"]).optional() }).strict()).min(1).max(6),
      note: text(200).optional(),
    }).strict().optional(),
  }).strict(),
  concept: z.object({
    type: z.literal("concept"), ...head,
    items: z.array(z.object({
      title: text(80), subtitle: text(80).optional(), body: text(400).optional(),
      chips: z.array(text(30)).min(1).max(6).optional(), highlight: z.boolean().optional(),
    }).strict()).min(1).max(6).optional(),
    note: text(300).optional(),
  }).strict(),
  how_it_works: z.object({
    type: z.literal("how_it_works"), ...head,
    steps: z.array(Item).min(1).max(6),
    layout: z.enum(["steps", "flow", "loop"]).optional(),
    loop_label: text(40).optional(),
  }).strict(),
  proof: z.object({
    type: z.literal("proof"), ...head,
    metrics: z.array(z.object({ value: text(16), label: text(80), note: text(160).optional() }).strict()).min(1).max(6).optional(),
    items: z.array(Item).min(1).max(12).optional(),
    note: text(300).optional(),
  }).strict().refine((s) => s.metrics || s.items, "proof shows metrics, items or both: give at least one"),
  where_you_work: z.object({
    type: z.literal("where_you_work"), ...head,
    clients: z.array(ClientId).min(1).max(12).refine((a) => new Set(a).size === a.length, "each client once").optional(),
    chat: z.object({ messages: z.array(z.object({ from: z.enum(["person", "assistant", "tool"]), text: text(300) }).strict()).min(1).max(6), note: text(120).optional() }).strict().optional(),
    note: text(300).optional(),
  }).strict(),
  faq: z.object({ type: z.literal("faq"), ...head, items: Faq.shape.items }).strict(),
  cta: z.object({ type: z.literal("cta"), id: Id.optional(), title: text(120).optional(), body: text(300).optional(), primary_cta: Cta.optional(), secondary_cta: Cta.optional() }).strict(),
} as const;

export type Section = { [K in SectionType]: z.infer<(typeof SECTION_SCHEMAS)[K]> }[SectionType];
export type SectionOf<K extends SectionType> = z.infer<(typeof SECTION_SCHEMAS)[K]>;

/** The block a build shows (what gen-packs writes): sections (absent: the whole wireframe, neutral), footer, seo. */
export interface Landing { sections?: Section[]; footer?: z.infer<typeof Footer>; seo?: z.infer<typeof Seo> }

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
  footer: Footer.optional(),
  seo: Seo.optional(),
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
 * replace the pack's (the app picks); its footer and seo replace the pack's one by one. An old-style profile block
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
  const footer = prof?.footer ?? pack?.footer, seo = prof?.seo ?? pack?.seo;
  return { ...(sections ? { sections } : {}), ...(footer ? { footer } : {}), ...(seo ? { seo } : {}) };
}
