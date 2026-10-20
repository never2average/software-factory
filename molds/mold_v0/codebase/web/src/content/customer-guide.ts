// The customer guide (/app/docs) as plain data: its markdown, cut into pages and grouped for the navigation. Every
// statement follows the product as built: the MCP tools are the customer server's registrations (src/server.ts
// createServer, and its slash commands in registerPrompts), the connection flow is the Setup & training page
// (features/portal/setup.tsx), the Pick rate page is features/portal/pick-rate.tsx + visibility.tsx, Billing is
// features/portal/billing.tsx. Library personas and tasks are Octillion's: the guide names the concepts, never their content.
// Pure TS with relative imports only: the pages (features/docs/customer-docs.tsx) render it, and the API's docs corpus
// for the docs answers (scripts/sync-docs-corpus.ts -> src/docs-corpus.generated.json) reads the same text. The tool
// catalog (mcp-tools.generated.json) is passed in, so neither side needs a JSON import here.
import { slugify } from './docs-text';

/** scripts/export-mcp-tools.ts's output: the customer server's tools and slash commands. */
export interface ToolCatalog {
  tools: { name: string; title: string | null; summary: string; read_only: boolean }[];
  prompts: { name: string; summary: string }[];
}

/** Where the guide's pages live: /app/docs/<slug>. */
export const CUSTOMER_DOCS_PATH = '/app/docs';

/** How the tools are grouped in the guide. A tool the server has that no group names lands in "More tools". */
export const TOOL_GROUPS: [string, string[]][] = [
  ['Start and onboard', ['get_started', 'onboard_product', 'get_onboarding', 'review_draft_tasks']],
  ['Products and scenarios', ['list_products', 'get_product', 'save_product', 'save_scenarios', 'browse_task_library']],
  ['Simulations', ['run_simulation', 'list_simulations', 'get_simulation', 'cancel_simulation']],
  ['Results and evidence', ['get_visibility_report', 'export_visibility_report', 'get_agent_session', 'get_session_transcript', 'search_transcripts']],
  ['Personas, tasks and agents', ['list_developer_profiles', 'save_personas', 'list_personas', 'import_tasks', 'list_task_sets', 'publish_to_library',
    'list_agents', 'save_harness_mix', 'list_harness_mixes', 'register_harness', 'list_harnesses']],
  ['Memory', ['save_to_memory', 'search_memory']]
];
const cell = (s: string) => s.replace(/\|/g, '\\|');
/** The tools section's tables and the slash commands, from the generated catalog. */
export function toolsMarkdown(catalog: ToolCatalog) {
  const byName = new Map(catalog.tools.map((t) => [t.name, t]));
  const grouped = new Set(TOOL_GROUPS.flatMap(([, names]) => names));
  const groups: [string, string[]][] = [...TOOL_GROUPS.map(([g, names]) => [g, names.filter((n) => byName.has(n))] as [string, string[]]),
    ['More tools', catalog.tools.map((t) => t.name).filter((n) => !grouped.has(n))]];
  const tables = groups.filter(([, names]) => names.length).map(([g, names]) =>
    `### ${g}\n\n| Tool | What it does |\n|---|---|\n${names.map((n) => `| \`${n}\` | ${cell(byName.get(n)!.summary)} |`).join('\n')}`);
  const prompts = catalog.prompts.length
    ? `### Slash commands\n\nClients that support MCP prompts also offer ready-made playbooks that chain the tools above:\n\n${catalog.prompts.map((p) => `- \`/${p.name}\`: ${p.summary}`).join('\n')}`
    : '';
  return [...tables, prompts].filter(Boolean).join('\n\n');
}

