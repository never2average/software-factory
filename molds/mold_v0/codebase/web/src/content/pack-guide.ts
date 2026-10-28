// The customer guide of an app whose packs bring no guide code (mold_v0-106): the pages a pack wrote (pack.json `guide`,
// src/pack-guide.ts) and the pages written here from what its packs declare (record areas, the console's tabs, job
// kinds, schedules, credentials, onboarding steps and the generated MCP tools, get_started first), so a pack with no
// guide of its own still gets a real one. scripts/gen-packs.mjs writes the facts into config/pack-guides.generated.ts;
// customer-guide.ts calls packGuide with them. Base text writes the build's words ({run}, {workspace}, {product}) through
// lib/vocabulary.ts and names no product's concepts. Pure TS with relative imports only: the API's docs corpus
// (scripts/sync-docs-corpus.ts) reads the same pages.
import { fill } from '../lib/vocabulary';

/** What gen-packs writes (scripts/gen-packs.mjs packGuideData). */
export interface PackGuideData {
  titles: { start: string; console: string; records: string; runs: string; tools: string; account: string };
  generated: boolean;
  /** The packs' own groups of the MCP tools page (mold_v0-139, pack.json guide.tool_groups): [title, tool names]. */
  tool_groups?: [string, string[]][];
  /** The line before the slash commands' list (mold_v0-139, pack.json guide.prompts_intro), or null: the shell's. */
  prompts_intro?: string | null;
  groups: string[];
  pages: { title: string; slug: string; group: string; body: string }[];
  packs: { id: string; name: string; description: string | null }[];
  onboarding: { label: string; help: string | null; prompt: string | null }[];
  get_started: string[];
  tabs: { group: string; label: string; kind: string; description: string | null; area?: string; charts: string[]; include?: string[] }[];
  areas: {
    name: string; label: string; description: string | null; scope: 'platform' | 'workspace'; role: string; sealed: boolean;
    fields: { label: string; type: string; help: string | null; required: boolean; options: string[]; to: string | null; multiple: boolean }[];
    lifecycle: { field: string; initial: string; states: string[]; moves: { label: string | null; from: '*' | string[]; to: string }[] } | null;
    due: { field: string; within_days: number } | null;
    tools: string[];
  }[];
  kinds: { label: string; description: string | null; credentials: string[]; report: string | null; start: string; approval: string | null }[];
  credentials: { label: string; help: string | null; bound_to: 'workspace' | 'asset' | 'environment'; area: string | null }[];
  schedules: { label: string; kind: string; cron: string; area: string | null; enabled: boolean }[];
  tools: { name: string; op: string; area: string | null }[];
  record_tools: string[];
}

/** The line before the slash commands' list, unless a guide says its own (pack.json guide.prompts_intro, mold_v0-139). */
export const PROMPTS_INTRO = 'Clients that support MCP prompts also offer these:';

interface Catalog { tools: { name: string; summary: string }[]; prompts: { name: string; summary: string }[] }
/** The shell's own texts the generated pages reuse (customer-guide.ts): connecting a client, the account. */
export interface ShellTexts { connect: (setupPage: string) => string; account: string }

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const code = (s: string) => `\`${s}\``;
/** A pack's text as one markdown paragraph: its own words, never markup of ours. */
const para = (s: string) => s.replace(/\s+/g, ' ').trim();
const sentence = (s: string) => { const t = para(s); return /[.!?]$/.test(t) ? t : `${t}.`; };
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** A schedule's cron in words when it is a plain daily or weekly time, else the expression itself (UTC). */
export function cronWords(cron: string): string {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-7])$/.exec(cron.trim());
  if (!m) return `${code(cron)} (cron, UTC)`;
  const at = `${m[2]!.padStart(2, '0')}:${m[1]!.padStart(2, '0')} UTC`;
  return m[3] === '*' ? `every day at ${at}` : `every ${DAYS[Number(m[3]) % 7]} at ${at}`;
}

/** The type of a field as a person reads it. */
function fieldKind(f: PackGuideData['areas'][number]['fields'][number]): string {
  if (f.type === 'enum') return f.options.length && f.options.length <= 12 ? `${f.multiple ? 'Any of' : 'One of'}: ${f.options.join(', ')}` : 'A choice from a list';
  if (f.type === 'reference' || f.type === 'link') return f.to ? `${f.multiple ? 'Records' : 'A record'} of ${f.to}` : 'A link to another record';
  const words: Record<string, string> = { text: 'Text', number: 'A number', date: 'A date', boolean: 'Yes or no', json: 'Structured data',
    person: fill(f.multiple ? 'People of your {workspace}' : 'A person of your {workspace}'), file: fill(f.multiple ? "Files of your {workspace}'s store" : "A file of your {workspace}'s store") };
  return words[f.type] ?? 'A value';
}

