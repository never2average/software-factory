// Shapes and helpers shared by the docs layout (server) and its navigation / table of contents (client). Only these
// small structures (titles, hrefs, headings) ever reach the browser as props; a page's markdown body never does.
// The markdown helpers live in content/docs-text.ts, which the API's docs corpus (scripts/sync-docs-corpus.ts) uses too.
import type { DocHeading } from '@/content/docs-text';
export { markdownHeadings, plainHeading, slugify, type DocHeading } from '@/content/docs-text';

export interface DocNavPage { title: string; href: string; headings: DocHeading[] }
export interface DocNavGroup { title: string; pages: DocNavPage[] }

/**
 * A page's opening paragraph, to show under its title as the summary, and the rest of the body. A paragraph that
 * introduces what follows (ends in ":") stays in the body, as does anything that is not plain prose.
 */
export function splitLead(md: string): { lead: string; rest: string } {
  const body = md.replace(/^\s+/, '');
  const end = body.search(/\n\s*\n/);
  const first = (end < 0 ? body : body.slice(0, end)).trim();
  const rest = end < 0 ? '' : body.slice(end);
  // A page that is one paragraph keeps it as its body.
  if (!first || !rest.trim() || /^([#>|`~<-]|\d+\.\s|[*+]\s|!\[)/.test(first) || first.endsWith(':')) return { lead: '', rest: md };
  return { lead: first, rest };
}
