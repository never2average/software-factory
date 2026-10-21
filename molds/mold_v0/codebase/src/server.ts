import * as priv from "./private.js";
import { withTenant } from "./tenant-scope.js";
import * as contributions from "./contributions.js";
import { accountRefusal, canAccount, type AccountPermission } from "./account-roles.js";
import { readFileSync } from "node:fs";
import { chatLine, nudgeForChat } from "./journeys.js";
import { span } from "./telemetry.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import * as q from "./queries.js";
import * as research from "./research.js";
import type { Org } from "./auth.js";
import { errorClass, jsonBytes, recordMcpEvent } from "./analytics.js";
import { limitsFor } from "./rate-limits.js";
import * as memory from "./context.js";
import * as vis from "./visibility.js";
import { registerPackTools, reserveShellTools } from "./packs.js";
import { generatedInstructions } from "./mcp-tools.js";
import { PROFILE } from "./profile.js";

/** Hosts (ChatGPT in particular) cache the template by URI: bump the version on breaking HTML/JS changes. */
export const WIDGET_URI = "ui://octillion/dashboard-v2.html";
export const WIDGET_HTML = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "ui", "widget.html"),
  "utf8",
);

const pct = (x: number | null | undefined) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
const competitor = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  packages: z.array(z.string()).optional(),
  domains: z.array(z.string()).optional(),
  evidence_url: z.string().url().optional().describe("A page showing it competes (research sets this from its searches)"),
  source: z.enum(["research", "customer", "runs"]).optional().describe("Who added it; omit when adding by hand (customer)"),
});

/** Tool name -> handler, for one organization. Shared by the MCP server and the local preview. */
export function handlersFor(org: Org) {
  return {
    get_started: () => q.getStarted(org),
    list_products: () => q.listProducts(org),
    onboard_product: (a: research.OnboardInput) => research.onboardProduct(org, a),
    get_onboarding: (a: { research_id?: string; product?: string }) => research.getOnboarding(org, a),
    get_product: (a: { product?: string }) => q.getProduct(org, a.product),
    save_product: (a: q.ProductInput) => q.saveProduct(org, a),
    save_scenarios: (a: { product?: string; scenarios: q.ScenarioInput[] }) => q.saveScenarios(org, a.product, a.scenarios),
    run_simulation: (a: q.RunInput) => q.runSimulation(org, a),
    list_simulations: (a: { product?: string }) => q.listSimulations(org, a.product),
    get_simulation: (a: { simulation_id: string }) => q.getSimulation(org, a.simulation_id),
    cancel_simulation: (a: { simulation_id: string }) => q.cancelSimulation(org, a.simulation_id),
    get_visibility_report: (a: { product?: string; days?: number; model?: string; population?: string; simulation?: string; platform?: string }) => q.getReport(org, a),
    export_visibility_report: (a: Parameters<typeof vis.mcpExport>[1]) => vis.mcpExport(org, a),
    get_agent_session: (a: { session_id: string }) => q.getSession(org, a.session_id),
    get_session_transcript: (a: { session_id: string; offset?: number; limit?: number }) =>
      q.getTranscript(org, a.session_id, a.offset, a.limit),
    search_transcripts: (a: Parameters<typeof q.searchTranscripts>[1]) => q.searchTranscripts(org, a),
    list_developer_profiles: (a: { query?: string; product?: string }) => q.listProfiles(org, a),
    list_agents: (a: { population?: string }) => q.listAgents(org, a),
    browse_task_library: (a: { query?: string; category?: string; language?: string; platform?: string; limit?: number }) => q.browseTaskLibrary(a),
    save_harness_mix: (a: { name: string; description?: string; agents: { agent_id: string; share: number }[] }) => priv.saveHarnessMix(org, a),
    list_harness_mixes: (_a: Record<string, never>) => priv.listHarnessMixes(org),
    review_draft_tasks: (a: { product?: string; approve?: number[]; reject?: number[] }) => research.reviewDraftTasks(org, a),
    save_personas: (a: { personas: priv.PersonaInput[] }) => priv.savePersonas(org, a.personas),
    list_personas: (_a: Record<string, never>) => priv.listPersonas(org),
    import_tasks: (a: { product?: string; task_set: string; description?: string; tasks: priv.TaskInput[] }) => priv.importTasks(org, a),
    list_task_sets: (a: { product?: string }) => priv.listTaskSets(org, a.product),
    publish_to_library: (a: { persona?: string; task_id?: number }) => {
      if ((a.persona == null) === (a.task_id == null)) throw new Error("Pass one of persona (a slug from list_personas) or task_id (a task id from list_task_sets)");
      return contributions.publish(org, `ai:${org.userId ?? org.slug}`, a.persona != null ? "persona" : "task", String(a.persona ?? a.task_id));
    },
    register_harness: (a: { spec: priv.HarnessSpec }) => priv.registerHarness(org, a.spec),
    list_harnesses: (_a: Record<string, never>) => priv.listHarnesses(org),
    save_to_memory: (a: { body: string; kind?: string; scope?: memory.ToolScope; product?: string }) => memory.saveMemoryFromAI(org, a),
    search_memory: (a: { query?: string; scope?: memory.ToolScope | "all"; product?: string; limit?: number }) => memory.searchMemory(org, a),
  };
}
type Handlers = ReturnType<typeof handlersFor>;
export type ToolName = keyof Handlers;
type Data = Awaited<ReturnType<Handlers[ToolName]>>;

/** A persona's or task's publication to Octillion's library, for the summaries. */
const pubLine = (p: { status: string; reason?: string | null } | null | undefined) =>
  !p ? "" : p.status === "accepted" ? ", published to Octillion's library" : p.status === "declined" ? `, declined by Octillion's library${p.reason ? `: ${p.reason}` : ""}` : ", submitted to Octillion's library";