/** What a console tab shows, when its pack gave no description. */
function tabWhat(t: PackGuideData['tabs'][number], d: PackGuideData): string {
  if (t.description) return sentence(t.description);
  const area = t.area ? d.areas.find((a) => a.name === t.area) : undefined;
  switch (t.kind) {
    case 'overview': {
      // A home tab (mold_v0-134): the shell's sections it includes come first, in its order (mold_v0-172: the checklist
      // stays, beside the connection to your AI client).
      const parts: string[] = (t.include ?? []).map((x) => (x === 'setup' ? 'your setup checklist and how to connect your AI client' : 'the records due soon'));
      if (t.charts.length) parts.push(`charts: ${list(t.charts)}`);
      const text = parts.join('; ');
      return text ? sentence(text.charAt(0).toUpperCase() + text.slice(1)) : 'The overview charts.';
    }
    case 'area': return area?.description ? sentence(area.description.split(/(?<=[.!?])\s/)[0]!) : `The records of ${t.label}.`;
    case 'runs': return fill('Every {run} of your {workspace} and how it went.');
    case 'reports': return fill('The reports your {runs} wrote.');
    case 'credentials': return fill('The keys and tokens your {runs} use to reach your own systems.');
    case 'schedules': return fill('When {runs} start by themselves, for your {workspace}.');
    case 'notices': return 'Records whose due date is near.';
    case 'setup': return 'Connect your AI client and follow the setup checklist.';
    case 'usage': return fill('{Tool_calls} and spend, per {member} and per {run}.');
    case 'billing': return "Your plan and this month's spend.";
    case 'profile': return 'Your own profile.';
    case 'files': return fill("Your {workspace}'s files.");
    default: return '';
  }
}

/**
 * The tools' groups on the MCP tools page: the packs' own groups first (guide.tool_groups, each tool in the order listed),
 * then what each other tool reaches, in the order a client lists them.
 */
function toolGroups(d: PackGuideData, catalog: Catalog): [string, string[]][] {
  const by = new Map(d.tools.map((t) => [t.name, t]));
  const has = new Set(catalog.tools.map((t) => t.name));
  const owner = new Map<string, string>();
  for (const [g, names] of d.tool_groups ?? []) for (const n of names) if (!owner.has(n)) owner.set(n, g);
  const groups: [string, string[]][] = [];
  const add = (g: string, name: string) => { let e = groups.find(([x]) => x === g); if (!e) { e = [g, []]; groups.push(e); } e[1].push(name); };
  for (const [g, names] of d.tool_groups ?? []) for (const n of names) if (has.has(n) && owner.get(n) === g) add(g, n);
  const RUN_OPS = new Set(['start', 'run_status', 'list_runs', 'run_results', 'cancel_run', 'report']);
  for (const t of catalog.tools) {
    const g = by.get(t.name);
    if (owner.has(t.name)) continue;
    if (g?.op === 'get_started') add('Start here', t.name);
    else if (g?.area) add(g.area, t.name);
    else if (g && RUN_OPS.has(g.op)) add(fill('{Runs}'), t.name);
    else if (g?.op === 'metrics') add('Numbers', t.name);
    else if (d.record_tools.includes(t.name)) add('Any record area', t.name);
    else add('More tools', t.name);
  }
  // The groups in a reader's order: start here, the packs' own, the areas as declared, any area, runs, numbers, the rest.
  const order = ['Start here', ...(d.tool_groups ?? []).map(([g]) => g), ...d.areas.map((a) => a.label), 'Any record area', fill('{Runs}'), 'Numbers', 'More tools'];
  return groups.sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
}

