/**
 * Private customer assets (docs/security.md, phase 1): the personas, task sets and harnesses an organization brings.
 * They belong to that organization alone: every query here is scoped to `org.orgId`, nothing here ever writes the
 * public data (library_tasks, shared developer_profiles), and nothing outside the org can list, use or detect them.
 *
 *  - personas: developer_profiles rows with source 'custom' and the org as owner (the table's CHECK enforces an owner);
 *    random `per_` slugs, so another org can neither guess nor collide with them.
 *  - task sets: org_task_sets, whose tasks become the product's scenarios (source 'custom', task_set_id).
 *  - harnesses: org_harnesses, a declarative spec plus a review status; nothing runs until a harness is approved and
 *    built in isolation (phase 2).
 */
import { ensureOrgKey, open as openText, openJson, openRows, seal, sealJson } from "./orgcrypto.js";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import type { Org } from "./auth.js";
import { resolveProduct, checkTemplate, checkPlatform, WORKSPACE_TEMPLATES, forCustomer, personaForCustomer, type Surface, SCENARIO_ROWS } from "./queries.js";
import { PLATFORMS } from "./platform.js";
import { platformOf } from "./platform.js";
import { environmentIssues, type PersonaEnvironment } from "../orchestrator/core/environment.js";
import { publicationsFor } from "./contributions.js";

const rid = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
/** Strip control, bidi and zero-width characters (they can hide text from a reviewer) and trim. */
export const cleanText = (s: unknown, max: number, what: string): string => {
  const t = String(s ?? "").normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, "").trim();
  if (t.length > max) throw new Error(`${what} is too long (${t.length} characters; at most ${max})`);
  return t;
};

// ---------- input shapes: the MCP tools (src/server.ts) and the /app pages (src/app.ts) check the same ones ----------

export const personaInputSchema = z.object({
  slug: z.string().optional().describe("Update this persona (from list_personas); omit to add a new one"),
  name: z.string().max(80), summary: z.string().max(600).optional(),
  instructions: z.string().max(1500).optional().describe("How this developer answers a coding agent's questions"),
  attributes: z.record(z.string(), z.unknown()).optional().describe("role, experience_years, company_size, stack[], constraints[], tone"),
  environment: z.object({ editor: z.string(), tools: z.array(z.string()).optional() }).passthrough().optional()
    .describe("Editor and CLI tools they have installed (see list_developer_profiles for examples)"),
  active: z.boolean().optional(),
});
export const personasInputSchema = z.array(personaInputSchema).min(1).max(20);

export const taskInputSchema = z.object({
  title: z.string().max(160).optional(), prompt: z.string().min(20).max(6000).describe("The task as a developer would give it to a coding agent"),
  language: z.string().optional(), tags: z.array(z.string()).optional(),
  platform: z.enum(PLATFORMS).optional(),
  template: z.enum([...WORKSPACE_TEMPLATES, "auto"]).optional(),
  repo_url: z.string().optional(), expectation: z.enum(["recommend", "avoid"]).optional(),
  provenance: z.string().max(500).optional().describe("Where the task comes from, e.g. the case study"),
});
export const importTasksInputShape = {
  task_set: z.string().max(120).describe("Name of the set, e.g. '2025 case studies'"),
  description: z.string().max(2000).optional(),
  tasks: z.array(taskInputSchema).min(1).max(200),
};

/** A zod failure in plain words: `tasks[0].prompt: Too small: expected string to have >=20 characters`. */
export function inputIssues(e: z.ZodError, root = ""): string {
  return e.issues.map((i) => {
    const path = i.path.reduce<string>((a, k) => (typeof k === "number" ? `${a}[${k}]` : a ? `${a}.${String(k)}` : String(k)), root);
    return path ? `${path}: ${i.message}` : i.message;
  }).join("; ");
}

// ---------- personas ----------

export interface PersonaInput {
  slug?: string; name: string; summary?: string; instructions?: string;
  attributes?: Record<string, unknown>; environment?: PersonaEnvironment | null; active?: boolean;
}

