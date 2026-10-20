import { open as openText, openJson, openRows } from "./orgcrypto.js";
import { PLATFORMS, isPlatform, platformOf, type Platform } from "./platform.js";
import { getDb, type Queryable } from "./db.js";
import { settingNumber } from "./settings.js";
import { orgBudget } from "./billing.js";
import { LimitError, askAdmins, checkRun, launchNote, runsAtOnceError, launcherOverLimit, monthFigures, monthWords, sessionsLimit, type LaunchNote } from "./limits.js";
import { randomId, type Org } from "./auth.js";
import { transcripts, type SearchParams } from "./transcripts.js";
import type { Tool } from "./scoring.js";
import { dealByPreference, planFirstBatch, schedulingShares, drawVariant, enabledAgents, findAgent, isRunnable, runnableCoverage, sandboxMix, scheduledAgents, variantsOf, type AgentSpec } from "./agents.js";
import { getPopulation, listPopulations } from "./populations.js";
import { capacityStatus } from "./autoscaler.js";

export const agentLabel = (id: string) => findAgent(id)?.label ?? id;

/** A developer population's coding-agent mix as customers see it: who we simulate and how much each counts. */
export async function listAgents(org: Org, input: { population?: string } = {}) {
  const pop = await getPopulation(input.population, org.orgId);
  const unit = pop.sandbox_unit;
  const mix = new Map(sandboxMix(pop).map((r) => [r.agent.id, r])); // whole sandboxes out of the unit
  return {
    view: "agents" as const,
    population: { slug: pop.slug, name: pop.name, description: pop.description, is_default: pop.is_default },
    populations: await listPopulations(org.orgId),
    as_of: pop.as_of,
    unrepresented_share: pop.unrepresented_share,
    runnable_coverage: runnableCoverage(pop),
    sources: pop.sources,
    agents: pop.agents.filter((a) => a.weight > 0 || a.enabled === false).map((a) => ({ id: a.id, label: a.label, vendor: a.vendor ?? null, harness: a.harness, model: a.model,
                                    harness_version: a.harness_version ?? null, weight: (mix.get(a.id)?.sandboxes ?? 0) / unit,
                                    sandboxes: mix.get(a.id)?.sandboxes ?? 0, exact_sandboxes: mix.get(a.id)?.exact ?? 0,
                                    market_share: a.enabled === false ? 0 : a.weight,
                                    enabled: isRunnable(a), status: isRunnable(a) ? "running" : a.enabled === false ? "not runnable headless" : a.paused ? `paused${a.paused_reason ? `: ${a.paused_reason}` : ""}` : "adapter pending",
                                    notes: a.notes ?? null })),
    default_samples: config.defaultSamples(),
    sandbox_unit: unit,
  };
}

/**
 * Everything the MCP tools read or write. Every function takes the calling Org first and every query is
 * filtered by org_id, so one company can never see another's products, runs or transcripts.
 */

export const config = {
  models: async () => [...new Set(enabledAgents(await getPopulation()).map((a) => a.model))],
  agents: async () => scheduledAgents(await getPopulation()).map((a) => ({ id: a.id, label: a.label, model: a.model, harness: a.harness, weight: a.weight })),
  // These three are global settings (/admin/compute, src/settings.ts): set there, else the environment, else the default.
  defaultSamples: () => settingNumber("OCTILLION_DEFAULT_SAMPLES"),
  maxSessionsPerRun: () => settingNumber("OCTILLION_MAX_SESSIONS_PER_RUN"),
  /**
   * Adaptive sampling: a task is sampled until its hit rate is known to within +/- samplingMargin (95% interval), or
   * until maxSamples sessions. Tasks where agents agree settle after a handful; contested ones run to the cap.
   */
  maxSamples: () => Math.max(1, settingNumber("OCTILLION_MAX_SAMPLES")),
  samplingMargin: () => Number(process.env.OCTILLION_SAMPLING_MARGIN ?? 0.2),
  samplingMin: () => Math.max(1, Number(process.env.OCTILLION_SAMPLING_MIN ?? 6)),
  samplingBatch: () => Math.max(1, Number(process.env.OCTILLION_SAMPLING_BATCH ?? 4)),
  /** Default per-organization model spend per calendar month (UTC), for orgs without a Stripe plan that sets one (src/billing.ts). 0 = no cap. */
  orgMonthlyBudgetUsd: () => Number(process.env.OCTILLION_ORG_MONTHLY_BUDGET_USD ?? 1000),
};

/**
 * A product's tasks as they read: the scenarios row with what it leaves empty filled from its library task. A task
 * from Octillion's library is a link (library_task_id), never a copy (schema.sql, 2026-10-20): its title, prompt,
 * repo, language and tags come from library_tasks unless the product has its own (an edit, or research's adaptation).
 * Use `${SCENARIO_ROWS} sc` wherever scenarios are read; write to `scenarios` itself. List every scenarios column here.
 */
export const SCENARIO_ROWS = `/* tenant: the scenarios table, rows scoped by the query around it */ (SELECT sc0.id, sc0.product_id,
    coalesce(sc0.title, lt0.title) AS title, coalesce(sc0.prompt, lt0.prompt) AS prompt, coalesce(sc0.repo_url, lt0.repo_url) AS repo_url,
    coalesce(sc0.language, lt0.language) AS language, CASE WHEN cardinality(sc0.tags) > 0 THEN sc0.tags ELSE coalesce(lt0.tags, '{}') END AS tags,
    sc0.expectation, sc0.active, sc0.created_at, sc0.updated_at, sc0.library_task_id, sc0.source, sc0.rationale, sc0.template,
    sc0.prompt_variants, sc0.decision, sc0.platform, sc0.task_set_id
  FROM scenarios sc0 LEFT JOIN library_tasks lt0 ON lt0.id = sc0.library_task_id)`;

// A session is a hit when the agent picked the product in a "recommend" scenario, or left it out in an "avoid" one
// (scoring.ts isHit, in SQL over agent_sessions s JOIN scenarios sc). Shared with the portal's Usage charts (src/app.ts).
export const HIT = `CASE WHEN sc.expectation = 'recommend' THEN s.verdict IN ('adopted', 'recommended')
                  ELSE s.verdict NOT IN ('adopted', 'recommended') END`;
/** The agent picked the product (adopted or recommended it): the "picked" half of HIT, whatever the expectation. */
export const PICKED = `s.verdict IN ('adopted', 'recommended')`;
const rate = (hits: number, n: number) => (Number(n) ? Number(hits) / Number(n) : null);
/** Wilson 95% interval for a hit rate; agents are nondeterministic, so every rate is shown with its n and interval. */
export function wilson(hits: number, n: number): [number, number] | null {
  hits = Number(hits); n = Number(n);
  if (!n) return null;
  const z = 1.96, p = hits / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - w) / d), Math.min(1, (c + w) / d)];
}

export interface ProductRow {
  id: number; org_id: number; slug: string; name: string; description: string; category: string;
  website_url: string | null; docs_url: string | null; aliases: string[]; packages: string[]; domains: string[];
  competitors: Tool[]; created_at: Date; updated_at: Date;
}

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

/** Resolve a product by slug, name or id within the org; with no ref, the org's only product. */
export async function resolveProduct(org: Org, ref?: string | number): Promise<ProductRow> {
  const db = await getDb();
  const rows = await db.query<ProductRow>("SELECT * FROM products WHERE org_id = $1 ORDER BY id", [org.orgId]);
  if (!rows.length) throw new Error("No products yet. Start with onboard_product: a short description of the product plus its website and docs links (or save_product to enter the details by hand).");
  if (ref === undefined || ref === "") {
    if (rows.length === 1) return rows[0];
    throw new Error(`Several products exist (${rows.map((r) => r.slug).join(", ")}); pass product.`);
  }
  const r = String(ref).toLowerCase();
  const p = rows.find((x) => String(x.id) === r || x.slug === r || x.name.toLowerCase() === r);
  if (!p) throw new Error(`No product "${ref}". Products: ${rows.map((x) => x.slug).join(", ")}`);
  return p;
}

const toolOf = (p: ProductRow): Tool => ({ name: p.name, aliases: p.aliases, packages: p.packages, domains: p.domains });

// ---------- products ----------

export async function listProducts(org: Org) {
  const db = await getDb();
  const products = await db.query(
    `SELECT p.id, p.slug, p.name, p.category, p.description, jsonb_array_length(p.competitors) AS competitors,
            (SELECT count(*) FROM ${SCENARIO_ROWS} sc WHERE sc.product_id = p.id AND sc.active) AS scenarios,
            count(s.id) AS sessions_30d,
            count(*) FILTER (WHERE ${HIT}) AS hits_30d,
            max(s.ended_at) AS last_run_at
       FROM products p
       LEFT JOIN agent_sessions s ON s.product_id = p.id AND s.verdict IS NOT NULL AND s.ended_at > now() - interval '30 days'
       LEFT JOIN ${SCENARIO_ROWS} sc ON sc.id = s.scenario_id
      WHERE p.org_id = $1
      GROUP BY p.id ORDER BY p.name`,
    [org.orgId],
  );
  return {
    view: "products" as const,
    org: { name: org.name, slug: org.slug },
    products: products.map((p: any) => ({ ...p, hit_rate_30d: rate(p.hits_30d, p.sessions_30d) })),
  };
}

export interface ProductInput {
  product?: string; name?: string; description?: string; category?: string; website_url?: string; docs_url?: string;
  aliases?: string[]; packages?: string[]; domains?: string[]; competitors?: Tool[];
}

/**
 * Which surface a read serves. The MCP connector (the customer's AI client) sees everything its product holds, library
 * copies included; the customer portal (/api/app, src/app.ts) passes `redact: true`, and tasks or personas that came from
 * Octillion's shared library then show by title or name only (forCustomer, personaForCustomer).
 */
export interface Surface { redact?: boolean }

