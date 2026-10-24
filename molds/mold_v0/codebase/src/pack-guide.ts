/**
 * A declarative pack's customer guide (mold_v0-106): pack.json `guide`, the pages /app/docs shows and the docs answers
 * (Ask AI, src/docs-answers.ts) cite, written by the pack instead of as console code. A host pack's guide stays its own
 * code (web/src/packs/<id>/guide.ts, mold_v0-039); a host pack may not declare `guide`.
 *
 *   markdown   the guide inline: one page per `## ` heading (its `### ` subsections become the page's sections), as the
 *              shell's own guide is cut; nothing may stand before the first `## `
 *   dir        or a directory of the pack holding one .md file per page, in file-name order: its first line `# Title`,
 *              then the page (`## ` sections). Flat: .md files only
 *   groups     the navigation's groups, in order: [{ title, pages: [page titles] }]; a page no group names lands in
 *              "Guide". A group may be one the generated pages use ("Getting started", "Reference"): the pages join it
 *   generated  false leaves out the pages generated from the pack's declarations (the console, its records, its runs);
 *              connecting a client, the MCP tools and the account pages stay. Default true
 *
 * Every page is MARKDOWN ONLY, checked by the build (scripts/gen-packs.mjs runs pageProblems on each): no raw HTML
 * (the console would show it as text, the docs answers would quote it), no images, no control or invisible characters,
 * no `# ` title inside a page, and every link a path of this site (/app/records/x), an in-page #anchor, an https://
 * address or a mailto: address (src/landing.ts hrefProblem): never javascript:, data:, http: or //host, which also
 * rules out bare http:// and www. addresses (GitHub-flavoured markdown would link them). Code spans and fenced blocks
 * are free text: they render as code.
 *
 * A pack with no `guide` still gets a guide: the console's web/src/content/customer-guide.ts writes it from the
 * pack's declarations (record areas, tabs, job kinds, schedules, credentials, onboarding, the generated MCP tools and
 * get_started), which gen-packs writes into web/src/config/pack-guides.generated.ts with the hand-written pages.
 */
import { z } from "zod";
import { hrefProblem } from "./landing.js";

/** The ceilings: a guide stays a guide (the host pack's whole guide is about 25,000 characters). */
export const GUIDE_LIMITS = { pages: 40, pageChars: 30_000, totalChars: 200_000, titleChars: 80, groups: 12, groupChars: 40 } as const;
/** The group a page no `groups` entry names lands in. */
export const DEFAULT_GUIDE_GROUP = "Guide";

