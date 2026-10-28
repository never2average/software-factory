// The staff guide (mold_v0-170): the admin Docs' first page when no pack brings a guide of its own (pack.json
// `staff_docs`, a doc in the Guides group, as a first product's beta guide is). Written from the build itself, so it
// says only what this build has: the product's name and words (the profile), what the product does (the first page of
// its customer guide, PACK_GUIDE / HOST_GUIDE), the admin console's pages as its sidebar lists them, the shared record
// areas and where their rows come from. The engineering documents (../../docs/*.md) stay in the navigation below it.
// Pure TS with relative imports: features/docs/admin-docs.tsx renders it, scripts/record-pages-test.ts reads it.
import { HOST_GUIDE, PACK_GUIDE } from '../config/pack-guides.generated';
import { recordAreas, repositoryCount } from '../config/pack-nav.generated';
import { profile } from '../config/profile.generated';
import { ADMIN_DOCS, type AdminDoc } from './admin-docs.generated';
import { fill, W } from '../lib/vocabulary';

export const STAFF_GUIDE_SLUG = 'staff-guide';

const titleCase = (s: string) => s.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
/**
 * A doc's group in the admin Docs' navigation: a doc in a folder (docs/case-studies/…) takes it from the folder; a
 * top-level doc is a spec (…-spec.md), a guide (a guide or walkthrough) or architecture.
 */
export const adminDocGroup = (d: Pick<AdminDoc, 'group' | 'slug'>) =>
  d.group ? titleCase(d.group) : d.slug.endsWith('-spec') ? 'Specs' : /guide|walkthrough/.test(d.slug) ? 'Guides' : 'Architecture';

/** Whether the build shows the staff guide: no doc of the shell's or the packs' is a guide. */
export const staffGuideShown = !ADMIN_DOCS.some((d) => adminDocGroup(d) === 'Guides');

/** The sidebar's groups, as features/docs/admin-docs.tsx passes them (config/nav-config.ts adminNav). */
export interface GuideNavGroup { label: string; items: { title: string; url: string }[] }

/** What each of the shell's admin pages is for, by address; a pack's own page is listed with its group only. */
const PAGE_USE: Record<string, string> = {
  '/admin': fill('The onboarding funnel, from access request to the last step, and the {accounts} where a person should step in.'),
  '/admin/requests': fill('People who asked for access from the landing page. Approve one to create their {account} (or add them to one), or decline.'),
  '/admin/accounts': fill('Every {account}: its stage, what needs attention, its plan and when it was last seen. Open one for its people, keys, usage and billing.'),
  '/admin/journeys': fill('The messages that bring people back to a step they have not taken.'),
  '/admin/analytics': fill('Use across every {account}: active {accounts} and people, {tool_calls}, new {accounts} and how each changes week to week.'),
  '/admin/health': fill('What failed, newest first: {tool_call} errors and latency and failed agent sessions, each with its {account} and client.'),
  '/admin/compute': fill('The capacity that runs the {runs}: limits in force, what is running and what failed.'),
  '/admin/finops': 'Revenue, plans and measured spend: model use, compute hours and storage, by account or by provider.',
  '/admin/configuration': 'Every global setting but capacity, edited in place, each with where its value comes from.',
  '/admin/repositories': 'Where the shared record areas get their rows: each catalog\'s pin, when it was last indexed, and Index now.',
  '/admin/keys': 'Every key the platform uses, one row per provider. A key is typed once and shown only as a hint after that.',
  '/admin/admins': 'The platform\'s staff and their roles. Owners add, change and remove staff; everyone else reads.',
  '/admin/activity': fill('{Tool_calls} and {run} spend across every {workspace}, per {member} and per {run}.')
};

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** The first paragraphs of the product's customer guide (its first page), up to its first heading: what customers read first. */
function productIntro(): string | null {
  const g = (HOST_GUIDE ?? PACK_GUIDE) as { pages?: { title: string; body: string }[] } | null;
  const first = g?.pages?.[0];
  if (!first?.body) return null;
  const paras = first.body.split(/\n(?=#)/)[0].split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !/^[#|>`<]/.test(p));
  return paras.length ? paras.slice(0, 2).map((p) => p.replace(/\n/g, ' ')).join('\n\n') : null;
}

/** The guide's markdown (its `# ` title first), for this build and its sidebar. */
export function staffGuideMarkdown(nav: readonly GuideNavGroup[]): { title: string; markdown: string } {
  const product = profile.name;
  const title = `${product} staff guide`;
  const intro = productIntro();
  const shared = recordAreas.filter((a) => a.scope === 'platform');
  const rows = nav.flatMap((g) => g.items.map((i) => {
    const area = shared.find((a) => i.url === `/admin/records/${a.name}`);
    const use = PAGE_USE[i.url] ?? (area ? `${area.description ?? 'Records shared by every ' + W.workspace + '.'}` : `The product's own page, under ${g.label}.`);
    return `| [${md(i.title)}](${i.url}) | ${md(use)} |`;
  }));
  const parts = [
    `# ${title}`,
    fill(`How ${product}'s staff run it from this console: who gets in, what each page is for, where the shared records come from and what to check each day. The engineering documents follow this guide in the navigation.`),
    `## What ${product} does`,
    intro
      ? `What customers read first, from the customer guide:\n\n${intro.split('\n\n').map((p) => `> ${p}`).join('\n>\n')}\n\nThe whole customer guide is [Docs in the customer portal](/app/docs).`
      : `${profile.console_description} The customer guide is [Docs in the customer portal](/app/docs).`,
    '## Letting people in',
    fill(`1. Someone asks for access on the landing page: the request waits in [Access requests](/admin/requests).
2. Approve it: the {account} is created and its first person invited (or the person joins the {account} named). Decline it, and nothing is created.
3. [Overview](/admin) follows each new {account} through the onboarding funnel. **Needs attention** lists the {accounts} that stopped at a step, with the person to contact.`),
    '## The console, page by page',
    `| Page | What it is for |\n|---|---|\n${rows.join('\n')}`,
    ...(shared.length ? [
      '## Shared records',
      fill(`${shared.map((a) => `**${a.label}**`).join(', ').replace(/, ([^,]*)$/, ' and $1')} ${shared.length === 1 ? 'is' : 'are'} shared by every {workspace} and read only to customers. Each page lists its records with search, sort and filters; click a row to read the record beside the list, and **Open record** for its own page.`),
      repositoryCount
        ? 'A shared area fed by a catalog fills itself when its pin changes. While one is empty, its page says where its records come from: open [Data repositories](/admin/repositories) and press **Index now** to fill it at once.'
        : 'Records are added by the product and by staff through the admin MCP server and the data API.'
    ] : []),
    '## Every day',
    fill(`- [Access requests](/admin/requests): answer new requests.
- [Overview](/admin): look at **Needs attention** and contact who is stuck.
- [Health](/admin/health): what failed since yesterday.`)
  ];
  return { title, markdown: parts.join('\n\n') + '\n' };
}