export async function savePersonas(org: Org, items: PersonaInput[], surface: Surface = {}) {
  if (!Array.isArray(items) || !items.length || items.length > 20) throw new Error("Send 1-20 personas");
  const db = await getDb();
  await ensureOrgKey(org.orgId); // before the transaction: sealing inside it then needs no query
  const saved: string[] = [];
  await db.transaction(async (tx) => {
    for (const [i, x] of items.entries()) {
      const name = cleanText(x.name, 80, `personas[${i}].name`);
      if (!name) throw new Error(`personas[${i}].name is required`);
      const summary = cleanText(x.summary, 600, `personas[${i}].summary`);
      const instructions = cleanText(x.instructions, 1500, `personas[${i}].instructions`);
      const attributes = x.attributes && typeof x.attributes === "object" && !Array.isArray(x.attributes) ? x.attributes : {};
      if (JSON.stringify(attributes).length > 1500) throw new Error(`personas[${i}].attributes is too large (at most 1500 characters as JSON)`);
      const envIssues = x.environment ? environmentIssues(x.environment) : [];
      if (envIssues.length) throw new Error(`personas[${i}].environment: ${envIssues.join("; ")}`);
      const env = x.environment ? JSON.stringify({ editor: x.environment.editor, tools: x.environment.tools ?? [], skills: x.environment.skills ?? [],
                                                    agent_rules: x.environment.agent_rules ?? null }) : null;
      // Private text at rest is encrypted with the organization's own key (src/orgcrypto.ts).
      const sSummary = await seal(org.orgId, summary), sInstructions = await seal(org.orgId, instructions);
      const sAttributes = JSON.stringify(await sealJson(org.orgId, attributes));
      if (x.slug) {
        const [row] = await tx.query<{ slug: string }>(
          `UPDATE developer_profiles SET name = $3, summary = $4, instructions = $5, attributes = $6, environment = coalesce($7, environment),
                  active = coalesce($8, active), synced_at = now()
            WHERE slug = $1 AND org_id = $2 AND source = 'custom' RETURNING slug`,
          [x.slug, org.orgId, name, sSummary, sInstructions, sAttributes, env, x.active ?? null]);
        if (!row) throw new Error(`No persona ${x.slug}. See list_personas.`); // same message whether or not it exists elsewhere
        saved.push(row.slug);
      } else {
        const slug = rid("per");
        await tx.query(
          `INSERT INTO developer_profiles (slug, name, summary, instructions, attributes, environment, org_id, source, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'custom', true)`,
          [slug, name, sSummary, sInstructions, sAttributes, env, org.orgId]);
        saved.push(slug);
      }
    }
  });
  return listPersonas(org, saved, surface);
}

/**
 * The organization's personas: its own (custom, or written for it by research), and the library personas research
 * linked to its products (source 'library', product_personas; never copied into the account). Never another org's.
 * Over MCP (list_personas) each is returned whole; the portal (surface.redact, src/app.ts) shows a library persona by
 * name only (personaForCustomer).
 */
export async function listPersonas(org: Org, highlight: string[] = [], surface: Surface = {}) {
  const db = await getDb();
  const personas = await db.query<any>(
    `SELECT slug, name, summary, attributes, instructions, environment, source, active, product_id
       FROM developer_profiles WHERE org_id = $1 ORDER BY source, name`, [org.orgId]);
  await openRows(org.orgId, personas, ["summary", "instructions"]);
  // The library personas linked to the account's products (product_personas): Octillion's, never copied into the account.
  personas.push(...await db.query<any>(
    `SELECT dp.slug, dp.name, dp.summary, dp.attributes, dp.instructions, coalesce(pp.environment, dp.environment) AS environment, 'library' AS source,
            pp.active, pp.product_id
       FROM product_personas pp JOIN products p ON p.id = pp.product_id AND p.org_id = $1 JOIN developer_profiles dp ON dp.id = pp.profile_id AND dp.org_id IS NULL
      ORDER BY dp.name`, [org.orgId]));
  for (const p of personas) p.attributes = await openJson(org.orgId, p.attributes);
  // Its publication to Octillion's library (src/contributions.ts): only the account's own (custom) personas can be published.
  const pubs = await publicationsFor(org.orgId, "persona");
  return { view: "personas" as const, saved: highlight, personas: personas.map((p) => (surface.redact ? personaForCustomer(p) : p)).map((p) => ({
    ...p, publishable: p.source === "custom", publication: p.source === "custom" ? pubs.get(p.slug) ?? null : null })) };
}

