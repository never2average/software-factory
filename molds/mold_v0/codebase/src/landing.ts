/**
 * The landing block (mold_v0-091): an app's public landing page at `/`, declared as settings instead of written as code.
 * A declarative pack declares it in pack.json `landing`; the app's own profile.json `landing` comes over it, section by
 * section (a section the profile names replaces the pack's whole section; one it leaves out keeps the pack's). At most one
 * pack of a build declares one. scripts/gen-packs.mjs checks both with this schema and writes the result, with the build's
 * source offer (src/source-offer.ts), into web/src/config/landing.generated.ts, which the console's `/` renders
 * (web/src/features/site/landing.tsx) in the build's brand (its name, tagline, mark and theme colours). With no block the
 * same page renders the shell's neutral one from the profile's words. A host pack's own landing page (code, mold_v0-039)
 * stays its own: the block is for packs that bring no code.
 *
 * Every value is PLAIN TEXT, shown as text (React escapes it; nothing is parsed as HTML or Markdown), on one line, with no
 * control or invisible characters (bidirectional overrides, zero-width and tag characters are refused). A link's address
 * is a path of this site (`/install`, `/auth/sign-up`), an https:// address or a mailto: address: never javascript:,
 * data: or a protocol-relative `//host`. Every list and every text has a ceiling, so a block cannot make the page unusable.
 *
 * Sections, all optional, in the order the page shows them:
 *   hero          eyebrow, headline (default: the profile's name), subheadline (default: its tagline), primary_cta
 *                 (default: create an account), secondary_cta (default: connect an MCP client), note
 *   coverage      a row of text badges (e.g. the regulators or standards the product covers), a title and a note
 *   value_points  up to 6 {title, body}
 *   how_it_works  up to 6 steps {title, body}, numbered
 *   features      a grid of up to 12 {title, body}
 *   faq           up to 15 {question, answer}, each a disclosure that opens without script
 *   closing       a last call to action: title, body, primary_cta, secondary_cta
 *   footer        a note and up to 8 links (the source offer and the shell's own links are always added)
 *   seo           title and description for search results and link previews (Open Graph); default from the hero
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

export const LandingSchema = z.object({
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
  faq: z.object({ title: text(120).optional(), items: z.array(z.object({ question: text(200), answer: text(1200) }).strict()).min(1).max(15) }).strict().optional(),
  closing: z.object({ title: text(120), body: text(300).optional(), primary_cta: Cta.optional(), secondary_cta: Cta.optional() }).strict().optional(),
  footer: z.object({ note: text(300).optional(), links: z.array(Cta).max(8).optional() }).strict().optional(),
  seo: z.object({ title: text(70).optional(), description: text(200).optional() }).strict().optional(),
}).strict();
export type Landing = z.infer<typeof LandingSchema>;

/** The sections, in page order (also the keys a profile's block replaces one by one). */
export const LANDING_SECTIONS = ["hero", "coverage", "value_points", "how_it_works", "features", "faq", "closing", "footer", "seo"] as const;

const where = (path: readonly PropertyKey[]) => path.reduce<string>((s, p) => (typeof p === "number" ? `${s}[${p}]` : s ? `${s}.${String(p)}` : String(p)), "");

/** Every problem of a landing block as "landing.path: message"; [] when it is well formed. */
export function landingProblems(json: unknown): string[] {
  const r = LandingSchema.safeParse(json);
  return r.success ? [] : r.error.issues.map((i) => `landing${i.path.length ? "." : ""}${where(i.path)}: ${i.message}`);
}

/**
 * The block a build shows: the pack's, with the app profile's sections over it (a section the profile names replaces the
 * pack's). null when neither declares one. Both must have been checked (landingProblems) first. `$comment` is dropped.
 */
export function mergeLanding(fromPack: Landing | null | undefined, fromProfile: Landing | null | undefined): Landing | null {
  if (!fromPack && !fromProfile) return null;
  const out: Record<string, unknown> = {};
  for (const k of LANDING_SECTIONS) {
    const v = fromProfile?.[k] ?? fromPack?.[k];
    if (v !== undefined) out[k] = v;
  }
  return out as Landing;
}