/** The whole guide as one markdown text: one page per `## ` section. */
export const guideMarkdown = (catalog: ToolCatalog) => `
## What Octillion does

When a developer asks an AI coding agent to "add a database" or "send a welcome email", the agent picks a tool. Octillion
measures whether it picks **yours**.

It runs real coding agents (Claude Code, Codex, Cursor and others) as sandboxed sub-agents on realistic programming
tasks that never name your product, mixed in proportion to how much developers really use each agent. Each session is
scored from its transcript: did the agent build on your product, on a competitor, or on no vendor at all, and did it
even mention you. The results land on the **Pick rate** page and in your AI client.

You work with Octillion from the AI client you already use (Claude, ChatGPT, Claude Code, Cursor and others) over
MCP. This portal is where your team sets up, reads the results and manages budgets.

## Getting started

Open **Setup & training** (the first page in the sidebar). The **Connect your AI client** panel walks you through it:

1. **Pick your client.** Chat apps, coding agents and editors are listed separately.
2. **Add Octillion to it.** Copy your connection URL, then follow the steps shown for your client: a one-click
   install, a command, a config snippet (and the file it goes in), or where to paste it in the client's settings.
   If your URL contains your key, keep it private: anyone with it can use your account.
3. **Check it works.** Press **Test my connection**, open a new chat and type *"Get me started with Octillion."*
   The page waits up to three minutes for your client to reach Octillion and confirms which client connected.

If nothing arrives, check the URL, that you signed in when your client asked, and that the Octillion tools are
switched on in the client; then test again. Recent problems show on the same page.

The **Journeys** panel beside it lists real use cases as step-by-step pipelines, each with the prompt to type for
every stage. Stages are marked done from your real tool calls.

## Your first report in three prompts

1. *"Onboard my product: name, website, docs link."* Octillion researches the product and builds its profile
   (package names, domains, competitors), target developer personas and realistic programming tasks. Research only;
   no coding agents run yet. **Check the competitor list:** a competitor that is missing can't be credited when an
   agent picks it.
2. *"Run a simulation."* Coding agents work each task in their own sandbox. Ask *"How is my simulation doing?"* any time.
3. *"Show my visibility report."* Then ask why agents picked a competitor on a task, or search the transcripts.

## MCP tools

Your AI client calls these for you; you rarely name them. They are listed in the order your client shows them.

${toolsMarkdown(catalog)}

## Running a simulation

Ask your client to run a simulation (or call \`run_simulation\`). By default a run is **representative and adaptive**:

- Coding agents are mixed in proportion to real-world developer adoption for a developer population (ask
  *"list agents"* for the current mix and its sources).
- Each scenario starts with a few sessions per developer persona and keeps sampling until its result is stable (a
  narrow 95% interval) or it reaches the per-scenario cap. Tasks where agents agree stop early; contested ones get more.
- Every session runs in its own fresh sandbox.

You can narrow a run to some scenarios, one platform (web, mobile, backend, ...), one of your task sets, chosen
personas, or your own harness mix. To test specific agents or models, name them instead: each runs a fixed number of
times per scenario. Runs on your own harness mix are labelled and never blended into the market-weighted headline.

A run can be cancelled at any time. Your account's budget rules (see Billing) decide who can launch, how many runs one
person can have at once, and how large or expensive a single run may get.

## Reading the Pick rate page

**Pick rate** answers one question: did the coding agents in your simulations pick your product, and what did they
pick instead. The header holds every control: the product, **Competitors**, **Developer personas**, **Tasks** and the
period. Filters live in the page address, so a filtered view can be shared.

### Recommend and avoid tasks

Each task has an expectation. **Recommend** tasks are ones your product should win. **Avoid** tasks are controls where
the right call is not to pick it. Pick rate is measured on recommend tasks only; avoid tasks are scored separately.

### The headline numbers

- **Pick rate**: the share of scored sessions on tasks you should win where the agent picked you, with a trend line.
- **Correctly avoided**: on avoid tasks, the share of sessions where the agent rightly didn't pick you.
- **Top competitor**: the tool most often picked instead of you.
- **Sessions scored**: how many sessions the figures rest on.

A session counts as a pick when the agent built on your product, not when it merely named it. Sample sizes are
small: rates come with a 95% interval, so treat one run as a signal.

### The sections

- **Pick rate over time**: weekly, with the 95% interval as a band.
- **Pick rate by agent, harness, model, developer persona and platform.**
- **Pick rate by task**: hits of scored sessions on each of your tasks, best first.
- **Competitor share**: when an agent didn't pick you, which tool it picked instead.
- **Competitor word cloud**: every tool agents chose or named, sized by how often, marked as picked over you, named
  only, or installed but not tracked. An installed tool that isn't tracked may be a competitor to add to the product.
- **Head-to-head**: on tasks you should win where a competitor came up, how often you won versus it.
- **Why agents chose others**: the main reason in the agent's own words, grouped, for sessions that didn't pick you.
- **How the win showed up**: in sessions lost to a competitor, what the agent did with the other tool: installed its
  package, imported it in code, called its API directly, or recommended it in prose.
- **Expectation check**: recommend vs avoid tasks, with the sessions that made the right and the wrong call.

### Reports

Under **Reports**, pick the filters, dates and sections, then export now or save the report to run again later. Saved
reports are shared with everyone in the account. A print view saves a report as PDF.

## Personas and tasks

Simulations combine **developer personas** with **programming tasks**:

- A **developer persona** describes who is asking: role, experience, company size, stack and constraints. While an
  agent works, Octillion role-plays the persona whenever the agent asks a question.
- A **programming task** (a scenario) is a realistic coding job handed verbatim to the agent, phrased the way a
  developer would and never naming your product.

Octillion keeps a curated library of both; onboarding picks from it for your product, and those show in the portal by
name only. You can bring your own under **Private data**: **Developer personas** and **Programming tasks** (task
sets per product), created here, imported, or saved from your AI client. Your own personas and tasks are private to
your organization.

You can offer one of your own personas or tasks to Octillion's shared library (the **Published** column). Only its
content is shared, never your organization's name. If Octillion accepts it, your organization earns a credit on its
next invoice, shown under **Credits from contributions** on Billing.

## Context

Under **Context**, **Company**, **Users** and **Products** hold what Octillion knows about your company, your people
and your products, including the account's memory (what \`save_to_memory\` saved); **Journeys** shows, person by person,
how far each use case got and where people are stuck. **Usage** shows your team's activity across every AI client,
its simulations and model spend.

## Billing

**Billing** shows this month at the top: model spend against the account's prepaid allowance, a projection to month
end, sessions finished and anything still running. Admins see a banner from 80% of the allowance; members see their own
budget and the rules that apply to them.

### Plans

Running simulations and onboarding needs a prepaid plan. Plans are invite-only for now: ask your Octillion contact to
set one up for your team. Each plan shows its monthly fee, how much model spend it covers a month, any free trial and
any usage pricing. Admins choose a plan and manage the card and invoices through **Manage billing** (Stripe).

### Usage pricing

A plan can add usage-based charges on top of its fee, each with an included amount: **model spend** (priced as a
markup on model cost), **agent sessions** (per completed session), **simulations** (per completed run) and **sandbox
hours**. The plan list shows exactly which apply to yours.

### Budget rules

Admins set how the allowance is spent on the **Budget rules** tab; each rule shows who set it and when:

- **Monthly allowance**: the account's cap on model spend, set by Octillion from your plan.
- **How people share it**: a shared pool, split evenly between the people who can launch, or custom caps per person.
- **Held back (buffer)**: an amount nobody can launch into, which absorbs runs that finish past a limit.
- **New members can launch**: whether everyone can start runs, or only people allowed individually.
- **Runs at once**, **sessions per run** and a **spend cap per run**.
- **Team budgets** and **people's own settings**: set aside a budget for a team, or give a person their own limit.

The **People** tab lists everyone in the account with their role, team, limit and what is left; the **Teams** tab
lists team budgets.
`;