/** Turn one of the organization's own personas on or off (Turn off on /app/personas), without rewriting it. */
export async function setPersonaActive(org: Org, slug: string, active: boolean, surface: Surface = {}) {
  const [row] = await (await getDb()).query<{ slug: string }>(
    "UPDATE developer_profiles SET active = $3, synced_at = now() WHERE slug = $1 AND org_id = $2 AND source = 'custom' RETURNING slug",
    [slug, org.orgId, active]);
  if (!row) throw new Error(`No persona ${slug}. See list_personas.`);
  return listPersonas(org, [row.slug], surface);
}

/** Delete one of the organization's own personas. Past sessions keep their transcript; their persona link is cleared. */
export async function deletePersona(org: Org, slug: string) {
  const [row] = await (await getDb()).query<{ slug: string }>(
    "DELETE FROM developer_profiles WHERE slug = $1 AND org_id = $2 AND source = 'custom' RETURNING slug", [slug, org.orgId]);
  if (!row) throw new Error(`No persona ${slug}. See list_personas.`);
  return { deleted: row.slug };
}

// ---------- task sets ----------

export interface TaskInput {
  title?: string; prompt: string; language?: string; tags?: string[]; platform?: string; template?: string | null;
  repo_url?: string; expectation?: "recommend" | "avoid"; provenance?: string;
}

const REPO_URL = /^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/\S+$/;

/** One task checked and normalised (`at` names it in errors: tasks[3], or task for an edit). Import and edit share it. */
function cleanTask(t: TaskInput, at: string) {
  const prompt = cleanText(t.prompt, 6000, `${at}.prompt`);
  if (prompt.length < 20) throw new Error(`${at}.prompt must be at least 20 characters`);
  if (t.repo_url != null && !REPO_URL.test(t.repo_url)) throw new Error(`${at}.repo_url must be an https URL of a public git host`);
  const template = checkTemplate(t.template);
  const platform = checkPlatform(t.platform) ?? platformOf({ template, language: t.language, tags: t.tags, prompt });
  return {
    prompt, title: cleanText(t.title, 160, `${at}.title`) || prompt.slice(0, 80), repo_url: t.repo_url ?? null,
    language: t.language ? cleanText(t.language, 40, `${at}.language`) || null : null, tags: (t.tags ?? []).slice(0, 20).map((x) => cleanText(x, 40, "tag")).filter(Boolean),
    expectation: t.expectation === "avoid" ? "avoid" as const : "recommend" as const,
    provenance: t.provenance ? cleanText(t.provenance, 500, `${at}.provenance`) || null : null, template: template ?? null, platform,
  };
}

export async function importTasks(org: Org, input: { product?: string; task_set: string; description?: string; tasks: TaskInput[] }) {
  const p = await resolveProduct(org, input.product);
  const setName = cleanText(input.task_set, 120, "task_set");
  if (!setName) throw new Error("task_set (a name for this set, e.g. '2025 case studies') is required");
  if (!Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 200) throw new Error("Send 1-200 tasks");
  const db = await getDb();
  await ensureOrgKey(org.orgId); // before the transaction: sealing inside it then needs no query
  let setId = 0;
  await db.transaction(async (tx) => {
    const [set] = await tx.query<{ id: number }>(
      `INSERT INTO org_task_sets (public_id, org_id, product_id, name, description) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, product_id, name) DO UPDATE SET description = coalesce(excluded.description, org_task_sets.description)
       RETURNING id`,
      [rid("tset"), org.orgId, p.id, setName, input.description ? cleanText(input.description, 2000, "description") : null]);
    setId = set!.id;
    for (const [i, t] of input.tasks.entries()) {
      const c = cleanTask(t, `tasks[${i}]`);
      await tx.query(
        `/* tenant: product resolved within the caller's org (resolveProduct) */ INSERT INTO scenarios (product_id, title, prompt, repo_url, language, tags, expectation, active, source, rationale, template, platform, task_set_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'custom', $8, $9, $10, $11)`,
        [p.id, c.title, await seal(org.orgId, c.prompt), c.repo_url, c.language, c.tags, c.expectation,
         c.provenance ? await seal(org.orgId, c.provenance) : null, c.template, c.platform, setId]);
    }
  });
  return listTaskSets(org, p.slug);
}

