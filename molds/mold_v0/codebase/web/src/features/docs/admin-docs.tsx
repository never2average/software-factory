// /admin/docs: the internal docs (../docs/**/*.md), bundled at build time by scripts/sync-docs.mjs into
// src/content/admin-docs.generated.ts. Server components only: the markdown never ships to the browser as data (the
// navigation's client part gets titles and headings).
import { notFound } from 'next/navigation';
import { Markdown } from '@/components/markdown';
import { ADMIN_DOCS, type AdminDoc } from '@/content/admin-docs.generated';
import { DocsLayout } from './docs-layout';
import { markdownHeadings, splitLead, type DocNavGroup } from './docs-data';
import { adminDocGroup as groupOf, STAFF_GUIDE_SLUG, staffGuideMarkdown, staffGuideShown } from '@/content/staff-guide';
import { adminNav } from '@/config/nav-config';

/** The navigation's groups (content/staff-guide.ts adminDocGroup says which a doc is in), in this order. */
const GROUP_ORDER = ['Guides', 'Architecture', 'Specs', 'Case studies'];

/**
 * Every doc: the shell's and the packs' (sync-docs.mjs), after the staff guide written from the build (mold_v0-170) when
 * none of them is a guide, so Docs opens on how to run the product, never on an engineering document.
 */
const DOCS: AdminDoc[] = (() => {
  if (!staffGuideShown) return ADMIN_DOCS;
  const g = staffGuideMarkdown(adminNav);
  return [{ slug: STAFF_GUIDE_SLUG, path: '', group: '', title: g.title, summary: '', body: g.markdown }, ...ADMIN_DOCS];
})();

const HOME = '/admin/docs';
const href = (d: AdminDoc) => `${HOME}/${d.slug}`;
/** A doc's markdown without its leading `# Title` (the layout shows the title). */
const bodyOf = (d: AdminDoc) => d.body.replace(/^\s*#\s+.+\n/, '');

/** Titles, hrefs and headings only: this is what goes to the browser for the navigation and its filter. */
function nav(): DocNavGroup[] {
  const groups = [...new Set([...GROUP_ORDER, ...DOCS.map(groupOf)])];
  return groups.map((g) => ({
      title: g,
    pages: DOCS.filter((d) => groupOf(d) === g).map((d) => ({ title: d.title, href: href(d), headings: markdownHeadings(bodyOf(d)) }))
  })).filter((g) => g.pages.length);
}

/** /admin/docs has no cover page: it opens the first doc in the navigation. */
export const firstAdminDocHref = () => nav()[0]?.pages[0]?.href ?? HOME;

/** The same, for the Cmd+K bar's Docs section: passed down from the admin layout, so it reaches admins only. */
export const adminDocsNav = () => nav();

export const findAdminDoc = (slug: string): AdminDoc | undefined => DOCS.find((d) => d.slug === slug);

/** A relative link between docs (e.g. `journeys.md`, `../beta-guide.md`) opens that doc here; other repo paths render as text. */
function resolver(doc: AdminDoc) {
  return (href: string): string | null => {
    // The staff guide links to the console's own pages (/admin/…, /app/…): kept as they are.
    if (!doc.path && /^\/(admin|app)(\/|$)/.test(href)) return href;
    const [file, hash] = href.split('#');
    if (!file) return hash ? `#${hash}` : null;
    const parts = doc.path.split('/').slice(0, -1);
    for (const seg of file.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg && seg !== '.') parts.push(seg);
    }
    const target = ADMIN_DOCS.find((d) => d.path === parts.join('/'));
    return target ? `/admin/docs/${target.slug}${hash ? `#${hash}` : ''}` : null;
  };
}

export function AdminDocPage({ slug }: { slug: string }) {
  const doc = findAdminDoc(slug);
  if (!doc) notFound();
  const { lead, rest } = splitLead(bodyOf(doc));
  const resolve = resolver(doc);
  return (
    <DocsLayout nav={nav()} title={doc.title} headings={markdownHeadings(rest)}
      description={lead ? <Markdown resolveHref={resolve} className='text-muted-foreground max-w-none text-lg [&_p]:my-0 [&_p]:leading-relaxed'>{lead}</Markdown> : undefined}
      meta={doc.path ? <span>Source: <code className='font-mono'>docs/{doc.path}</code></span> : <span>Written from this build: its pages, record areas and customer guide.</span>}>
      <Markdown resolveHref={resolve} className='max-w-none'>{rest}</Markdown>
    </DocsLayout>
  );
}