export async function saveProduct(org: Org, input: ProductInput, surface: Surface = {}) {
  const db = await getDb();
  const existing = input.product ? await resolveProduct(org, input.product).catch(() => null) : null;
  const clean = (xs?: string[]) => (xs ? [...new Set(xs.map((x) => x.trim()).filter(Boolean))] : undefined);
  const competitors = input.competitors?.map((c) => ({
    name: c.name.trim(), aliases: clean(c.aliases) ?? [], packages: clean(c.packages) ?? [], domains: clean(c.domains) ?? [],
    ...(c.evidence_url && /^https?:\/\//.test(c.evidence_url) ? { evidence_url: c.evidence_url } : {}),
    ...(c.source ? { source: c.source } : {}),
  }));
  if (existing) {
    await db.query(
      `UPDATE products SET
         name = coalesce($3, name), description = coalesce($4, description), category = coalesce($5, category),
         website_url = coalesce($6, website_url), docs_url = coalesce($7, docs_url),
         aliases = coalesce($8, aliases), packages = coalesce($9, packages), domains = coalesce($10, domains),
         competitors = coalesce($11, competitors), updated_at = now()
       WHERE id = $1 AND org_id = $2`,
      [existing.id, org.orgId, input.name ?? null, input.description ?? null, input.category ?? null, input.website_url ?? null,
       input.docs_url ?? null, clean(input.aliases) ?? null, clean(input.packages) ?? null, clean(input.domains) ?? null,
       competitors ? JSON.stringify(competitors) : null],
    );
    return getProduct(org, existing.slug, surface);
  }
  if (!input.name) throw new Error(input.product ? `No product "${input.product}"; pass name to create it.` : "name is required to create a product");
  const slug = slugify(input.product ?? input.name) || "product";
  await db.query(
    `INSERT INTO products (org_id, slug, name, description, category, website_url, docs_url, aliases, packages, domains, competitors)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [org.orgId, slug, input.name, input.description ?? "", input.category ?? "", input.website_url ?? null, input.docs_url ?? null,
     clean(input.aliases) ?? [], clean(input.packages) ?? [], clean(input.domains) ?? [], JSON.stringify(competitors ?? [])],
  );
  return getProduct(org, slug, surface);
}

export async function getProduct(org: Org, ref?: string, surface: Surface = {}) {
  const p = await resolveProduct(org, ref);
  const db = await getDb();
  const scenarios = await db.query(
    `/* tenant: product from resolveProduct(org) */ SELECT sc.id, sc.title, sc.prompt, sc.repo_url, sc.language, sc.tags, sc.template, sc.platform, sc.library_task_id, sc.expectation, sc.active, sc.source, sc.rationale,
            count(s.id) AS sessions, count(*) FILTER (WHERE ${HIT}) AS hits,
            mode() WITHIN GROUP (ORDER BY s.winner) FILTER (WHERE s.winner IS NOT NULL) AS usual_winner
       FROM ${SCENARIO_ROWS} sc
       LEFT JOIN agent_sessions s ON s.scenario_id = sc.id AND s.verdict IS NOT NULL
      WHERE sc.product_id = $1
      GROUP BY sc.id, sc.title, sc.prompt, sc.repo_url, sc.language, sc.tags, sc.template, sc.platform, sc.library_task_id, sc.expectation, sc.active, sc.source, sc.rationale
      ORDER BY sc.active DESC, sc.id`,
    [p.id],
  );
  await openRows(org.orgId, scenarios as any[], ["prompt", "rationale"]);
  const warnings = scenarios.filter((sc: any) => sc.active && (!surface.redact || !sc.library_task_id) && namesProduct(sc.prompt, p))
    .map((sc: any) => `Scenario ${sc.id} ("${sc.title}") names ${p.name} in its prompt, which biases the agent. Rephrase it as a neutral task.`);
  const simulations = await db.query(
    `/* tenant: product from resolveProduct(org) */ SELECT id, name, status, models, repeats, created_at FROM simulations WHERE product_id = $1 ORDER BY created_at DESC LIMIT 5`,
    [p.id],
  );
  return {
    view: "product" as const,
    product: p,
    scenarios: scenarios.map((s: any) => ({ ...(surface.redact ? forCustomer(s) : s), hit_rate: rate(s.hits, s.sessions) })),
    simulations,
    warnings,
    models: await config.models(),
    agents: await config.agents(),
  };
}

/**
 * Portal only (Surface.redact): the portal never shows Octillion's curated task library. A task research picked from
 * the library into a customer's product shows there by title and status, never by its prompt or library metadata
 * (prompt, rationale, repo, language, tags, template, library id); everything else passes through, with `curated`.
 * Over MCP the same task is returned whole (browse_task_library lists the library itself).
 */
export function forCustomer<T extends Record<string, any>>(s: T): Omit<T, "library_task_id"> & { curated: boolean } {
  const { library_task_id, ...rest } = s;
  const curated = library_task_id != null || s.source === "library";
  if (!curated) return { ...rest, curated };
  for (const k of ["rationale", "repo_url", "language", "template", "decision", "prompt_variants"]) if (k in rest) (rest as any)[k] = null;
  if ("tags" in rest) (rest as any).tags = [];
  return { ...rest, prompt: null, curated } as any;
}

/** Portal only (Surface.redact): a library persona linked to a product (source 'library'; 'picked' was the old copy) by name only. */
export function personaForCustomer<T extends Record<string, any>>(p: T): T & { curated: boolean } {
  if (p.source !== "picked" && p.source !== "library") return { ...p, curated: false };
  const out: any = { ...p, curated: true, summary: null, attributes: {} };
  for (const k of ["instructions", "environment"]) if (k in out) out[k] = null;
  return out;
}

function namesProduct(prompt: string, p: ProductRow) {
  const words = [p.name, ...p.aliases, ...p.packages, ...p.domains].filter((w) => w.length > 2);
  return words.some((w) => new RegExp(`(?<![\\w-])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(prompt));
}

// ---------- scenarios ----------

/** Starter workspaces the orchestrator can seed (orchestrator/workspaces/<template>) for scenarios without repo_url. */
export const WORKSPACE_TEMPLATES = ["express-ts", "nextjs-ts", "node-ts", "fastapi", "django", "go-http", "react-native", "flutter", "java-spring", "rust-axum", "cpp-cmake"] as const;

/** Validate an optional platform. */
export function checkPlatform(v: unknown): Platform | undefined {
  if (v == null || v === "") return undefined;
  if (!isPlatform(v)) throw new Error(`Unknown platform "${v}"; one of ${PLATFORMS.join(", ")}`);
  return v;
}

/** Normalize an optional template: "" / "auto" -> null (picked from language/tags/prompt); unknown -> error. */
export function checkTemplate(t: string | null | undefined): string | null | undefined {
  if (t === undefined) return undefined;
  const v = (t ?? "").trim().toLowerCase();
  if (!v || v === "auto") return null;
  if (!(WORKSPACE_TEMPLATES as readonly string[]).includes(v)) throw new Error(`Unknown template "${t}"; one of ${WORKSPACE_TEMPLATES.join(", ")} (or omit it)`);
  return v;
}

export interface ScenarioInput {
  id?: number; library_task_id?: number; title?: string; prompt?: string; repo_url?: string; language?: string; tags?: string[];
  expectation?: "recommend" | "avoid"; active?: boolean;
  /** Starter workspace when there is no repo_url; omit to let the orchestrator pick from language/tags/prompt. */
  template?: string | null;
  /** Where the task's code runs (web, mobile, backend, ...); omit to derive it from the template, language and prompt. */
  platform?: Platform;
}

export async function saveScenarios(org: Org, productRef: string | undefined, items: ScenarioInput[]) {
  const p = await resolveProduct(org, productRef);
  const db = await getDb();
  await db.transaction(async (tx) => {
    for (let s of items) {
      let template = checkTemplate(s.template);
      if (s.id !== undefined) {
        const [row] = await tx.query(
          `/* tenant: product from resolveProduct(org); scenario id must belong to it */ UPDATE scenarios SET title = coalesce($3, title), prompt = coalesce($4, prompt), repo_url = coalesce($5, repo_url),
                  language = coalesce($6, language), tags = coalesce($7, tags), expectation = coalesce($8, expectation),
                  active = coalesce($9, active), template = CASE WHEN $10 THEN $11 ELSE template END,
                  platform = coalesce($12, platform), updated_at = now()
            WHERE id = $1 AND product_id = $2 RETURNING id`,
          [s.id, p.id, s.title ?? null, s.prompt ?? null, s.repo_url ?? null, s.language ?? null, s.tags ?? null,
           s.expectation ?? null, s.active ?? null, template !== undefined, template ?? null, checkPlatform(s.platform) ?? null],
        );
        if (!row) throw new Error(`Scenario ${s.id} does not belong to ${p.name}`);
        // A new template moves the task to that template's platform unless one was given.
        if (template && !s.platform) await tx.query("/* tenant: scenario id just verified against product_id from resolveProduct(org) above */ UPDATE scenarios SET platform = $2 WHERE id = $1", [s.id, platformOf({ template })]);
      } else {
        // A library task is linked, never copied (SCENARIO_ROWS reads its text from library_tasks): the row stores only
        // what the caller gave on top of it, plus the product's own settings.
        let lib: any = null;
        if (s.library_task_id !== undefined) {
          // An active library task only (an inactive or admin-hidden one is not public).
          [lib] = await tx.query<any>("SELECT * FROM library_tasks WHERE id = $1 AND active", [s.library_task_id]);
          if (!lib) throw new Error(`No library task ${s.library_task_id}; see browse_task_library`);
          // Curated tasks carry the starter workspace they were written for.
          if (template == null && (WORKSPACE_TEMPLATES as readonly string[]).includes(lib.attributes?.template)) template = lib.attributes.template;
        }
        const prompt = s.prompt?.trim() || null;
        if (!prompt && !lib) throw new Error("New scenarios need a prompt (the task given to the agent) or a library_task_id");
        // Only what differs from the library task is the product's own.
        const own = <T,>(v: T | undefined, l: T | null | undefined) => (v == null || (lib && v === l) ? null : v);
        const ownTags = s.tags && !(lib && JSON.stringify(s.tags) === JSON.stringify(lib.tags ?? [])) ? s.tags : [];
        await tx.query(
          `/* tenant: product from resolveProduct(org) */ INSERT INTO scenarios (product_id, title, prompt, repo_url, language, tags, expectation, active, library_task_id, template, platform, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [p.id, own(s.title?.trim() || (lib ? undefined : prompt!.slice(0, 80)), lib?.title), own(prompt ?? undefined, lib?.prompt),
           own(s.repo_url, lib?.repo_url), own(s.language, lib?.language), ownTags, s.expectation ?? "recommend", s.active ?? true,
           s.library_task_id ?? null, template ?? null,
           checkPlatform(s.platform ?? lib?.platform ?? undefined) ?? platformOf({ template, language: s.language ?? lib?.language, tags: s.tags ?? lib?.tags, prompt: prompt ?? lib?.prompt }),
           lib ? "library" : "manual"],
        );
      }
    }
  });
  return getProduct(org, p.slug);
}

// ---------- simulations ----------

export interface RunInput {
  product?: string; scenario_ids?: number[]; profiles?: string[]; name?: string;
  platform?: string;                                        // only active scenarios on this platform (web, mobile, ...)
  task_set?: string;                                        // only the active tasks of one of the org's private task sets
  population?: string;                                      // developer population (default: the default one)
  agents?: string[]; models?: string[]; repeats?: number;  // explicit: these agents x repeats on every scenario
  samples?: number;                                         // representative (default): sessions per scenario, mixed by adoption
  /** Adaptive sampling cap per scenario. Default (no `samples` given): config.maxSamples(). `samples` alone = a fixed-size run. */
  max_samples?: number;
}

/**
 * The welcome a client gets when the user has not asked for anything specific yet (MCP has no connect-time message a
 * person sees, so the first tool in the list carries it): what Octillion does and the ONE next step for this
 * organization's state. Same payload as list_products (so the dashboard renders) plus `welcome`.
 */
export async function getStarted(org: Org) {
  const d = await listProducts(org);
  const { simulations } = await listSimulations(org);
  const what = "Octillion runs real AI coding agents on realistic development tasks and reports how often they pick your developer tool versus competitors, if they pick one at all.";
  const first = d.products[0] as any;
  const running = simulations.find((s: any) => s.status === "queued" || s.status === "running") as any;
  let stage: "onboard" | "onboarding" | "run" | "running" | "report", next: string, say: string;
  if (!d.products.length) {
    stage = "onboard";
    say = "Onboard my product: <name>, <website>, <docs link>. It is a <one-line description>.";
    next = "No product is set up yet. Ask the user for their product's name, website and docs link, then call onboard_product. Octillion researches the product and its competitors and proposes the coding tasks to test.";
  } else if (!d.products.some((p: any) => Number(p.scenarios) > 0)) {
    stage = "onboarding";
    say = "How is my onboarding going?";
    next = `${first.name} is set up but has no tasks yet. Call get_onboarding to see whether research is still running; if it finished without tasks, add some with save_scenarios (browse_task_library has curated ones).`;
  } else if (running) {
    stage = "running";
    say = "How is my simulation doing?";
    next = `Simulation "${running.name}" is ${running.status} (${running.finished}/${running.sessions} sessions done). Call get_simulation for progress; results fill in as sessions finish.`;
  } else if (!simulations.length) {
    stage = "run";
    say = "Run a simulation.";
    next = `${first.name} has ${first.scenarios} tasks ready and no runs yet. Call run_simulation (${config.defaultSamples()} sessions per task by default); it takes roughly 10 to 30 minutes.`;
  } else {
    stage = "report";
    say = "Show my visibility report.";
    next = `${d.products.length} product(s) with completed runs. Call get_visibility_report for how often agents chose the product, who won instead and why.`;
  }
  return { ...d, welcome: { stage, say, message: `Welcome to Octillion, ${org.name}. ${what} ${next} Tell the user their next step in one or two sentences and offer this prompt to type: "${say}"` } };
}

/** The organization's metered model spend (gateway cost of its agent sessions) this calendar month, UTC. */
export async function orgMonthSpendUsd(orgId: number): Promise<number> {
  const db = await getDb();
  const [r] = await db.query<{ usd: number }>(
    // Per session: its recorded cost, or the gateway's live total while it runs (whichever is larger); same as Billing shows.
    `SELECT coalesce(sum(GREATEST(s.cost_usd, coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.session_id = s.id), 0))), 0) AS usd
       FROM agent_sessions s WHERE s.org_id = $1 AND s.queued_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [orgId]);
  return Number(r?.usd ?? 0);
}

/** Why an account without a plan or allowance cannot run anything that spends on models. */
export const NO_PLAN = (name?: string | null) => `${name ?? "This organization"} has no prepaid plan, so it can't start runs. ` +
  "Plans are invite-only while we keep inference costs in check: ask your Octillion contact for access.";

/** Each scenario's harness preference, from the library task it came from (empty: any harness in the mix). */
async function harnessPreferences(scenarioIds: number[]): Promise<Map<number, string[]>> {
  if (!scenarioIds.length) return new Map();
  const rows = await (await getDb()).query<{ id: number; harnesses: string[] }>(
    `/* tenant: internal: scenario ids already scoped by the caller */ SELECT sc.id, lt.harnesses FROM ${SCENARIO_ROWS} sc
       JOIN library_tasks lt ON lt.id = sc.library_task_id WHERE sc.id = ANY($1) AND cardinality(lt.harnesses) > 0`, [scenarioIds]);
  return new Map(rows.map((r) => [Number(r.id), r.harnesses]));
}

/**
 * The run's own words for its library tasks (src/adapt.ts): each library-linked task with no text of its own, once per
 * persona the run uses (`<scenario id>:<persona slug>`, or `<scenario id>` with no persona). Tasks with their own text
 * (written by the customer, or edited) run as written. Kept on the run (simulations.prompts), never on the product.
 */
async function runPrompts(org: Org, p: ProductRow, scenarioIds: number[], profileIds: number[]): Promise<Record<string, string>> {
  const db = await getDb();
  const tasks = await db.query<{ id: number; title: string; prompt: string; template: string | null; language: string | null; platform: string | null }>(
    `/* tenant: product from resolveProduct(org) */ SELECT sc.id, sc.title, sc.prompt, sc.template, sc.language, sc.platform FROM ${SCENARIO_ROWS} sc
      JOIN scenarios own ON own.id = sc.id WHERE sc.product_id = $1 AND sc.id = ANY($2) AND sc.library_task_id IS NOT NULL AND own.prompt IS NULL ORDER BY sc.id`,
    [p.id, scenarioIds]);
  if (!tasks.length) return {};
  const personas = profileIds.length
    ? await openRows(org.orgId, await db.query<any>("SELECT id, slug, name, summary, attributes FROM developer_profiles WHERE id = ANY($1) AND (org_id IS NULL OR org_id = $2)", [profileIds, org.orgId]), ["summary"])
    : [];
  for (const x of personas) x.attributes = await openJson(org.orgId, x.attributes);
  const [prod] = await db.query<{ terms: unknown }>("/* tenant: product from resolveProduct(org) */ SELECT research->'category_terms' AS terms FROM products WHERE id = $1", [p.id]);
  const words = [p.name, ...p.aliases, ...p.packages, ...p.domains, ...(p.competitors ?? []).flatMap((c) => [c.name, ...(c.aliases ?? []), ...(c.packages ?? []), ...(c.domains ?? [])])]
    .filter((w): w is string => typeof w === "string" && w.trim().length > 2);
  const { adaptPrompts } = await import("./adapt.js"); // lazily: adapt.ts uses research.ts, which imports this file
  return adaptPrompts(tasks.flatMap((t) => (personas.length ? personas : [null]).map((x) => ({
    key: x ? `${t.id}:${x.slug}` : String(t.id), title: t.title, prompt: t.prompt, template: t.template, language: t.language, platform: t.platform,
    persona: x ? { name: x.name, summary: x.summary ?? "", attributes: x.attributes ?? {} } : null }))),
    { category: p.category ?? null, description: p.description ?? null, words, categoryTerms: Array.isArray(prod?.terms) ? (prod!.terms as string[]) : [] });
}

export async function runSimulation(org: Org, input: RunInput) {
  // No plan, no runs: checked before anything else so the reason is the first thing the customer hears.
  const { budget } = await orgBudget(org.orgId); // admin allowance, else the prepaid plan's cap, else 0
  if (budget <= 0) throw new LimitError(NO_PLAN(org.name), 403, { code: "no_allowance", limit_usd: 0, left_usd: 0, set_by: "account" });
  const p = await resolveProduct(org, input.product);
  const db = await getDb();
  const spent = await orgMonthSpendUsd(org.orgId);
  // The account's allowance is set by Octillion, not its admins: the way out is the Octillion contact, or the new month.
  if (spent >= budget)
    throw new LimitError(`Your account has used its $${budget.toFixed(2)} for ${monthWords().month} ($${spent.toFixed(2)} spent). ` +
      `Results so far stay available; reply to your Octillion contact to raise the allowance, or wait until ${monthWords().reset}.`, 403,
      { code: "account_cap", limit_usd: budget, left_usd: 0, set_by: "account" });
  // The account's own limits for this person (src/limits.ts): rollout, allowance, team budget, concurrency, run size.
  const personal = await checkRun(org);
  const maxSessions = Math.min(config.maxSessionsPerRun(), personal.maxSessions ?? Infinity);
  const pop = await getPopulation(input.population, org.orgId);
  const enabled = enabledAgents(pop);
  if (!enabled.length) throw new Error(`No coding agents are running in developer population ${pop.slug}`);

  const platform = checkPlatform(input.platform);
  if (input.task_set) {
    // Private task set: scoped to this org and product (another org's set name or id resolves to nothing).
    const ids = (await db.query<{ id: number }>(
      `SELECT sc.id FROM ${SCENARIO_ROWS} sc JOIN org_task_sets ts ON ts.id = sc.task_set_id
        WHERE ts.org_id = $1 AND ts.product_id = $2 AND (ts.public_id = $3 OR ts.name = $3) AND sc.active ORDER BY sc.id`,
      [org.orgId, p.id, input.task_set])).map((r) => r.id);
    if (!ids.length) throw new Error(`No task set ${input.task_set} with active tasks. See list_task_sets.`);
    input = { ...input, scenario_ids: ids };
  }
  const scenarios = await db.query<{ id: number }>(
    input.scenario_ids?.length
      ? "/* tenant: product from resolveProduct(org) */ SELECT id FROM scenarios WHERE product_id = $1 AND id = ANY($2) ORDER BY id"
      : platform ? "/* tenant: product from resolveProduct(org) */ SELECT id FROM scenarios WHERE product_id = $1 AND active AND platform = $2 ORDER BY id"
      : "/* tenant: product from resolveProduct(org) */ SELECT id FROM scenarios WHERE product_id = $1 AND active ORDER BY id",
    input.scenario_ids?.length ? [p.id, input.scenario_ids] : platform ? [p.id, platform] : [p.id],
  );
  if (platform && !input.scenario_ids?.length && !scenarios.length) throw new Error(`${p.name} has no active ${platform} scenarios`);
  if (input.scenario_ids?.length && scenarios.length !== new Set(input.scenario_ids).size)
    throw new Error(`Some scenario_ids don't belong to ${p.name}`);
  if (!scenarios.length) throw new Error(`${p.name} has no active scenarios. Add some with save_scenarios.`);
  let profiles: { id: number }[] = [];
  if (input.profiles?.length) {
    const wanted = [...new Set(input.profiles.map((x) => x.toLowerCase()))];
    profiles = await db.query<{ id: number; slug: string }>(
      "SELECT id, slug FROM developer_profiles WHERE active AND slug = ANY($1) AND (org_id IS NULL OR org_id = $2) ORDER BY id", [wanted, org.orgId]);
    const missing = wanted.filter((w) => !profiles.some((p: any) => p.slug === w));
    if (missing.length) throw new Error(`Unknown developer profile(s): ${missing.join(", ")}. See list_developer_profiles.`);
  }
  else if (input.profiles === undefined) {
    // No personas named: the product's own, i.e. its active personas and the library personas linked to it
    // (product_personas), so agents talk to the developers research picked rather than to nobody. profiles: [] asks
    // for a generic developer. At most as many as fit one session per task and persona under the run's cap.
    profiles = await db.query<{ id: number }>(
      `SELECT id FROM developer_profiles WHERE org_id = $1 AND product_id = $2 AND active
       UNION SELECT pp.profile_id FROM product_personas pp JOIN developer_profiles dp ON dp.id = pp.profile_id AND dp.active AND dp.org_id IS NULL
        WHERE pp.product_id = $2 AND pp.active
       ORDER BY 1`, [org.orgId, p.id]);
    profiles = profiles.slice(0, Math.max(1, Math.floor(maxSessions / Math.max(1, scenarios.length))));
  }
  const profileIds: (number | null)[] = profiles.length ? profiles.map((p) => p.id) : [null];
  // A run on the org's own tasks or personas is private: only an orchestrator launched for this run may claim it.
  const [{ n: privateAssets }] = await db.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM scenarios WHERE id = ANY($1) AND source IN ('custom', 'manual'))
          + (SELECT count(*) FROM developer_profiles WHERE id = ANY($2) AND org_id IS NOT NULL) AS n`,
    [scenarios.map((s) => s.id), profiles.map((x) => x.id)]);
  const isPrivate = Number(privateAssets) > 0;
  if (isPrivate && (process.env.OCTILLION_ORCH_PER_JOB ?? "on").toLowerCase() === "off")
    throw new Error("This run uses your private tasks or personas, which run only on an orchestrator dedicated to the run; per-job orchestrators are off on this server");
  const slots = scenarios.flatMap((sc) => profileIds.map((profileId) => ({ scenarioId: sc.id, profileId })));

  // Explicit: chosen agents (by id or by model) x repeats on every slot. Representative: `samples` sessions per slot,
  // with agents apportioned by real-world adoption over the whole run.
  const explicit = Boolean(input.agents?.length || input.models?.length);
  // Representative runs size their first batch from the grid (agents.ts planFirstBatch): the smallest samples per
  // problem x persona that give every harness a session and every major harness every problem. `samples` overrides.
  const batchPlan = !explicit && input.samples === undefined
    ? planFirstBatch(scenarios.length, profileIds.length, schedulingShares(pop), { maxSessions })
    : null;
  const samples = input.samples ?? batchPlan?.samples ?? config.defaultSamples();
  const repeats = input.repeats ?? 3;
  // Representative runs are adaptive unless the caller fixed the size with `samples` alone: `samples` is then the first
  // batch per slot and more sessions are added per task until it settles or reaches the cap (extendAdaptive).
  const maxSamples = explicit ? null
    : input.max_samples !== undefined ? Math.max(1, Math.trunc(input.max_samples))
    : input.samples === undefined ? config.maxSamples() : null;
  let plan: { scenarioId: number; profileId: number | null; agent: AgentSpec; attempt: number }[];
  if (explicit) {
    // A slot agent's model_variants (e.g. pi on GPT) are selectable by id too.
    let chosen = [...new Map(enabled.flatMap((a) => [a, ...variantsOf(a)]).map((a) => [a.id, a])).values()];
    if (input.agents?.length) {
      const unknown = input.agents.filter((a) => !chosen.some((e) => e.id === a));
      if (unknown.length) throw new Error(`Unknown or disabled agent(s): ${unknown.join(", ")}. Available: ${chosen.map((e) => e.id).join(", ")}`);
      chosen = chosen.filter((e) => input.agents!.includes(e.id));
    }
    if (input.models?.length) {
      const unknown = input.models.filter((m) => !chosen.some((e) => e.model === m));
      if (unknown.length) throw new Error(`Unsupported model(s): ${unknown.join(", ")}. Available: ${[...new Set(chosen.map((e) => e.model))].join(", ")}`);
      chosen = chosen.filter((e) => input.models!.includes(e.model));
    }
    plan = slots.flatMap((slot) => chosen.flatMap((agent) => Array.from({ length: repeats }, (_, i) => ({ ...slot, agent, attempt: i + 1 }))));
  } else {
    // Slot agents with model_variants (e.g. pi) run each sampled session as one of their models, drawn by share.
    // Each scenario x profile cell gets a near-proportional share of the weighted mix (agents.ts dealToCells, by harness preference).
    // First batch: every scheduled harness gets at least one session; the rest by weight, spread over problems.
    // A task with a harness preference (Tasks library) is dealt only among the harnesses it names.
    const prefer = await harnessPreferences(scenarios.map((s) => s.id));
    const cells = dealByPreference(slots.map(() => samples), schedulingShares(pop), slots.map((s) => prefer.get(s.scenarioId)),
      { floor: 1, groups: slots.map((s) => s.scenarioId) });
    plan = slots.flatMap((slot, si) => cells[si]!.map((a, i) => ({ ...slot, agent: drawVariant(a), attempt: i + 1 })));
  }
  if (plan.length > maxSessions)
    throw new LimitError(`This simulation needs ${plan.length} agent sessions (${scenarios.length} scenarios x ${profileIds.length} profiles x ${explicit ? "agents x repeats" : `${samples} samples`}); ` +
      `the limit per run is ${maxSessions}. Use fewer scenarios, profiles, agents, repeats or samples.` +
      (maxSessions < config.maxSessionsPerRun() ? ` ${askAdmins(personal.admins, false)}` : ""), 400,
      { code: "run_sessions", set_by: maxSessions < config.maxSessionsPerRun() ? "account" : undefined });

  const used = [...new Map(plan.map((x) => [x.agent.id, x.agent])).values()];
  const prompts = await runPrompts(org, p, scenarios.map((x) => Number(x.id)), profiles.map((x) => x.id));
  const id = randomId("sim_");
  const name = input.name?.trim() || `${p.name} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
  await db.transaction(async (tx) => {
    // Launches for one account take turns (released at COMMIT), and runs at once is counted again inside the turn:
    // two launches at the same moment both passed checkRun's count, which saw neither of them.
    await tx.query("SELECT pg_advisory_xact_lock(7270012, $1)", [org.orgId]);
    if (personal.max_runs != null && org.userId) {
      const [{ n }] = await tx.query<{ n: number }>(
        "SELECT count(*) AS n FROM simulations WHERE org_id = $1 AND created_by = $2 AND status IN ('queued', 'running')", [org.orgId, org.userId]);
      if (Number(n) >= personal.max_runs) throw runsAtOnceError(Number(n), personal.max_runs, personal.runs_set_by, personal.admins);
    }
    await tx.query(
      `INSERT INTO simulations (id, org_id, product_id, name, models, harness, repeats, profile_ids, mode, agent_ids, population_id, max_samples, research_id, created_by, private, prompts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, (SELECT research->>'research_id' FROM products WHERE id = $3), $13, $14, $15)`,
      [id, org.orgId, p.id, name, [...new Set(used.map((a) => a.model))], [...new Set(used.map((a) => a.harness))].join(", "),
       explicit ? repeats : samples, profiles.map((x) => x.id), explicit ? "explicit" : "representative", used.map((a) => a.id), pop.id, maxSamples, org.userId ?? null, isPrivate,
       JSON.stringify(prompts)],
    );
    for (const x of plan)
      await tx.query(
        `INSERT INTO agent_sessions (id, simulation_id, org_id, product_id, scenario_id, model, harness, agent_id, attempt, profile_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [randomId("ses_"), id, org.orgId, p.id, x.scenarioId, x.agent.model, x.agent.harness, x.agent.id, x.attempt, x.profileId],
      );
  });
  // What is left for the launcher (connector keys: the account's), and what this run is likely to cost (Budget rules).
  const { avg_session_usd } = await monthFigures(org.orgId);
  const budgetNote = launchNote(personal.left_usd ?? Math.max(0, Math.round((budget - spent) * 100) / 100), personal.limit_usd, plan.length, avg_session_usd);
  return { ...(await getSimulation(org, id)), budget: budgetNote };
}

/**
 * Adaptive sampling. Called when a simulation's queued and running sessions have all finished: for each task, decide
 * whether its result is settled, and queue another batch for the ones that are not. A task is settled when its hit rate
 * is known to within +/- samplingMargin (Wilson 95% interval, at least samplingMin scored sessions), or when it has had
 * max_samples sessions. Unanimous tasks settle after a handful; split ones run to the cap. Also stops at the per-run
 * session limit, the organization's monthly budget, the launcher's limits, and the account's dollar cap per run.
 * Returns the number of sessions queued (0 = the run is done).
 */
export async function extendAdaptive(simulationId: string): Promise<number> {
  const db = await getDb();
  // Read what needs its own queries before taking the row lock (no nested queries inside the transaction).
  // The run's live spend (as orgMonthSpendUsd, per session) and the account's dollar cap per run (Budget rules).
  const [pre] = await db.query<{ org_id: number; mode: string; max_samples: number | null; slug: string | null; created_by: string | null; org_slug: string;
                                 max_run_usd: number | null; run_usd: number }>(
    `SELECT sim.org_id, sim.mode, sim.max_samples, dp.slug, sim.created_by, o.slug AS org_slug,
            (SELECT p.max_run_usd FROM usage_policies p WHERE p.org_id = sim.org_id) AS max_run_usd,
            (SELECT coalesce(sum(GREATEST(a.cost_usd, coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.session_id = a.id), 0))), 0)
               FROM agent_sessions a WHERE a.simulation_id = sim.id) AS run_usd
       FROM simulations sim JOIN organizations o ON o.id = sim.org_id LEFT JOIN developer_populations dp ON dp.id = sim.population_id
      WHERE sim.id = $1`, [simulationId]);
  if (!pre || pre.mode !== "representative" || !pre.max_samples) return 0;
  // Fails closed: if the allowance can't be looked up, stop adding sessions (the ones running still finish).
  const budget = await orgBudget(pre.org_id).then((b) => b.budget, () => null);
  // The account's budget, or the launcher's own allowance or team budget (src/limits.ts), stops sampling early.
  const overBudget = budget == null || budget <= 0 || (await orgMonthSpendUsd(pre.org_id)) >= budget || (await launcherOverLimit(pre.org_id, pre.org_slug, pre.created_by));
  // The run's own dollar cap: once it has spent that much, no more sessions (the ones running still finish).
  const runCapped = !overBudget && pre.max_run_usd != null && Number(pre.run_usd) >= Number(pre.max_run_usd);
  const stopped = budget == null ? "stopped: couldn't check the allowance" : overBudget ? "stopped: monthly budget" : "stopped: run spend limit";
  const stop = overBudget || runCapped;
  // Sessions per run applies to the whole run, top-ups included: the server's limit, or the account's if lower.
  const maxSessions = await sessionsLimit(pre.org_id);
  const pop = await getPopulation(pre.slug ?? undefined);
  const prefer = await harnessPreferences((await db.query<{ scenario_id: number }>(
    "/* tenant: internal: adaptive sampling of a finished session's simulation */ SELECT DISTINCT scenario_id FROM agent_sessions WHERE simulation_id = $1",
    [simulationId])).map((r) => Number(r.scenario_id)));
  return db.transaction(async (tx) => {
    const [sim] = await tx.query<{ id: string; org_id: number; product_id: number; mode: string; status: string; max_samples: number | null;
                                   population_id: number | null; profile_ids: number[] | null }>(
      "SELECT id, org_id, product_id, mode, status, max_samples, population_id, profile_ids FROM simulations WHERE id = $1 FOR UPDATE", [simulationId]);
    if (!sim || sim.mode !== "representative" || !sim.max_samples || sim.status === "cancelled") return 0;
    const [open] = await tx.query<{ n: number }>("/* tenant: internal: adaptive sampling of a finished session's simulation */ SELECT count(*) AS n FROM agent_sessions WHERE simulation_id = $1 AND status IN ('queued', 'running')", [simulationId]);
    if (Number(open.n) > 0) return 0; // a batch is still in flight (or another completion already extended the run)
    const rows = await tx.query<{ scenario_id: number; attempts: number; n: number; hits: number }>(
      `/* tenant: internal: adaptive sampling of a finished session's simulation */ SELECT s.scenario_id, count(*) AS attempts, count(*) FILTER (WHERE s.verdict IS NOT NULL) AS n,
              count(*) FILTER (WHERE s.verdict IS NOT NULL AND ${HIT}) AS hits
         FROM agent_sessions s JOIN ${SCENARIO_ROWS} sc ON sc.id = s.scenario_id
        WHERE s.simulation_id = $1 GROUP BY s.scenario_id ORDER BY s.scenario_id`, [simulationId]);
    let room = maxSessions - rows.reduce((t, r) => t + Number(r.attempts), 0);
    const decisions: Record<string, unknown> = {};
    const more: { scenarioId: number; from: number; count: number }[] = [];
    for (const r of rows) {
      const attempts = Number(r.attempts), n = Number(r.n), hits = Number(r.hits);
      const ci = wilson(hits, n);
      const margin = ci ? (ci[1] - ci[0]) / 2 : 1;
      const settled = n >= config.samplingMin() && margin <= config.samplingMargin();
      const want = settled || attempts >= sim.max_samples || stop ? 0 : Math.max(0, Math.min(config.samplingBatch(), sim.max_samples - attempts, room));
      room -= want;
      decisions[String(r.scenario_id)] = {
        attempts, scored: n, hits, margin: Math.round(margin * 100) / 100,
        status: settled ? "settled" : attempts >= sim.max_samples ? "cap reached" : stop ? stopped : want ? "sampling more" : "stopped: run limit",
      };
      if (want) more.push({ scenarioId: Number(r.scenario_id), from: attempts, count: want });
    }
    await tx.query("/* tenant: internal: adaptive sampling of a finished session's simulation */ UPDATE simulations SET sampling = $2 WHERE id = $1", [simulationId, JSON.stringify(decisions)]);
    const total = more.reduce((t, m) => t + m.count, 0);
    if (!total) return 0;
    // Top-ups are dealt the same way: each scenario's batch gets a near-proportional share of the weighted mix.
    // top-ups: by usage share only, within each task's harness preference
    const cells = dealByPreference(more.map((m) => m.count), schedulingShares(pop), more.map((m) => prefer.get(m.scenarioId)));
    const profileIds: (number | null)[] = sim.profile_ids?.length ? sim.profile_ids : [null];
    for (const [mi, m] of more.entries())
      for (let i = 0; i < m.count; i++) {
        const agent = drawVariant(cells[mi]![i]!);
        await tx.query(
          `INSERT INTO agent_sessions (id, simulation_id, org_id, product_id, scenario_id, model, harness, agent_id, attempt, profile_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [randomId("ses_"), simulationId, sim.org_id, sim.product_id, m.scenarioId, agent.model, agent.harness, agent.id,
           m.from + i + 1, profileIds[(m.from + i) % profileIds.length]]);
      }
    await tx.query("/* tenant: internal: adaptive sampling of a finished session's simulation */ UPDATE simulations SET status = 'running', finished_at = NULL WHERE id = $1 AND status <> 'cancelled'", [simulationId]);
    return total;
  });
}