function toolsMarkdown(d: PackGuideData, catalog: Catalog): string {
  const summary = new Map(catalog.tools.map((t) => [t.name, t.summary]));
  const tables = toolGroups(d, catalog).map(([g, names]) =>
    `## ${g}\n\n| Tool | What it does |\n|---|---|\n${names.map((n) => `| ${code(n)} | ${cell(summary.get(n) ?? '')} |`).join('\n')}`);
  const prompts = catalog.prompts.length
    ? `## Slash commands\n\n${d.prompts_intro ?? PROMPTS_INTRO}\n\n${catalog.prompts.map((p) => `- \`/${p.name}\`: ${p.summary}`).join('\n')}`
    : '';
  return [`Your AI client calls these for you; you rarely name them. They are grouped by what they reach.`,
    ...(catalog.tools.length ? tables : [fill('This {workspace} offers no tools yet.')]), prompts].filter(Boolean).join('\n\n');
}

function startMarkdown(d: PackGuideData, shell: ShellTexts, setupPage: string): string {
  const parts = [shell.connect(setupPage)];
  if (d.onboarding.length) {
    const ask = d.get_started.length
      ? ` Not sure what is next? Type *"Get me started"* in your AI client: it calls ${list(d.get_started.map(code))}, which says which step is next and what to type for it.`
      : '';
    parts.push(`## Your first steps\n\nThe **${setupPage}** page lists these steps and ticks each one off by itself, from what really happens in your ${fill('{workspace}')}.${ask}\n\n` +
      d.onboarding.map((st, i) => `${i + 1}. **${para(st.label)}**.${st.help ? ` ${sentence(st.help)}` : ''} You can type: *"${para(st.prompt ?? `Help me with the next step: ${st.label}.`)}"*`).join('\n'));
  }
  return parts.join('\n\n');
}

function consoleMarkdown(d: PackGuideData): string {
  const groups: [string, PackGuideData['tabs']][] = [];
  for (const t of d.tabs) { let g = groups.find(([x]) => x === t.group); if (!g) { g = [t.group, []]; groups.push(g); } g[1].push(t); }
  const items = (ts: PackGuideData['tabs']) => ts.map((t) => `- **${t.label}**${tabWhat(t, d) ? `: ${tabWhat(t, d)}` : ''}`).join('\n');
  return [`The console's sidebar holds these pages${groups.some(([g]) => g) ? ', in its groups' : ''}. What you see depends on your role.`,
    ...groups.map(([g, ts]) => (g ? `## ${g}\n\n${items(ts)}` : items(ts)))].join('\n\n');
}

function recordsMarkdown(d: PackGuideData): string {
  const area = (a: PackGuideData['areas'][number]) => {
    const where = a.scope === 'platform'
      ? fill('Shared by every {workspace} and kept up to date by the platform: you read it, you never write it.')
      : fill(`Your {workspace}'s own: no other {workspace} sees it.${a.sealed ? ' Encrypted at rest with your {workspace}\'s own key.' : ''}`);
    const lc = a.lifecycle
      ? `\n\nA record's **${a.lifecycle.field}** starts at *${a.lifecycle.initial}* and changes only by a move: ${a.lifecycle.moves.map((m) =>
        `${m.label ? `**${para(m.label)}** (` : ''}${m.from === '*' ? 'any' : m.from.join(' or ')} to ${m.to}${m.label ? ')' : ''}`).join('; ')}.`
      : '';
    const due = a.due ? `\n\nWhen a record's **${a.due.field}** is ${a.due.within_days ? `within ${a.due.within_days} days` : 'today'}, it shows in the notices and a daily email lists it.` : '';
    const fields = `| Field | What it holds |\n|---|---|\n${a.fields.map((f) => `| ${cell(f.label)}${f.required ? ' (required)' : ''} | ${cell(f.help ? `${sentence(f.help)} ${fieldKind(f)}.` : `${fieldKind(f)}.`)} |`).join('\n')}`;
    const tools = a.tools.length ? `\n\nFrom your AI client: ${list(a.tools.map(code))}.` : '';
    return `## ${a.label}\n\n${a.description ? `${sentence(a.description)} ` : ''}${where}${lc}${due}${tools}\n\n${fields}`;
  };
  return [fill('Records are what {product} keeps for you, in areas. Open an area from the sidebar to see its records, and open one record to see every field and the records it links to. Your AI client reads the same records.'),
    ...d.areas.map(area)].join('\n\n');
}

