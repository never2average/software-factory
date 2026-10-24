/**
 * The legal pages (mold_v0-109): an app's Terms and Privacy pages and the links to them, from profile.json `legal`.
 * Pure, no imports, so the server (the install pages' footer), the console (web/src/features/site/legal.tsx, through
 * the generated copy below) and scripts/gen-packs.mjs (node strips the types) all run the same rules.
 *
 *   "legal": {
 *     "company_name":   "Acme Ltd",              the company that offers the app (its legal name), required
 *     "contact_email":  "legal@acme.example",    where people write about the terms and their data, required
 *     "effective_date": "2026-10-23",            when these terms take effect (YYYY-MM-DD), required
 *     "jurisdiction":   "England and Wales",     whose law governs the terms, optional (absent: not said)
 *     "terms_url":      "https://acme.example/terms",     optional: the company's own terms, which then win
 *     "privacy_url":    "https://acme.example/privacy"    optional: the company's own privacy notice, which then wins
 *   }
 *
 * With `legal` set, the console serves /terms and /privacy (the shell's neutral template in the build's words, the
 * company's facts filled in; a page whose own URL is set redirects there instead), and the landing page's footer, the
 * sign-in and sign-up pages and the install pages link to them. Without it there are no legal pages and no links: the
 * shell never publishes terms nobody agreed to. Only the app's own profile.json sets it (never a host pack's profile).
 *
 * Every text is plain text on one line (no control or invisible characters), shown as text. An own URL is an https://
 * address with a host and no user name or password. scripts/gen-packs.mjs refuses a build whose `legal` breaks a rule,
 * and writes the checked block to src/legal.generated.ts and web/src/config/legal.generated.ts, never into the profile
 * modules (so the MCP surface and the console's names are unchanged by it).
 */

export interface Legal {
  company_name: string;
  contact_email: string;
  effective_date: string;
  jurisdiction?: string;
  terms_url?: string;
  privacy_url?: string;
}

export const LEGAL_KEYS = ["company_name", "contact_email", "effective_date", "jurisdiction", "terms_url", "privacy_url"] as const;
const REQUIRED = ["company_name", "contact_email", "effective_date"] as const;

/** Characters a plain-text line may not hold (the landing block's rule, src/landing.ts NOT_PLAIN). */
const NOT_PLAIN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;
/** One email address (src/email.ts ADDRESS), and no character a mailto: link or a page could misread. */
const ADDRESS = /^[^\s@<>,;"'`\\/?#%&:]+@[^\s@<>,;"'`\\/?#%&:]+\.[^\s@<>,;"'`\\/?#%&:]+$/;

const textProblem = (v: unknown, max: number): string | null =>
  typeof v !== "string" || !v.trim() ? "text is required"
    : v.length > max ? `at most ${max} characters`
      : NOT_PLAIN.test(v) || /[<>{}[\]]/.test(v) ? "plain text on one line: no line breaks, control or invisible characters, angle brackets, braces or square brackets"
        : null;

/** An own page's address: https:// with a host, printable ASCII, no user name or password, no quotes or brackets. */
export function legalUrlProblem(v: unknown): string | null {
  if (typeof v !== "string" || !v) return "an https:// address is required";
  if (v.length > 500) return "at most 500 characters";
  if (!/^https:\/\//i.test(v) || !/^[!-~]+$/.test(v) || /["'<>\\`]/.test(v)) return "an https:// address (printable, no spaces, quotes, angle brackets or backslashes)";
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname && !u.username && !u.password ? null : "an https:// address with a host and no user name or password";
  } catch { return "not a valid https:// address"; }
}

/** A date YYYY-MM-DD that exists on the calendar. */
export function dateProblem(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return "a date written YYYY-MM-DD";
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? "a date that exists (YYYY-MM-DD)" : null;
}

/** Every problem of a `legal` block as "legal.<field>: message"; [] when it is well formed. */
export function legalProblems(v: unknown): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["legal: an object with company_name, contact_email and effective_date (and optionally jurisdiction, terms_url, privacy_url)"];
  const o = v as Record<string, unknown>, out: string[] = [];
  for (const k of Object.keys(o)) if (k !== "$comment" && !(LEGAL_KEYS as readonly string[]).includes(k)) out.push(`legal.${k}: not a legal field (known: ${LEGAL_KEYS.join(", ")})`);
  for (const k of REQUIRED) if (o[k] === undefined) out.push(`legal.${k}: required`);
  const at = (k: string, p: string | null) => { if (p) out.push(`legal.${k}: ${p}`); };
  if (o.$comment !== undefined && (typeof o.$comment !== "string" || o.$comment.length > 2000)) at("$comment", "text of up to 2000 characters");
  if (o.company_name !== undefined) at("company_name", textProblem(o.company_name, 160));
  if (o.contact_email !== undefined) at("contact_email", typeof o.contact_email === "string" && o.contact_email.length <= 254 && ADDRESS.test(o.contact_email) ? null : "one email address, like legal@yourcompany.com");
  if (o.effective_date !== undefined) at("effective_date", dateProblem(o.effective_date));
  if (o.jurisdiction !== undefined) at("jurisdiction", textProblem(o.jurisdiction, 120));
  if (o.terms_url !== undefined) at("terms_url", legalUrlProblem(o.terms_url));
  if (o.privacy_url !== undefined) at("privacy_url", legalUrlProblem(o.privacy_url));
  return out;
}

/** The checked block as the build carries it: the known fields only, texts trimmed. Call legalProblems first. */
export function legalOf(v: unknown): Legal | null {
  if (!v || typeof v !== "object" || legalProblems(v).length) return null;
  const o = v as Record<string, string>;
  const out: Record<string, string> = {};
  for (const k of LEGAL_KEYS) if (typeof o[k] === "string") out[k] = o[k].trim();
  return out as unknown as Legal;
}

/** The two legal pages, their paths on the console and the field of a company's own address that replaces them. */
export const LEGAL_PAGES = [
  { kind: "terms", label: "Terms", path: "/terms", own: "terms_url" },
  { kind: "privacy", label: "Privacy", path: "/privacy", own: "privacy_url" },
] as const;

/** The links the public pages show: Terms and Privacy, each the company's own address when set, else the console's page. [] without `legal`. */
export function legalLinks(legal: Legal | null): { label: string; href: string }[] {
  if (!legal) return [];
  return LEGAL_PAGES.map((p) => ({ label: p.label, href: legal[p.own] ?? p.path }));
}

/** The console's own legal pages a sitemap lists: those whose own address is not set. */
export function ownLegalPaths(legal: Legal | null): string[] {
  if (!legal) return [];
  return LEGAL_PAGES.filter((p) => !legal[p.own]).map((p) => p.path);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The install pages' footer line (server-rendered HTML): Terms · Privacy, or "" without `legal`. */
export function legalFooterHtml(legal: Legal | null): string {
  const links = legalLinks(legal);
  if (!links.length) return "";
  return `<nav class="muted" aria-label="Legal"><p>${links.map((l) => `<a href="${esc(l.href)}"${l.href.startsWith("/") ? "" : ' rel="noopener noreferrer"'}>${esc(l.label)}</a>`).join(" · ")}</p></nav>`;
}