export async function listSimulations(org: Org, productRef?: string) {
  const db = await getDb();
  const p = productRef ? await resolveProduct(org, productRef) : null;
  const simulations = await db.query(
    `SELECT sim.id, sim.name, sim.status, sim.models, sim.repeats, sim.created_at, sim.finished_at, p.name AS product, p.slug AS product_slug,
            count(s.id) AS sessions,
            count(*) FILTER (WHERE s.status IN ('completed', 'failed', 'timeout', 'cancelled')) AS finished,
            count(*) FILTER (WHERE s.verdict IS NOT NULL) AS scored,
            count(*) FILTER (WHERE s.verdict IS NOT NULL AND ${HIT}) AS hits
       FROM simulations sim JOIN products p ON p.id = sim.product_id
       LEFT JOIN agent_sessions s ON s.simulation_id = sim.id
       LEFT JOIN ${SCENARIO_ROWS} sc ON sc.id = s.scenario_id
      WHERE sim.org_id = $1 ${p ? "AND sim.product_id = $2" : ""}
      GROUP BY sim.id, p.id ORDER BY sim.created_at DESC LIMIT 50`,
    p ? [org.orgId, p.id] : [org.orgId],
  );
  return { view: "simulations" as const, product: p?.slug ?? null, simulations: simulations.map((s: any) => ({ ...s, hit_rate: rate(s.hits, s.scored) })) };
}