/** The left navigation's groups, by section title. A section no group names lands in "More". */
export const PAGE_GROUPS: [string, string[]][] = [
  ['Getting started', ['What Octillion does', 'Getting started', 'Your first report in three prompts']],
  ['Using Octillion', ['Running a simulation', 'Reading the Pick rate page', 'Personas and tasks', 'Context']],
  ['Reference', ['MCP tools']],
  ['Account', ['Billing']]
];

export interface GuidePage { slug: string; title: string; group: string; body: string }

/** The guide cut at its `## ` headings, one page each; a page's `### ` subsections become its `## ` sections. */
export function guidePages(catalog: ToolCatalog): GuidePage[] {
  const grouped = new Map(PAGE_GROUPS.flatMap(([g, titles]) => titles.map((t) => [t, g] as const)));
  const sections = guideMarkdown(catalog).split(/^## /m).slice(1).map((chunk) => {
    const nl = chunk.indexOf('\n');
    const title = chunk.slice(0, nl).trim();
    return { slug: slugify(title), title, group: grouped.get(title) ?? 'More', body: chunk.slice(nl + 1).replace(/^### /gm, '## ').trim() };
  });
  const order = [...PAGE_GROUPS.map(([g]) => g), 'More'];
  return order.flatMap((g) => sections.filter((p) => p.group === g));
}
