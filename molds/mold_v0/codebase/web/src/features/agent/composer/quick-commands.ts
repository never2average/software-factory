// The workspace agent's blank screen and quick commands (mold_v0-316, flag agent_quick_commands): pure, so
// scripts/agent-quick-commands-test.ts runs it without a browser. No React and no '@/' imports here.
//
//   examples   a session with nothing in it yet shows a greeting and 4 to 6 example prompts: the active tab's own
//              (pack.json tabs[].agent.examples), else the app's (pack.json agent_defaults.examples), else the shell's
//              generic ones below. Choosing one fills the composer; nothing is ever sent on its own.
//   commands   the composer's "/" menu (its button beside the paperclip, or "/" typed first): the active tab's commands,
//              then the app's global ones (agent_defaults.commands, else the shell's generic ones), one per name, the
//              tab's first. Choosing one puts its prompt in the composer, the context's placeholders filled.
//   active tab the console page the agent was opened from (the top bar's agent button passes ?from=<tab>, and on a
//              record's page &record=<area>/<key>); the session keeps it (its policy's opened_from). The plain Agents
//              page has none: the app's global commands only.

/** An example prompt on the blank screen: a title and one line under it (its description, else the prompt itself). */
export interface AgentExample { title: string; prompt: string; description?: string }
/** A quick command: chosen from the "/" menu, its prompt goes into the composer. `send` is only ever false. */
export interface AgentCommand { name: string; label: string; description?: string; prompt: string; send?: false }
/** What a pack declares, on a tab (`agent`) or for the whole app (`agent_defaults`, which may also carry the greeting). */
export interface AgentPrompts { greeting?: string; intro?: string; examples?: AgentExample[]; commands?: AgentCommand[] }
/** The generated registry (web/src/config/agent-prompts.generated.ts): the app's defaults and each tab's own, by tab id. */
export interface AgentPromptsRegistry { defaults: AgentPrompts | null; tabs: Record<string, AgentPrompts> }

/** Where the agent was opened from: a tab of the console, and on a record's page that record. */
export interface OpenedFrom { tab: string | null; record: { area: string; key: string } | null }
/** The words a prompt's placeholders are filled with. */
export interface PromptContext { tab?: string | null; area?: string | null; record_key?: string | null; record_title?: string | null }

/** The placeholders the shell fills from the active tab and record. Any other {name} is a blank the person fills in. */
export const CONTEXT_PLACEHOLDERS = ['tab', 'area', 'record_key', 'record_title'] as const;
/** A placeholder's form: {name}, a few lowercase words ({what to compare} is a blank, the cursor lands on it). */
export const PLACEHOLDER = /\{([a-z][a-z0-9_ ]{0,39})\}/g;
export const COMMAND_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const TAB_ID = /^[a-z][a-z0-9-]{0,40}$/;
const AREA_NAME = /^[a-z][a-z0-9_]{1,62}$/;
const RECORD_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const LIMITS = { examples: 6, commands: 12, shown_examples: 6, menu: 30 } as const;
/** What {tab} reads where no tab is active (the plain Agents page). */
export const NO_TAB_WORDS = 'this workspace';

/** The shell's examples where the app declares none: about the workspace, a tab, or a record. */
export const GENERIC_EXAMPLES: Record<'workspace' | 'tab' | 'record', AgentExample[]> = {
  workspace: [
    { title: 'Summarise this workspace', description: 'What it holds and what needs attention first', prompt: "Summarise this workspace's records and say what needs attention first." },
    { title: 'What changed this week', description: 'Every change of the last seven days, by area', prompt: 'List what changed in this workspace in the last seven days, grouped by area, with who changed it.' },
    { title: 'Find what is overdue', description: 'Records past their date, and who owns each', prompt: 'Find the records that are overdue or due in the next seven days, and say who owns each.' },
    { title: 'Draft a status update', description: 'A short update for the team, in plain words', prompt: "Draft a short status update for the team from this workspace's activity this week." },
  ],
  tab: [
    { title: 'Summarise {tab}', description: 'What is here and what needs attention first', prompt: 'Summarise {tab}: what it holds, what changed lately and what needs attention first.' },
    { title: 'What changed lately', description: 'The last seven days, newest first', prompt: 'What changed in {tab} in the last seven days? List each change, newest first, with who made it.' },
    { title: 'Find the gaps', description: 'Missing details and stalled items', prompt: 'Look through {tab} for missing details, stalled items and anything that looks wrong, and list them by importance.' },
    { title: 'Draft a status update', description: 'A short update for the team', prompt: 'Draft a short status update for the team about {tab}, in plain words.' },
  ],
  record: [
    { title: 'Summarise {record_title}', description: 'Where it stands, in a few lines', prompt: 'Summarise {record_title} ({record_key}): where it stands, what is missing and what should happen next.' },
    { title: 'What changed', description: 'Its history, newest first', prompt: 'List what changed on {record_title} ({record_key}) lately, newest first, with who made each change.' },
    { title: 'Check it for gaps', description: 'Missing or inconsistent details', prompt: 'Check {record_title} ({record_key}) for missing or inconsistent details and say how to fix each.' },
    { title: 'Draft an update', description: 'A short note for the people involved', prompt: 'Draft a short update about {record_title} ({record_key}) for the people involved.' },
  ],
};