export async function listTaskSets(org: Org, product?: string) {
  const db = await getDb();
  const params: unknown[] = [org.orgId];
  let where = "ts.org_id = $1";
  if (product) params.push((await resolveProduct(org, product)).id), (where += " AND ts.product_id = $2");
  const sets = await db.query(
    `SELECT ts.public_id AS id, ts.name, ts.description, p.slug AS product, ts.created_at,
            count(sc.id) FILTER (WHERE sc.active) AS active_tasks,
            jsonb_agg(jsonb_build_object('id', sc.id, 'title', sc.title, 'platform', sc.platform, 'expectation', sc.expectation, 'active', sc.active)
                      ORDER BY sc.id) FILTER (WHERE sc.id IS NOT NULL) AS tasks
       FROM org_task_sets ts JOIN products p ON p.id = ts.product_id AND p.org_id = ts.org_id
       LEFT JOIN ${SCENARIO_ROWS} sc ON sc.task_set_id = ts.id
      WHERE ${where} GROUP BY ts.id, p.slug ORDER BY ts.created_at DESC`, params);
  // Each task's publication to Octillion's library (src/contributions.ts).
  const pubs = await publicationsFor(org.orgId, "task");
  for (const set of sets as any[]) for (const t of set.tasks ?? []) t.publication = pubs.get(String(t.id)) ?? null;
  return { view: "task_sets" as const, task_sets: sets };
}

/** Scenario ids of an org's task set (by public id or name), for run_simulation {task_set}. */
export async function taskSetScenarioIds(org: Org, productId: number, ref: string): Promise<number[]> {
  const rows = await (await getDb()).query<{ id: number }>(
    `SELECT sc.id FROM ${SCENARIO_ROWS} sc JOIN org_task_sets ts ON ts.id = sc.task_set_id
      WHERE ts.org_id = $1 AND ts.product_id = $2 AND (ts.public_id = $3 OR ts.name = $3) AND sc.active ORDER BY sc.id`,
    [org.orgId, productId, ref]);
  if (!rows.length) throw new Error(`No task set ${ref} with active tasks. See list_task_sets.`);
  return rows.map((r) => r.id);
}

/**
 * Portal only (GET /api/app/tasks): every task of the organization's task sets, with prompts opened (they are stored sealed), and the
 * Octillion-curated tasks onboarding picked into its products, by title and status only (forCustomer), plus the runs
 * that used each set.
 */
export async function taskSetDetails(org: Org) {
  const db = await getDb();
  const tasks = await db.query<any>(
    `SELECT sc.id, sc.title, sc.prompt, sc.repo_url, sc.language, sc.tags, sc.platform, sc.template, sc.expectation, sc.active, sc.source,
            sc.rationale AS provenance, sc.library_task_id, sc.created_at, ts.public_id AS task_set, p.slug AS product, p.name AS product_name
       FROM ${SCENARIO_ROWS} sc JOIN products p ON p.id = sc.product_id AND p.org_id = $1
       LEFT JOIN org_task_sets ts ON ts.id = sc.task_set_id AND ts.org_id = $1
      WHERE ts.id IS NOT NULL OR sc.library_task_id IS NOT NULL ORDER BY sc.id`, [org.orgId]);
  for (const t of tasks) {
    if (t.task_set) { t.prompt = await openText(org.orgId, t.prompt); t.provenance = t.provenance ? await openText(org.orgId, t.provenance) : null; }
    else t.provenance = null; // a library pick: its rationale is research's, not a provenance
  }
  const pubs = await publicationsFor(org.orgId, "task");
  // Only a task of the account's own sets can be published; a curated one (onboarding's pick) can't.
  const shown = tasks.map((t) => forCustomer(t)).map((t) => {
    const publishable = Boolean(t.task_set) && !t.curated && t.source === "custom";
    return { ...t, publishable, publication: publishable ? pubs.get(String(t.id)) ?? null : null };
  });
  const runs = await db.query<{ task_set: string; id: string; name: string; status: string; created_at: Date }>(
    `SELECT DISTINCT ON (ts.public_id, sim.id) ts.public_id AS task_set, sim.id, sim.name, sim.status, sim.created_at
       FROM agent_sessions s JOIN ${SCENARIO_ROWS} sc ON sc.id = s.scenario_id JOIN org_task_sets ts ON ts.id = sc.task_set_id AND ts.org_id = $1
       JOIN simulations sim ON sim.id = s.simulation_id AND sim.org_id = $1
      WHERE s.org_id = $1 ORDER BY ts.public_id, sim.id`, [org.orgId]);
  return { tasks: shown, runs };
}