export async function getSimulation(org: Org, simulationId: string) {
  const db = await getDb();
  const [sim] = await db.query<any>(
    `SELECT sim.*, p.name AS product, p.slug AS product_slug FROM simulations sim JOIN products p ON p.id = sim.product_id
      WHERE sim.id = $1 AND sim.org_id = $2`,
    [simulationId, org.orgId],
  );
  if (!sim) throw new Error(`No simulation ${simulationId}`);
  const sessions = await db.query<any>(
    `SELECT s.id, s.scenario_id, sc.title AS scenario, sc.expectation, s.model, s.attempt, s.status, s.verdict, s.winner,
            s.agent_id, s.started_at, s.ended_at, s.events, s.user_turns, s.cost_usd, s.error_message, dp.name AS profile,
            s.completed_reason, (s.metadata->>'agent_turns')::int AS agent_turns,
            CASE WHEN s.verdict IS NULL THEN NULL ELSE ${HIT} END AS hit
       FROM agent_sessions s JOIN ${SCENARIO_ROWS} sc ON sc.id = s.scenario_id LEFT JOIN developer_profiles dp ON dp.id = s.profile_id
      WHERE s.simulation_id = $1 AND s.org_id = $2 ORDER BY sc.id, s.model, s.attempt`,
    [simulationId, org.orgId],
  );
  const by = <K extends string>(key: (s: any) => K) => {
    const m = new Map<K, any[]>();
    for (const s of sessions) m.set(key(s), [...(m.get(key(s)) ?? []), s]);
    return m;
  };
  const summarize = (xs: any[]) => {
    const scored = xs.filter((x) => x.verdict);
    const hits = scored.filter((x) => x.hit).length;
    return { sessions: xs.length, scored: scored.length, hits, hit_rate: rate(hits, scored.length), hit_ci: wilson(hits, scored.length) };
  };
  const statusCounts: Record<string, number> = {};
  const verdictCounts: Record<string, number> = {};
  const reasonCounts: Record<string, number> = {};
  for (const s of sessions) {
    statusCounts[s.status] = (statusCounts[s.status] ?? 0) + 1;
    if (s.verdict) verdictCounts[s.verdict] = (verdictCounts[s.verdict] ?? 0) + 1;
    if (s.completed_reason) reasonCounts[s.completed_reason] = (reasonCounts[s.completed_reason] ?? 0) + 1;
  }
  const agentIds = [...new Set(sessions.map((s) => s.agent_id ?? s.model))]
    .sort((a, b) => (findAgent(b)?.weight ?? 0) - (findAgent(a)?.weight ?? 0));
  const matrix = [...by((s) => String(s.scenario_id))].map(([scenarioId, xs]) => ({
    scenario_id: Number(scenarioId), scenario: xs[0].scenario, expectation: xs[0].expectation,
    cells: agentIds.map((id) => ({ agent_id: id, label: agentLabel(id), ...summarize(xs.filter((x) => (x.agent_id ?? x.model) === id)) })),
  }));
  // On-demand orchestrators: while sessions wait in the queue, say what capacity is doing ("starting orchestrator…").
  const capacity = sessions.some((s) => s.status === "queued") ? await capacityStatus() : null;
  return {
    view: "simulation" as const,
    capacity,
    // Set on launch only (runSimulation): what is left for the launcher and the run's estimated cost.
    budget: null as LaunchNote | null,
    simulation: sim,
    totals: { ...summarize(sessions), cost_usd: sessions.reduce((a, s) => a + Number(s.cost_usd), 0) },
    status: statusCounts,
    verdicts: verdictCounts,
    completed_reasons: reasonCounts,
    by_model: sim.models.map((model: string) => ({ model, ...summarize(sessions.filter((s) => s.model === model)) })),
    by_agent: agentIds.map((id) => ({ agent_id: id, label: agentLabel(id), ...summarize(sessions.filter((s) => (s.agent_id ?? s.model) === id)) })),
    by_profile: [...by((s) => s.profile ?? "")].filter(([k]) => k).map(([profile, xs]) => ({ profile, ...summarize(xs) })),
    matrix,
    sessions,
  };
}

