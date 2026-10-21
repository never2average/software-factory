/**
 * Journeys on /app Setup: real use cases as pipelines a customer can replicate in their AI client, one prompt at a
 * time. Platform admins manage them on /admin (create, edit, promote, order); PLAYBOOKS below are the built-in
 * templates the table is seeded with once. Each stage names the prompt to paste (filled in with the account's own product and competitor), the Octillion
 * tool it runs, and what the person will see; a worked example from the Resend case study (docs/case-studies/resend.md)
 * shows what a finished pipeline produced.
 *
 * Progress is real: a stage is done when one of its tools ran successfully for this account after the previous stage
 * was done (so re-running a pipeline after a fix counts again only from where it restarted); an action on an /app page
 * that does the same as a tool (Developer personas, Programming tasks) counts as that tool. Stages with no tool
 * (shipping a docs change) are marked by the person.
 */
import { getDb } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import { capture, keepAlive } from "./telemetry.js";

export interface Stage {
  id: string; title: string; why: string; prompt: string; tools: string[]; expect: string; manual?: boolean;
  /** The /app page that does the same as the stage's tools (its actions count the same; src/analytics.ts recordPageAction). */
  link?: { href: string; label: string };
}
export interface Playbook {
  id: string; name: string; outcome: string; who: string; time: string;
  example: { title: string; result: string };
  stages: Stage[];
}