/**
 * Edit one task of the organization's task sets (or turn it on or off), checked like import_tasks. A shared library
 * task picked into a product can only be turned on or off here.
 */
export async function updateTask(org: Org, id: number, patch: Partial<TaskInput> & { active?: boolean }) {
  const db = await getDb();
  const [row] = await db.query<any>(
    `SELECT sc.*, ts.id AS set_id FROM ${SCENARIO_ROWS} sc JOIN products p ON p.id = sc.product_id AND p.org_id = $1
       LEFT JOIN org_task_sets ts ON ts.id = sc.task_set_id AND ts.org_id = $1 WHERE sc.id = $2`, [org.orgId, id]);
  if (!row || (!row.set_id && row.library_task_id == null)) throw new Error(`No task ${id}. See list_task_sets.`);
  const fields = Object.keys(patch).filter((k) => k !== "active" && (patch as Record<string, unknown>)[k] !== undefined);
  if (!row.set_id && fields.length) throw new Error("A task curated by Octillion can only be turned on or off");
  if (patch.active != null && typeof patch.active !== "boolean") throw new Error("active must be true or false");
  if (fields.length) {
    await ensureOrgKey(org.orgId);
    const cur: TaskInput = {
      title: row.title, prompt: await openText(org.orgId, row.prompt), repo_url: row.repo_url ?? undefined, language: row.language ?? undefined,
      tags: row.tags ?? [], platform: row.platform ?? undefined, template: row.template, expectation: row.expectation,
      provenance: row.rationale ? await openText(org.orgId, row.rationale) : undefined,
    };
    const c = cleanTask({ ...cur, ...Object.fromEntries(fields.map((k) => [k, (patch as Record<string, unknown>)[k]])) } as TaskInput, "task");
    await db.query(
      `/* tenant: scenario verified against the caller's org above */ UPDATE scenarios SET title = $2, prompt = $3, repo_url = $4, language = $5, tags = $6,
              expectation = $7, rationale = $8, template = $9, platform = $10, updated_at = now() WHERE id = $1`,
      [id, c.title, await seal(org.orgId, c.prompt), c.repo_url, c.language, c.tags, c.expectation,
       c.provenance ? await seal(org.orgId, c.provenance) : null, c.template, c.platform]);
  }
  if (patch.active != null)
    await db.query("/* tenant: scenario verified against the caller's org above */ UPDATE scenarios SET active = $2, updated_at = now() WHERE id = $1", [id, patch.active]);
  return { id, set: Boolean(row.set_id) };
}

// ---------- harness mixes (private populations) ----------