export async function cancelSimulation(org: Org, simulationId: string) {
  const db = await getDb();
  const [sim] = await db.query("SELECT id FROM simulations WHERE id = $1 AND org_id = $2", [simulationId, org.orgId]);
  if (!sim) throw new Error(`No simulation ${simulationId}`);
  // Running sessions stop too: their gateway tokens are revoked (no more model calls), and their next heartbeat is
  // refused (409), so the orchestrator kills the sandbox. Before 2026-10-14 only queued sessions were cancelled, and
  // a run whose sessions had all been claimed kept running and spending.
  await db.transaction(async (tx) => {
    await tx.query(
      `/* tenant: simulation checked with org_id = the caller's org above */ UPDATE gateway_tokens SET revoked_at = now()
        WHERE revoked_at IS NULL AND session_id IN (SELECT id FROM agent_sessions WHERE simulation_id = $1 AND status IN ('queued', 'running'))`,
      [simulationId]);
    await tx.query("/* tenant: simulation checked with org_id = the caller's org above */ UPDATE agent_sessions SET status = 'cancelled', ended_at = now() WHERE simulation_id = $1 AND status IN ('queued', 'running')", [simulationId]);
    await tx.query("/* tenant: simulation checked with org_id = the caller's org above */ UPDATE simulations SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status IN ('queued', 'running')", [simulationId]);
  });
  return getSimulation(org, simulationId);
}