/** {product} and {competitor} are filled in per account. */
export const PLAYBOOKS: Playbook[] = [
  {
    id: "baseline", name: "Get your APO baseline", time: "about an hour, mostly waiting for agents",
    outcome: "Your first measured answer to “do coding agents pick us?”, per task and per agent.",
    who: "Anyone starting out; run once per product.",
    example: { title: "Resend, 14 Oct 2026", result: "4 tasks, 2 personas, 32 sessions across 7 agents: agents built on Resend in 14 of 19 sending sessions, and 0 of 6 receiving sessions." },
    stages: [
      { id: "onboard", title: "Onboard the product", tools: ["onboard_product"],
        why: "Octillion researches your site and docs and writes realistic coding tasks that never name you.",
        prompt: "Onboard my product: {product}, <website>, <docs link>. It is a <one-line description>.",
        expect: "A research job starts; in a few minutes you get a product profile (packages, domains), competitors, personas and 3 to 10 tasks." },
      { id: "review", title: "Review the profile and competitors", tools: ["get_onboarding", "get_product", "save_product"],
        why: "A competitor missing from the list can't be credited when agents pick it, so check before you run.",
        prompt: "Show me the onboarding result for {product}. Add {competitor} as a competitor if it's missing.",
        expect: "The profile, personas and tasks, with any warnings (e.g. a task that names your product)." },
      { id: "run", title: "Run the agent mix", tools: ["run_simulation"],
        why: "Real coding agents work each task in fresh sandboxes, in proportion to how developers use them.",
        prompt: "Run a simulation for {product}.",
        expect: "A run starts with sessions dealt across Claude Code, Codex, Copilot, Cursor and others; tasks sample until their result settles." },
      { id: "watch", title: "Watch it settle", tools: ["get_simulation", "list_simulations"],
        why: "Contested tasks get more sessions; agreed ones stop early.",
        prompt: "How is my simulation doing?",
        expect: "Sessions done and running, and which tasks are settled or still sampling." },
      { id: "report", title: "Read the visibility report", tools: ["get_visibility_report"],
        why: "Your headline number, where you win, and who wins where you don't.",
        prompt: "Show my visibility report for {product}.",
        expect: "Hit rate with a 95% range, results per task and per agent, losses to competitors and share of voice." },
    ],
  },
  {
    id: "fix-loss", name: "Fix a losing task", time: "a day, including your docs change",
    outcome: "Find why agents skip you on one task, change what they learn from, and prove the change worked.",
    who: "DevRel and docs owners after the first report.",
    example: { title: "Resend inbound email", result: "0 of 6 sessions picked Resend to receive email although its docs show it can; agents shortlisted Postmark, SES and SendGrid. The fix to test: an inbound quickstart and the words agents search for." },
    stages: [
      { id: "recall", title: "Check what the team already tried", tools: ["search_memory"],
        why: "Someone may have fixed this before, or decided not to; start from what the team remembers.",
        prompt: "What do we remember about {product} losing to {competitor}?",
        expect: "Past fixes, decisions and notes about it, newest first (or nothing yet)." },
      { id: "weakest", title: "Find your weakest task", tools: ["get_visibility_report"],
        why: "Start where agents should pick you and don't.",
        prompt: "Which of my tasks has the lowest hit rate where agents should pick {product}?",
        expect: "The task, its hit rate and range, and which competitor or approach won instead." },
      { id: "evidence", title: "Read the losing sessions", tools: ["get_agent_session", "get_session_transcript"],
        why: "The transcript shows what the agent searched, which options it listed and why it chose.",
        prompt: "Show me a session where the agent chose {competitor} on that task, with the key lines of the transcript.",
        expect: "The verdict, the evidence lines (install commands, imports, the agent's own reasoning) and the transcript." },
      { id: "pattern", title: "Check it's a pattern", tools: ["search_transcripts"],
        why: "One session is an anecdote; search all of them for the competitor or the phrase that tipped it.",
        prompt: "Search my transcripts for {competitor} and summarise how often and why agents picked it.",
        expect: "Matching sessions across agents with the surrounding lines." },
      { id: "ship", title: "Ship the fix", tools: [], manual: true,
        why: "Change what agents learn from: a quickstart for this use case, examples, package metadata, error messages.",
        prompt: "(In your docs or SDK) Add the page or example the transcripts show agents were missing.",
        expect: "Mark this done when the change is live; agents read the public web and package registries." },
      { id: "rerun", title: "Re-run the same task", tools: ["run_simulation"],
        why: "Same task, same personas, the current agent mix: the only thing that changed is you.",
        prompt: "Re-run my last simulation for {product}, only the task we just looked at.",
        expect: "A new run on that task; it samples until the result settles." },
      { id: "compare", title: "Compare before and after", tools: ["get_visibility_report"],
        why: "Proof the change moved agents' choices, task by task and agent by agent.",
        prompt: "Compare the hit rate on that task before and after my change.",
        expect: "The daily trend and both runs' results with their ranges; overlapping ranges mean run more sessions." },
      { id: "remember", title: "Remember the fix", tools: ["save_to_memory"],
        why: "So the next person (and every AI client on the team) knows what changed on this task and why, without re-reading transcripts.",
        prompt: "Remember for {product}: we fixed the loss to {competitor} on that task by <what you changed>; the hit rate moved from <before> to <after>.",
        expect: "The decision saved to the product's memory; it shows under Context and in every new chat." },
    ],
  },
  {
    id: "head-to-head", name: "Competitor head-to-head", time: "an hour",
    outcome: "Where one competitor beats you, on which tasks and with which agents, in the agents' own words.",
    who: "Product marketing and founders.",
    example: { title: "Resend vs Postmark", result: "Postmark took 2 of the 10 password-recovery sessions and both receiving-email wins; Claude Code's provider shortlist named SES, Postmark and SendGrid but not Resend." },
    stages: [
      { id: "recall", title: "Recall what you know about them", tools: ["search_memory"],
        why: "The team's past decisions about this competitor frame what to look for.",
        prompt: "What have we decided or learned about {competitor}?",
        expect: "Facts, decisions and preferences saved about them, newest first." },
      { id: "competitors", title: "Make sure the competitor is tracked", tools: ["get_product", "save_product"],
        why: "Octillion only credits competitors it knows by name, package and domain.",
        prompt: "Make sure {competitor} is a competitor of {product}, with its npm/PyPI packages and domains.",
        expect: "The product's competitor list with packages and domains." },
      { id: "run", title: "Run with enough sessions", tools: ["run_simulation"],
        why: "Head-to-head numbers need sessions on every task and every major agent.",
        prompt: "Run a simulation for {product} with at least 6 sessions per task.",
        expect: "A run sized to your tasks, across the agent mix." },
      { id: "share", title: "Read share of voice", tools: ["get_visibility_report"],
        why: "How often agents chose you versus each competitor, overall and per task.",
        prompt: "Show share of voice for {product} versus {competitor}, by task and by agent.",
        expect: "Picks per product per task and per agent, and where you lose head to head." },
      { id: "why", title: "Read why they win", tools: ["search_transcripts", "get_agent_session"],
        why: "The reasons agents give for the competitor are your positioning gaps.",
        prompt: "Search my transcripts where agents chose {competitor} and list the reasons they gave.",
        expect: "Quotes and evidence lines grouped by reason." },
    ],
  },
  {
    id: "agent-audit", name: "Agent-by-agent audit", time: "an hour",
    outcome: "Which coding agents never pick you, weighted by how many developers use them.",
    who: "Teams prioritising where to spend docs and partnership effort.",
    example: { title: "Resend by agent", result: "Codex built on Resend in 5 of its 6 sending sessions; Claude Code's two password-recovery losses both went to Postmark." },
    stages: [
      { id: "mix", title: "See the agent mix", tools: ["list_agents"],
        why: "Agents are sampled by real-world usage share, with sources.",
        prompt: "Which coding agents do you test with, and what share of developers uses each?",
        expect: "Agents with their share, sandboxes out of 20 and sources." },
      { id: "run", title: "Run across the mix", tools: ["run_simulation"],
        why: "Every agent needs sessions on your tasks to compare them.",
        prompt: "Run a simulation for {product} across the full agent mix.",
        expect: "Sessions dealt so every harness gets a share." },
      { id: "by-agent", title: "Read results by agent", tools: ["get_visibility_report"],
        why: "The adoption-weighted hit rate tells you what most developers' agents do.",
        prompt: "Show my visibility report for {product} broken down by agent.",
        expect: "Hit rate per agent with ranges, and the adoption-weighted total." },
      { id: "worst", title: "Dig into the agent that skips you", tools: ["get_agent_session", "search_transcripts"],
        why: "Each agent has its own defaults; its transcripts show which ones.",
        prompt: "For the agent with the lowest hit rate, show a session where it chose something else and why.",
        expect: "The session's verdict, evidence and transcript." },
    ],
  },
  {
    id: "new-capability", name: "Launch a new capability", time: "an hour plus the run",
    outcome: "Know whether agents use your new feature for the job it was built for, before and after launch.",
    who: "Product teams shipping a feature or SDK.",
    example: { title: "Resend receiving email", result: "A capability agents didn't associate with Resend at all: the task to add before and after launching inbound." },
    stages: [
      { id: "tasks", title: "Add tasks for the capability", tools: ["save_scenarios", "browse_task_library"],
        why: "Tasks phrased the way a developer would ask, without naming you or the feature.",
        prompt: "Add a task for {product}: <what a developer would ask an agent to build that needs the new capability>.",
        expect: "The task saved, with warnings if it names your product or a competitor." },
      { id: "run", title: "Run the new tasks", tools: ["run_simulation"],
        why: "A baseline before you announce, so the launch has a measurable effect.",
        prompt: "Run a simulation for {product} on the new task only.",
        expect: "A run on that task across the agent mix." },
      { id: "report", title: "Read the result", tools: ["get_visibility_report"],
        why: "Whether agents reach for you, a competitor, or build it themselves.",
        prompt: "Show the result for the new task, and who won if not {product}.",
        expect: "Hit rate on the new task with the winners and evidence." },
    ],
  },
  {
    id: "release-watch", name: "Release watch", time: "minutes, every few weeks",
    outcome: "Catch it when a new model or agent version stops picking you.",
    who: "Anyone with a baseline; repeat when major models ship.",
    example: { title: "Why re-run", result: "Each model, version and harness has its own defaults; a release can change who gets picked without anything changing on your side." },
    stages: [
      { id: "run", title: "Re-run your tasks", tools: ["run_simulation"],
        why: "The same tasks on today's agent mix.",
        prompt: "Re-run my last simulation for {product} on the current agent mix.",
        expect: "A new run with today's agent versions." },
      { id: "trend", title: "Read the trend", tools: ["get_visibility_report"],
        why: "The daily trend shows whether preference moved.",
        prompt: "Show my hit rate trend for {product} over the last 90 days, by agent.",
        expect: "The trend line and per-agent change since the last run." },
    ],
  },
  {
    id: "team-memory", name: "Build your team's memory", time: "ten minutes, then as you go",
    outcome: "Your AI client remembers the company's facts, decisions and preferences, so nobody explains them twice.",
    who: "Anyone on the team; most useful for whoever owns positioning or DevRel.",
    example: { title: "Resend positioning", result: "\"We don't compete with SES on price; lead with deliverability\" saved once; every later report and draft on the team led with deliverability." },
    stages: [
      { id: "save", title: "Save a decision", tools: ["save_to_memory"],
        why: "Lasting context (competitors you ignore, the angle you lead with, internal names) belongs in memory, not in every prompt.",
        prompt: "Remember: we lead with <your angle> against {competitor}, and never compete on price.",
        expect: "The item saved to the company's memory; your team sees it under Context." },
      { id: "recall", title: "Find it again", tools: ["search_memory"],
        why: "Memory is only useful if it comes back when someone asks.",
        prompt: "What have we decided about {competitor}?",
        expect: "The decisions and facts saved about it, newest first." },
      { id: "use", title: "See it used in a new chat", tools: [], manual: true,
        why: "Your AI client reads the newest memory as background at the start of every conversation.",
        prompt: "(In a new chat) Draft the opening of a comparison page for {product} vs {competitor}.",
        expect: "Mark this done when the draft follows what you saved without being told." },
    ],
  },
  {
    id: "byo-personas", name: "Bring your own developer personas", time: "fifteen minutes, plus a run",
    outcome: "Simulations answer as the developers you actually sell to, not a generic population.",
    who: "Product marketing, DevRel or anyone who knows the target developers.",
    example: { title: "A mobile-first API company", result: "Three personas from their ICP (a Flutter lead at a 50-person startup, an enterprise Android team, an indie iOS developer): the enterprise persona's runs picked the incumbent twice as often." },
    stages: [
      { id: "describe", title: "Describe your developers", tools: ["list_developer_profiles", "list_personas"],
        why: "Start from who you target: role, experience, company size, stack and constraints. The shared personas show the shape.",
        prompt: "Show me the developer personas I can use, then help me describe ours: <role>, <stack>, <company size>, <what they care about>.",
        expect: "The shared personas and your own, and a draft of yours to check.",
        link: { href: "/app/personas", label: "Developer personas" } },
      { id: "save", title: "Save your personas", tools: ["save_personas"],
        why: "Saved personas are private to your account; the simulated developer answers coding agents the way they would.",
        prompt: "Save these as our developer personas: <the personas above>.",
        expect: "Each persona saved with its own id, private to your account. You can also add or import them on the Developer personas page.",
        link: { href: "/app/personas", label: "Developer personas" } },
      { id: "run", title: "Run a simulation with them", tools: ["run_simulation"],
        why: "The same tasks, with your developers answering the agents' questions.",
        prompt: "Run a simulation for {product} with our own developer personas.",
        expect: "A run starts with your personas in the sessions." },
    ],
  },
  {
    id: "byo-tasks", name: "Bring your own programming tasks", time: "half an hour, plus a run",
    outcome: "Measure agents on the tasks your customers really bring, from case studies, support tickets or sales calls.",
    who: "DevRel, solutions engineers and anyone with real customer requests to hand.",
    example: { title: "Case studies as tasks", result: "Twelve tasks from 2025 case studies imported as one set: agents picked the product on 9 of the 12, and the 3 losses were all on the same migration path." },
    stages: [
      { id: "product", title: "Pick a product", tools: ["list_products", "get_product", "list_task_sets"],
        why: "A task set belongs to one product; its tasks are tested against that product and its competitors.",
        prompt: "Which products do I have, and which task sets does {product} have?",
        expect: "Your products and any task sets they already have.",
        link: { href: "/app/tasks", label: "Programming tasks" } },
      { id: "import", title: "Import a task set", tools: ["import_tasks"],
        why: "Tasks phrased the way a developer asks a coding agent, never naming your product. Private to your account.",
        prompt: "Import these tasks for {product} as a task set called <name>: <paste the tasks, one per line>.",
        expect: "The task set with its tasks, each with a platform. You can also create, import and edit them on the Programming tasks page.",
        link: { href: "/app/tasks", label: "Programming tasks" } },
      { id: "run", title: "Run a simulation on it", tools: ["run_simulation"],
        why: "Coding agents work only that set's tasks, in fresh sandboxes.",
        prompt: "Run a simulation for {product} on the task set <name>.",
        expect: "A run starts on that set's active tasks across the agent mix." },
      { id: "report", title: "Read the report", tools: ["get_visibility_report"],
        why: "How often agents picked you on your own tasks, and who won where you didn't.",
        prompt: "Show the visibility report for that run.",
        expect: "Hit rate per task in the set, the winners and the transcript evidence." },
    ],
  },
];

