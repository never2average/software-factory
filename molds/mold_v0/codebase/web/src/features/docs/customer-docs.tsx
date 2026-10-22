// /app/docs: the customer guide (its text is content/customer-guide.ts), opened from the Docs button at the top right;
// one page per `## ` section of the guide, at /app/docs/<slug of the heading>, grouped in the left navigation by
// PAGE_GROUPS.
import { notFound } from 'next/navigation';
import { Markdown } from '@/components/markdown';
import { CUSTOMER_DOCS_PATH, guidePages, PAGE_GROUPS } from '@/content/customer-guide';
import { DocsLayout } from './docs-layout';
import { markdownHeadings, splitLead, type DocNavGroup } from './docs-data';
// Generated from the MCP server itself (scripts/export-mcp-tools.ts; the smoke test fails when it is stale).
import catalog from '@/content/mcp-tools.generated.json';
import { profile } from '@/config/profile.generated';

const PAGES = guidePages(catalog);
const href = (slug: string) => `${CUSTOMER_DOCS_PATH}/${slug}`;
const NAV: DocNavGroup[] = [...PAGE_GROUPS.map(([g]) => g), 'More']
  .map((g) => ({ title: g, pages: PAGES.filter((p) => p.group === g).map((p) => ({ title: p.title, href: href(p.slug), headings: markdownHeadings(p.body) })) }))
  .filter((g) => g.pages.length);

/** The guide's pages and their headings, for the Cmd+K bar's Docs section (public product docs). */
export const customerDocsNav = () => NAV;

/** The first page: /app/docs opens it. */
export const CUSTOMER_DOCS_HOME = href(PAGES[0].slug);
export const customerDocSlugs = () => PAGES.map((p) => p.slug);
export const findCustomerDoc = (slug: string) => PAGES.find((p) => p.slug === slug);

export function CustomerDocPage({ slug }: { slug: string }) {
  const page = findCustomerDoc(slug);
  if (!page) notFound();
  const { lead, rest } = splitLead(page.body);
  const tools = page.slug === 'mcp-tools';
  return (
    <DocsLayout nav={NAV} title={page.title} headings={markdownHeadings(rest)}
      description={lead ? <Markdown className='text-muted-foreground max-w-none text-lg [&_p]:my-0 [&_p]:leading-relaxed'>{lead}</Markdown> : undefined}
      meta={tools ? <span>Generated from the {profile.name} MCP server: {catalog.tools.length} tools{catalog.prompts.length ? `, ${catalog.prompts.length} slash commands` : ''}.</span> : undefined}>
      <Markdown className='max-w-none'>{rest}</Markdown>
    </DocsLayout>
  );
}