export async function saveHarnessMix(org: Org, input: { name: string; description?: string; agents: { agent_id: string; share: number }[] }) {
  const name = cleanText(input.name, 80, "name");
  if (name.length < 2) throw new Error("name is required");
  const { registry } = await import("./agents.js");
  const runnable = new Map(registry().agents.filter((a) => a.enabled !== false).map((a) => [a.id, a]));
  const seen = new Set<string>();
  for (const a of input.agents ?? []) {
    if (!runnable.has(a.agent_id)) throw new Error(`Unknown or unavailable agent ${a.agent_id}; see list_agents`);
    if (seen.has(a.agent_id)) throw new Error(`${a.agent_id} is listed twice`);
    if (!(Number(a.share) > 0)) throw new Error(`${a.agent_id}: share must be positive`);
    seen.add(a.agent_id);
  }
  if (!seen.size) throw new Error("A mix needs at least one agent");
  const total = input.agents.reduce((s, a) => s + Number(a.share), 0);
  const db = await getDb();
  await db.transaction(async (tx) => {
    const [existing] = await tx.query<{ id: number }>("SELECT id FROM developer_populations WHERE org_id = $1 AND name = $2", [org.orgId, name]);
    const [pop] = existing
      ? await tx.query<{ id: number }>("UPDATE developer_populations SET description = $2, updated_at = now() WHERE id = $1 RETURNING id",
          [existing.id, input.description ? cleanText(input.description, 500, "description") : ""])
      : await tx.query<{ id: number }>(
          `INSERT INTO developer_populations (slug, name, description, methodology, sandbox_unit, min_one_sandbox, is_default, org_id)
           VALUES ($1, $2, $3, 'Custom harness mix defined by the organization', 20, true, false, $4) RETURNING id`,
          [rid("mix"), name, input.description ? cleanText(input.description, 500, "description") : "", org.orgId]);
    await tx.query("DELETE FROM developer_population_agents WHERE population_id = $1", [pop!.id]);
    for (const a of input.agents)
      await tx.query("INSERT INTO developer_population_agents (population_id, agent_id, market_share) VALUES ($1, $2, $3)",
        [pop!.id, a.agent_id, Number(a.share) / total]);
  });
  return listHarnessMixes(org);
}

export async function listHarnessMixes(org: Org) {
  const mixes = await (await getDb()).query(
    `SELECT p.slug, p.name, p.description, p.updated_at,
            coalesce(jsonb_agg(jsonb_build_object('agent_id', a.agent_id, 'share', a.market_share) ORDER BY a.market_share DESC)
                     FILTER (WHERE a.agent_id IS NOT NULL), '[]') AS agents
       FROM developer_populations p LEFT JOIN developer_population_agents a ON a.population_id = p.id
      WHERE p.org_id = $1 GROUP BY p.id ORDER BY p.name`, [org.orgId]);
  return { view: "harness_mixes" as const, mixes };
}

// ---------- harnesses ----------

export const HARNESS_EVENT_FORMATS = ["octillion-jsonl", "claude-stream-json", "codex-json", "acp"] as const;
const ARGV_PART = /^([A-Za-z0-9._/@:=+-]{1,200}|\{model\}|\{session_id\}|\{prompt_file\})$/;

export interface HarnessSpec {
  name: string; version: string;
  install: ({ npm: string; version: string; integrity: string } | { pip: string; hashes: string[] } | { tarball: string; sha256: string })[];
  allow_install_scripts?: boolean; bin: string; launch_argv: string[]; resume_argv?: string[];
  event_format: (typeof HARNESS_EVENT_FORMATS)[number]; providers: string[]; egress_hosts?: string[];
}