// ---------- templates in the database (managed on /admin) ----------

export class PlaybookError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

interface Row { id: string; name: string; outcome: string; who: string; time: string; example_title: string; example_result: string;
  stages: Stage[]; promoted: boolean; position: number; updated_at: Date; updated_by: string | null; org_id: number | null }

const toPlaybook = (r: Row): Playbook & { promoted: boolean; position: number; updated_at: Date; updated_by: string | null; own: boolean } => ({
  id: r.id, name: r.name, outcome: r.outcome, who: r.who, time: r.time, example: { title: r.example_title, result: r.example_result },
  stages: r.stages, promoted: r.promoted, position: r.position, updated_at: r.updated_at, updated_by: r.updated_by, own: r.org_id != null,
});

let seeded = false;
/** The built-in pipelines become the first templates, once (an admin may delete or rewrite them afterwards). */
/** The built-ins that existed before the seed ledger: a database seeded then has them (or deleted them on purpose). */
const FIRST_BUILT_INS = ["baseline", "fix-loss", "head-to-head", "agent-audit", "new-capability", "release-watch"];

/**
 * Built-in journeys, through a ledger (journey_seed): each is added once, so one an admin deleted stays deleted; one
 * still untouched (updated_by 'built-in') follows the code when its stages change; one an admin edited is left alone.
 */
