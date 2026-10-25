/**
 * A pack's staff docs (mold_v0-139): pack.json `staff_docs`, the internal pages /admin/docs shows platform staff and the
 * staff docs answers (Ask AI) cite, beside the shell's own docs/*.md. A host pack kept them as files (packs/<id>/docs)
 * until mold_v0-139; a pack is its pack.json, so they are inline now, as the customer guide is (mold_v0-124).
 *
 *   path      where the doc sits among the shell's docs/ ("onboarding.md", "case-studies/resend.md"): its address is
 *             /admin/docs/<path without .md, / as -> and its first folder its group, as a file of docs/ would be
 *   title     the doc's title (plain text): its body is `# <title>`, a blank line, then the markdown
 *   markdown  the doc, markdown (src/pack-guide.ts pageProblems with the staff rules: no images, control or invisible
 *             characters, `# ` headings or unsafe links; HTML shows as text, and a relative link to another doc opens it)
 *
 * Read by web/scripts/sync-docs.mjs (/admin/docs) and scripts/sync-docs-corpus.ts (the docs answers' corpus) straight
 * from each pack's pack.json under packs/, checked by scripts/gen-packs.mjs: no two docs (nor a doc and a file of the
 * shell's docs/) at one path.
 */
import { z } from "zod";
import { pageProblems } from "./pack-guide.js";

export const STAFF_DOC_LIMITS = { docs: 60, pathChars: 120, titleChars: 120, docChars: 60_000 } as const;

/** A doc's path: lowercase folders and a name ending .md, as the shell's docs/ files are named. */
const PATH = /^(?:[a-z0-9][a-z0-9_-]*\/){0,3}[a-z0-9][a-z0-9_.-]*\.md$/;
const NOT_TITLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;

export const StaffDocSchema = z.object({
  path: z.string().max(STAFF_DOC_LIMITS.pathChars).regex(PATH, "a path like onboarding.md or case-studies/resend.md: lowercase letters, digits, - and _, at most 3 folders, ending .md")
    .refine((p) => !p.split("/").some((s) => s.startsWith(".") || s.includes("..")), "no hidden or parent segments"),
  title: z.string().trim().min(1).max(STAFF_DOC_LIMITS.titleChars).refine((s) => !NOT_TITLE.test(s), "plain text: no line breaks, control or invisible characters"),
  markdown: z.string().min(1).max(STAFF_DOC_LIMITS.docChars),
}).strict();
export const StaffDocsSchema = z.array(StaffDocSchema).max(STAFF_DOC_LIMITS.docs);
export type StaffDoc = z.infer<typeof StaffDocSchema>;

/** A doc's body as /admin/docs renders it and the corpus cuts it: its title as the `# ` heading, then its markdown. */
export const staffDocBody = (d: { title: string; markdown: string }) => `# ${d.title}\n\n${d.markdown}`;

/** Everything wrong with a pack's staff_docs beyond their shape, each "staff_docs[<path>]: <problem>". */
export function staffDocProblems(docs: readonly StaffDoc[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of docs) {
    const where = `staff_docs[${d.path}]`;
    if (seen.has(d.path)) out.push(`${where}: two docs at one path`);
    seen.add(d.path);
    // /admin/docs shows HTML as text and opens relative links between docs (src/pack-guide.ts PageRules).
    out.push(...pageProblems(d.markdown, where, { html: true, relative: true, maxChars: STAFF_DOC_LIMITS.docChars }));
  }
  return out;
}