/** The shell's global commands where the app declares none. */
export const GENERIC_COMMANDS: AgentCommand[] = [
  { name: 'summarise', label: 'Summarise', description: 'What is here and what needs attention first', prompt: 'Summarise {tab}: what it holds, what changed lately and what needs attention first.' },
  { name: 'whats-new', label: 'What changed', description: 'The last seven days, newest first', prompt: 'What changed in {tab} in the last seven days? List each change, newest first, with who made it.' },
  { name: 'find', label: 'Find', description: 'Records that match what you describe', prompt: 'Find the records in {tab} that match {what to find}, and list each with a link.' },
  { name: 'next-steps', label: 'Next steps', description: 'The three most useful things to do now', prompt: 'What should I do next in {tab}? Give the three most useful steps and why.' },
  { name: 'draft', label: 'Draft an update', description: 'A short note for the team', prompt: 'Draft a short update for the team about {tab}, in plain words.' },
];

// ---------------------------------------------------------------- checks (the server's pack schema says the same)

/** The placeholders a template names, in order (each once). */
export function placeholders(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** What is wrong with a template's braces, or null: every { opens a placeholder of a few lowercase words. */
export function templateProblem(template: string): string | null {
  if (template.includes('{{')) return 'a placeholder is {name} with single braces';
  const left = template.replace(PLACEHOLDER, '');
  if (/[{}]/.test(left)) return 'a brace that is not a placeholder: write placeholders as {name} in lowercase words (tab, area, record_key, record_title, or a blank such as {what to compare})';
  return null;
}

// ---------------------------------------------------------------- the active tab

const cleanTab = (v: string | null | undefined) => (v && TAB_ID.test(v) ? v : null);
/** "<area>/<key>" from the address, checked, or null. */
export function parseRecord(v: string | null | undefined): { area: string; key: string } | null {
  if (!v) return null;
  const i = v.indexOf('/');
  if (i < 1) return null;
  const area = v.slice(0, i), key = v.slice(i + 1);
  return AREA_NAME.test(area) && RECORD_KEY.test(key) ? { area, key } : null;
}

/** The agent page's own address: ?from=<tab>&record=<area>/<key> (anything malformed is dropped, never guessed). */
export function openedFromParams(params: { get(name: string): string | null }): OpenedFrom {
  return { tab: cleanTab(params.get('from')), record: parseRecord(params.get('record')) };
}

/** The address the top bar's agent button opens from a page: the Agents page, with the page's tab and record. */
export function agentHref(base: string, from: OpenedFrom): string {
  const q = new URLSearchParams();
  if (from.tab || from.record) q.set('new', '1');
  if (from.tab) q.set('from', from.tab);
  if (from.record) q.set('record', `${from.record.area}/${from.record.key}`);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

/** A tab as the resolver needs it (the generated PackTabSpec has these). */
export interface TabRef { id: string; url: string; area?: string; areas?: { area: string }[] }

/**
 * The tab a console page belongs to (its sidebar entry's), and the record when it is a record's page:
 *   /app/records/<area>/<key>   the record, and the tab that lists its area (one of its own before a merged one)
 *   /app/agent...               none (the agent's own pages)
 *   anything else               the tab whose address is the page's (its query a subset of the page's), else the
 *                               longest tab address the page is under; /app itself only for /app
 */
export function resolveOpenedFrom(path: string, search: string, tabs: readonly TabRef[], base = '/app'): OpenedFrom {
  const p = path.replace(/(.)\/+$/, '$1');
  if (p === `${base}/agent` || p.startsWith(`${base}/agent/`)) return { tab: null, record: null };
  const rec = new RegExp(`^${base}/records/([^/]+)(?:/([^/]+))?$`).exec(p);
  if (rec) {
    const area = decodeURIComponent(rec[1]!), key = rec[2] ? decodeURIComponent(rec[2]) : null;
    const own = tabs.find((t) => t.area === area && !t.areas) ?? tabs.find((t) => t.area === area || (t.areas ?? []).some((a) => a.area === area));
    const record = key ? parseRecord(`${area}/${key}`) : null;
    return { tab: own ? cleanTab(own.id) : null, record };
  }
  const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  let best: { t: TabRef; score: number } | null = null;
  for (const t of tabs) {
    const i = t.url.indexOf('?');
    const tp = (i < 0 ? t.url : t.url.slice(0, i)).replace(/(.)\/+$/, '$1');
    const tq = new URLSearchParams(i < 0 ? '' : t.url.slice(i + 1));
    const subset = [...tq.entries()].every(([k, v]) => query.get(k) === v);
    let score = -1;
    if (tp === p && subset) score = 10000 + tp.length + [...tq.keys()].length;
    else if (tp !== base && p.startsWith(`${tp}/`) && subset) score = tp.length;
    if (score >= 0 && (!best || score > best.score)) best = { t, score };
  }
  return { tab: best ? cleanTab(best.t.id) : null, record: null };
}

// ---------------------------------------------------------------- what is offered

/** The examples for the active tab and record: the tab's own, else the app's, else the shell's generic ones (at most 6). */
export function examplesFor(reg: AgentPromptsRegistry, from: OpenedFrom): AgentExample[] {
  const own = from.tab ? reg.tabs[from.tab]?.examples : undefined;
  if (own?.length) return own.slice(0, LIMITS.shown_examples);
  if (reg.defaults?.examples?.length) return reg.defaults.examples.slice(0, LIMITS.shown_examples);
  return GENERIC_EXAMPLES[from.record ? 'record' : from.tab ? 'tab' : 'workspace'];
}

/** The active tab's commands, then the app's global ones (else the shell's), one per name: the first of a name wins. */
export type ScopedCommand = AgentCommand & { scope: 'tab' | 'global' };
export function mergeCommands(tab: readonly AgentCommand[] | undefined, global: readonly AgentCommand[] | undefined): ScopedCommand[] {
  const out: ScopedCommand[] = [], seen = new Set<string>();
  const all = [...(tab ?? []).map((c) => ({ ...c, scope: 'tab' as const })), ...(global?.length ? global : GENERIC_COMMANDS).map((c) => ({ ...c, scope: 'global' as const }))];
  for (const c of all) {
    if (seen.has(c.name)) continue;
    seen.add(c.name); out.push(c);
  }
  return out.slice(0, LIMITS.menu);
}

/** The "/" menu's commands for where the agent was opened from (the plain Agents page: the global ones only). */
export function commandsFor(reg: AgentPromptsRegistry, from: OpenedFrom): ScopedCommand[] {
  return mergeCommands(from.tab ? reg.tabs[from.tab]?.commands : undefined, reg.defaults?.commands);
}

/** The blank screen's greeting and the line under it. */
export function greetingFor(reg: AgentPromptsRegistry, ctx: PromptContext): { title: string; text: string } {
  const title = reg.defaults?.greeting ?? (ctx.record_title ? 'How can I help with {record_title}?' : ctx.tab ? 'How can I help with {tab}?' : 'How can I help?');
  const text = reg.defaults?.intro ?? 'Ask anything, or start from an example. Type / for quick commands.';
  return { title: fillPrompt(title, ctx).text, text: fillPrompt(text, ctx).text };
}

/** The "/" menu filtered by what follows the slash: names starting with it first, then any word of the label or description. */
export function filterCommands<C extends AgentCommand>(list: readonly C[], query: string): C[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  const starts = list.filter((c) => c.name.startsWith(q) || c.label.toLowerCase().startsWith(q));
  const has = list.filter((c) => !starts.includes(c) && `${c.name} ${c.label} ${c.description ?? ''}`.toLowerCase().includes(q));
  return [...starts, ...has];
}

/** What follows a "/" typed as the box's first character (the menu's filter), or null: the box is not a quick command. */
export function slashQuery(value: string): string | null {
  const m = /^\/([a-z0-9-]*)$/i.exec(value);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------- filling a prompt

/**
 * A template with the context's placeholders filled: {tab} (the tab's label, else "this workspace"), {area}, {record_key}
 * and {record_title} when there is a record. `select` is the first placeholder left (a blank for the person, or a
 * record's with no record), so the composer puts the cursor on it; null: the cursor goes to the end.
 */
export function fillPrompt(template: string, ctx: PromptContext): { text: string; select: [number, number] | null } {
  const words: Record<string, string | null | undefined> = { tab: ctx.tab ?? NO_TAB_WORDS, area: ctx.area, record_key: ctx.record_key, record_title: ctx.record_title ?? ctx.record_key };
  const text = template.replace(PLACEHOLDER, (all, name: string) => {
    const w = (CONTEXT_PLACEHOLDERS as readonly string[]).includes(name) ? words[name] : null;
    return w ? w.replace(/[{}]/g, '') : all;
  });
  const left = new RegExp(PLACEHOLDER.source).exec(text);
  return { text, select: left ? [left.index, left.index + left[0].length] : null };
}