/** Characters markdown text may not hold: controls (but tab and line feed), zero-width, bidirectional and tag characters, variation selectors. */
const NOT_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;
const TITLE = /^[^[\]`*_<>#|\\{}]+$/;
const title = z.string().trim().min(1).max(GUIDE_LIMITS.titleChars)
  .refine((s) => TITLE.test(s) && !NOT_TEXT.test(s) && !/\n/.test(s), "plain text: no markdown, braces, line breaks, control or invisible characters");

export const GuideSchema = z.object({
  $comment: z.string().max(2000).optional(),
  markdown: z.string().min(1).max(GUIDE_LIMITS.totalChars).optional(),
  dir: z.string().regex(/^[a-z0-9_\-/]+$/i, "dir: a directory inside the pack").refine((p) => !p.split("/").includes("..") && !p.startsWith("/") && !p.endsWith("/"), "dir: a directory inside the pack").optional(),
  groups: z.array(z.object({ title: title.refine((s) => s.length <= GUIDE_LIMITS.groupChars, `at most ${GUIDE_LIMITS.groupChars} characters`), pages: z.array(title).min(1).max(GUIDE_LIMITS.pages) }).strict()).max(GUIDE_LIMITS.groups).optional(),
  generated: z.boolean().optional(),
}).strict()
  .refine((g) => !(g.markdown !== undefined && g.dir !== undefined), "a guide is inline (markdown) or a directory of the pack (dir), not both")
  .refine((g) => g.markdown !== undefined || g.dir !== undefined || g.generated !== false, "a guide with neither markdown nor dir is its generated pages: generated cannot be false");
export type PackGuideJson = z.infer<typeof GuideSchema>;

/** One hand-written page: its title, the anchor-style slug /app/docs/<slug> uses, its navigation group and markdown. */
export interface GuidePageSource { title: string; slug: string; group: string; body: string }

/** As web/src/content/docs-text.ts slugify (the console's page and heading ids). */
export const guideSlug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** The text outside fenced code blocks and code spans (each replaced by spaces, so line numbers stay). */
function prose(md: string): string {
  let fence = "";
  const lines = md.split("\n").map((line) => {
    const f = FENCE.exec(line);
    if (fence) { if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && !line.slice(f[0].length).trim()) fence = ""; return ""; }
    if (f) { fence = f[1]!; return ""; }
    return line;
  });
  return lines.join("\n").replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, (m) => m.replace(/[^\n]/g, " "));
}

/** A link target as the guide may write it: a path of this site, an #anchor of the page, https:// or mailto:. */
export function guideHrefProblem(href: string): string | null {
  if (/^#[A-Za-z0-9_-]{1,100}$/.test(href)) return null;
  return hrefProblem(href);
}

/** Everything wrong with one page's markdown, each "<where>: <problem>". Empty: the page is markdown only, its links safe. */
export function pageProblems(md: string, where: string): string[] {
  const out: string[] = [];
  const bad = (what: string) => out.push(`${where}: ${what}`);
  if (NOT_TEXT.test(md)) bad("control or invisible characters (zero-width, bidirectional, tag characters): markdown text only");
  if (md.length > GUIDE_LIMITS.pageChars) bad(`at most ${GUIDE_LIMITS.pageChars} characters a page`);
  const text = prose(md);
  const lineOf = (i: number) => text.slice(0, i).split("\n").length;
  const html = /<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>]|$)|<!--|<![A-Za-z[]|<\?/m.exec(text);
  if (html) bad(`line ${lineOf(html.index)}: raw HTML (${html[0]}…): write markdown (the console shows HTML as text)`);
  const img = /!\[/.exec(text);
  if (img) bad(`line ${lineOf(img.index)}: an image: a guide is text (describe it, or link to it)`);
  const h1 = /^ {0,3}#(?=[ \t]|$)/m.exec(text);
  if (h1) bad(`line ${lineOf(h1.index)}: a # heading inside a page: the page's title is its heading; use ## for its sections`);
  const hrefs: [number, string][] = [];
  for (const m of text.matchAll(/\]\(\s*(<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))*)/g)) hrefs.push([m.index!, m[1]!.replace(/^<|>$/g, "")]);
  for (const m of text.matchAll(/^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm)) hrefs.push([m.index!, m[1]!.replace(/^<|>$/g, "")]);
  for (const m of text.matchAll(/<([A-Za-z][A-Za-z0-9+.-]*:[^<>\s]*)>/g)) hrefs.push([m.index!, m[1]!]);
  // Bare addresses GitHub-flavoured markdown links by itself: https:// ones are checked, http:// and www. refused.
  const unlinked = text.replace(/\]\(\s*(<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))*)/g, "](").replace(/^( {0,3}\[[^\]\n]+\]:)[ \t]*\S+/gm, "$1").replace(/<[A-Za-z][A-Za-z0-9+.-]*:[^<>\s]*>/g, "");
  for (const m of unlinked.matchAll(/https:\/\/[^\s<>()[\]]+/gi)) hrefs.push([m.index!, m[0].replace(/[.,;:!?'"*_~]+$/, "")]);
  for (const m of unlinked.matchAll(/\bhttp:\/\/|(^|[^\w./@-])www\./gim)) bad(`line ${lineOf(m.index!)}: a bare http:// or www. address: write it as an https:// link`);
  for (const [i, href] of hrefs) {
    if (!href) { bad(`line ${lineOf(i)}: a link with no address`); continue; }
    const p = guideHrefProblem(href);
    if (p) bad(`line ${lineOf(i)}: the link ${JSON.stringify(href.slice(0, 80))}: ${p}`);
  }
  return out;
}

/** The inline guide cut at its `## ` headings (outside fenced code), each page's `### ` becoming `## `. */
function inlinePages(md: string, problems: string[]): { title: string; body: string }[] {
  const pages: { title: string; lines: string[] }[] = [];
  const lead: string[] = [];
  let fence = "";
  for (const line of md.split("\n")) {
    const f = FENCE.exec(line);
    if (fence) { if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && !line.slice(f[0].length).trim()) fence = ""; }
    else if (f) fence = f[1]!;
    else {
      const h = /^## +(.+?)\s*#*\s*$/.exec(line);
      if (h) { pages.push({ title: h[1]!.trim(), lines: [] }); continue; }
    }
    const to = pages.at(-1)?.lines ?? lead;
    to.push(!fence && !f ? line.replace(/^### /, "## ") : line);
  }
  if (lead.join("").trim()) problems.push("guide.markdown: text before the first ## heading: every page starts with its ## title");
  return pages.map((p) => ({ title: p.title, body: p.lines.join("\n").trim() }));
}

/** One page per .md file of the guide's directory, in file-name order: its `# Title` line, then its body. */
function dirPages(dir: string, files: readonly { name: string; text: string }[], problems: string[]): { title: string; body: string }[] {
  return [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).flatMap((f) => {
    const text = f.text.replace(/^\ufeff/, "");
    const m = /^\s*# +(.+?)\s*#*\s*(\n|$)/.exec(text);
    if (!m) { problems.push(`guide ${dir}/${f.name}: its first line is the page's title, as # Title`); return []; }
    return [{ title: m[1]!.trim(), body: text.slice(m[0].length).trim() }];
  });
}

/**
 * A pack's `guide` as pages, checked: the pages (inline markdown or the directory's files, read by gen-packs and given
 * here as {name, text}), each in its group, and every problem. `reserved` holds the titles of the pages the console
 * generates (words filled), which a hand-written page may not take.
 */
export function compileGuide(json: unknown, files: readonly { name: string; text: string }[] | null, reserved: readonly string[] = []): { pages: GuidePageSource[]; groups: string[]; generated: boolean; problems: string[] } {
  const r = GuideSchema.safeParse(json);
  if (!r.success) return { pages: [], groups: [], generated: true, problems: r.error.issues.map((i) => `guide${i.path.length ? `.${i.path.join(".")}` : ""}: ${i.message}`) };
  const g = r.data;
  const problems: string[] = [];
  const raw = g.markdown !== undefined ? inlinePages(g.markdown.replace(/\r\n?/g, "\n"), problems)
    : g.dir !== undefined ? dirPages(g.dir, (files ?? []).map((f) => ({ name: f.name, text: f.text.replace(/\r\n?/g, "\n") })), problems) : [];
  if (g.dir !== undefined && files !== null && !files.length) problems.push(`guide.dir ${g.dir}: no .md pages in it`);
  if (raw.length > GUIDE_LIMITS.pages) problems.push(`guide: at most ${GUIDE_LIMITS.pages} pages (it has ${raw.length})`);
  const total = raw.reduce((n, p) => n + p.title.length + p.body.length, 0);
  if (total > GUIDE_LIMITS.totalChars) problems.push(`guide: at most ${GUIDE_LIMITS.totalChars} characters in all (it has ${total})`);
  const bySlug = new Map<string, string>();
  const reservedSlugs = new Map(reserved.map((t) => [guideSlug(t), t]));
  const grouped = new Map<string, string>();
  for (const grp of g.groups ?? []) for (const t of grp.pages) {
    if (grouped.has(t)) problems.push(`guide.groups: page ${JSON.stringify(t)} is in two groups (${grouped.get(t)} and ${grp.title})`);
    else grouped.set(t, grp.title);
  }
  if (new Set((g.groups ?? []).map((x) => x.title)).size !== (g.groups ?? []).length) problems.push("guide.groups: a group is listed twice");
  const pages: GuidePageSource[] = [];
  for (const p of raw) {
    const where = `guide page ${JSON.stringify(p.title.slice(0, 80))}`;
    const t = title.safeParse(p.title);
    if (!t.success) { problems.push(`${where}: its title: ${t.error.issues[0]!.message}`); continue; }
    const slug = guideSlug(p.title);
    if (!slug) { problems.push(`${where}: its title needs a letter or a digit`); continue; }
    if (bySlug.has(slug)) { problems.push(`${where}: the same page address as ${JSON.stringify(bySlug.get(slug))} (/app/docs/${slug})`); continue; }
    if (reservedSlugs.has(slug)) { problems.push(`${where}: ${JSON.stringify(reservedSlugs.get(slug))} is a page the console writes from the pack's declarations: choose another title`); continue; }
    bySlug.set(slug, p.title);
    if (!p.body) problems.push(`${where}: the page is empty`);
    problems.push(...pageProblems(p.body, where));
    pages.push({ title: p.title, slug, group: grouped.get(p.title) ?? DEFAULT_GUIDE_GROUP, body: p.body });
  }
  for (const t of grouped.keys()) if (!pages.some((p) => p.title === t) && !raw.some((p) => p.title === t)) problems.push(`guide.groups: page ${JSON.stringify(t)} is not a page of the guide`);
  const groups = [...(g.groups ?? []).map((x) => x.title)];
  if (pages.some((p) => p.group === DEFAULT_GUIDE_GROUP) && !groups.includes(DEFAULT_GUIDE_GROUP)) groups.unshift(DEFAULT_GUIDE_GROUP);
  return { pages, groups, generated: g.generated !== false, problems };
}