function runsMarkdown(d: PackGuideData): string {
  const tool = (op: string) => d.tools.filter((t) => t.op === op).map((t) => code(t.name));
  const kinds = d.kinds.map((k) => [`## ${k.label}`, k.description ? sentence(k.description) : '',
    k.credentials.length ? `It uses: ${list(k.credentials.map((c) => `**${c}**`))} (set on **Credentials**).` : '',
    k.report !== null ? fill(`It writes a report${k.report ? ` (**${k.report}**)` : ''}, which you read on **Reports** or from your AI client once the {run} has succeeded.`) : '',
    k.approval ? fill(`It starts only after a **${k.approval}** {run} has succeeded and was approved.`) : '',
    `Start it from your AI client: ${code(k.start)}.`].filter(Boolean).join('\n\n'));
  const follow = [
    tool('run_status').length ? fill(`- Ask how a {run} is doing (${list(tool('run_status'))}): queued, running, succeeded, failed or cancelled.`) : '',
    tool('list_runs').length ? fill(`- List your {workspace}'s {runs}, newest first (${list(tool('list_runs'))}).`) : '',
    tool('run_results').length ? fill(`- Read what a {run} found (${list(tool('run_results'))}).`) : '',
    tool('cancel_run').length ? fill(`- Cancel a {run} that is queued or running (${list(tool('cancel_run'))}): it stops spending at once.`) : '',
  ].filter(Boolean).join('\n');
  const schedules = d.schedules.length
    ? fill(`## Schedules\n\nThese start {runs} by themselves. Each {workspace} has its own copy: its owners turn each one on or off and change its time on **Schedules**.\n\n`) +
      d.schedules.map((s) => `- **${s.label}**: ${s.kind}, ${cronWords(s.cron)}${s.area ? fill(`, one {run} for each record of ${s.area}`) : ''}${s.enabled ? '' : ' (off until you turn it on)'}.`).join('\n')
    : '';
  const BOUND: Record<string, (a: string | null) => string> = {
    workspace: () => fill('one for the whole {workspace}'), asset: (a) => `one for each record of ${a}`, environment: (a) => `one for each record of ${a} and environment`,
  };
  const credentials = d.credentials.length
    ? fill(`## Credentials\n\nA {run} reaches your own systems only with what you give it on **Credentials**. A value is stored encrypted (only its last 4 characters are ever shown again) and given only to the {runs} that use it.\n\n`) +
      d.credentials.map((c) => `- **${c.label}** (${BOUND[c.bound_to]!(c.area)})${c.help ? `: ${sentence(c.help)}` : '.'}`).join('\n')
    : '';
  return [fill(`A {run} is work {product} does for your {workspace} in the background. Ask your AI client to start one${d.schedules.length ? ' (or let a schedule start it)' : ''}, then follow it until it ends.`),
    follow, kinds.length ? fill(`These are the {runs} you can start:`) : '', ...kinds, schedules, credentials].filter(Boolean).join('\n\n');
}

/** The whole guide: the packs' own pages first (in their groups), then the generated ones. */
export function packGuide(d: PackGuideData, catalog: Catalog, shell: ShellTexts): { groups: [string, string[]][]; pages: { slug: string; title: string; group: string; body: string }[] } {
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const setupPage = d.tabs.find((t) => t.kind === 'setup' || (t.include ?? []).includes('setup'))?.label ?? 'Setup & training';
  const T = d.titles;
  const generated: { title: string; group: string; body: string }[] = [
    { title: T.start, group: 'Getting started', body: startMarkdown(d, shell, setupPage) },
    ...(d.generated && d.tabs.length ? [{ title: T.console, group: 'Reference', body: consoleMarkdown(d) }] : []),
    ...(d.generated && d.areas.length ? [{ title: T.records, group: 'Reference', body: recordsMarkdown(d) }] : []),
    ...(d.generated && d.kinds.length ? [{ title: T.runs, group: 'Reference', body: runsMarkdown(d) }] : []),
    { title: T.tools, group: 'Reference', body: toolsMarkdown(d, catalog) },
    { title: T.account, group: 'Account', body: shell.account },
  ];
  // A pack's lead: what the app is, before its own pages when it wrote none.
  const lead = !d.pages.length && d.packs.some((p) => p.description)
    ? [{ title: fill('What {product} does'), group: 'Getting started', body: d.packs.filter((p) => p.description).map((p) => sentence(p.description!)).join('\n\n') }]
    : [];
  const all = [...d.pages, ...lead, ...generated].map((p) => ({ slug: slug(p.title), title: p.title, group: p.group, body: p.body }));
  const order = [...d.groups, 'Getting started', 'Reference', 'Account'].filter((g, i, xs) => xs.indexOf(g) === i);
  const groups = order.map((g) => [g, all.filter((p) => p.group === g).map((p) => p.title)] as [string, string[]]).filter(([, ts]) => ts.length);
  return { groups, pages: groups.flatMap(([g]) => all.filter((p) => p.group === g)) };
}
