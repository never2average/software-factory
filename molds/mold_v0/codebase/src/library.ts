import { randomBytes } from "node:crypto";
import { AdminError, log } from "./admin.js";
import { registry, sandboxMix } from "./agents.js";
import { getDb } from "./db.js";
import { platformOf } from "./platform.js";
import * as kv from "./keyvault.js";
import { envStillSet } from "./keyvault-env.js";
import * as populations from "./populations.js";
import * as harnesses from "./harnesses.js";
import { listSettings, SETTING_GROUPS, setSettings } from "./settings.js";

/**
 * The shared libraries and global compute settings behind /admin/personas, /admin/tasks and /admin/compute.
 *  - Personas: shared developer_profiles (org_id NULL), from the vault or written here. An organization's private
 *    personas are never listed or touched.
 *  - Tasks: library_tasks (all public); 7k+ rows, so the list is searched and paged in Postgres.
 *  - Compute: platform_settings (src/settings.ts), the default developer population's agent mix (src/populations.ts) and
 *    the model keys in the key vault (src/keyvault.ts; secrets go in once, only hints come out).
 * Every edit stamps edited_at / edited_by, which the vault sync (src/vault.ts) respects: an edited row keeps the admin's
 * version, and a row written here (source 'admin') is never retired.
 */

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown, maxItems: number, maxLen: number) =>
  [...new Set((Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\n,]/) : []).map((x) => str(x, maxLen)).filter(Boolean))].slice(0, maxItems);
const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "item";
const suffix = () => randomBytes(3).toString("hex");
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// ---------- personas ----------

const PERSONA_COLS = `slug, external_id, name, summary, attributes, instructions, active, source, synced_at, edited_at, edited_by, contributed_by, submission_id`;

export async function listPersonas() {
  const rows = await (await getDb()).query(
    `/* tenant: admin-only: shared personas (org_id NULL) */ SELECT ${PERSONA_COLS} FROM developer_profiles WHERE org_id IS NULL ORDER BY name, slug`);
  return { personas: rows };
}

async function personaBySlug(slug: string) {
  const [p] = await (await getDb()).query<{ slug: string; attributes: Record<string, unknown> }>(
    `SELECT ${PERSONA_COLS} FROM developer_profiles WHERE slug = $1 AND org_id IS NULL`, [slug]);
  if (!p) throw new AdminError(`No shared persona "${slug}"`, 404);
  return p;
}

/** The editable persona fields that were sent: name, summary, instructions, and attributes role, experience_years,
 *  company_size, stack, constraints, tone. Other attributes (industry, survey, ...) are kept as they are. */
function personaPatch(b: Record<string, unknown>) {
  const cols: Record<string, string> = {}, attrs: Record<string, unknown> = {};
  if (has(b, "name")) { cols.name = str(b.name, 120); if (!cols.name) throw new AdminError("A persona needs a name"); }
  if (has(b, "summary")) cols.summary = str(b.summary, 2000);
  if (has(b, "instructions")) cols.instructions = str(b.instructions, 8000);
  for (const k of ["role", "company_size", "tone"]) if (has(b, k)) attrs[k] = str(b[k], 200) || null;
  if (has(b, "experience_years")) {
    const v = b.experience_years, n = v === null || v === "" ? null : Number(v);
    if (n !== null && !(Number.isFinite(n) && n >= 0 && n <= 70)) throw new AdminError("Experience must be a number of years (0–70)");
    attrs.experience_years = n;
  }
  if (has(b, "stack")) attrs.stack = list(b.stack, 60, 60);
  if (has(b, "constraints")) attrs.constraints = list(b.constraints, 30, 300);
  return { cols, attrs };
}

