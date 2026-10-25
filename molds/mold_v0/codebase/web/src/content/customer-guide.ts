// The customer guide (/app/docs) as plain data: its markdown, cut into pages and grouped for the navigation. A host pack
// (mold_v0-039) brings its product's own guide, which replaces this one: its pack.json `guide` (mold_v0-139; it was its
// code, web/src/packs/<id>/guide.ts), written by gen-packs into src/config/pack-guides.generated.ts HOST_GUIDE; other packs
// (mold_v0-106) get their own pages (pack.json `guide`) and the pages written from their declarations (./pack-guide.ts,
// from PACK_GUIDE); with zero packs this is the shell's short guide in the profile's words. Pure TS with relative
// imports only: the pages (features/docs/customer-docs.tsx) render it, and the API's docs corpus for the docs answers
// (scripts/sync-docs-corpus.ts -> src/docs-corpus.generated.json) reads the same text. The tool catalog
// (mcp-tools.generated.json) and the profile's name are passed in, so neither side needs a JSON import here.
import { slugify } from './docs-text';
import { HOST_GUIDE, PACK_GUIDE } from '../config/pack-guides.generated';
import { packGuide, PROMPTS_INTRO, type PackGuideData } from './pack-guide';
import { profile } from '../config/profile.generated';
import { fill } from '../lib/vocabulary';

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

/**
 * A host pack's guide (mold_v0-139, scripts/gen-packs.mjs from its pack.json `guide`, checked by src/pack-guide.ts): the
 * whole guide. Its pages in its groups' order, and the groups of its MCP tools page (the page titled `tools_title`).
 */
export interface HostGuideData {
  pack: string;
  tools_title: string;
  groups: string[];
  pages: { title: string; slug: string; group: string; body: string }[];
  tool_groups: [string, string[]][];
  /** The line before the slash commands' list (pack.json guide.prompts_intro), or null: the shell's. */
  prompts_intro: string | null;
}

const cell = (s: string) => s.replace(/\|/g, '\\|');
/** Connecting a client: the shell's Getting started page, and the generated guide's (./pack-guide.ts) first section. */
const connectText = (setupPage: string) => `Connect your AI client to this ${fill('{workspace}')}'s MCP server from the **${setupPage}** page: pick your client, follow its
one step, then press **Test my connection**. ${keysOff ? 'Every client signs in with your account (OAuth): there is no key to copy.' : `Clients that sign in (OAuth) need no key; the others send an API key in a
header, never in a URL.`} The public install pages at \`/install\` show every client's setup.`;
const ACCOUNT_TEXT = `**Team** lists the account's people and their roles (owner, billing manager, member, viewer). **Usage** shows tool calls
and spend; **Billing** the plan and this month's model spend against its allowance.`;
const shellMarkdown = (catalog: ToolCatalog) => `
## Getting started

${connectText('Setup & training')}

## MCP tools

${catalog.tools.length
    ? `| Tool | What it does |\n|---|---|\n${catalog.tools.map((t) => `| \`${t.name}\` | ${cell(t.summary)} |`).join('\n')}`
    : 'This workspace offers no tools yet: they come with the products installed in it.'}

## Your account

${ACCOUNT_TEXT}
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

/**
 * A host guide's tools section: each of its tool groups (the tools the build has, in the order listed), then "More
 * tools" (the rest, in the client's order), then the slash commands.
 */
function groupedToolsMarkdown(toolGroups: [string, string[]][], promptsIntro: string | null, catalog: ToolCatalog): string {
  const byName = new Map(catalog.tools.map((t) => [t.name, t]));
  const grouped = new Set(toolGroups.flatMap(([, names]) => names));
  const groups: [string, string[]][] = [...toolGroups.map(([g, names]) => [g, names.filter((n) => byName.has(n))] as [string, string[]]),
    ['More tools', catalog.tools.map((t) => t.name).filter((n) => !grouped.has(n))]];
  const tables = groups.filter(([, names]) => names.length).map(([g, names]) =>
    `## ${g}\n\n| Tool | What it does |\n|---|---|\n${names.map((n) => `| \`${n}\` | ${cell(byName.get(n)!.summary)} |`).join('\n')}`);
  const prompts = catalog.prompts.length
    ? `## Slash commands\n\n${promptsIntro ?? PROMPTS_INTRO}\n\n${catalog.prompts.map((p) => `- \`/${p.name}\`: ${p.summary}`).join('\n')}`
    : '';
  return [...tables, prompts].filter(Boolean).join('\n\n');
}

/** A host guide as pages: its own, in its groups' order, the MCP tools page followed by the tools (added in Reference when it wrote none). */
function hostPages(h: HostGuideData, catalog: ToolCatalog): { groups: [string, string[]][]; pages: GuidePage[] } {
  const tools = groupedToolsMarkdown(h.tool_groups, h.prompts_intro, catalog);
  const own = h.pages.some((p) => p.title === h.tools_title);
  const all: GuidePage[] = [...h.pages.map((p) => ({ slug: p.slug, title: p.title, group: p.group, body: p.title === h.tools_title ? [p.body, tools].filter(Boolean).join('\n\n') : p.body })),
    ...(own ? [] : [{ slug: slugify(h.tools_title), title: h.tools_title, group: 'Reference', body: ['Your AI client calls these for you; you rarely name them.', tools].filter(Boolean).join('\n\n') }])];
  const order = [...h.groups, 'Reference'].filter((g, i, xs) => xs.indexOf(g) === i);
  const groups = order.map((g) => [g, all.filter((p) => p.group === g).map((p) => p.title)] as [string, string[]]).filter(([, ts]) => ts.length);
  return { groups, pages: groups.flatMap(([g]) => all.filter((p) => p.group === g)) };
}

const host = HOST_GUIDE as HostGuideData | null;
const packs = host ? null : (PACK_GUIDE as PackGuideData | null);
/** The packs' guide does not depend on the catalog for its groups: worked out once with an empty one. */
const packGroups = packs ? packGuide(packs, { tools: [], prompts: [] }, { connect: connectText, account: ACCOUNT_TEXT }).groups : null;

/** The left navigation's groups, by section title. A section no group names lands in "More". */
export const PAGE_GROUPS: [string, string[]][] = host ? hostPages(host, { tools: [], prompts: [] }).groups : packGroups ?? SHELL_GROUPS;

/** The guide cut at its `## ` headings, one page each; a page's `### ` subsections become its `## ` sections. */
export function guidePages(catalog: ToolCatalog): GuidePage[] {
  if (host) return hostPages(host, catalog).pages;
  if (packs) return packGuide(packs, catalog, { connect: connectText, account: ACCOUNT_TEXT }).pages;
  return pagesOf(shellMarkdown(catalog), SHELL_GROUPS);
}