/** Validation of a customer harness spec: declarative only, pinned by integrity hashes, gateway providers only. */
export function harnessSpecIssues(s: any, gatewayProviders: string[]): string[] {
  const out: string[] = [];
  if (!s || typeof s !== "object") return ["spec must be an object"];
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(s.name ?? "")) out.push("name: 2-41 lowercase letters, digits and dashes");
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(s.version ?? "")) out.push("version: 1-40 characters [A-Za-z0-9._-]");
  if (!Array.isArray(s.install) || !s.install.length || s.install.length > 10) out.push("install: 1-10 items");
  for (const [i, it] of (Array.isArray(s.install) ? s.install : []).entries()) {
    if (it?.npm) { if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(it.npm) || !/^\d+\.\d+\.\d+/.test(it.version ?? "") || !/^sha512-[A-Za-z0-9+/=]{80,}$/.test(it.integrity ?? "")) out.push(`install[${i}]: npm needs a package name, an exact version and its sha512 integrity`); }
    else if (it?.pip) { if (!/^[A-Za-z0-9._-]+==[A-Za-z0-9.+-]+$/.test(it.pip) || !Array.isArray(it.hashes) || !it.hashes.length || it.hashes.some((h: unknown) => !/^sha256:[a-f0-9]{64}$/.test(String(h)))) out.push(`install[${i}]: pip needs name==version and sha256 hashes`); }
    else if (it?.tarball) { if (!/^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/\S+$/.test(it.tarball) || !/^[a-f0-9]{64}$/.test(it.sha256 ?? "")) out.push(`install[${i}]: tarball needs an https URL and its sha256`); }
    else out.push(`install[${i}]: one of npm, pip or tarball`);
  }
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(s.bin ?? "")) out.push("bin: the executable name");
  for (const k of ["launch_argv", "resume_argv"]) {
    const argv = s[k];
    if (argv == null && k === "resume_argv") continue;
    if (!Array.isArray(argv) || !argv.length || argv.length > 40 || argv.some((a: unknown) => typeof a !== "string" || !ARGV_PART.test(a)))
      out.push(`${k}: 1-40 arguments of [A-Za-z0-9._/@:=+-] or the placeholders {model}, {session_id}, {prompt_file}; no shell`);
  }
  if (!(HARNESS_EVENT_FORMATS as readonly string[]).includes(s.event_format)) out.push(`event_format: one of ${HARNESS_EVENT_FORMATS.join(", ")}`);
  if (!Array.isArray(s.providers) || !s.providers.length || s.providers.some((p: unknown) => !gatewayProviders.includes(String(p))))
    out.push(`providers: model providers it calls, through the Octillion gateway only: ${gatewayProviders.join(", ")} (real vendor keys are never given to customer harnesses)`);
  if (s.egress_hosts != null && (!Array.isArray(s.egress_hosts) || s.egress_hosts.length > 10 || s.egress_hosts.some((h: unknown) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(String(h)))))
    out.push("egress_hosts: up to 10 hostnames (extra hosts need review)");
  return out;
}

export async function registerHarness(org: Org, spec: HarnessSpec) {
  const db = await getDb();
  const gateway = (await db.query<{ slug: string }>("SELECT slug FROM vault_providers WHERE mode = 'gateway' AND enabled ORDER BY slug")).map((r) => r.slug);
  const issues = harnessSpecIssues(spec, gateway);
  if (issues.length) throw new Error(`Invalid harness spec: ${issues.join("; ")}`);
  const needsReview = Boolean(spec.allow_install_scripts) || Boolean(spec.egress_hosts?.length);
  const [row] = await db.query<{ id: string }>(
    `INSERT INTO org_harnesses (id, org_id, name, version_label, spec, status, providers, event_format, egress_hosts, status_reason)
     VALUES ($1, $2, $3, $4, $5, 'submitted', $6, $7, $8, $9)
     ON CONFLICT (org_id, name, version_label) DO UPDATE SET spec = excluded.spec, status = 'submitted', providers = excluded.providers,
       event_format = excluded.event_format, egress_hosts = excluded.egress_hosts, status_reason = excluded.status_reason, updated_at = now()
     RETURNING id`,
    [rid("oh"), org.orgId, spec.name, spec.version, JSON.stringify(spec), spec.providers, spec.event_format, spec.egress_hosts ?? [],
     needsReview ? "needs review: install scripts or extra egress hosts" : "queued for an isolated build and scan"]);
  return listHarnesses(org, row!.id);
}

/** The organization's own harnesses (never another org's; artifact locations are internal and not returned). */
export async function listHarnesses(org: Org, highlight?: string) {
  const harnesses = await (await getDb()).query(
    `SELECT id, name, version_label AS version, status, status_reason, providers, event_format, egress_hosts, artifact_digest,
            scan_summary, created_at, updated_at
       FROM org_harnesses WHERE org_id = $1 ORDER BY name, created_at DESC`, [org.orgId]);
  return { view: "harnesses" as const, harnesses, saved: highlight ?? null };
}