// ---------- visibility report ----------

export async function getReport(org: Org, input: { product?: string; days?: number; model?: string; population?: string; simulation?: string; platform?: string }) {
  const p = await resolveProduct(org, input.product);
  const db = await getDb();
  const days = input.days ?? 30;
  const params: unknown[] = [p.id, days];
  let sim: any = null;
  let base = "s.product_id = $1 AND s.ended_at > now() - make_interval(days => $2)";
  if (input.simulation) {
    [sim] = await db.query<any>(
      "SELECT id, name, status, sampling, max_samples, created_at, finished_at FROM simulations WHERE id = $1 AND org_id = $2 AND product_id = $3",
      [input.simulation, org.orgId, p.id]);
    if (!sim) throw new Error(`No simulation ${input.simulation} for ${p.name}`);
    // One run, whatever its age. $2 (days) stays referenced so every query keeps the same parameter list.
    params.push(sim.id), (base = `s.product_id = $1 AND s.simulation_id = $${params.length} AND $2::int > 0`);
  }
  if (input.model) params.push(input.model), (base += ` AND s.model = $${params.length}`);
  // Never blend harness mixes: a report covers runs on one population (the run's own, the named one, or the default).
  const pop = await getPopulation(sim ? (await db.query<{ slug: string }>(
    "/* tenant: simulation checked with org_id and product above */ SELECT dp.slug FROM simulations s JOIN developer_populations dp ON dp.id = s.population_id WHERE s.id = $1", [sim.id]))[0]?.slug ?? input.population : input.population, org.orgId);
  if (!sim) {
    params.push(pop.id);
    base += ` /* tenant: appended to a filter on s.product_id from resolveProduct(org) */ AND s.simulation_id IN (SELECT id FROM simulations WHERE coalesce(population_id, (SELECT id FROM developer_populations WHERE is_default)) = $${params.length})`;
  }
  const platform = checkPlatform(input.platform);
  if (platform) params.push(platform), (base += ` AND sc.platform = $${params.length}`);
  const filter = `${base} AND s.verdict IS NOT NULL`;
  const from = `agent_sessions s JOIN ${SCENARIO_ROWS} sc ON sc.id = s.scenario_id WHERE ${filter}`;

  const [t] = await db.query<any>(
    `SELECT count(*) AS sessions, count(*) FILTER (WHERE ${HIT}) AS hits,
            count(*) FILTER (WHERE s.verdict = 'adopted') AS adopted,
            count(*) FILTER (WHERE s.verdict = 'recommended') AS recommended,
            count(*) FILTER (WHERE s.verdict = 'mentioned') AS mentioned,
            count(*) FILTER (WHERE s.verdict = 'competitor') AS competitor,
            count(*) FILTER (WHERE s.verdict = 'none') AS none,
            coalesce(sum(s.cost_usd), 0) AS cost_usd
       FROM ${from}`,
    params,
  );
  // Share of voice: in how many sessions each tool was at least recommended.
  const voice = await db.query<any>(
    `SELECT m->>'tool' AS tool, bool_or((m->>'target')::boolean) AS target,
            count(*) FILTER (WHERE m->>'level' IN ('recommended', 'adopted')) AS recommended,
            count(*) FILTER (WHERE m->>'level' = 'adopted') AS adopted,
            count(*) AS mentioned
       FROM ${from.replace(" WHERE ", ", jsonb_array_elements(coalesce(s.mentions, '[]'::jsonb)) m WHERE ")}
      GROUP BY 1 ORDER BY recommended DESC, mentioned DESC`,
    params,
  );
  const byModel = await db.query<any>(
    `SELECT s.model, count(*) AS sessions, count(*) FILTER (WHERE ${HIT}) AS hits,
            count(*) FILTER (WHERE s.verdict = 'competitor') AS competitor
       FROM ${from} GROUP BY s.model ORDER BY s.model`,
    params,
  );
  const byProfile = await db.query<any>(
    `SELECT dp.slug, dp.name, count(*) AS sessions, count(*) FILTER (WHERE ${HIT}) AS hits, avg(s.user_turns)::float AS avg_user_turns
       FROM ${from.replace(" WHERE ", " JOIN developer_profiles dp ON dp.id = s.profile_id WHERE ")}
      GROUP BY dp.id ORDER BY dp.name`,
    params,
  );
  const byAgent = await db.query<any>(
    `SELECT coalesce(s.agent_id, s.model) AS agent_id, count(*) AS sessions, count(*) FILTER (WHERE ${HIT}) AS hits,
            count(*) FILTER (WHERE s.verdict = 'competitor') AS competitor
       FROM ${from} GROUP BY 1`,
    params,
  );
  const running = new Map(scheduledAgents(pop).map((x) => [x.id, x.weight])); // whole-sandbox shares, sum to 1
  const market = new Map(pop.agents.map((x) => [x.id, x.weight]));
  const agentRows = byAgent.map((a) => {
    const spec = findAgent(a.agent_id);
    return { ...a, label: agentLabel(a.agent_id), weight: running.get(a.agent_id) ?? 0, market_share: spec?.enabled === false ? 0 : market.get(a.agent_id) ?? 0,
             hit_rate: rate(a.hits, a.sessions), hit_ci: wilson(a.hits, a.sessions) };
  }).sort((a, b) => b.weight - a.weight);
  // What a randomly chosen developer's agent would do: per-agent hit rates weighted by real-world adoption.
  const weightSum = agentRows.reduce((s, a) => s + (a.hit_rate == null ? 0 : a.weight), 0);
  const weighted = weightSum ? agentRows.reduce((s, a) => s + (a.hit_rate ?? 0) * a.weight, 0) / weightSum : null;
  const byScenario = await db.query<any>(
    `SELECT sc.id, sc.title, sc.expectation, sc.platform, sc.library_task_id, sc.source, count(*) AS sessions, count(*) FILTER (WHERE ${HIT}) AS hits,
            mode() WITHIN GROUP (ORDER BY s.winner) FILTER (WHERE s.winner IS NOT NULL) AS usual_winner
       FROM ${from} GROUP BY sc.id, sc.title, sc.expectation, sc.platform, sc.library_task_id, sc.source ORDER BY count(*) FILTER (WHERE ${HIT})::float / count(*), sc.id`,
    params,
  );
  const daily = await db.query<any>(
    `/* tenant: product from resolveProduct(org), in the shared filter */ SELECT d::date AS day, count(s.id) AS sessions, count(s.id) FILTER (WHERE ${HIT}) AS hits
       FROM generate_series(current_date - ($2::int - 1), current_date, interval '1 day') d
       LEFT JOIN (agent_sessions s JOIN ${SCENARIO_ROWS} sc ON sc.id = s.scenario_id)
              ON s.ended_at::date = d::date AND ${filter}
      GROUP BY d ORDER BY d`,
    params,
  );
  const losses = await db.query<any>(
    `SELECT s.id, s.model, s.winner, s.ended_at, sc.id AS scenario_id, sc.title AS scenario
       FROM ${from} AND s.verdict = 'competitor' ORDER BY s.ended_at DESC LIMIT 10`,
    params,
  );
  const n = Number(t.sessions);
  const rows = await db.query<any>(
    `/* tenant: product from resolveProduct(org), in the shared base filter */ SELECT s.id, s.status, s.verdict, s.winner, s.mentions, s.untracked, coalesce(s.agent_id, s.model) AS agent_id, s.cost_usd,
            sc.id AS scenario_id, sc.expectation, sc.platform, dp.name AS profile
       FROM agent_sessions s JOIN ${SCENARIO_ROWS} sc ON sc.id = s.scenario_id LEFT JOIN developer_profiles dp ON dp.id = s.profile_id
      WHERE ${base} AND s.status NOT IN ('queued', 'running', 'cancelled')`,
    params,
  );
  const promptRows = await openRows(org.orgId, await db.query<any>(`/* tenant: product from resolveProduct(org) */ SELECT sc.id, sc.prompt FROM ${SCENARIO_ROWS} sc WHERE sc.product_id = $1`, [p.id]), ["prompt"]);
  const prompts = new Map(promptRows.map((r: any) => [Number(r.id), String(r.prompt ?? "")]));
  const sections = reportSections(p, rows, byScenario, prompts, sim);
  return {
    view: "report" as const,
    product: { id: p.id, slug: p.slug, name: p.name },
    filters: { days, model: input.model ?? null, simulation: sim?.id ?? null, platform: platform ?? null },
    population: { slug: pop.slug, name: pop.name, is_default: pop.is_default, private: pop.org_id != null },
    ...sections.report,
    models: await config.models(),
    totals: { ...t, hit_rate: rate(t.hits, n), hit_ci: wilson(t.hits, n), weighted_hit_rate: weighted,
              adoption_coverage: weightSum, adoption_rate: rate(t.adopted, n), competitor_rate: rate(t.competitor, n) },
    share_of_voice: voice.map((v) => ({ ...v, share: rate(v.recommended, n) })),
    by_model: byModel.map((m) => ({ ...m, hit_rate: rate(m.hits, m.sessions), hit_ci: wilson(m.hits, m.sessions) })),
    by_agent: agentRows.map((a) => ({ ...a, on_target: sections.onTarget.get(a.agent_id) ?? null })),
    by_profile: byProfile.map((p) => ({ ...p, hit_rate: rate(p.hits, p.sessions), hit_ci: wilson(p.hits, p.sessions) })),
    by_scenario: byScenario.map((s) => ({ ...s, hit_rate: rate(s.hits, s.sessions), hit_ci: wilson(s.hits, s.sessions), ...sections.tasks.get(Number(s.id)) })),
    daily: daily.map((d) => ({ day: new Date(d.day).toISOString().slice(0, 10), sessions: Number(d.sessions), hits: Number(d.hits), hit_rate: rate(d.hits, d.sessions) })),
    recent_losses: losses,
    untracked_tools: untrackedTools(p, rows),
  };
}