export async function createPersona(actor: string, body: Record<string, unknown>) {
  const { cols, attrs } = personaPatch({ ...body, name: body.name ?? "" });
  const db = await getDb();
  let slug = slugify(str(body.slug, 64) || `admin-${cols.name}`);
  if ((await db.query("SELECT 1 FROM developer_profiles WHERE slug = $1", [slug])).length) slug = `${slug.slice(0, 40)}-${suffix()}`;
  await db.query(
    `INSERT INTO developer_profiles (slug, name, summary, attributes, instructions, source, active, edited_at, edited_by)
     VALUES ($1, $2, $3, $4, $5, 'admin', $6, now(), $7)`,
    [slug, cols.name, cols.summary ?? "", JSON.stringify({ ...(body.attributes && typeof body.attributes === "object" ? body.attributes : {}), ...attrs }),
     cols.instructions ?? "", body.active !== false, actor]);
  log(actor, "persona.create", null, { persona: slug });
  return personaBySlug(slug);
}

export async function updatePersona(actor: string, slug: string, body: Record<string, unknown>) {
  await personaBySlug(slug);
  const { cols, attrs } = personaPatch(body);
  await (await getDb()).query(
    `UPDATE developer_profiles SET name = coalesce($2, name), summary = coalesce($3, summary), instructions = coalesce($4, instructions),
       attributes = attributes || $5::jsonb, edited_at = now(), edited_by = $6
     WHERE slug = $1 AND org_id IS NULL`,
    [slug, cols.name ?? null, cols.summary ?? null, cols.instructions ?? null, JSON.stringify(attrs), actor]);
  log(actor, "persona.edit", null, { persona: slug, fields: [...Object.keys(cols), ...Object.keys(attrs)] });
  return personaBySlug(slug);
}

/** Turn shared personas on or off (one or many). Counts as an edit, so a sync never turns them back. */
export async function setPersonasActive(actor: string, slugs: unknown, active: unknown) {
  const ids = list(slugs, 1000, 64);
  if (!ids.length || typeof active !== "boolean") throw new AdminError("slugs and active (true or false) are required");
  const rows = await (await getDb()).query(
    `UPDATE developer_profiles SET active = $2, edited_at = now(), edited_by = $3 WHERE slug = ANY($1) AND org_id IS NULL RETURNING slug`,
    [ids, active, actor]);
  log(actor, active ? "persona.activate" : "persona.deactivate", null, { personas: rows.length });
  return { updated: rows.length };
}

// ---------- tasks ----------

const TASK_COLS = `id, slug, external_id, title, prompt, repo_url, language, category, tags, attributes, platform, active, source, synced_at, edited_at, edited_by, harnesses, contributed_by, submission_id`;

/**
 * What a task's harness preference may name: each harness in the registry (its sessions go to that CLI, any model), and
 * each admin-added agent by id (a variant of a CLI, e.g. a custom Pi setup).
 */
export function harnessOptions(): { value: string; label: string; hint?: string }[] {
  const agents = registry().agents;
  const byHarness = new Map<string, string>();
  for (const a of agents) if (a.origin !== "admin" && !byHarness.has(a.harness)) byHarness.set(a.harness, a.label.split(" · ")[0]!.trim() || a.harness);
  return [...[...byHarness].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
          ...agents.filter((a) => a.origin === "admin").map((a) => ({ value: a.id, label: a.label, hint: "added here" }))];
}
const harnessList = (v: unknown) => {
  const want = list(v, 40, 120);
  const known = new Set(harnessOptions().map((o) => o.value));
  const bad = want.filter((x) => !known.has(x));
  if (bad.length) throw new AdminError(`Unknown harness${bad.length === 1 ? "" : "es"}: ${bad.join(", ")}`);
  return [...new Set(want)];
};

/**
 * One page of the task library: ?q (every word must appear), language, category, active, has_repo, limit, offset.
 * `facets` counts the tasks each filter value would match under the other filters ("" is the filter's "all").
 */
