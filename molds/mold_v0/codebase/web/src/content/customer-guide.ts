// The customer guide (/app/docs) as plain data: its markdown, cut into pages and grouped for the navigation. A host pack
// (mold_v0-039) brings its product's own guide (web/src/packs/<id>/guide.ts, listed in src/config/pack-guides.generated.ts),
// which replaces this one; with zero packs this is the shell's short guide in the profile's words. Pure TS with relative
// imports only: the pages (features/docs/customer-docs.tsx) render it, and the API's docs corpus for the docs answers
// (scripts/sync-docs-corpus.ts -> src/docs-corpus.generated.json) reads the same text. The tool catalog
// (mcp-tools.generated.json) and the profile's name are passed in, so neither side needs a JSON import here.
import { slugify } from './docs-text';
import { HOST_GUIDES } from '../config/pack-guides.generated';
import { profile } from '../config/profile.generated';

/** Member API keys (mold_v0-099, profile `member_keys`): off, every client signs in and the guide names no key. */
const keysOff = (profile as Readonly<Record<string, unknown>>).member_keys === false;

/** scripts/export-mcp-tools.ts's output: the customer server's tools and slash commands. */
export interface ToolCatalog {
  tools: { name: string; title: string | null; summary: string; read_only: boolean }[];
  prompts: { name: string; summary: string }[];
}

/** Where the guide's pages live: /app/docs/<slug>. */
export const CUSTOMER_DOCS_PATH = '/app/docs';

export interface GuidePage { slug: string; title: string; group: string; body: string }

/** A host pack's guide: its navigation groups and its pages. */
export interface HostGuide { PAGE_GROUPS: [string, string[]][]; guidePages(catalog: ToolCatalog): GuidePage[] }

const cell = (s: string) => s.replace(/\|/g, '\\|');
const shellMarkdown = (catalog: ToolCatalog) => `
## Getting started

Connect your AI client to this workspace's MCP server from the **Setup & training** page: pick your client, follow its
one step, then press **Test my connection**. ${keysOff ? 'Every client signs in with your account (OAuth): there is no key to copy.' : `Clients that sign in (OAuth) need no key; the others send an API key in a
header, never in a URL.`} The public install pages at \`/install\` show every client's setup.

## MCP tools

${catalog.tools.length
    ? `| Tool | What it does |\n|---|---|\n${catalog.tools.map((t) => `| \`${t.name}\` | ${cell(t.summary)} |`).join('\n')}`
    : 'This workspace offers no tools yet: they come with the products installed in it.'}

## Your account

**Team** lists the account's people and their roles (owner, billing manager, member, viewer). **Usage** shows tool calls
and spend; **Billing** the plan and this month's model spend against its allowance.
`;
const SHELL_GROUPS: [string, string[]][] = [['Getting started', ['Getting started']], ['Reference', ['MCP tools']], ['Account', ['Your account']]];

function pagesOf(md: string, groups: [string, string[]][]): GuidePage[] {
  const grouped = new Map(groups.flatMap(([g, titles]) => titles.map((t) => [t, g] as const)));
  const sections = md.split(/^## /m).slice(1).map((chunk) => {
    const nl = chunk.indexOf('\n');
    const title = chunk.slice(0, nl).trim();
    return { slug: slugify(title), title, group: grouped.get(title) ?? 'More', body: chunk.slice(nl + 1).replace(/^### /gm, '## ').trim() };
  });
  return [...groups.map(([g]) => g), 'More'].flatMap((g) => sections.filter((p) => p.group === g));
}

const host = (HOST_GUIDES as readonly HostGuide[])[0] ?? null;

/** The left navigation's groups, by section title. A section no group names lands in "More". */
export const PAGE_GROUPS: [string, string[]][] = host ? host.PAGE_GROUPS : SHELL_GROUPS;

/** The guide cut at its `## ` headings, one page each; a page's `### ` subsections become its `## ` sections. */
export function guidePages(catalog: ToolCatalog): GuidePage[] {
  return host ? host.guidePages(catalog) : pagesOf(shellMarkdown(catalog), SHELL_GROUPS);
}
