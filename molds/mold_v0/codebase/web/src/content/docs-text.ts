// Markdown helpers shared by the docs pages (features/docs) and the API's docs corpus (scripts/sync-docs-corpus.ts, for
// the docs answers): no imports, so the API side can load it as is. Anchors here must match components/markdown.tsx.

/** A heading of a page: its anchor id (as components/markdown.tsx renders it), text and level (2 or 3). */
export interface DocHeading { id: string; text: string; depth: 2 | 3 }

/** The same id components/markdown.tsx gives a heading, from its plain text. */
export const slugify = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** A heading's markdown as the text it renders to: links, emphasis, code ticks and escapes dropped. */
export const plainHeading = (md: string) =>
  md.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1').replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(^|\W)[*_](.+?)[*_](?=\W|$)/g, '$1$2').trim();

/** The h2/h3 headings of a markdown page, skipping fenced code. */
export function markdownHeadings(md: string): DocHeading[] {
  const out: DocHeading[] = [];
  let fence = '';
  for (const line of md.split('\n')) {
    const f = line.match(/^\s*(```|~~~)/);
    if (f) { fence = fence ? (fence === f[1] ? '' : fence) : f[1]; continue; }
    if (fence) continue;
    const m = line.match(/^(##|###)\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const text = plainHeading(m[2]);
    out.push({ id: slugify(text), text, depth: m[1].length as 2 | 3 });
  }
  return out;
}

/** A page cut at its h2/h3 headings (fenced code skipped): the text before the first one, then one part per heading. */
export function markdownSections(md: string): { heading: DocHeading | null; body: string }[] {
  const out: { heading: DocHeading | null; body: string[] }[] = [{ heading: null, body: [] }];
  let fence = '';
  for (const line of md.split('\n')) {
    const f = line.match(/^\s*(```|~~~)/);
    if (f) fence = fence ? (fence === f[1] ? '' : fence) : f[1];
    const m = !f && !fence ? line.match(/^(##|###)\s+(.+?)\s*#*\s*$/) : null;
    if (m) {
      const text = plainHeading(m[2]);
      out.push({ heading: { id: slugify(text), text, depth: m[1].length as 2 | 3 }, body: [] });
    } else out[out.length - 1].body.push(line);
  }
  return out.map((s) => ({ heading: s.heading, body: s.body.join('\n').trim() })).filter((s) => s.heading || s.body);
}