/**
 * What agents installed in sessions that picked neither the product nor a tracked competitor (verdict "none"):
 * the alternatives the competitor list is missing. Re-checked against the current list, so adding one clears it.
 */
function untrackedTools(p: ProductRow, rows: any[]) {
  const known = new Set([p.name, ...p.aliases, ...p.packages, ...p.competitors.flatMap((c) => [c.name, ...(c.aliases ?? []), ...(c.packages ?? [])])].map((x) => x.toLowerCase()));
  const none = rows.filter((r) => r.verdict === "none");
  const by = new Map<string, { name: string; ecosystem: string; sessions: number }>();
  for (const r of none)
    for (const x of (r.untracked ?? []) as { name: string; ecosystem: string }[]) {
      if (known.has(x.name.toLowerCase())) continue;
      const k = `${x.ecosystem}:${x.name}`;
      by.set(k, { ...x, sessions: (by.get(k)?.sessions ?? 0) + 1 });
    }
  return { sessions_with_no_tool: none.length, competitors: p.competitors,
           packages: [...by.values()].sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name)).slice(0, 15) };
}

/** Outcome of one scored session: built on the product, on a competitor, or on no vendor (built it, or left it open). */
export const outcomeOf = (verdict: string) => verdict === "adopted" || verdict === "recommended" ? "product" : verdict === "competitor" ? "competitor" : "no_vendor";
const tally = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())]
  .map(([tool, sessions]) => ({ tool, sessions })).sort((a, b) => b.sessions - a.sessions || a.tool.localeCompare(b.tool));
const share = (k: number, n: number) => `${k} of ${n}`;

/**
 * The sections a written report needs beyond the rates (the shape of docs/case-studies/resend.md): per task, what the
 * agents built instead and whether they mentioned the product at all; per agent, outcomes on the tasks the product
 * should win; quotes from the deciding sessions; how the run was set up; headline findings and limits.
 */
function reportSections(p: ProductRow, rows: any[], byScenario: any[], prompts: Map<number, string>, sim: any) {
  const name = p.name;
  const scored = rows.filter((r) => r.verdict);
  const mentionsProduct = (r: any) => (r.mentions ?? []).some((m: any) => m.target);
  const titles = new Map(byScenario.map((s) => [Number(s.id), String(s.title)]));

  const tasks = new Map<number, any>();
  for (const s of byScenario) {
    const id = Number(s.id);
    const xs = scored.filter((r) => Number(r.scenario_id) === id);
    const out = { product: 0, competitor: 0, no_vendor: 0 };
    for (const r of xs) out[outcomeOf(r.verdict) as keyof typeof out]++;
    const misses = xs.filter((r) => outcomeOf(r.verdict) !== "product");
    tasks.set(id, {
      outcomes: out,
      winners: tally(xs.filter((r) => r.verdict === "competitor" && r.winner).map((r) => r.winner)),
      // Tools the agent named or used in sessions that did not choose the product: its shortlist.
      alternatives: tally(misses.flatMap((r) => [...new Set((r.mentions ?? []).filter((m: any) => !m.target).map((m: any) => String(m.tool)))] as string[])),
      product_mentioned: xs.filter(mentionsProduct).length,
      unscored: rows.filter((r) => !r.verdict && Number(r.scenario_id) === id).length,
      prompt: (prompts.get(id) ?? "").replace(/\s+/g, " ").slice(0, 280),
    });
  }

  const target = scored.filter((r) => r.expectation === "recommend");
  // Results per platform the tasks target, so a product's mobile and web results can be read apart.
  const byPlatform = [...new Set(scored.map((r) => r.platform ?? "other"))].map((pl) => {
    const xs = target.filter((r) => (r.platform ?? "other") === pl), ctl = scored.filter((r) => r.expectation !== "recommend" && (r.platform ?? "other") === pl);
    const o = { product: 0, competitor: 0, no_vendor: 0 };
    for (const r of xs) o[outcomeOf(r.verdict) as keyof typeof o]++;
    return { platform: pl, tasks: new Set(scored.filter((r) => (r.platform ?? "other") === pl).map((r) => Number(r.scenario_id))).size,
             sessions: xs.length, ...o, hit_rate: rate(o.product, xs.length), hit_ci: wilson(o.product, xs.length),
             product_mentioned: xs.filter(mentionsProduct).length,
             control: { sessions: ctl.length, correct: ctl.filter((r) => outcomeOf(r.verdict) !== "product").length } };
  }).sort((a, b) => b.sessions - a.sessions);
  const onTarget = new Map<string, any>();
  for (const r of target) {
    const a = onTarget.get(r.agent_id) ?? { sessions: 0, product: 0, competitor: 0, no_vendor: 0 };
    a.sessions++; a[outcomeOf(r.verdict)]++;
    onTarget.set(r.agent_id, a);
  }

  // Evidence: losses first, then sessions that built without a vendor, then wins; at most 3 per task, 12 in all.
  const quoteOf = (r: any) => {
    const ms: any[] = r.mentions ?? [];
    const pick = ms.find((m) => r.winner && m.tool === r.winner && m.evidence?.length) ?? ms.find((m) => m.target && m.evidence?.length) ?? ms.find((m) => m.evidence?.length);
    return pick ? { tool: pick.tool, level: pick.level, seq: pick.evidence[0].seq, quote: String(pick.evidence[0].snippet ?? "").replace(/\s+/g, " ").slice(0, 300) } : null;
  };
  const rank = (r: any) => r.expectation !== "recommend" ? 3 : r.verdict === "competitor" ? 0 : outcomeOf(r.verdict) === "no_vendor" ? 1 : 2;
  const perTask = new Map<number, number>();
  const evidence = [...scored].sort((a, b) => rank(a) - rank(b) || Number(a.scenario_id) - Number(b.scenario_id)).flatMap((r) => {
    const used = perTask.get(Number(r.scenario_id)) ?? 0;
    if (rank(r) === 3 || used >= 3) return [];
    perTask.set(Number(r.scenario_id), used + 1);
    return [{ session_id: r.id, scenario_id: Number(r.scenario_id), scenario: titles.get(Number(r.scenario_id)) ?? "", agent: agentLabel(r.agent_id),
              profile: r.profile ?? null, outcome: outcomeOf(r.verdict), verdict: r.verdict, winner: r.winner ?? null,
              mentioned_product: mentionsProduct(r), evidence: quoteOf(r) }];
  }).slice(0, 12);

  const statusOf = (st: string) => rows.filter((r) => !r.verdict && r.status === st).length;
  const sampling = Object.values((sim?.sampling ?? {}) as Record<string, { status: string }>);
  const method = {
    scope: sim ? { simulation: sim.id, name: sim.name, status: sim.status, started: sim.created_at, finished: sim.finished_at } : null,
    sessions: rows.length,
    scored: scored.length,
    excluded: { timeout: statusOf("timeout"), failed: statusOf("failed"), unscored: rows.filter((r) => !r.verdict && !["timeout", "failed"].includes(r.status)).length },
    tasks: { total: byScenario.length, recommend: byScenario.filter((s) => s.expectation === "recommend").length, avoid: byScenario.filter((s) => s.expectation !== "recommend").length },
    personas: tally(rows.map((r) => r.profile).filter(Boolean)).map((x) => ({ name: x.tool, sessions: x.sessions })),
    agents: tally(rows.map((r) => r.agent_id)).map((x) => ({ agent_id: x.tool, label: agentLabel(x.tool), sessions: x.sessions })),
    competitors: ((p as any).competitors ?? []).map((c: any) => c.name),
    cost_usd: rows.reduce((a, r) => a + Number(r.cost_usd ?? 0), 0),
    sampling: sim?.max_samples ? { max_per_task: sim.max_samples, settled: sampling.filter((x) => x.status === "settled").length,
                                   at_cap: sampling.filter((x) => x.status === "cap reached").length } : null,
  };

  // Headline findings: plain statements computed from the numbers, for the writer to build on (not conclusions).
  const headline: string[] = [];
  const hits = target.filter((r) => outcomeOf(r.verdict) === "product").length;
  if (target.length) headline.push(`On tasks ${name} should win, agents built on it in ${share(hits, target.length)} scored sessions.`);
  const platformsRun = byPlatform.filter((x) => x.sessions);
  if (platformsRun.length > 1) headline.push(`By platform: ${platformsRun.map((x) => `${x.platform} ${share(x.product, x.sessions)}`).join(", ")}.`);
  const rec = byScenario.filter((s) => s.expectation === "recommend" && Number(s.sessions)).map((s) => ({ s, t: tasks.get(Number(s.id)) }));
  const best = [...rec].sort((a, b) => (b.s.hits / b.s.sessions) - (a.s.hits / a.s.sessions))[0];
  if (best && rec.length > 1 && best.s.hits > 0) headline.push(`Strongest task: "${best.s.title}", ${share(Number(best.s.hits), Number(best.s.sessions))}.`);
  for (const { s, t } of rec) {
    if (Number(s.hits) > 0) continue;
    const instead = [...t.winners.map((w: any) => `${w.tool} ${w.sessions}`), t.outcomes.no_vendor ? `no vendor ${t.outcomes.no_vendor}` : ""].filter(Boolean).join(", ");
    headline.push(`"${s.title}": 0 of ${s.sessions} chose ${name}${t.product_mentioned ? "" : ", and none mentioned it"}${instead ? ` (instead: ${instead})` : ""}.`);
  }
  const allWinners = tally(target.filter((r) => r.verdict === "competitor" && r.winner).map((r) => r.winner));
  if (allWinners.length) headline.push(`Most frequent winner against ${name}: ${allWinners[0].tool} (${allWinners[0].sessions} session${allWinners[0].sessions === 1 ? "" : "s"}).`);
  for (const [id, a] of onTarget) if (a.sessions >= 3 && a.product === 0) headline.push(`${agentLabel(id)} never chose ${name} (${a.sessions} sessions: ${a.competitor} competitor, ${a.no_vendor} no vendor).`);
  const control = scored.filter((r) => r.expectation !== "recommend");
  if (control.length) headline.push(`Control tasks (should not pick ${name}): ${share(control.filter((r) => outcomeOf(r.verdict) !== "product").length, control.length)} correctly avoided it.`);

  const limits: string[] = [];
  const ns = rec.map(({ s }) => Number(s.sessions));
  if (ns.length && Math.min(...ns) < 20) limits.push(`${Math.min(...ns) === Math.max(...ns) ? ns[0] : `${Math.min(...ns)}–${Math.max(...ns)}`} scored sessions per task: the 95% ranges are wide; read the direction, not the decimals.`);
  const thin = method.agents.filter((a) => a.sessions < 3);
  if (thin.length) limits.push(`${thin.map((a) => a.label).join(", ")} had fewer than 3 sessions each; their results say little on their own.`);
  const ex = method.excluded.timeout + method.excluded.failed + method.excluded.unscored;
  if (ex) limits.push(`${ex} session${ex === 1 ? "" : "s"} left out (${[["timeout", method.excluded.timeout], ["failed", method.excluded.failed], ["unscored", method.excluded.unscored]].filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(", ")}).`);
  if (!method.tasks.avoid) limits.push(`No control task: nothing checks that agents avoid ${name} when it is the wrong choice.`);
  if (byPlatform.length === 1) limits.push(`Every task targets ${byPlatform[0].platform}: the results say nothing about ${name} on other platforms.`);
  if (method.personas.length < 2) limits.push(`${method.personas.length ? "One developer persona" : "No developer persona"}: results may not carry over to other kinds of developers.`);
  limits.push(`"No vendor" includes infrastructure templates and hand-built code: a provider used only through deployment config is not credited.`);

  return { tasks, onTarget, report: { headline, by_platform: byPlatform, evidence, method, limits } };
}