export async function listTasks(q: Record<string, unknown> = {}) {
  // Each condition keeps the filter it belongs to, so a facet can drop its own and count under the rest.
  const conds: { k: string; sql: string; v?: unknown }[] = [];
  const add = (k: string, sql: string, v?: unknown) => conds.push({ k, sql, v });
  for (const w of str(q.q, 200).split(/\s+/).filter(Boolean).slice(0, 8))
    add("q", "concat_ws(' ', title, prompt, array_to_string(tags, ' '), repo_url, category, language, slug) ILIKE $?", `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  if (str(q.language, 60)) add("language", "language = $?", str(q.language, 60));
  if (str(q.category, 60)) add("category", "category = $?", str(q.category, 60));
  if (q.active === "true" || q.active === "false") add("active", "active = $?", q.active === "true");
  if (q.has_repo === "true") add("has_repo", "coalesce(repo_url, '') <> ''");
  if (q.has_repo === "false") add("has_repo", "coalesce(repo_url, '') = ''");
  if (q.source === "vault" || q.source === "admin" || q.source === "contributed") add("source", "source = $?", q.source);
  if (q.edited === "true") add("edited", "edited_at IS NOT NULL");
  if (q.harness === "any") add("harness", "cardinality(harnesses) = 0");
  else if (q.harness === "set") add("harness", "cardinality(harnesses) > 0");
  else if (str(q.harness, 120)) add("harness", "$? = ANY(harnesses)", str(q.harness, 120));
  const whereOf = (skip?: string) => {
    const params: unknown[] = [];
    const parts = conds.filter((c) => c.k !== skip).map((c) => (c.v === undefined ? c.sql : (params.push(c.v), c.sql.replace("$?", `$${params.length}`))));
    return { w: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
  };
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(q.limit ?? 50)) || 50));
  const offset = Math.max(0, Math.trunc(Number(q.offset ?? 0)) || 0);
  const { w, params } = whereOf();
  const db = await getDb();
  const by = (col: string) => { const x = whereOf(col); return db.query<{ value: string | null; n: number }>(`SELECT ${col} AS value, count(*) AS n FROM library_tasks ${x.w} GROUP BY 1`, x.params); };
  const flags = (k: string, yes: string, no: string) => { const x = whereOf(k); return db.query<Record<string, number>>(
    `SELECT count(*) AS n_all, count(*) FILTER (WHERE ${yes}) AS n_yes, count(*) FILTER (WHERE ${no}) AS n_no FROM library_tasks ${x.w}`, x.params); };
  const hx = whereOf("harness");
  const [rows, [{ n }], languages, categories, [all], fLang, fCat, [fActive], [fRepo], [fHarness], fEach] = await Promise.all([
    db.query(`SELECT ${TASK_COLS} FROM library_tasks ${w} ORDER BY title, id LIMIT ${limit} OFFSET ${offset}`, params),
    db.query<{ n: number }>(`SELECT count(*) AS n FROM library_tasks ${w}`, params),
    db.query<{ value: string; n: number }>("SELECT language AS value, count(*) AS n FROM library_tasks WHERE language IS NOT NULL GROUP BY language ORDER BY count(*) DESC, language"),
    db.query<{ value: string; n: number }>("SELECT category AS value, count(*) AS n FROM library_tasks WHERE category IS NOT NULL GROUP BY category ORDER BY count(*) DESC, category"),
    db.query<{ total: number; active: number }>("SELECT count(*) AS total, count(*) FILTER (WHERE active) AS active FROM library_tasks"),
    by("language"), by("category"),
    flags("active", "active", "NOT active"),
    flags("has_repo", "coalesce(repo_url, '') <> ''", "coalesce(repo_url, '') = ''"),
    flags("harness", "cardinality(harnesses) = 0", "cardinality(harnesses) > 0"),
    db.query<{ value: string; n: number }>(`SELECT h AS value, count(*) AS n FROM library_tasks CROSS JOIN LATERAL unnest(harnesses) AS h ${hx.w} GROUP BY 1`, hx.params),
  ]);
  const counts = (xs: { value: string | null; n: number }[]) => ({ "": xs.reduce((t, r) => t + Number(r.n), 0),
    ...Object.fromEntries(xs.filter((r) => r.value != null).map((r) => [r.value, Number(r.n)])) });
  const pair = (r: Record<string, number> | undefined) => ({ "": Number(r?.n_all ?? 0), true: Number(r?.n_yes ?? 0), false: Number(r?.n_no ?? 0) });
  return { tasks: rows, total: Number(n), limit, offset, all: Number(all?.total ?? 0), active: Number(all?.active ?? 0),
           languages: languages.map((r) => ({ value: r.value, n: Number(r.n) })), categories: categories.map((r) => ({ value: r.value, n: Number(r.n) })),
           harnesses: harnessOptions(),
           facets: { language: counts(fLang), category: counts(fCat), active: pair(fActive), has_repo: pair(fRepo),
             harness: { "": Number(fHarness?.n_all ?? 0), any: Number(fHarness?.n_yes ?? 0), set: Number(fHarness?.n_no ?? 0),
               ...Object.fromEntries(fEach.map((r) => [r.value, Number(r.n)])) } as Record<string, number> } };
}

async function taskById(id: number) {
  if (!Number.isInteger(id)) throw new AdminError("Bad task id");
  const [t] = await (await getDb()).query<{ id: number; title: string; prompt: string; language: string | null; tags: string[]; attributes: Record<string, unknown> }>(
    `SELECT ${TASK_COLS} FROM library_tasks WHERE id = $1`, [id]);
  if (!t) throw new AdminError(`No task ${id}`, 404);
  return t;
}

function taskPatch(b: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  if (has(b, "title")) { out.title = str(b.title, 200); if (!out.title) throw new AdminError("A task needs a title"); }
  if (has(b, "prompt")) { out.prompt = str(b.prompt, 20000); if (!out.prompt) throw new AdminError("A task needs a prompt"); }
  if (has(b, "language")) out.language = str(b.language, 60) || null;
  if (has(b, "category")) out.category = str(b.category, 60) || null;
  if (has(b, "tags")) out.tags = list(b.tags, 30, 60);
  if (has(b, "harnesses")) out.harnesses = harnessList(b.harnesses);
  if (has(b, "repo_url")) {
    const u = str(b.repo_url, 500);
    if (u && !/^https:\/\/[^\s/]+\.[^\s/]+\/\S+$/.test(u)) throw new AdminError("The repository must be an https:// link, e.g. https://github.com/owner/repo");
    out.repo_url = u || null;
  }
  return out;
}

export async function createTask(actor: string, body: Record<string, unknown>) {
  const t = taskPatch({ title: body.title ?? "", prompt: body.prompt ?? "", ...body });
  const db = await getDb();
  const slug = `admin-${slugify(String(t.title))}-${suffix()}`;
  const [row] = await db.query<{ id: number }>(
    `INSERT INTO library_tasks (slug, title, prompt, repo_url, language, category, tags, attributes, platform, source, active, edited_at, edited_by, harnesses)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '{}', $8, 'admin', $9, now(), $10, $11) RETURNING id`,
    [slug, t.title, t.prompt, t.repo_url ?? null, t.language ?? null, t.category ?? null, t.tags ?? [],
     platformOf({ language: t.language as string | null, tags: t.tags as string[], prompt: t.prompt as string }), body.active !== false, actor, t.harnesses ?? []]);
  log(actor, "task.create", null, { task: row!.id });
  return taskById(row!.id);
}

export async function updateTask(actor: string, id: number, body: Record<string, unknown>) {
  const cur = await taskById(id);
  const t = taskPatch(body);
  const next = { ...cur, ...t } as typeof cur;
  const platform = platformOf({ template: cur.attributes?.template as string | undefined, language: next.language, tags: next.tags, prompt: next.prompt });
  await (await getDb()).query(
    `UPDATE library_tasks SET title = $2, prompt = $3, repo_url = $4, language = $5, category = $6, tags = $7, platform = $8,
       edited_at = now(), edited_by = $9, harnesses = $10 WHERE id = $1`,
    [id, next.title, next.prompt, (next as any).repo_url ?? null, next.language ?? null, (next as any).category ?? null, next.tags ?? [], platform, actor,
     (next as any).harnesses ?? []]);
  log(actor, "task.edit", null, { task: id, fields: Object.keys(t) });
  return taskById(id);
}

/** Set the harness preference of one or many tasks (empty: any harness in the mix). Counts as an edit. */
export async function setTasksHarnesses(actor: string, ids: unknown, harnesses: unknown) {
  const nums = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger).slice(0, 1000);
  if (!nums.length) throw new AdminError("ids are required");
  const h = harnessList(harnesses);
  const rows = await (await getDb()).query("UPDATE library_tasks SET harnesses = $2, edited_at = now(), edited_by = $3 WHERE id = ANY($1) RETURNING id", [nums, h, actor]);
  log(actor, "task.harnesses", null, { tasks: rows.length, harnesses: h });
  return { updated: rows.length };
}

/** Turn tasks on or off (one or many). Counts as an edit, so a sync never turns them back. */
export async function setTasksActive(actor: string, ids: unknown, active: unknown) {
  const nums = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger).slice(0, 1000);
  if (!nums.length || typeof active !== "boolean") throw new AdminError("ids and active (true or false) are required");
  const rows = await (await getDb()).query("UPDATE library_tasks SET active = $2, edited_at = now(), edited_by = $3 WHERE id = ANY($1) RETURNING id", [nums, active, actor]);
  log(actor, active ? "task.activate" : "task.deactivate", null, { tasks: rows.length });
  return { updated: rows.length };
}

// ---------- compute ----------

/** The default population's agent mix: every registry agent, its share, whether it runs, and its sandboxes out of the unit. */
async function agentMix() {
  const pop = await populations.getPopulation();
  const db = await getDb();
  const inMix = new Set((await db.query<{ agent_id: string }>("SELECT agent_id FROM developer_population_agents WHERE population_id = $1", [pop.id])).map((r) => r.agent_id));
  const mix = new Map(sandboxMix(pop).map((m) => [m.agent.id, m]));
  const total = pop.agents.filter((a) => a.enabled !== false && a.weight > 0 && !a.paused && a.worker_adapter !== "todo").reduce((s, a) => s + a.weight, 0);
  return {
    slug: pop.slug, name: pop.name, sandbox_unit: pop.sandbox_unit, as_of: pop.as_of,
    agents: pop.agents.map((a) => {
      const runnable = a.enabled !== false && a.worker_adapter !== "todo";
      const running = runnable && a.weight > 0 && !a.paused;
      return {
        id: a.id, label: a.label, harness: a.harness, model: a.model, vendor: a.vendor ?? null, in_mix: inMix.has(a.id),
        origin: a.origin ?? "registry", base_agent: a.base_agent ?? null, harness_version: a.harness_version ?? null,
        weight: a.weight, share: running && total ? a.weight / total : 0, sandboxes: mix.get(a.id)?.sandboxes ?? 0,
        paused: Boolean(a.paused), paused_reason: a.paused_reason ?? null, runnable,
        status: !runnable ? (a.enabled === false ? (a.origin === "admin" ? "Disabled" : "Can't run headless") : "Adapter pending") : a.paused ? "Off" : a.weight > 0 ? "On" : "No share",
      };
    }).sort((x, y) => y.weight - x.weight || x.label.localeCompare(y.label)),
  };
}

export async function compute() {
  return { groups: SETTING_GROUPS, settings: await listSettings(), population: await agentMix() };
}

export async function saveSettings(actor: string, values: unknown) {
  const changes = await setSettings(actor, (values && typeof values === "object" ? values : {}) as Record<string, unknown>);
  if (changes.length) log(actor, "settings.save", null, { changes });
  return compute();
}

/** Change one agent in the default population: its share (weight) and/or whether it runs. */
export async function setAgent(actor: string, agentId: string, body: { market_share?: unknown; paused?: unknown }) {
  if (!registry().agents.some((a) => a.id === agentId)) throw new AdminError(`Unknown agent ${agentId}`, 404);
  const pop = await populations.getPopulation();
  const share = body.market_share === undefined ? undefined : Number(body.market_share);
  if (share !== undefined && !(Number.isFinite(share) && share >= 0 && share <= 1000)) throw new AdminError("The weight must be a number of 0 or more");
  const db = await getDb();
  const [row] = await db.query<{ market_share: number }>("SELECT market_share FROM developer_population_agents WHERE population_id = $1 AND agent_id = $2", [pop.id, agentId]);
  // Turning on an agent that has no share yet (or a 0 share, as a newly added harness has) needs a weight; it gets the
  // smallest share in the mix unless one was sent.
  if (share !== undefined || !row || (body.paused === false && !(Number(row.market_share) > 0))) {
    const [{ w }] = await db.query<{ w: number | null }>("SELECT min(market_share) FILTER (WHERE market_share > 0) AS w FROM developer_population_agents WHERE population_id = $1", [pop.id]);
    await populations.setShare(pop.slug, agentId, share ?? (body.paused === false ? Number(w ?? 0.01) : 0));
  }
  if (body.paused !== undefined) await populations.setPaused(pop.slug, agentId, Boolean(body.paused), body.paused ? `turned off on /admin/compute by ${actor}` : undefined);
  log(actor, "agent_mix.edit", null, { population: pop.slug, agent: agentId, ...(share !== undefined ? { weight: share } : {}), ...(body.paused !== undefined ? { paused: Boolean(body.paused) } : {}) });
  return compute();
}

// ---------- admin-added harnesses (src/harnesses.ts) ----------
// Variants of a CLI that harnesses/registry.json supports. A new one joins the default population at weight 0 and off.

const harnessError = (e: unknown) => (e instanceof harnesses.HarnessError ? new AdminError(e.message, e.status) : e);

export const listHarnesses = () => harnesses.listPlatformHarnesses();

export async function addHarness(actor: string, body: Record<string, unknown>) {
  const row = await harnesses.createPlatformHarness(actor, body).catch((e) => { throw harnessError(e); });
  const pop = await populations.getPopulation();
  await (await getDb()).query(
    `INSERT INTO developer_population_agents (population_id, agent_id, market_share, paused, paused_reason) VALUES ($1, $2, 0, true, $3)
     ON CONFLICT DO NOTHING`, [pop.id, row.id, `added on /admin/agents by ${actor}; set a weight and turn it on`]);
  log(actor, "harness.add", null, { harness: row.id, base: row.harness, model: row.model, version: row.harness_version });
  return { harness: row, ...(await compute()) };
}

export async function editHarness(actor: string, id: string, body: Record<string, unknown>) {
  const { harness, changes } = await harnesses.updatePlatformHarness(actor, id, body).catch((e) => { throw harnessError(e); });
  if (Object.keys(changes).length) log(actor, "harness.edit", null, { harness: id, changes });
  return { harness, ...(await compute()) };
}

export async function deleteHarness(actor: string, id: string) {
  const { harness, mixes } = await harnesses.deletePlatformHarness(id).catch((e) => { throw harnessError(e); });
  log(actor, "harness.delete", null, { harness: id, base: harness.harness, model: harness.model, populations: mixes });
  return compute();
}

// ---------- model keys (the key vault, src/keyvault.ts) ----------
// The vault's own admin API (/api/admin/keyvault/*) stays as it is; these wrap it for /admin/compute with the console's
// actor and audit log. A secret is taken once and never returned: only its hint ("sk-ant…9xQ2").

const vaultError = (e: unknown) => (e instanceof AdminError ? e : new AdminError((e as Error).message));

/** Providers (with how many keys they hold and when one was last used) and every credential, hints only. */
export async function modelKeys() {
  // Every key is a vault key (env keys were imported once, src/keyvault-env.ts); env_set names the variables still set
  // on the server for a provider, which nothing reads any more and can be deleted there.
  const [providers, creds, envSet] = await Promise.all([kv.listProviders(), kv.listCredentials() as Promise<any[]>, envStillSet()]);
  const credentials = creds.map(({ key_id: _k, meta, ...c }) => ({ ...c, uses: Number(c.uses),
    ...(meta?.client_email ? { project_id: meta.project_id || null, client_email: meta.client_email } : {}) }));
  return {
    unlocked: kv.vaultUnlocked(),
    providers: providers.map((p) => {
      const mine = credentials.filter((c) => c.provider === p.slug);
      const last = mine.map((c) => c.last_used_at).filter(Boolean).sort((a, b) => +new Date(b) - +new Date(a))[0] ?? null;
      return { slug: p.slug, mode: p.mode, backend: p.backend, enabled: p.enabled, keys: mine.length, enabled_keys: mine.filter((c) => c.enabled).length, last_used_at: last,
               env_set: envSet[p.slug] ?? [] };
    }),
    credentials,
  };
}

export async function addModelKey(actor: string, body: { provider?: unknown; secret?: unknown; label?: unknown; priority?: unknown }) {
  const provider = str(body.provider, 40), secret = typeof body.secret === "string" ? body.secret : "";
  if (!provider || !secret) throw new AdminError("provider and secret are required");
  if (!kv.vaultUnlocked()) throw new AdminError("The key vault is locked: set OCTILLION_VAULT_KEY on the server first");
  const label = str(body.label, 60) || undefined, priority = body.priority === undefined || body.priority === "" ? undefined : Math.trunc(Number(body.priority));
  if (priority !== undefined && !Number.isFinite(priority)) throw new AdminError("Priority must be a whole number");
  const saved = await kv.setCredential(provider, secret, { label, priority }).catch((e) => { throw vaultError(e); });
  log(actor, "model_key.add", null, { provider, label: saved.label, hint: saved.hint });
  return saved; // { id, provider, label, hint } (+ project_id, client_email for a service account): never the secret
}

export async function setModelKeyEnabled(actor: string, id: number, enabled: unknown) {
  if (!Number.isInteger(id) || typeof enabled !== "boolean") throw new AdminError("A credential id and enabled (true or false) are required");
  await kv.setCredentialEnabled(id, enabled).catch((e) => { throw new AdminError((e as Error).message, 404); });
  log(actor, enabled ? "model_key.enable" : "model_key.disable", null, { credential: id });
}

export async function deleteModelKey(actor: string, id: number) {
  if (!Number.isInteger(id)) throw new AdminError("Bad credential id");
  await kv.deleteCredential(id).catch((e) => { throw new AdminError((e as Error).message, 404); });
  log(actor, "model_key.delete", null, { credential: id });
}

export async function setProviderEnabled(actor: string, slug: string, enabled: unknown) {
  if (typeof enabled !== "boolean") throw new AdminError("enabled (true or false) is required");
  if (!(await kv.getProvider(slug))) throw new AdminError(`No provider ${slug}`, 404); // never create one from here
  await kv.upsertProvider({ slug, enabled }).catch((e) => { throw vaultError(e); });
  log(actor, enabled ? "model_provider.enable" : "model_provider.disable", null, { provider: slug });
}

// ---------- sandbox provider (boat.dev) ----------

/**
 * The sandbox provider as Compute shows it: boat.dev, the vault key it uses (hint only; replace or rotate it in Key
 * vault), live plan limits and what is running, ours (this deployment's namespace) and anyone else's on the account.
 * Each call asks boat.dev directly, so it doubles as a connection test.
 */
export async function sandboxProvider() {
  const lib = await import("../orchestrator/deploy/boat-lib.js");
  const { BOAT } = await import("../orchestrator/core/config.js");
  const creds = (await kv.listCredentials() as any[]).filter((c) => c.provider === "boat").map(({ key_id: _k, ...c }) => ({ ...c, uses: Number(c.uses) }));
  const db = await getDb();
  const orchestrators = await db.query<{ state: string; n: number }>(
    "SELECT state, count(*)::int AS n FROM orchestrator_sandboxes WHERE state IN ('booting', 'running', 'draining') GROUP BY state");
  const base = { provider: "boat.dev", api: BOAT.apiUrl, namespace: lib.BOAT_NAMESPACE, keys: creds,
    orchestrators: Object.fromEntries(orchestrators.map((o) => [o.state, Number(o.n)])) };
  try {
    BOAT.apiKey = (await kv.useCredential("boat")).secret;
    const [limits, list] = await Promise.all([lib.boatLimits(), lib.listSandboxes()]);
    const live = list.filter((s) => lib.isLive(s));
    const ours = live.filter((s) => s.name?.startsWith(lib.ORCH_PREFIX) || s.name?.startsWith(lib.WORKER_PREFIX));
    return { ...base, ok: true, error: null, limits,
      running: { total: live.length, ours: ours.length, orchestrators: ours.filter((s) => s.name?.startsWith(lib.ORCH_PREFIX)).length, others: live.length - ours.length } };
  } catch (e) {
    return { ...base, ok: false, error: (e as Error).message.slice(0, 300), limits: null, running: null };
  }
}