/** Model-readable summary placed in the text content next to the structured data. */
function summarize(d: Data): string {
  switch (d.view) {
    case "products":
      if ("welcome" in d && d.welcome) return d.welcome.message;
      return d.products.length
        ? `${d.org.name} has ${d.products.length} product(s): ${d.products.map((p: any) => `${p.name} [${p.slug}] (${p.scenarios} scenarios, ${p.sessions_30d} scored runs in 30d, hit rate ${pct(p.hit_rate_30d)})`).join("; ")}.`
        : `${d.org.name} has no products yet. Start with onboard_product: a short description plus the website and docs links, and Octillion researches the rest (or use save_product to enter the details by hand).`;
    case "product": {
      const p = d.product;
      return `${p.name} [${p.slug}]: ${p.description || "(no description)"} Category: ${p.category || "n/a"}. Aliases: ${p.aliases.join(", ") || "none"}. Packages: ${p.packages.join(", ") || "none"}. Competitors: ${p.competitors.map((c) => c.name).join(", ") || "none"}. ${d.scenarios.length} scenarios (${d.scenarios.filter((s: any) => s.active).length} active)${d.scenarios.length ? `: ${d.scenarios.map((s: any) => `#${s.id} ${s.title} (${s.library_task_id ? `library task #${s.library_task_id}` : `not from the library: ${s.source}`}, ${s.platform ?? "?"}, ${s.expectation}, hit ${pct(s.hit_rate)} of ${s.sessions})`).join("; ")}` : ""}. Worker agents: ${d.agents.map((a: any) => `${a.id} (${pct(a.weight)})`).join(", ")}.${d.warnings.length ? ` Warnings: ${d.warnings.join(" ")}` : ""}`;
    }
    case "simulations":
      return d.simulations.length
        ? `${d.simulations.length} simulations: ${d.simulations.slice(0, 10).map((s: any) => `${s.id} "${s.name}" ${s.status} ${s.finished}/${s.sessions} done, hit ${pct(s.hit_rate)}`).join("; ")}.`
        : "No simulations yet. Launch one with run_simulation.";
    case "simulation": {
      const s = d.simulation;
      const sampling = Object.values((s.sampling ?? {}) as Record<string, { status: string }>);
      const count = (st: string) => sampling.filter((x) => x.status === st).length;
      const adaptive = !s.max_samples ? "" : !sampling.length
        ? ` Adaptive sampling: up to ${s.max_samples} sessions per scenario, more are added until each result is stable.`
        : ` Adaptive sampling (up to ${s.max_samples} per scenario): ${count("settled")} scenario(s) settled, ${count("cap reached")} at the cap, ${count("sampling more")} still being sampled${sampling.some((x) => x.status.startsWith("stopped")) ? `, ${sampling.filter((x) => x.status.startsWith("stopped")).length} stopped by a limit` : ""}.`;
      const base = `Simulation ${s.id} "${s.name}" for ${s.product}: ${s.status}. ${d.totals.sessions} agent sessions (${Object.entries(d.status).map(([k, v]) => `${v} ${k}`).join(", ")}). Hit rate ${pct(d.totals.hit_rate)} over ${d.totals.scored} scored. Verdicts: ${Object.entries(d.verdicts).map(([k, v]) => `${k} ${v}`).join(", ") || "none yet"}.${Object.keys(d.completed_reasons ?? {}).length ? ` Ended: ${Object.entries(d.completed_reasons).map(([k, v]) => `${k} ${v}`).join(", ")}.` : ""} By agent: ${d.by_agent.map((a: any) => `${a.label} ${pct(a.hit_rate)} (n=${a.scored})`).join(", ")}.${d.capacity ? ` Capacity: ${d.capacity.message}` : ""}`;
      const budget = d.budget ? ` Budget: ${d.budget.line}${d.budget.warning ? ` ${d.budget.warning}` : ""}` : "";
      // Execution modes: plan-then-execute vs direct, when the run compared them (paired sessions).
      const modeName = { plan: "plan then execute", direct: "direct execution" } as Record<string, string>;
      const modes = d.by_mode.length > 1
        ? ` By execution mode: ${d.by_mode.map((m: any) => `${modeName[m.mode]} ${pct(m.hit_rate)} (${m.hits}/${m.scored})`).join(" vs ")}; per agent: ${
            [...new Set(d.by_mode.flatMap((m: any) => m.by_agent.map((a: any) => a.label)))].map((label) =>
              `${label} ${d.by_mode.map((m: any) => pct(m.by_agent.find((a: any) => a.label === label)?.hit_rate ?? null)).join(" vs ")}`).join("; ")}.`
        : d.by_mode.length === 1 ? ` Execution: ${modeName[d.by_mode[0].mode]}.` : "";
      return base + modes + adaptive + budget;
    }
    case "report":
      return reportMarkdown(d);
    case "visibility_export": {
      const sum = d.sections.find((x) => x.id === "summary");
      const val = (k: string) => sum?.rows.find((r) => r[0] === k)?.[1];
      const f = d.filters, picked = [f.product && `product ${f.product.name}`, f.competitor.length && `competitors ${f.competitor.join(", ")}`,
        f.persona.length && `personas ${f.persona.map((x) => x.name ?? `#${x.id}`).join(", ")}`, f.task.length && `tasks ${f.task.map((x) => x.title ?? `#${x.id}`).join(", ")}`].filter(Boolean);
      return `${d.report} for ${d.account}, ${d.range.from} to ${d.range.to}${picked.length ? ` (${picked.join("; ")})` : ""}: ${d.sections.map((x) => x.title).join(", ")}.` +
        (sum ? ` Pick rate ${val("pick_pct") ?? "n/a"}% (${val("hits")} hits of ${val("scored")} scored sessions), picked ${val("picked")} times, top competitor ${val("top_competitor") ?? "none"}.` : "") +
        (d.format === "csv" ? ` The CSV (${d.filename}) is in \`csv\`: one row per table row, a section column first.` : ` Tables per section in \`sections\` (${d.filename}).`);
    }
    case "session": {
      const s = d.session;
      const ev = (s.mentions ?? []).map((m: any) => `${m.tool}: ${m.level}${m.evidence[0] ? ` (#${m.evidence[0].seq} "${m.evidence[0].snippet}")` : ""}`);
      return `Session ${s.id}: ${s.model} on "${s.scenario}" (${s.product})${s.profile ? ` as ${s.profile}` : ""}, ${s.status}${s.completed_reason ? ` (${s.completed_reason}${s.agent_turns != null ? ` after ${s.agent_turns} agent turns` : ""})` : ""}, ${s.user_turns} questions answered by the simulated developer. Verdict: ${s.verdict ?? "not scored yet"}${s.winner ? `, went with ${s.winner}` : ""}. ${s.events} transcript events.${ev.length ? ` Evidence: ${ev.join("; ")}.` : ""}${s.error_message ? ` Error: ${s.error_message}.` : ""}`;
    }
    case "transcript":
      return `Transcript of ${d.session_id} (${d.model}, "${d.scenario}", verdict ${d.verdict ?? "pending"}): events ${d.total ? d.offset + 1 : 0}-${d.offset + d.events.length} of ${d.total}.`;
    case "agents":
      return `Developer population "${d.population.name}" [${d.population.slug}]${d.populations.length > 1 ? ` (others: ${d.populations.filter((p: any) => p.slug !== d.population.slug).map((p: any) => p.slug).join(", ")})` : ""}. Coding agents (as of ${d.as_of ?? "n/a"}), weighted by real-world developer adoption, rounded to whole sandboxes out of ${d.sandbox_unit}: ${d.agents.filter((a) => a.enabled).map((a) => `${a.id} ${a.sandboxes}/${d.sandbox_unit} (${pct(a.weight)})`).join(", ")}.${d.agents.some((a) => !a.enabled) ? ` Not runnable yet: ${d.agents.filter((a) => !a.enabled).map((a) => a.label).join(", ")}.` : ""}${d.unrepresented_share != null ? ` Usage share not representable (IDE-only tools): ${pct(d.unrepresented_share)}.` : ""} A default run samples ${d.default_samples} sessions per scenario in these proportions. Runnable agents cover ${pct(d.runnable_coverage)} of representable usage${d.agents.some((a) => a.status === "adapter pending") ? `; adapters pending for ${d.agents.filter((a) => a.status === "adapter pending").map((a) => a.label).join(", ")}` : ""}.`;
    case "onboarding": {
      const r = d.research, p = d.product;
      const head = `Onboarding ${r.id} for ${p.name}: ${r.status}${r.stage && r.status === "running" ? ` (${r.stage}${r.note ? `: ${r.note}` : ""})` : ""}.`;
      if (r.status === "failed" && d.failure)
        return `${head} ${d.failure.summary} What to do next: ${d.failure.next.map((x: string, i: number) => `(${i + 1}) ${x}`).join(" ")} Tell the user plainly; do not show internal error text.`;
      if (r.status === "queued" && d.capacity) return `${head} Capacity: ${d.capacity.message} Check again with get_onboarding.`;
      if (r.status !== "completed") return `${head} The orchestrator is researching the website and docs, then writes the product profile, target developer personas and programming problems. Check again with get_onboarding.`;
      return `${head} Profile: ${p.category || "n/a"}; aliases ${p.aliases.join(", ") || "none"}; packages ${p.packages.join(", ") || "none"}; competitors ${p.competitors.map((c: any) => c.name).join(", ") || "none"}. Personas: ${d.personas.map((x: any) => x.name).join("; ")}. Problems (${d.scenarios.length}): ${d.scenarios.map((s: any) => `#${s.id} ${s.title} [${s.source}${s.expectation === "avoid" ? ", avoid" : ""}]`).join("; ")}.${d.drafts?.length ? ` Draft tasks waiting for the user's approval (research wrote them because the library had nothing fitting; they run only once approved with review_draft_tasks): ${d.drafts.map((s: any) => `#${s.id} ${s.title}`).join("; ")}.` : ""}${d.simulation ? ` Simulation ${d.simulation.id}: ${d.simulation.status}, ${d.simulation.finished}/${d.simulation.sessions} sessions done; see get_simulation / get_visibility_report.` : d.next_step ? ` Next step, offer it to the user now: ${d.next_step.message} If they agree, call ${d.next_step.tool} ${JSON.stringify(d.next_step.args)}.` : r.status === "completed" && d.drafts?.length ? " No task is active yet: ask the user to review the draft tasks (review_draft_tasks), then run_simulation." : ""}`;
    }
    case "profiles":
      return d.profiles.length
        ? `${d.profiles.length} developer profiles${d.query ? ` matching "${d.query}"` : ""}: ${d.profiles.map((p: any) => `${p.slug} (${p.name}: ${p.summary})`).join("; ")}. Pass slugs as run_simulation profiles.`
        : "No developer profiles synced from the vault yet.";
    case "personas":
      return d.personas.length
        ? `${d.personas.length} private persona(s) of this organization: ${d.personas.map((p: any) => `${p.slug} (${p.name}, ${p.source}${p.active ? "" : ", inactive"}${pubLine(p.publication)})`).join("; ")}. Pass slugs as run_simulation profiles. Only this organization can see or use them.`
        : "No private personas yet. Add your own with save_personas, or pick shared ones with list_developer_profiles.";
    case "task_sets":
      return d.task_sets.length
        ? `${d.task_sets.length} private task set(s): ${d.task_sets.map((t: any) => `${t.name} [${t.id}] for ${t.product}: ${t.active_tasks} active task(s)${(t.tasks ?? []).some((x: any) => x.publication) ? ` (published to Octillion's library: ${(t.tasks ?? []).filter((x: any) => x.publication).map((x: any) => `#${x.id}${pubLine(x.publication)}`).join(", ")})` : ""}`).join("; ")}. Run one with run_simulation {task_set}.`
        : "No private task sets yet. Bring your own with import_tasks.";
    case "library_submission":
      return `Submitted ${d.kind === "persona" ? "persona" : "task"} "${d.title}" to Octillion's library for review. Only its content is shared, never the account's name; if Octillion accepts it, it may be used for every customer, and the account earns a $${d.credit_usd} credit on its next invoice. Its status shows in list_${d.kind === "persona" ? "personas" : "task_sets"}; it can be withdrawn from the Developer personas or Programming tasks page until it is reviewed.`;
    case "library":
      return d.tasks.length
        ? `${d.tasks.length} library tasks: ${d.tasks.map((t: any) => `#${t.id} ${t.title} [${t.platform ?? "?"}, ${t.category ?? "uncategorized"}${t.language ? `, ${t.language}` : ""}]`).join("; ")}. Categories: ${d.categories.map((c: any) => `${c.category ?? "uncategorized"} (${c.tasks})`).join(", ")}. Platforms: ${(d.platforms ?? []).map((c: any) => `${c.platform ?? "?"} (${c.tasks})`).join(", ")}. Add one to a product with save_scenarios {library_task_id}.`
        : "No matching tasks in the library.";
    case "harness_mixes":
      return d.mixes.length
        ? `${d.mixes.length} private harness mix(es): ${d.mixes.map((m: any) => `${m.name} [${m.slug}]: ${m.agents.map((a: any) => `${a.agent_id} ${Math.round(a.share * 100)}%`).join(", ")}`).join("; ")}. Run one with run_simulation {population: slug}; its reports are labelled and never blended with the default mix.`
        : "No private harness mixes yet. The default is the market-weighted mix (list_agents); define your own with save_harness_mix.";
    case "harnesses":
      return d.harnesses.length
        ? `${d.harnesses.length} private harness(es): ${d.harnesses.map((h: any) => `${h.name} ${h.version} [${h.id}]: ${h.status}${h.status_reason ? ` (${h.status_reason})` : ""}`).join("; ")}. A harness runs only once it is approved after an isolated build and scan.`
        : "No private harnesses yet. Submit a declarative spec with register_harness.";
    case "memory": {
      const line = (m: any) => `#${m.id} [${m.scope === "product" ? m.subject_name : m.scope === "user" ? "you" : "company"}, ${m.kind}] ${m.body}`;
      const whose = d.saved?.scope === "user" ? "your" : d.saved?.scope === "company" ? "the company's" : `${d.saved?.subject_name}'s`;
      if (d.action === "saved") return `Saved to ${whose} memory: ${line(d.saved)}${/[.!?]$/.test(d.saved!.body) ? "" : "."} The team sees it on the Octillion account page under Context, and it is part of the background you get at the start of every conversation.`;
      return d.items.length
        ? `${d.items.length} memory item(s)${d.query ? ` matching "${d.query}"` : ""}, newest first: ${d.items.map(line).join(" | ")}`
        : `Nothing in memory${d.query ? ` matches "${d.query}"` : " yet"}. Save what the team should not have to repeat with save_to_memory.`;
    }
    case "search": {
      const r = d.results;
      return `${r.total} transcript events match "${d.query}" (${d.filters.mode}).${r.hits.length ? ` Top: ${r.hits.slice(0, 5).map((h) => `${h.session_id}#${h.seq} (${h.type}, ${h.model}): ${h.text.slice(0, 120)}`).join(" | ")}` : ""}`;
    }
  }
}

/**
 * The visibility report as a sectioned Markdown document, in the order a written report uses (docs/case-studies/resend.md):
 * headline findings, results by task, by agent, by persona, share of voice, the agents' own words, method, limits.
 */
export function reportMarkdown(d: Extract<Data, { view: "report" }>): string {
  const t = d.totals, name = d.product.name, m = d.method;
  const range = (ci: [number, number] | null) => (ci ? `${Math.round(ci[0] * 100)}–${Math.round(ci[1] * 100)}%` : "–");
  const cell = (s: string) => String(s ?? "").replace(/\|/g, "/");
  const scope = (m.scope ? `run ${m.scope.simulation} "${m.scope.name}" (${m.scope.status})` : `last ${d.filters.days} days`) +
    (d.population && !d.population.is_default ? `, custom harness mix "${d.population.name}" (not the market-weighted default; do not compare it with default-mix figures)` : "");
  if (!Number(t.sessions)) return `# ${name}: agent visibility report\n\nNo scored agent sessions (${scope}${d.filters.model ? `, ${d.filters.model}` : ""}). Run a simulation with run_simulation.`;
  const out: string[] = [`# ${name}: agent visibility report`, `Scope: ${scope}${d.filters.model ? `, model ${d.filters.model}` : ""}${d.filters.platform ? `, ${d.filters.platform} tasks only` : ""}. ${t.sessions} scored sessions.`];

  out.push("## Headline", ...d.headline.map((h: string) => `- ${h}`),
    `- Right call on ${pct(t.hit_rate)} of all scored sessions, should-win and control tasks together (95% range ${range(t.hit_ci)})${t.weighted_hit_rate != null ? `, adoption-weighted ${pct(t.weighted_hit_rate)}` : ""}; lost to a competitor ${pct(t.competitor_rate)}.`);

  if (d.by_platform?.length) out.push("## Results by platform", `| Platform | Tasks | Sessions (should win) | ${cell(name)} | Competitor | No vendor | Mentioned ${cell(name)} | 95% range | Control correct |`, "|---|---|---|---|---|---|---|---|---|",
    ...d.by_platform.map((x: any) => `| ${x.platform} | ${x.tasks} | ${x.sessions} | ${x.product} | ${x.competitor} | ${x.no_vendor} | ${x.product_mentioned} | ${range(x.hit_ci)} | ${x.control.sessions ? `${x.control.correct} of ${x.control.sessions}` : "–"} |`));

  out.push("## Results by task", `| Task | Library task | Platform | Should ${cell(name)} win? | Scored | ${cell(name)} | Competitor | No vendor | Mentioned ${cell(name)} | 95% range |`, "|---|---|---|---|---|---|---|---|---|---|",
    ...d.by_scenario.map((s: any) => {
      const o = s.outcomes ?? { product: s.hits, competitor: 0, no_vendor: 0 };
      const winners = (s.winners ?? []).map((w: any) => `${w.tool} ${w.sessions}`).join(", ");
      return `| ${cell(s.title)} | ${s.library_task_id ? `#${s.library_task_id}` : `none (${s.source ?? "custom"})`} | ${s.platform ?? "–"} | ${s.expectation === "recommend" ? "yes" : "no (control)"} | ${s.sessions} | ${o.product} | ${winners || o.competitor} | ${o.no_vendor} | ${s.product_mentioned ?? "–"} | ${range(s.hit_ci)} |`;
    }));
  const shortlists = d.by_scenario.filter((s: any) => s.expectation === "recommend" && s.alternatives?.length);
  if (shortlists.length) out.push("", "Named instead of " + name + " (sessions that did not choose it):", ...shortlists.map((s: any) => `- ${s.title}: ${s.alternatives.slice(0, 5).map((a: any) => `${a.tool} ${a.sessions}`).join(", ")}`));

  const agents = d.by_agent.filter((a: any) => a.on_target?.sessions);
  if (agents.length) out.push(`## By agent (tasks ${name} should win)`, `| Agent | Sessions | ${cell(name)} | Competitor | No vendor |`, "|---|---|---|---|---|",
    ...agents.map((a: any) => `| ${cell(a.label)} | ${a.on_target.sessions} | ${a.on_target.product} | ${a.on_target.competitor} | ${a.on_target.no_vendor} |`));
  if (d.by_profile.length > 1) out.push("## By developer persona", ...d.by_profile.map((p: any) => `- ${p.name}: ${pct(p.hit_rate)} of ${p.sessions} (95% range ${range(p.hit_ci)}), ${Number(p.avg_user_turns || 0).toFixed(1)} questions answered on average`));
  if (d.share_of_voice.length) out.push("## Share of voice", "Share of scored sessions where the agent recommended or adopted each tool:",
    ...d.share_of_voice.slice(0, 8).map((v: any) => `- ${v.tool}${v.target ? " (product)" : ""}: ${pct(v.share)} (recommended ${v.recommended}, adopted ${v.adopted}, mentioned ${v.mentioned})`));

  const ut = d.untracked_tools;
  if (ut?.packages?.length) out.push("## Installed but not tracked",
    `In the ${ut.sessions_with_no_tool} sessions scored "no vendor", agents installed these packages, which match neither ${name} nor a tracked competitor. Any that do the same job is a missing competitor: offer to add it with save_product (keep the existing competitors in the list).`,
    ...ut.packages.map((x: any) => `- ${x.name} (${x.ecosystem}): ${x.sessions} session${x.sessions === 1 ? "" : "s"}`));

  if (d.evidence.length) out.push("## Evidence: the deciding sessions", "Losses first, then sessions that built without a vendor. Read the transcript around #seq with get_session_transcript.",
    ...d.evidence.map((e: any) => `- ${e.session_id} · ${e.agent}${e.profile ? ` as ${e.profile}` : ""} · "${e.scenario}" → ${e.outcome === "product" ? name : e.outcome === "competitor" ? e.winner ?? "competitor" : `no vendor${e.mentioned_product ? ` (mentioned ${name})` : ""}`}${e.evidence ? `: "${e.evidence.quote}" (${e.evidence.tool}, ${e.evidence.level}, #${e.evidence.seq})` : ""}`));

  out.push("## How this was run",
    `- ${m.tasks.total} tasks (${m.tasks.recommend} ${name} should win, ${m.tasks.avoid} control); ${m.sessions} sessions, ${m.scored} scored; agent spend $${Number(m.cost_usd).toFixed(2)}.`,
    `- Agents: ${m.agents.map((a: any) => `${a.label} ${a.sessions}`).join(", ") || "n/a"}.`,
    `- Personas: ${m.personas.map((p: any) => `${p.name} ${p.sessions}`).join(", ") || "none"}.`,
    `- Competitors credited: ${m.competitors.join(", ") || "none configured"}.`,
    ...(m.sampling ? [`- Adaptive sampling up to ${m.sampling.max_per_task} per task: ${m.sampling.settled} settled, ${m.sampling.at_cap} at the cap.`] : []));
  out.push("## Limits", ...d.limits.map((l: string) => `- ${l}`));
  return out.join("\n");
}

/**
 * Character budget for structuredContent. Claude (web/desktop) stops passing a tool result inline to the app above
 * ~150k characters, and the text content repeats the JSON for the model, so each half stays well under half of that.
 */
export const STRUCTURED_BUDGET = 50_000;

const capStrings = (v: unknown, cap: number): unknown =>
  typeof v === "string"
    ? v.length > cap ? `${v.slice(0, cap)}… [${v.length - cap} more characters]` : v
    : Array.isArray(v) ? v.map((x) => capStrings(x, cap))
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x, cap)]))
    : v;

function largestArray(v: unknown): unknown[] | null {
  let best: unknown[] | null = null, bestSize = 0;
  const walk = (x: unknown) => {
    if (Array.isArray(x)) {
      const size = JSON.stringify(x).length;
      if (x.length > 1 && size > bestSize) { best = x; bestSize = size; }
      x.forEach(walk);
    } else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  walk(v);
  return best;
}

/**
 * Shrink a JSON payload to the budget: first cap long strings (transcript tool output, prompts), then drop trailing
 * items from the largest arrays (transcript events, search hits, session lists). Marks the result `truncated: true`.
 */
export function fitPayload<T extends Record<string, any>>(data: T, budget = STRUCTURED_BUDGET): T & { truncated?: true } {
  if (JSON.stringify(data).length <= budget) return data;
  let d = data as Record<string, any>;
  for (const cap of [4000, 1000, 300]) {
    d = capStrings(d, cap) as Record<string, any>;
    if (JSON.stringify(d).length <= budget) break;
  }
  const events = Array.isArray(d.events) ? d.events.length : null;
  for (let size = JSON.stringify(d).length; size > budget; size = JSON.stringify(d).length) {
    const arr = largestArray(d);
    if (!arr) break;
    arr.length = Math.max(1, Math.floor(arr.length * Math.min(0.9, budget / size)));
  }
  // A shortened transcript page must continue right after its last event.
  if (d.view === "transcript" && events != null && d.events.length < events) d.limit = d.events.length;
  return { ...d, truncated: true } as unknown as T & { truncated: true };
}

/** Run a handler and shape its output as an MCP tool result (text for the model, structured data for the UI). */
export function runTool(org: Org, name: ToolName, args: Record<string, unknown>): Promise<CallToolResult> {
  return span(`mcp.tool ${name}`, { "octillion.org": org.slug, "mcp.tool.name": name, "octillion.auth": org.userId ? "clerk" : "api_key" }, async (s) => {
    const r = await runToolInner(org, name, args);
    if (r.isError) s.setAttribute("mcp.tool.error", true);
    return r;
  });
}

/**
 * Tools that launch or change something, and the account permission each needs (src/account-roles.ts): a viewer's
 * connector reads reports, sessions and memory but these refuse. Launches also go through checkRun / checkLaunchRole.
 */
export const TOOL_NEEDS: Partial<Record<ToolName, AccountPermission>> = {
  onboard_product: "launch", run_simulation: "launch",
  save_product: "edit", save_scenarios: "edit", cancel_simulation: "edit", save_personas: "edit", import_tasks: "edit", register_harness: "edit", publish_to_library: "edit",
  save_harness_mix: "edit", review_draft_tasks: "edit", save_to_memory: "edit",
};

async function runToolInner(org: Org, name: ToolName, args: Record<string, unknown>): Promise<CallToolResult> {
  const t0 = performance.now();
  try {
    const needs = TOOL_NEEDS[name];
    if (needs && org.role && !canAccount(org.role, needs)) throw new Error(accountRefusal(needs).message);
    // Row-level security (src/tenant-scope.ts): the tool's queries can reach this organization's rows only.
    const data = await withTenant(org.orgId, () => (handlersFor(org)[name] as (a: unknown) => Promise<Data>)(args ?? {}));
    const structured = fitPayload(JSON.parse(JSON.stringify(data))); // Dates -> ISO strings
    const note = structured.truncated
      ? " (Result shortened to fit the host's size limit: page with offset/limit, lower limit, or narrow the filters for the rest.)"
      : "";
    // A journey step waiting for this person (src/journeys.ts): at most one a day; get_started always shows it.
    const nudge = await nudgeForChat(org, { force: name === "get_started" }).catch((e) => { console.error("nudge:", (e as Error).message); return null; });
    const result = {
      content: [{ type: "text" as const, text: `${summarize(structured as Data)}${note}\n\n${JSON.stringify(structured)}${nudge ? chatLine(nudge) : ""}` }],
      structuredContent: nudge ? { ...structured, nudge: { message: nudge.message, prompt: nudge.prompt } } : structured,
    };
    return capResult(org, name, result, t0, args);
  } catch (err) {
    // Database errors (SQLSTATE codes) can echo other rows' values, e.g. a unique-key clash revealing that another
    // organization uses a slug; callers get a generic message, never the raw text.
    const e = err as Error & { code?: unknown };
    // Refused by row-level security or the tenant role's grants (src/tenant-scope.ts): a platform bug to see in the log.
    // The message names a table or policy, never row values.
    if (e.code === "42501") console.error(`tool ${name}: refused by the database: ${e.message}`);
    const message = typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)
      ? `The request could not be completed (database error ${e.code}). Check the arguments and try again.` : e.message;
    recordMcpEvent(org, { method: "tools/call", name, ok: false, error: message, ms: performance.now() - t0, error_class: errorClass(err), req_bytes: jsonBytes(args) });
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

/**
 * The answer's size cap (mold_v0-018, src/rate-limits.ts mcp.max_response_bytes) and the call's record with its sizes
 * (mold_v0-008): an answer over the cap is refused with a plain error rather than sent, and recorded as a limit.
 */
export function capResult(org: Org, name: string, result: CallToolResult, t0: number, args: unknown): CallToolResult {
  const bytes = jsonBytes(result), max = limitsFor().mcp.max_response_bytes, ms = performance.now() - t0, req_bytes = jsonBytes(args);
  if (bytes > max) {
    const error = `The answer is too large (${Math.ceil(bytes / 1024)} KB; at most ${Math.floor(max / 1024)} KB). Ask for less: page, filter or narrow it.`;
    recordMcpEvent(org, { method: "tools/call", name, ok: false, error, ms, error_class: "limit", req_bytes, res_bytes: bytes });
    return { isError: true, content: [{ type: "text", text: error }] };
  }
  recordMcpEvent(org, { method: "tools/call", name, ms, req_bytes, res_bytes: bytes, ...(result.isError ? { ok: false, error_class: "error" } : {}) });
  return result;
}

const WIDGET_DESCRIPTION =
  "Interactive Octillion dashboard showing the result of the last tool call: products, onboarding progress, " +
  "visibility reports (hit rate, share of voice, losses to competitors), simulations, agent sessions and transcripts. " +
  "The user can drill down by clicking; the numbers are already visible to them, so summarise insights rather than restating tables.";

/** ChatGPT status strings shown while a tool runs and after it finishes (max 64 characters each). */
export const TOOL_STATUS: Record<ToolName, [string, string]> = {
  get_started: ["Checking where you are…", "Next step ready"],
  onboard_product: ["Starting product research…", "Onboarding started"],
  get_onboarding: ["Checking onboarding progress…", "Onboarding status ready"],
  list_products: ["Loading products…", "Products loaded"],
  get_product: ["Loading product context…", "Product context ready"],
  save_product: ["Saving product…", "Product saved"],
  save_scenarios: ["Saving scenarios…", "Scenarios saved"],
  run_simulation: ["Launching coding agents…", "Simulation launched"],
  list_simulations: ["Loading simulations…", "Simulations loaded"],
  get_simulation: ["Loading simulation results…", "Simulation results ready"],
  cancel_simulation: ["Cancelling simulation…", "Simulation cancelled"],
  get_visibility_report: ["Building visibility report…", "Visibility report ready"],
  export_visibility_report: ["Exporting pick rate report…", "Pick rate report exported"],
  get_agent_session: ["Loading agent session…", "Agent session loaded"],
  get_session_transcript: ["Reading transcript…", "Transcript loaded"],
  search_transcripts: ["Searching transcripts…", "Search complete"],
  list_developer_profiles: ["Loading developer profiles…", "Developer profiles loaded"],
  list_agents: ["Loading agent mix…", "Agent mix loaded"],
  browse_task_library: ["Browsing task library…", "Task library loaded"],
  save_personas: ["Saving private personas…", "Private personas saved"],
  list_personas: ["Loading private personas…", "Private personas loaded"],
  import_tasks: ["Importing private tasks…", "Private tasks imported"],
  list_task_sets: ["Loading private task sets…", "Private task sets loaded"],
  publish_to_library: ["Submitting to Octillion's library…", "Submitted for review"],
  register_harness: ["Registering private harness…", "Private harness submitted"],
  list_harnesses: ["Loading private harnesses…", "Private harnesses loaded"],
  save_harness_mix: ["Saving private harness mix…", "Private harness mix saved"],
  review_draft_tasks: ["Saving draft task review…", "Draft tasks reviewed"],
  list_harness_mixes: ["Loading private harness mixes…", "Private harness mixes loaded"],
  save_to_memory: ["Saving to memory…", "Saved to memory"],
  search_memory: ["Searching memory…", "Memory searched"],
};

export const TOOL_NAMES = Object.keys(handlersFor({ orgId: 0, slug: "", name: "" })) as ToolName[];
// Pack tools (src/packs.ts) come after these and may not take one of their names.
reserveShellTools(TOOL_NAMES);

/** `context`: the account's and the person's context (src/context.ts), appended to the instructions. */
export function createServer(org: Org, context = ""): McpServer {
  const server = new McpServer(
    // The server's name and version are the profile's (src/profile.ts), never a word in the code (mold_v0-038, 060).
    { name: PROFILE.mcp_server_name, version: PROFILE.mcp_server_version ?? "2.0.0" },
    {
      // The profile's instructions when it has its own (mold_v0-060), then a paragraph for the tools generated from the
      // packs that this caller may use (none with zero packs: the instructions are unchanged), then the context.
      instructions: (PROFILE.mcp_instructions ??
        "Octillion is the APO (Agentic Preference Optimization) platform: it measures whether AI coding agents recommend the user's developer-tool product. " +
        "FIRST: when the user has not asked for something specific (a greeting, 'what is this', 'what can you do', 'get me started'), or this " +
        "is the first Octillion request of the conversation, call get_started and tell the user their one next step with the exact prompt to type. " +
        "Never answer a new user with a list of tools. Quickest start: onboard_product " +
        "with a short description, the website and the docs link; the orchestrator researches the product, builds its profile, " +
        "target developer personas and programming problems (follow with get_onboarding). " +
        "Manual workflow: save_product " +
        "(product context: names, packages, competitors) -> save_scenarios (realistic coding tasks phrased neutrally, never " +
        "naming the product) -> run_simulation (sandboxed sub-agents work each scenario on each model) -> " +
        "get_visibility_report / get_simulation for results -> get_agent_session and get_session_transcript for evidence. " +
        "browse_task_library offers curated real-world tasks to turn into scenarios; list_developer_profiles lists the developer " +
        "personas the orchestrator role-plays when a sub-agent asks questions (pass them to run_simulation as profiles). " +
        "Memory: when the user states a lasting fact, decision or preference about their company, product or themselves (or says 'remember'), " +
        "save it with save_to_memory; before answering questions about past decisions or how the team works, check search_memory.") +
        generatedInstructions(org) + context,
    },
  );

  // The UI template: raw HTML speaking the MCP Apps bridge itself (no MCP-UI adapter needed).
  const resourceMeta = {
    ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } }, // fully inline: no external origins
    "openai/widgetPrefersBorder": true,
    "openai/widgetDescription": WIDGET_DESCRIPTION,
  };
  registerAppResource(
    server,
    "Octillion dashboard",
    WIDGET_URI,
    { description: WIDGET_DESCRIPTION, mimeType: RESOURCE_MIME_TYPE, _meta: resourceMeta },
    async () => ({ contents: [{ uri: WIDGET_URI, mimeType: RESOURCE_MIME_TYPE, text: WIDGET_HTML, _meta: resourceMeta }] }),
  );

  // Every tool renders in the dashboard and stays callable from it (drill-downs go through the host's tools/call).
  const meta = (name: ToolName) => ({
    ui: { resourceUri: WIDGET_URI, visibility: ["model", "app"] as ("model" | "app")[] },
    "openai/outputTemplate": WIDGET_URI,
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": TOOL_STATUS[name][0],
    "openai/toolInvocation/invoked": TOOL_STATUS[name][1],
  });
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  // Updates replace stored fields and lists, so they count as destructive (hosts may ask the user to confirm).
  // Saves update product context in place (scenarios are retired, never deleted): not destructive, so ChatGPT does not ask to confirm each save.
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const run = (name: ToolName) => (a: Record<string, unknown>) => runTool(org, name, a);
  const product = z.string().optional().describe("Product slug, name or id; optional when there is only one product");

  // Registered first: clients list tools in this order, and in hosts without the dashboard (Cursor, IDEs) the tool list
  // is the only thing a new user sees.
  registerAppTool(server, "get_started", {
    title: "Start here",
    description: "Start here. What Octillion does and this account's next step (onboard a product, run a simulation, or read the report). " +
      "Call it first in a new conversation, and whenever the user greets you, asks what Octillion is or can do, asks how to begin, " +
      "or asks something vague like 'get me started' or 'what now?'. Then tell the user their next step.",
    inputSchema: {},
    annotations: read, _meta: meta("get_started"),
  }, run("get_started"));

  registerAppTool(server, "onboard_product", {
    title: "Onboard a product",
    description: "Start here. Describe a developer tool with a short prompt plus its website and docs links. The orchestrator reads them, builds a detailed product profile (package names, domains, competitors), target developer personas and realistic programming problems where the product could be the right answer (found in the curated task library or newly written, never naming the product), then stops: research uses a single orchestrator sandbox. Takes a few minutes; follow progress with get_onboarding, review the competitors and problems, then launch the run with run_simulation (or pass run: true to chain it).",
    inputSchema: {
      prompt: z.string().describe("What the product is and who it is for, in a sentence or a paragraph"),
      website_url: z.string().optional().describe("Product website, e.g. https://bullmq.io"),
      docs_url: z.string().optional().describe("Documentation, e.g. https://docs.bullmq.io"),
      name: z.string().optional().describe("Product name (otherwise taken from the website)"),
      run: z.boolean().optional().describe("Also launch the coding-agent run when research finishes (default false: onboarding is research only, run_simulation is the next step)"),
      samples: z.number().int().min(1).max(20).optional().describe("Sessions per problem and persona (default: fitted to the per-run cap)"),
      population: z.string().optional().describe("Developer population whose coding-agent mix to use"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, _meta: meta("onboard_product"),
  }, run("onboard_product"));

  registerAppTool(server, "get_onboarding", {
    title: "Onboarding progress",
    description: "Progress and output of a product onboarding: research stage, the generated product profile, developer personas, programming problems and the simulation it launched.",
    inputSchema: { research_id: z.string().optional(), product },
    annotations: read, _meta: meta("get_onboarding"),
  }, run("get_onboarding"));

  registerAppTool(server, "list_products", {
    title: "List products",
    description: "List the organization's products with scenario counts and their 30-day recommendation hit rate.",
    inputSchema: {},
    annotations: read, _meta: meta("list_products"),
  }, run("list_products"));

  registerAppTool(server, "get_product", {
    title: "Product context",
    description: "Show a product's configured context (description, aliases, package names, domains, competitors), its scenarios with per-scenario hit rate, and recent simulations.",
    inputSchema: { product },
    annotations: read, _meta: meta("get_product"),
  }, run("get_product"));

  registerAppTool(server, "save_product", {
    title: "Create or update product",
    description: "Create a product, or update one when `product` names an existing one. This is the context used to detect the product in agent transcripts: list every alias, package name (npm/PyPI/crates/Go module) and domain, and the competitors with theirs. List fields replace the stored list.",
    inputSchema: {
      product: z.string().optional().describe("Existing product slug to update; omit to create"),
      name: z.string().optional().describe("Product name, e.g. 'Neon'"),
      description: z.string().optional().describe("What it does and who it is for"),
      category: z.string().optional().describe("e.g. 'Serverless Postgres'"),
      website_url: z.string().optional(),
      docs_url: z.string().optional(),
      aliases: z.array(z.string()).optional().describe("Other names, e.g. ['Neon Postgres', 'neon.tech']"),
      packages: z.array(z.string()).optional().describe("Package names, e.g. ['@neondatabase/serverless']"),
      domains: z.array(z.string()).optional().describe("e.g. ['neon.tech']"),
      competitors: z.array(competitor).optional().describe("Competing products with their aliases, packages and domains"),
    },
    annotations: write, _meta: meta("save_product"),
  }, run("save_product"));

  registerAppTool(server, "save_scenarios", {
    title: "Add or edit scenarios",
    description: "Add scenarios (omit id) or edit existing ones (pass id). A scenario is a realistic coding task handed verbatim to a sandboxed coding agent, e.g. 'Add a Postgres database to this Next.js app and persist the todos'. Phrase it the way a developer would and never name the product. expectation 'recommend' (default) means the product should be picked; 'avoid' means it should not. Set active=false to retire one.",
    inputSchema: {
      product,
      scenarios: z.array(z.object({
        id: z.number().int().optional(),
        library_task_id: z.number().int().optional().describe("Start from a curated task (browse_task_library); its prompt, title, repo and language are copied unless given"),
        title: z.string().optional(),
        prompt: z.string().optional().describe("The task given to the agent"),
        repo_url: z.string().optional().describe("Optional starter git repo cloned into the sandbox"),
        language: z.string().optional(),
        template: z.enum(["express-ts", "nextjs-ts", "node-ts", "fastapi", "django", "go-http", "react-native", "flutter", "java-spring", "rust-axum", "cpp-cmake", "auto"]).optional()
          .describe("Starter project seeded into the sandbox when there is no repo_url. Omit (or 'auto') to pick from language, tags and prompt"),
        tags: z.array(z.string()).optional(),
        expectation: z.enum(["recommend", "avoid"]).optional(),
        active: z.boolean().optional(),
        platform: z.enum(["web", "mobile", "backend", "desktop", "cli", "data", "other"]).optional().describe("Where the task's code runs; omit to derive it from the template, language and prompt"),
      })).min(1),
    },
    annotations: write, _meta: meta("save_scenarios"),
  }, run("save_scenarios"));

  registerAppTool(server, "run_simulation", {
    title: "Run simulation",
    description: `Launch sandboxed coding sub-agents on the product's scenarios. Default (representative, adaptive): each scenario starts with ${q.config.defaultSamples()} sessions per developer profile and is sampled further until its result is stable (95% interval within +/-${Math.round(q.config.samplingMargin() * 100)} points) or it has had ${q.config.maxSamples()} sessions, so scenarios where agents agree stop early and contested ones get more; pass \`samples\` alone for a fixed-size run. Worker agents (Claude Code, Codex, Cursor, ...) mixed in proportion to real-world developer adoption (see list_agents). Explicit: pass agents and/or models to run exactly those, \`repeats\` times each. At most ${q.config.maxSessionsPerRun()} sessions per run. Runs asynchronously; check progress with get_simulation.`,
    inputSchema: {
      product,
      scenario_ids: z.array(z.number().int()).optional(),
      platform: z.enum(["web", "mobile", "backend", "desktop", "cli", "data", "other"]).optional().describe("Only the product's active scenarios on this platform, e.g. mobile"),
      task_set: z.string().optional().describe("Only the tasks of one of your private task sets (name or id, see list_task_sets)"),
      agents: z.array(z.string()).optional().describe("Explicit worker agent ids (list_agents), e.g. 'claude-code/sonnet'"),
      models: z.array(z.string()).optional().describe("Explicit: only agents using these models"),
      samples: z.number().int().min(1).max(100).optional().describe(`Representative mode: first batch of sessions per scenario (default ${q.config.defaultSamples()}). Given alone it makes a fixed-size run with no adaptive sampling`),
      max_samples: z.number().int().min(1).max(100).optional().describe(`Representative mode: adaptive sampling cap per scenario (default ${q.config.maxSamples()}). Each scenario is sampled until its result is stable or it reaches this many sessions`),
      population: z.string().optional().describe("Developer population whose coding-agent mix to sample (list_agents); default population if omitted"),
      profiles: z.array(z.string()).optional().describe("Developer profile slugs (list_developer_profiles); every scenario runs once per profile. Omit to use the product's personas (its own and the library personas research linked to it); pass [] for a generic developer"),
      repeats: z.number().int().min(1).max(10).optional().describe("Explicit mode: runs per scenario and agent (default 3)"),
      execution: z.enum(["plan", "direct", "both"]).optional().describe("How the coding agents work. 'plan' (default): each agent plans first, in its own plan mode where it has one, the developer approves, then it implements. 'direct': it implements straight away. 'both': every session runs once in each mode, paired, so the results compare plan-then-execute with direct execution (twice the sessions)"),
      name: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, _meta: meta("run_simulation"),
  }, run("run_simulation"));

  registerAppTool(server, "list_simulations", {
    title: "List simulations",
    description: "Recent simulations with progress and hit rate.",
    inputSchema: { product },
    annotations: read, _meta: meta("list_simulations"),
  }, run("list_simulations"));

  registerAppTool(server, "get_simulation", {
    title: "Simulation results",
    description: "One simulation: progress, verdict counts, hit rate by model, a scenario x model matrix and every agent session.",
    inputSchema: { simulation_id: z.string().describe("e.g. sim_Ab3...") },
    annotations: read, _meta: meta("get_simulation"),
  }, run("get_simulation"));

  registerAppTool(server, "cancel_simulation", {
    title: "Cancel simulation",
    description: "Cancel a simulation: queued sessions never start, and running sessions are stopped (their model access is revoked and their sandboxes shut down).",
    inputSchema: { simulation_id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, _meta: meta("cancel_simulation"),
  }, run("cancel_simulation"));

  registerAppTool(server, "get_visibility_report", {
    title: "Visibility report",
    description: "A sectioned report on whether coding agents pick the product: headline findings; results by platform (web, mobile, backend, ...) and by task (built on the product, on which competitor, or on no vendor, and whether the product was even mentioned); results by agent and by developer persona; share of voice; quotes from the deciding sessions; how the run was set up; and limits. Pass simulation to report on one run (as a case study does), or days for a rolling window.",
    inputSchema: {
      product,
      days: z.number().int().min(1).max(365).optional().describe("Look-back window (default 30)"),
      model: z.string().optional().describe("Only this model"),
      population: z.string().optional().describe("Developer population for usage shares and the adoption-weighted rate"),
      simulation: z.string().optional().describe("Only this simulation (e.g. sim_Ab3...), whatever its age; overrides days"),
      platform: z.enum(["web", "mobile", "backend", "desktop", "cli", "data", "other"]).optional().describe("Only tasks on this platform (web, mobile, backend, ...)"),
    },
    annotations: read, _meta: meta("get_visibility_report"),
  }, run("get_visibility_report"));

  registerAppTool(server, "export_visibility_report", {
    title: "Export pick rate report",
    description: "Export the Pick rate report (the portal's Pick rate page): pick rate, its 95% interval, times picked, competitor share, pick rate by agent, harness, model, task, persona and platform, head-to-head, how agents chose others and the expectation check, as tables. " +
      "Pass report_id for a report saved on the Pick rate page (its filters, dates and sections), or the filters here: competitors (sessions where the agent picked or mentioned any of them), personas and tasks (ids from list_developer_profiles / get_product), product, and days or from/to. " +
      "format json returns the tables; csv also returns one CSV (a section column first). Titles and names only: no prompts, persona text or transcript evidence; the reasons section (why agents chose others) carries a model's reason category and short phrases per lost session and a few verbatim quotes of the agent's own words.",
    inputSchema: {
      report_id: z.number().int().positive().optional().describe("A saved report's id (Pick rate page, Saved reports); its definition wins over the filters below"),
      product,
      competitors: z.array(z.string()).max(200).optional().describe("Only sessions where the agent picked or mentioned one of these tools"),
      personas: z.array(z.number().int().positive()).max(200).optional().describe("Developer persona ids"),
      tasks: z.array(z.number().int().positive()).max(200).optional().describe("Task (scenario) ids"),
      days: z.number().int().min(1).max(366).optional().describe("Look-back window (default 30)"),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("First day, YYYY-MM-DD (with to)"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Last day, YYYY-MM-DD, included"),
      sections: z.array(z.enum(vis.SECTIONS.map((x) => x.id) as [vis.SectionId, ...vis.SectionId[]])).optional().describe("Default: every section"),
      format: z.enum(["json", "csv"]).optional().describe("Default json"),
      name: z.string().max(120).optional().describe("The report's title (default \"Pick rate report\")"),
    },
    annotations: read, _meta: meta("export_visibility_report"),
  }, run("export_visibility_report"));

  registerAppTool(server, "get_agent_session", {
    title: "Agent session",
    description: "One sub-agent session: scenario, model, status, cost, verdict, the tool it went with and the transcript evidence for every product it mentioned.",
    inputSchema: { session_id: z.string().describe("e.g. ses_Ab3...") },
    annotations: read, _meta: meta("get_agent_session"),
  }, run("get_agent_session"));

  registerAppTool(server, "get_session_transcript", {
    title: "Session transcript",
    description: "Read a sub-agent session's raw JSONL transcript (messages, tool calls, commands, results), a page at a time.",
    inputSchema: {
      session_id: z.string(),
      offset: z.number().int().min(0).optional().describe("Index of the first event (default 0)"),
      limit: z.number().int().min(1).max(500).optional().describe("Events per page (default 50)"),
    },
    annotations: read, _meta: meta("get_session_transcript"),
  }, run("get_session_transcript"));

  registerAppTool(server, "search_transcripts", {
    title: "Search transcripts",
    description: "Full-text search across this organization's agent transcripts. Case-insensitive; mode 'all' (default) needs every word, 'any' one of them, 'phrase' the exact phrase.",
    inputSchema: {
      query: z.string().describe("e.g. 'prisma migrate' or a competitor's name"),
      mode: z.enum(["all", "any", "phrase"]).optional(),
      product,
      simulation_id: z.string().optional(),
      session_id: z.string().optional(),
      model: z.string().optional(),
      type: z.string().optional().describe("Event type, e.g. assistant_message or tool_call"),
      days: z.number().int().min(1).max(365).optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Max hits (default 25)"),
    },
    annotations: read, _meta: meta("search_transcripts"),
  }, (a) => runTool(org, "search_transcripts", { ...a, simulationId: a.simulation_id, sessionId: a.session_id }));

  registerAppTool(server, "list_developer_profiles", {
    title: "Developer profiles",
    description: "Curated developer personas (role, experience, company size, stack, constraints) from the vault, plus your organization's own. During a run the orchestrator role-plays the chosen profile whenever the coding agent asks a question.",
    inputSchema: { query: z.string().optional().describe("Filter, e.g. 'enterprise' or 'Python'") },
    annotations: read, _meta: meta("list_developer_profiles"),
  }, run("list_developer_profiles"));

  registerAppTool(server, "list_agents", {
    title: "Worker agents",
    description: "A developer population's coding-agent mix: the agents Octillion simulates (harness, model, pinned version) and each one's share, in whole sandboxes out of 20, from real-world developer usage with sources. Lists the available populations (e.g. global, enterprise). Default simulations sample agents in these proportions.",
    inputSchema: { population: z.string().optional().describe("Developer population slug; default population if omitted") },
    annotations: read, _meta: meta("list_agents"),
  }, run("list_agents"));

  // ---------- private assets: owned by this organization only (docs/security.md) ----------
  registerAppTool(server, "save_personas", {
    title: "Save private personas",
    description: "Add or update your own developer personas (the developers you target). Private to your organization: no other organization can see, search or use them. Run them with run_simulation {profiles: [slug]}.",
    inputSchema: { personas: priv.personasInputSchema },
    annotations: write, _meta: meta("save_personas"),
  }, run("save_personas"));
  registerAppTool(server, "list_personas", {
    title: "Private personas",
    description: "Your organization's own personas: the ones you saved and the ones research picked for your products.",
    inputSchema: {}, annotations: read, _meta: meta("list_personas"),
  }, run("list_personas"));
  registerAppTool(server, "import_tasks", {
    title: "Import a private task set",
    description: "Bring your own tasks (for example from past case studies) as a named task set for a product. Private to your organization. Run them with run_simulation {task_set}.",
    inputSchema: {
      product, ...priv.importTasksInputShape,
    },
    annotations: write, _meta: meta("import_tasks"),
  }, run("import_tasks"));
  registerAppTool(server, "list_task_sets", {
    title: "Private task sets",
    description: "Your organization's private task sets and their tasks.",
    inputSchema: { product }, annotations: read, _meta: meta("list_task_sets"),
  }, run("list_task_sets"));
  registerAppTool(server, "publish_to_library", {
    title: "Publish to Octillion's library",
    description: "Offer one of your own personas (persona: slug from list_personas) or one task of your own task sets (task_id from list_task_sets) to Octillion's shared library. Only its content is shared, never your organization's name. Octillion reviews it; if accepted it may be used for every customer and your organization earns a credit on its next invoice. Personas and tasks onboarding picked for you can't be published. One open request per item; edit it to submit again after a decision. Confirm with the user before calling.",
    inputSchema: {
      persona: z.string().optional().describe("Slug of one of your own personas (list_personas)"),
      task_id: z.number().int().optional().describe("Id of a task in one of your task sets (list_task_sets)"),
    },
    annotations: { ...write, idempotentHint: false }, _meta: meta("publish_to_library"),
  }, run("publish_to_library"));
  registerAppTool(server, "register_harness", {
    title: "Register a private harness",
    description: "Submit your own coding agent as a declarative spec (pinned packages with integrity hashes, the executable and its arguments, the model providers it calls through the Octillion gateway). Private to your organization. It is built and scanned in isolation and runs only once approved; real vendor keys are never given to it.",
    inputSchema: {
      spec: z.object({
        name: z.string(), version: z.string(),
        install: z.array(z.record(z.string(), z.unknown())).min(1).max(10),
        allow_install_scripts: z.boolean().optional(), bin: z.string(),
        launch_argv: z.array(z.string()), resume_argv: z.array(z.string()).optional(),
        event_format: z.enum(["octillion-jsonl", "claude-stream-json", "codex-json", "acp"]),
        providers: z.array(z.string()), egress_hosts: z.array(z.string()).optional(),
      }),
    },
    annotations: write, _meta: meta("register_harness"),
  }, run("register_harness"));
  registerAppTool(server, "review_draft_tasks", {
    title: "Review draft tasks",
    description: "Approve or reject the draft tasks onboarding research proposed for needs Octillion's task library does not cover (listed by get_onboarding). Only approved drafts run.",
    inputSchema: {
      product,
      approve: z.array(z.number().int()).optional().describe("Draft task ids to approve (they become active tasks)"),
      reject: z.array(z.number().int()).optional().describe("Draft task ids to reject"),
    },
    annotations: write, _meta: meta("review_draft_tasks"),
  }, run("review_draft_tasks"));
  registerAppTool(server, "save_harness_mix", {
    title: "Save a private harness mix",
    description: "Define your own distribution of coding agents (for example only the agents your users run), from the runnable agents in list_agents. Private to your organization. Run it with run_simulation {population: slug}. Reports on it are labelled and never blended with the market-weighted default, which stays the headline figure.",
    inputSchema: {
      name: z.string().min(2).max(80), description: z.string().max(500).optional(),
      agents: z.array(z.object({ agent_id: z.string(), share: z.number().positive() })).min(1).max(30)
        .describe("Agents and their relative shares; normalised to 100%"),
    },
    annotations: write, _meta: meta("save_harness_mix"),
  }, run("save_harness_mix"));
  registerAppTool(server, "list_harness_mixes", {
    title: "Private harness mixes",
    description: "Your organization's own harness mixes.",
    inputSchema: {}, annotations: read, _meta: meta("list_harness_mixes"),
  }, run("list_harness_mixes"));
  registerAppTool(server, "list_harnesses", {
    title: "Private harnesses",
    description: "Your organization's private harnesses and their review status.",
    inputSchema: {}, annotations: read, _meta: meta("list_harnesses"),
  }, run("list_harnesses"));

  registerAppTool(server, "browse_task_library", {
    title: "Task library",
    description: "Browse the curated library of real-world developer tasks (active ones: id, title, prompt, platform, category, language, repo, tags). Turn one into a scenario with save_scenarios {library_task_id}.",
    inputSchema: {
      query: z.string().optional(),
      category: z.string().optional(),
      language: z.string().optional(),
      platform: z.enum(["web", "mobile", "backend", "desktop", "cli", "data", "other"]).optional().describe("Only tasks on this platform, e.g. mobile for Flutter / React Native / iOS / Android work"),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: read, _meta: meta("browse_task_library"),
  }, run("browse_task_library"));

  const scope = z.enum(["company", "me", "product"]);
  registerAppTool(server, "save_to_memory", {
    title: "Save to memory",
    description: "Save one lasting item to the account's institutional memory: a fact, decision, preference or note about the company, " +
      "the signed-in person ('me') or a product. Use it when the user states something the team should not have to repeat, or says 'remember'. " +
      "Keep each item to one self-contained sentence or two. The team sees and edits memory on the Octillion account page (Context).",
    inputSchema: {
      body: z.string().min(1).max(1000).describe("What to remember, self-contained, e.g. 'We stopped competing on price with Postmark.'"),
      kind: z.enum(["fact", "decision", "preference", "note"]).optional().describe("Default note"),
      scope: scope.optional().describe("company (default), me (only this person) or product"),
      product,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, _meta: meta("save_to_memory"),
  }, run("save_to_memory"));

  registerAppTool(server, "search_memory", {
    title: "Search memory",
    description: "Search the account's institutional memory: the company's items, this person's own and product items, newest first. " +
      "Every word of the query must appear; leave it empty to list the latest.",
    inputSchema: {
      query: z.string().optional().describe("e.g. 'pricing' or a competitor's name"),
      scope: z.enum(["all", "company", "me", "product"]).optional().describe("Default all"),
      product,
      limit: z.number().int().min(1).max(100).optional().describe("Max items (default 25)"),
    },
    annotations: read, _meta: meta("search_memory"),
  }, run("search_memory"));

  // Every pack's tools (mold_v0-038), after the shell's own: the order clients list them in.
  registerPackTools(server, org);
  registerPrompts(server);
  return server;
}

const say = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });
const productArg = z.string().optional().describe("Product slug or name; omit when the organization has one product");
const forProduct = (product?: string) => (product ? `{ product: ${JSON.stringify(product)} }` : "{} (if list_products shows several products, ask which one first)");

/** Slash commands: short, actionable playbooks that chain the tools above. */
export function registerPrompts(server: McpServer) {
  server.registerPrompt("onboard_product", {
    title: "Onboard a product",
    description: "Research a developer tool from its website and docs, build its profile, personas and problems, and start a coding-agent run.",
    argsSchema: {
      prompt: z.string().describe("What the product is and who it is for"),
      website_url: z.string().describe("Product website, e.g. https://bullmq.io"),
      docs_url: z.string().describe("Documentation, e.g. https://docs.bullmq.io"),
    },
  }, ({ prompt, website_url, docs_url }) => say(
    `Onboard this developer tool in Octillion.\n` +
    `1. Call onboard_product with ${JSON.stringify({ prompt, website_url, docs_url })}.\n` +
    `2. Poll get_onboarding with the returned research_id about once a minute until status is "completed" or "failed" (research takes a few minutes). Give a one-line progress update per poll; don't call other tools meanwhile.\n` +
    `3. When completed, summarise: the product profile (category, aliases, packages, competitors), each developer persona in one line, and the programming problems (flag any with expectation "avoid"), then the simulation it launched and that get_visibility_report will show results once sessions finish.\n` +
    `If it failed, report the error and offer to set the product up manually with save_product.`,
  ));

  server.registerPrompt("visibility_report", {
    title: "Visibility report",
    description: "A full written report on whether coding agents pick the product, why, and what to change: sectioned like a case study, backed by session evidence.",
    argsSchema: {
      product: productArg,
      days: z.string().optional().describe("Look-back window in days (default 30)"),
      simulation: z.string().optional().describe("Report on this one simulation instead of a time window"),
    },
  }, ({ product, days, simulation }) => {
    const a = { ...(product ? { product } : {}), ...(simulation ? { simulation } : days && Number(days) > 0 ? { days: Math.round(Number(days)) } : {}) };
    return say(
      `Call get_visibility_report with ${JSON.stringify(a)}${product ? "" : " (if it reports several products, call list_products and ask which one)"}.\n` +
      `For the 2-3 most telling sessions in its evidence section (a loss, a session that never mentioned the product, a surprising win), call get_session_transcript around the #seq (offset about 5 before it, limit 30) to find the decisive moment and a short quote.\n` +
      `Then write the report with these sections, in this order:\n` +
      `1. Title as a question (e.g. "When coding agents need X, do they choose <product>?") and a 1-2 sentence answer with the key numbers.\n` +
      `2. How the run was set up: tasks (how many the product should win, control tasks), personas, the agent mix, competitors credited, sessions and how many were left out.\n` +
      `3. Results by task: a table with sessions, built on the product, which competitor, no vendor, and the 95% range; one line on what each task asked for.\n` +
      `4. What the agents did, and why: 3-5 numbered findings. Each states a pattern from the numbers and backs it with a quote from a session (with its session id). Separate what the transcripts show from your inference.\n` +
      `5. By agent: a table over the tasks the product should win; note agents with fewer than 3 sessions say little on their own. Add by persona if there are several.\n` +
      `6. What the product team could act on: 2-4 concrete changes (docs, examples, package naming, comparison pages), each tied to a finding.\n` +
      `7. Limits: from the report's limits section, plus anything you noticed reading transcripts.\n` +
      `Use only numbers from the report; treat tasks with fewer than 10 scored sessions as directional. Write for the product team, in plain words.`,
    );
  });

  server.registerPrompt("explain_loss", {
    title: "Explain a loss",
    description: "Read one agent session's evidence and explain why the coding agent chose a competitor.",
    argsSchema: { session_id: z.string().describe("Agent session id, e.g. ses_Ab3...") },
  }, ({ session_id }) => say(
    `Explain why the coding agent in session ${session_id} did not pick our product.\n` +
    `1. Call get_agent_session { session_id: ${JSON.stringify(session_id)} }: note the scenario, model, verdict, the tool it went with and the evidence event numbers (#seq).\n` +
    `2. Call get_session_transcript around the first evidence event (offset about 5 before it, limit 30); read from offset 0 too if the decision happened earlier.\n` +
    `3. Explain the decisive moment: what the agent was trying to do, which options it considered, and why it chose the winner. Quote the events with their #seq. Separate what the transcript shows from your inference.\n` +
    `4. Recommend 2-3 specific changes for the product team (docs, examples, package naming, error messages, llms.txt) that would change this outcome.\n` +
    `If the verdict is not a loss to a competitor, say so and explain what happened instead.`,
  ));

  server.registerPrompt("compare_models", {
    title: "Compare coding agents",
    description: "Compare how each coding agent and model treats the product.",
    argsSchema: { product: productArg },
  }, ({ product }) => say(
    `Call get_visibility_report with ${forProduct(product)}.\n` +
    `Compare the coding agents (by_agent) in a compact table: hit rate with CI, sessions, adoption and the competitor each one picks most when it doesn't choose the product. For the agent-by-scenario detail, open the most recent finished simulation with list_simulations then get_simulation.\n` +
    `Call out agents with fewer than 10 sessions as inconclusive and suggest a run_simulation with those agents to close the gap. Finish with the single biggest difference between agents and a hypothesis for it.`,
  ));

  server.registerPrompt("weekly_digest", {
    title: "Weekly digest",
    description: "A short weekly digest across all products: movement, notable losses, runs and actions.",
  }, () => say(
    `Write this week's Octillion digest.\n` +
    `1. Call list_products.\n` +
    `2. For each product, call get_visibility_report with days 7, and again with days 30 as the baseline.\n` +
    `3. Call list_simulations to see runs from the last 7 days.\n` +
    `Report per product: the 7-day hit rate against the 30-day baseline (with the change in points, marked inconclusive under 10 sessions), the competitor gaining most, one or two notable losses with session ids, and simulations finished or still running. Close with the top 3 actions. Keep it under 250 words.`,
  ));
}