/** For the smoke test: seed again on the next read, as a fresh server would. */
export const __resetSeed = () => { seeded = false; };

async function ensureSeeded() {
  // Seeds Octillion's built-in journeys: shared rows, the platform's (src/tenant-scope.ts).
  return asPlatform(async () => {
  if (seeded) return;
  const db = await getDb();
  const [{ n }] = await db.query<{ n: number }>("SELECT count(*) AS n FROM journey_seed");
  if (!Number(n)) {
    const [{ t }] = await db.query<{ t: number }>("SELECT count(*) AS t FROM journey_templates");
    if (Number(t)) for (const id of FIRST_BUILT_INS) await db.query("INSERT INTO journey_seed (id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
  }
  const done = new Set((await db.query<{ id: string }>("SELECT id FROM journey_seed")).map((r) => r.id));
  for (const p of PLAYBOOKS) {
    if (done.has(p.id)) {
      await db.query("UPDATE journey_templates SET stages = $2, updated_at = now() WHERE id = $1 AND updated_by = 'built-in' AND org_id IS NULL AND stages::text <> $2::jsonb::text",
        [p.id, JSON.stringify(p.stages)]);
      continue;
    }
    const [{ next }] = await db.query<{ next: number }>("SELECT coalesce(max(position), -1) + 1 AS next FROM journey_templates WHERE org_id IS NULL");
    await db.query(
      `INSERT INTO journey_templates (id, name, outcome, who, time, example_title, example_result, stages, promoted, position, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, 'built-in') ON CONFLICT (id) DO NOTHING`,
      [p.id, p.name, p.outcome, p.who, p.time, p.example.title, p.example.result, JSON.stringify(p.stages), Number(next)]);
    await db.query("INSERT INTO journey_seed (id) VALUES ($1) ON CONFLICT DO NOTHING", [p.id]);
  }
  seeded = true;
});
}

/** Global templates (promoted only, if asked), plus with `orgId` that account's own use cases. */
export async function listTemplates(opts: { promotedOnly?: boolean; orgId?: number } = {}) {
  await ensureSeeded();
  const global = `org_id IS NULL${opts.promotedOnly ? " AND promoted" : ""}`;
  const rows = await (await getDb()).query<Row>(
    `SELECT * FROM journey_templates WHERE (${global})${opts.orgId != null ? " OR org_id = $1" : ""} ORDER BY org_id NULLS FIRST, position, name`,
    opts.orgId != null ? [opts.orgId] : []);
  return rows.map(toPlaybook);
}

/**
 * An account's own use case (Add use case on /app/adoption): a name, the outcome and its steps, each a prompt to type,
 * optionally tied to the Octillion tools that complete it (a step without tools is marked done by hand).
 */
export async function createUseCase(org: { orgId: number; slug: string }, actor: string, b: Record<string, any>, toolNames: readonly string[]) {
  const stages = (Array.isArray(b.stages) ? b.stages : []).filter((st: any) => String(st?.title ?? "").trim() || String(st?.prompt ?? "").trim())
    .map((st: any) => ({ ...st, title: String(st.title ?? "").trim() || String(st.prompt ?? "").trim().slice(0, 80), expect: String(st.expect ?? "").trim() || "Your AI client walks you through it." }));
  const t = cleanTemplate({ ...b, stages }, toolNames);
  const db = await getDb();
  const base = `${org.slug}-${slug(t.name)}`.slice(0, 60);
  let id = base;
  for (let i = 2; (await db.query("SELECT 1 FROM journey_templates WHERE id = $1", [id])).length; i++) id = `${base}-${i}`;
  await db.query(
    `INSERT INTO journey_templates (id, name, outcome, who, time, example_title, example_result, stages, promoted, position, updated_by, org_id)
     VALUES ($1, $2, $3, '', '', '', '', $4, false, 0, $5, $6)`, [id, t.name, t.outcome, JSON.stringify(t.stages), actor, org.orgId]);
  return id;
}

/** Remove an account's own use case: whoever added it, or an account admin. Global templates are managed on /admin. */
export async function deleteUseCase(orgId: number, id: string, actor: string, isAdmin: boolean) {
  const db = await getDb();
  const [r] = await db.query<{ updated_by: string | null }>("SELECT updated_by FROM journey_templates WHERE id = $1 AND org_id = $2", [id, orgId]);
  if (!r) throw new PlaybookError("No such use case on this account", 404);
  if (!isAdmin && r.updated_by !== actor) throw new PlaybookError("Only whoever added it, or an account admin, can remove it", 403);
  await db.query("DELETE FROM journey_progress WHERE org_id = $1 AND journey_id = $2", [orgId, id]);
  await db.query("DELETE FROM journey_templates WHERE id = $1 AND org_id = $2", [id, orgId]);
}

const slug = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
const txt = (v: unknown, max: number, field: string, required = true) => {
  const s = String(v ?? "").trim().slice(0, max);
  if (required && !s) throw new PlaybookError(`${field} is required`);
  return s;
};

/** Check and normalise a template from the admin editor. `tools` must be Octillion tool names. */
export function cleanTemplate(b: Record<string, any>, toolNames: readonly string[]) {
  const stagesIn = Array.isArray(b.stages) ? b.stages : [];
  if (!stagesIn.length || stagesIn.length > 12) throw new PlaybookError("A journey needs 1 to 12 stages");
  const ids = new Set<string>();
  const stages: Stage[] = stagesIn.map((st: any, i: number) => {
    const id = slug(st.id || st.title) || `stage-${i + 1}`;
    if (ids.has(id)) throw new PlaybookError(`Two stages are called ${id}`);
    ids.add(id);
    const tools = (Array.isArray(st.tools) ? st.tools : []).map(String).filter(Boolean);
    const bad = tools.find((t: string) => !toolNames.includes(t));
    if (bad) throw new PlaybookError(`Stage ${i + 1}: ${bad} is not an Octillion tool`);
    const manual = Boolean(st.manual) || tools.length === 0;
    return { id, title: txt(st.title, 120, `Stage ${i + 1} title`), why: txt(st.why, 500, `Stage ${i + 1} why`, false),
             prompt: txt(st.prompt, 600, `Stage ${i + 1} prompt`), tools, expect: txt(st.expect, 500, `Stage ${i + 1} "you'll see"`), ...(manual ? { manual: true } : {}),
             ...(typeof st.link?.href === "string" && /^\/app(\/[a-z0-9/-]*)?$/.test(st.link.href) ? { link: { href: st.link.href, label: txt(st.link.label, 60, `Stage ${i + 1} link label`, false) || "Open" } } : {}) };
  });
  return {
    name: txt(b.name, 80, "name"), outcome: txt(b.outcome, 300, "outcome"), who: txt(b.who, 200, "who", false), time: txt(b.time, 80, "time", false),
    example_title: txt(b.example?.title ?? b.example_title, 120, "example title", false), example_result: txt(b.example?.result ?? b.example_result, 600, "example result", false),
    stages,
  };
}

export async function createTemplate(actor: string, b: Record<string, any>, toolNames: readonly string[]) {
  await ensureSeeded();
  const t = cleanTemplate(b, toolNames);
  const id = slug(b.id || t.name);
  if (!id) throw new PlaybookError("A journey needs a name");
  const db = await getDb();
  const [{ next }] = await db.query<{ next: number }>("SELECT coalesce(max(position), -1) + 1 AS next FROM journey_templates");
  try {
    await db.query(
      `INSERT INTO journey_templates (id, name, outcome, who, time, example_title, example_result, stages, promoted, position, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, t.name, t.outcome, t.who, t.time, t.example_title, t.example_result, JSON.stringify(t.stages), Boolean(b.promoted), Number(next), actor]);
  } catch (e) {
    if (/duplicate|unique/i.test((e as Error).message)) throw new PlaybookError(`There is already a journey called ${id}`, 409);
    throw e;
  }
  return id;
}

export async function updateTemplate(actor: string, id: string, b: Record<string, any>, toolNames: readonly string[]) {
  await ensureSeeded();
  const t = cleanTemplate(b, toolNames);
  const r = await (await getDb()).query(
    `UPDATE journey_templates SET name = $2, outcome = $3, who = $4, time = $5, example_title = $6, example_result = $7, stages = $8,
            updated_at = now(), updated_by = $9 WHERE id = $1 RETURNING id`,
    [id, t.name, t.outcome, t.who, t.time, t.example_title, t.example_result, JSON.stringify(t.stages), actor]);
  if (!r.length) throw new PlaybookError("No such journey", 404);
}

export async function setPromoted(actor: string, id: string, promoted: boolean) {
  const r = await (await getDb()).query("UPDATE journey_templates SET promoted = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING id", [id, promoted, actor]);
  if (!r.length) throw new PlaybookError("No such journey", 404);
}

export async function reorder(actor: string, ids: unknown) {
  if (!Array.isArray(ids) || !ids.length) throw new PlaybookError("ids must be the journeys in their new order");
  const db = await getDb();
  for (const [i, id] of ids.entries()) await db.query("UPDATE journey_templates SET position = $2, updated_by = $3 WHERE id = $1", [String(id), i, actor]);
}

export async function deleteTemplate(id: string) {
  const r = await (await getDb()).query("DELETE FROM journey_templates WHERE id = $1 RETURNING id", [id]);
  if (!r.length) throw new PlaybookError("No such journey", 404);
}

// ---------- progress, events and analytics ----------

/**
 * Record newly done stages for an account and send the journey events to PostHog once each: journey_started (first
 * stage of a journey), journey_stage_completed, journey_completed. Runs after tool calls and when /app loads journeys.
 */
export async function syncProgress(org: { orgId: number; slug: string }, distinctId?: string) {
  const db = await getDb();
  const templates = await listTemplates({ promotedOnly: true, orgId: org.orgId });
  const progress = await progressFor(org.orgId, templates);
  const have = new Set((await db.query<{ journey_id: string; stage_id: string }>(
    "SELECT journey_id, stage_id FROM journey_progress WHERE org_id = $1", [org.orgId])).map((r) => `${r.journey_id}/${r.stage_id}`));
  const actor = { distinctId: distinctId ?? `org:${org.slug}`, orgSlug: org.slug };
  for (const p of progress) {
    const before = p.stages.filter((x) => have.has(`${p.id}/${x.id}`)).length;
    let added = 0;
    for (const [i, st] of p.stages.entries()) {
      if (!st.done || st.manual || have.has(`${p.id}/${st.id}`)) continue; // manual stages are recorded when marked
      const r = await db.query("INSERT INTO journey_progress (org_id, journey_id, stage_id, done_at, source) VALUES ($1, $2, $3, $4, 'tool') ON CONFLICT DO NOTHING RETURNING stage_id",
        [org.orgId, p.id, st.id, st.at]);
      if (!r.length) continue;
      if (before + added === 0) capture(actor, "journey_started", { journey: p.id });
      added++;
      capture(actor, "journey_stage_completed", { journey: p.id, stage: st.id, stage_index: i + 1, stages: p.total, source: "tool" });
    }
    if (added && p.done === p.total) capture(actor, "journey_completed", { journey: p.id, stages: p.total });
  }
  return progress;
}

const pending = new Map<number, ReturnType<typeof setTimeout>>();
/** After a tool call: sync this account's journey progress a few seconds later (calls in a burst sync once). */
export function scheduleSync(org: { orgId: number; slug: string }, distinctId?: string) {
  if (process.env.VERCEL) { keepAlive(syncProgress(org, distinctId).catch((e) => console.error("journey sync:", (e as Error).message))); return; }
  if (pending.has(org.orgId)) return;
  pending.set(org.orgId, setTimeout(() => {
    pending.delete(org.orgId);
    syncProgress(org, distinctId).catch((e) => console.error("journey sync:", (e as Error).message));
  }, 3000).unref());
}

/** A person marks a stage with no tool (e.g. "ship the fix") done, or undoes it. */
export async function markStage(org: { orgId: number; slug: string }, userId: string | null, journeyId: string, stageId: string, done: boolean) {
  const t = (await listTemplates({ orgId: org.orgId })).find((x) => x.id === journeyId);
  const st = t?.stages.find((x) => x.id === stageId);
  if (!t || !st) throw new PlaybookError("No such journey stage", 404);
  if (!st.manual) throw new PlaybookError("This stage is marked done by your AI client's tool calls, not by hand");
  const db = await getDb();
  const actor = { distinctId: userId ?? `org:${org.slug}`, orgSlug: org.slug };
  if (done) {
    const r = await db.query("INSERT INTO journey_progress (org_id, journey_id, stage_id, source, user_id) VALUES ($1, $2, $3, 'manual', $4) ON CONFLICT DO NOTHING RETURNING stage_id",
      [org.orgId, journeyId, stageId, userId]);
    if (r.length) capture(actor, "journey_stage_completed", { journey: journeyId, stage: stageId, stage_index: t.stages.indexOf(st) + 1, stages: t.stages.length, source: "manual" });
  } else {
    await db.query("DELETE FROM journey_progress WHERE org_id = $1 AND journey_id = $2 AND stage_id = $3 AND source = 'manual'", [org.orgId, journeyId, stageId]);
  }
  return syncProgress(org, userId ?? undefined);
}

/**
 * For /admin: every template with its funnel across accounts: how many reached each stage, started, completed, the
 * median time from first stage to completion, and the stage where most accounts stopped.
 */
export async function templatesWithAdoption() {
  const templates = await listTemplates();
  const rows = await (await getDb()).query<{ org_id: number; journey_id: string; stage_id: string; done_at: Date }>(
    "SELECT org_id, journey_id, stage_id, done_at FROM journey_progress");
  const [{ n: active }] = await (await getDb()).query<{ n: number }>("SELECT count(DISTINCT org_id) AS n FROM mcp_events WHERE method = 'tools/call'");
  return templates.map((t) => {
    const mine = rows.filter((r) => r.journey_id === t.id);
    const byOrg = new Map<number, Map<string, Date>>();
    for (const r of mine) { const m = byOrg.get(r.org_id) ?? new Map(); m.set(r.stage_id, r.done_at); byOrg.set(r.org_id, m); }
    const stageIds = t.stages.map((s) => s.id);
    const funnel = t.stages.map((s) => ({ id: s.id, title: s.title, reached: [...byOrg.values()].filter((m) => m.has(s.id)).length }));
    const completedOrgs = [...byOrg.values()].filter((m) => stageIds.every((id) => m.has(id)));
    const hours = completedOrgs.map((m) => {
      const ts = stageIds.map((id) => new Date(m.get(id)!).getTime());
      return (Math.max(...ts) - Math.min(...ts)) / 3_600_000;
    }).sort((a, b) => a - b);
    const median = hours.length ? hours[Math.floor(hours.length / 2)] : null;
    // Where accounts stop: the stage with the biggest drop from the one before it.
    let dropoff: { id: string; title: string; lost: number } | null = null;
    for (let i = 1; i < funnel.length; i++) {
      const lost = funnel[i - 1].reached - funnel[i].reached;
      if (lost > 0 && (!dropoff || lost > dropoff.lost)) dropoff = { id: funnel[i].id, title: funnel[i].title, lost };
    }
    const last = mine.reduce<Date | null>((a, r) => (!a || new Date(r.done_at) > new Date(a) ? r.done_at : a), null);
    return { ...t, adoption: { started: byOrg.size, completed: completedOrgs.length, median_hours_to_complete: median, dropoff, last_activity: last, funnel },
             accounts_active: Number(active) };
  });
}

/** Every promoted journey with its stages marked from this account's tool calls, prompts filled in with its product. */
export async function playbooksFor(orgId: number) {
  return progressFor(orgId, await listTemplates({ promotedOnly: true, orgId }));
}

async function progressFor(orgId: number, templates: Playbook[]) {
  const db = await getDb();
  const marked = new Map((await db.query<{ journey_id: string; stage_id: string; done_at: Date }>(
    "SELECT journey_id, stage_id, done_at FROM journey_progress WHERE org_id = $1 AND source = 'manual'", [orgId])).map((r) => [`${r.journey_id}/${r.stage_id}`, r.done_at]));
  const events = await db.query<{ name: string; at: Date }>(
    "SELECT name, at FROM mcp_events WHERE org_id = $1 AND method IN ('tools/call', 'page/action') AND ok ORDER BY at", [orgId]); // page/action: the /app pages' equivalent of a tool
  const [prod] = await db.query<{ name: string; competitors: { name: string }[] }>(
    "SELECT name, competitors FROM products WHERE org_id = $1 ORDER BY created_at LIMIT 1", [orgId]);
  const product = prod?.name ?? "my product";
  const competitor = (prod?.competitors ?? [])[0]?.name ?? "<competitor>";
  const fill = (t: string) => t.replace(/\{product\}/g, product).replace(/\{competitor\}/g, competitor);
  return templates.map((p) => {
    let since = 0; // a stage only counts tool calls after the previous stage was done
    const stages = p.stages.map((st) => {
      const manualAt = st.manual ? marked.get(`${p.id}/${st.id}`) ?? null : null;
      const hit = st.manual ? null : events.find((e) => st.tools.includes(e.name) && new Date(e.at).getTime() >= since);
      const at = hit?.at ?? manualAt;
      if (at) since = Math.max(since, new Date(at).getTime());
      return { ...st, prompt: fill(st.prompt), why: fill(st.why), expect: fill(st.expect), done: Boolean(at), at };
    });
    const own = Boolean((p as { own?: boolean }).own); // the account's own use case, not a global template
    return { id: p.id, name: p.name, outcome: p.outcome, who: p.who, time: p.time, example: { ...p.example }, stages,
             done: stages.filter((x) => x.done).length, total: stages.length, manualCount: stages.filter((x) => x.manual).length,
             own, added_by: own ? ((p as { updated_by?: string | null }).updated_by ?? null) : null };
  });
}

// ---------- adoption per person (/app/adoption) ----------

export interface PersonProgress {
  user_id: string; done: number; total: number; calls: number; errors: number; last_error: string | null;
  stuck: string | null; at: string | null; finished: boolean;
}

/**
 * Each use case, person by person: the same stage rules as the account's progress (a stage counts tool calls after the
 * previous one), on that person's own tool calls; plus their calls and failures on the use case's tools, where they
 * are stuck, and who can help (whoever finished it, else got furthest).
 */
export async function adoptionByPerson(orgId: number, opts: { start?: Date; end?: Date; users?: string[] } = {}) {
  const db = await getDb();
  // Progress counts all time (a stage done last quarter is still done); the range picks who shows up (anyone active in
  // it) and what their calls and errors count. users narrows to those people.
  const inRange = (at: Date) => (!opts.start || new Date(at) >= opts.start) && (!opts.end || new Date(at) < opts.end);
  const only = opts.users?.length ? new Set(opts.users) : null;
  const journeys = await playbooksFor(orgId);
  const events = await db.query<{ user_id: string; name: string; ok: boolean; error: string | null; at: Date }>(
    "SELECT user_id, name, ok, error, at FROM mcp_events WHERE org_id = $1 AND method IN ('tools/call', 'page/action') AND user_id IS NOT NULL ORDER BY at", [orgId]);
  const marked = await db.query<{ journey_id: string; stage_id: string; user_id: string | null; done_at: Date }>(
    "SELECT journey_id, stage_id, user_id, done_at FROM journey_progress WHERE org_id = $1 AND source = 'manual'", [orgId]);
  const byUser = new Map<string, typeof events>();
  for (const e of events) (byUser.get(e.user_id) ?? byUser.set(e.user_id, []).get(e.user_id)!).push(e);
  return journeys.map((j) => {
    const tools = new Set(j.stages.flatMap((s) => s.tools));
    const people: PersonProgress[] = [];
    const users = new Set([...byUser.keys(), ...marked.filter((m) => m.journey_id === j.id && m.user_id).map((m) => m.user_id!)]);
    for (const user of users) {
      if (only && !only.has(user)) continue;
      const mine = (byUser.get(user) ?? []).filter((e) => tools.has(e.name));
      const marks = marked.filter((m) => m.journey_id === j.id && m.user_id === user);
      if (!mine.length && !marks.length) continue; // never touched this use case
      const recent = mine.filter((e) => inRange(e.at));
      if (!recent.length && !marks.some((m) => inRange(m.done_at))) continue; // nothing in the range
      let since = 0, done = 0, stuck: string | null = null, lastMs = 0;
      for (const st of j.stages) {
        const at = st.manual ? marks.find((m) => m.stage_id === st.id)?.done_at ?? null
          : mine.find((e) => e.ok && st.tools.includes(e.name) && new Date(e.at).getTime() >= since)?.at ?? null;
        if (at) { done++; since = Math.max(since, new Date(at).getTime()); lastMs = Math.max(lastMs, new Date(at).getTime()); }
        else stuck ??= st.title;
      }
      const failed = recent.filter((e) => !e.ok);
      const lastAt = mine.reduce((m, e) => Math.max(m, new Date(e.at).getTime()), lastMs);
      people.push({ user_id: user, done, total: j.stages.length, calls: recent.length, errors: failed.length, last_error: failed.at(-1)?.error ?? null,
        stuck: done < j.stages.length ? stuck : null, at: lastAt ? new Date(lastAt).toISOString() : null, finished: done === j.stages.length });
    }
    people.sort((a, b) => b.done - a.done || b.calls - a.calls);
    const helper = people.find((x) => x.finished) ?? people.find((x) => x.done > 0) ?? null;
    return { id: j.id, name: j.name, outcome: j.outcome, own: j.own, added_by: j.added_by, total: j.stages.length, people, helper: helper?.user_id ?? null };
  });
}

// ---------- import ----------

/** Import use cases from a file (our export, or any list of { name, outcome, stages: [{ title, prompt }] }). A name the
 *  account already has (its own or Octillion's) is skipped, so importing the same file twice adds nothing. */
export async function importUseCases(org: { orgId: number; slug: string }, actor: string, items: unknown, toolNames: readonly string[]) {
  if (!Array.isArray(items)) throw new PlaybookError("items must be a list of use cases");
  if (items.length > 100) throw new PlaybookError("Import at most 100 use cases at a time");
  const taken = new Set((await playbooksFor(org.orgId)).map((j) => j.name.trim().toLowerCase()));
  let imported = 0, skipped = 0;
  const errors: string[] = [];
  for (const it of items as Record<string, any>[]) {
    const name = String(it?.name ?? "").trim();
    if (!name || taken.has(name.toLowerCase())) { skipped++; continue; }
    try {
      await createUseCase(org, actor, { name, outcome: it.outcome, stages: it.stages }, toolNames);
      taken.add(name.toLowerCase()); imported++;
    } catch (e) { skipped++; if (errors.length < 5) errors.push(`${name}: ${(e as Error).message}`); }
  }
  return { imported, skipped, errors };
}

// ---------- help requests ----------
// Someone stuck on a use case asks the team; a teammate picks it up (and gets the asker's email and where they are
// stuck), then either of them marks it done. One live request per person per use case.

export interface HelpRequest { id: number; journey_id: string; requester: string; helper: string | null; note: string; status: "open" | "picked" | "done"; created_at: string; picked_at: string | null }

export async function helpRequests(orgId: number): Promise<HelpRequest[]> {
  const db = await getDb();
  return db.query<HelpRequest>(
    `SELECT id::int AS id, journey_id, requester, helper, note, status, created_at, picked_at FROM adoption_help
      WHERE org_id = $1 AND (status <> 'done' OR closed_at > now() - interval '14 days') ORDER BY created_at DESC LIMIT 500`, [orgId]);
}

export async function askForHelp(orgId: number, journeyId: string, requester: string, note: unknown) {
  const db = await getDb();
  if (!(await playbooksFor(orgId)).some((j) => j.id === journeyId)) throw new PlaybookError("No such use case", 404);
  const [live] = await db.query<{ id: number }>(
    "SELECT id::int AS id FROM adoption_help WHERE org_id = $1 AND journey_id = $2 AND requester = $3 AND status <> 'done'", [orgId, journeyId, requester]);
  if (live) return live.id;
  const [r] = await db.query<{ id: number }>(
    "INSERT INTO adoption_help (org_id, journey_id, requester, note) VALUES ($1, $2, $3, $4) RETURNING id::int AS id",
    [orgId, journeyId, requester, String(note ?? "").trim().slice(0, 500)]);
  return r.id;
}

async function helpRow(orgId: number, id: number) {
  const db = await getDb();
  const [r] = await db.query<HelpRequest>("SELECT id::int AS id, journey_id, requester, helper, status FROM adoption_help WHERE org_id = $1 AND id = $2", [orgId, id]);
  if (!r) throw new PlaybookError("No such help request", 404);
  return r;
}

/** Pick up someone else's open request. */
export async function pickUpHelp(orgId: number, id: number, helper: string) {
  const r = await helpRow(orgId, id);
  if (r.requester === helper) throw new PlaybookError("That is your own request");
  if (r.status !== "open") throw new PlaybookError(r.status === "picked" ? "Someone already picked this up" : "This request is closed", 409);
  const db = await getDb();
  await db.query("UPDATE adoption_help SET helper = $3, status = 'picked', picked_at = now() WHERE org_id = $1 AND id = $2 AND status = 'open'", [orgId, id, helper]);
  return r;
}

/** done: the asker or the helper closes it. release: the helper hands it back. cancel: the asker withdraws it. */
export async function updateHelp(orgId: number, id: number, actor: string, action: "done" | "release" | "cancel") {
  const r = await helpRow(orgId, id);
  const db = await getDb();
  if (action === "cancel") {
    if (r.requester !== actor) throw new PlaybookError("Only whoever asked can withdraw it", 403);
    await db.query("DELETE FROM adoption_help WHERE org_id = $1 AND id = $2", [orgId, id]);
  } else if (action === "release") {
    if (r.helper !== actor) throw new PlaybookError("Only the helper can hand it back", 403);
    await db.query("UPDATE adoption_help SET helper = NULL, status = 'open', picked_at = NULL WHERE org_id = $1 AND id = $2", [orgId, id]);
  } else {
    if (r.requester !== actor && r.helper !== actor) throw new PlaybookError("Only the asker or the helper can close it", 403);
    await db.query("UPDATE adoption_help SET status = 'done', closed_at = now() WHERE org_id = $1 AND id = $2", [orgId, id]);
  }
}