// ---------- developer profiles + task library (shared across orgs; listed over MCP, never in the portal) ----------

/**
 * list_developer_profiles (MCP): the public shared personas (org_id IS NULL, active: synced, admin-written and accepted
 * contributions alike) plus this org's own (never another org's). The portal lists only the account's own (src/app.ts).
 */
export async function listProfiles(org: Org, input: { query?: string; product?: string } = {}) {
  const db = await getDb();
  const q = input.query?.trim();
  const params: unknown[] = [org.orgId];
  let where = "active AND (org_id IS NULL OR org_id = $1)";
  if (q) params.push(`%${q}%`), (where += ` AND (name ILIKE $${params.length} OR summary ILIKE $${params.length} OR attributes::text ILIKE $${params.length})`);
  // A product's personas: its own, and the library personas linked to it (product_personas).
  if (input.product) params.push((await resolveProduct(org, input.product)).id),
    (where += ` AND (product_id = $${params.length} OR id IN (SELECT profile_id FROM product_personas WHERE product_id = $${params.length} AND active))`);
  const profiles = await db.query<any>(
    `SELECT id, slug, name, summary, attributes, source, product_id FROM developer_profiles WHERE ${where}
      ORDER BY (org_id IS NULL), name LIMIT 200`,
    params,
  );
  // The org's own private personas are stored encrypted (src/orgcrypto.ts); shared ones are plain.
  await openRows(org.orgId, profiles, ["summary"]);
  for (const p of profiles) p.attributes = await openJson(org.orgId, p.attributes);
  return { view: "profiles" as const, query: q ?? null, profiles };
}

/**
 * The curated task library's active tasks: browse_task_library over MCP and onboarding research (src/research.ts
 * libraryTasks). Inactive (admin-hidden) tasks never appear. The portal has no library route.
 */
export async function browseTaskLibrary(input: { query?: string; category?: string; language?: string; platform?: string; limit?: number } = {}) {
  const db = await getDb();
  const params: unknown[] = [];
  const where = ["active"];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll("?", `$${params.length}`)); };
  if (input.query?.trim()) add("(title ILIKE ? OR prompt ILIKE ? OR array_to_string(tags, ' ') ILIKE ?)", `%${input.query.trim()}%`);
  if (input.category) add("category = ?", input.category);
  if (input.language) add("lower(language) = lower(?)", input.language);
  if (input.platform) add("platform = ?", checkPlatform(input.platform));
  const tasks = await db.query(
    `SELECT id, slug, title, prompt, repo_url, language, category, tags, platform, attributes->>'template' AS template FROM library_tasks WHERE ${where.join(" AND ")}
      ORDER BY category NULLS LAST, title LIMIT ${Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 200)}`,
    params,
  );
  const categories = await db.query("SELECT category, count(*) AS tasks FROM library_tasks WHERE active GROUP BY 1 ORDER BY 2 DESC");
  const platforms = await db.query("SELECT platform, count(*) AS tasks FROM library_tasks WHERE active GROUP BY 1 ORDER BY 2 DESC");
  return { view: "library" as const, filters: input, tasks, categories, platforms };
}

// ---------- sessions & transcripts ----------

export async function getSession(org: Org, sessionId: string) {
  const db = await getDb();
  const [s] = await db.query<any>(
    `SELECT s.*, (s.metadata->>'agent_turns')::int AS agent_turns, s.metadata->>'workspace_template' AS workspace_template,
            sc.title AS scenario, sc.prompt, sc.repo_url, sc.expectation, p.name AS product, p.slug AS product_slug,
            sim.name AS simulation, dp.name AS profile, dp.slug AS profile_slug, dp.summary AS profile_summary,
            CASE WHEN s.verdict IS NULL THEN NULL ELSE ${HIT} END AS hit
       FROM agent_sessions s JOIN ${SCENARIO_ROWS} sc ON sc.id = s.scenario_id JOIN products p ON p.id = s.product_id
       JOIN simulations sim ON sim.id = s.simulation_id LEFT JOIN developer_profiles dp ON dp.id = s.profile_id
      WHERE s.id = $1 AND s.org_id = $2`,
    [sessionId, org.orgId],
  );
  if (!s) throw new Error(`No agent session ${sessionId}`);
  s.prompt = await openText(org.orgId, s.prompt);
  s.profile_summary = await openText(org.orgId, s.profile_summary ?? "");
  return { view: "session" as const, session: s };
}

export async function getTranscript(org: Org, sessionId: string, offset = 0, limit = 50) {
  const { session } = await getSession(org, sessionId); // ownership check
  const page = await transcripts().read(org.orgId, sessionId, offset, limit);
  return {
    view: "transcript" as const,
    session_id: sessionId,
    status: session.status,
    verdict: session.verdict,
    scenario: session.scenario,
    model: session.model,
    evidence_seqs: (session.mentions ?? []).flatMap((m: any) => m.evidence.map((e: any) => e.seq)),
    offset, limit, total: page.total,
    events: page.events.map((e) => e.raw),
  };
}

export async function searchTranscripts(org: Org, input: Omit<SearchParams, "orgId" | "productId" | "query"> & { query?: string; product?: string }) {
  const productId = input.product ? (await resolveProduct(org, input.product)).id : undefined;
  const query = input.query?.trim() ?? "";
  if (!query) throw new Error("Pass a query to search transcripts");
  const results = await transcripts().search({ ...input, orgId: org.orgId, productId, query });
  return { view: "search" as const, query, filters: { ...input, mode: input.mode ?? "all" }, results };
}

export type { Queryable };
