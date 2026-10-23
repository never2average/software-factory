import { getDb } from "./db.js";
import { hostTable } from "./host-tables.js";
import { baseEntriesFor, fileRegistry, isBaseEntry, modelRoute, registry, setPlatformHarnesses, type PlatformHarness } from "./agents.js";

/**
 * Admin-added harnesses (/admin/agents, "Harness mix" -> Add harness): platform_harnesses rows, each a variant of a CLI
 * that harnesses/registry.json already supports (same install script, headless command, event format, adapter), with
 * its own model, label and optionally another version pin. registry() (src/agents.ts) merges them in synchronously
 * from the cache kept here: loaded on the first request and the first autoscaler tick, refreshed when older than 30s
 * (as src/settings.ts does), and at once after every change on this replica.
 *
 * Orchestrators learn an admin-added harness from the session claim: its `agent` payload carries the full spec
 * (src/worker.ts), which the orchestrator adds to its own registry view (orchestrator/fleet/plan.ts rememberAgents).
 * Not the per-org private harness feature (src/private.ts, org_harnesses): those are customer-built harnesses with a
 * review pipeline; these reuse an existing, already-reviewed CLI.
 */

export class HarnessError extends Error { constructor(message: string, public status = 400) { super(message); } }

const TTL_MS = 30_000;
let loadedAt = 0;
let loading: Promise<void> | null = null;
const COLS = `id, harness, model, label, harness_version, notes, enabled, created_at, created_by, updated_at, updated_by`;

/** Reload admin-added harnesses from Postgres into registry() (deduplicated). A failed load keeps the old ones. */
export function refreshPlatformHarnesses(): Promise<void> {
  loading ??= (async () => {
    const rows = await (await getDb()).query<PlatformHarness & { created_at: Date; updated_at: Date }>(`SELECT ${COLS} FROM platform_harnesses ORDER BY created_at, id`);
    setPlatformHarnesses(rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString(), updated_at: new Date(r.updated_at).toISOString() })));
    loadedAt = Date.now();
  })().catch((e) => { console.error("platform harnesses: load failed:", (e as Error).message); }).finally(() => { loading = null; });
  return loading;
}

/** Resolve once the cache is at most 30s old. Called per request and per autoscaler tick. */
export const freshPlatformHarnesses = (): Promise<void> => (Date.now() - loadedAt < TTL_MS ? Promise.resolve() : refreshPlatformHarnesses());

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
// Model ids and versions go into argv (as one argument) and provider requests: same character set as model settings.
const MODEL_RE = /^[A-Za-z0-9@._\/:-]{1,120}$/;
const VERSION_RE = /^[A-Za-z0-9._+-]{1,60}$/;
const slugify = (s: string) => s.toLowerCase().replace(/^[a-z]+\//, "").replace(/^@cf\/[^/]+\//, "").replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

/** Bases for the form: every CLI of registry.json that a variant can use, its pinned version and its models. */
export function harnessBases() {
  const byHarness = new Map<string, { harness: string; cli: string | null; label: string; harness_version: string | null; routes: string[]; models: string[] }>();
  for (const a of fileRegistry().agents.filter(isBaseEntry)) {
    const b = byHarness.get(a.harness) ?? { harness: a.harness, cli: a.cli ?? null, label: a.label.split(" · ")[0]!, harness_version: a.harness_version ?? null, routes: [], models: [] };
    if (!b.routes.includes(modelRoute(a.model))) b.routes.push(modelRoute(a.model));
    byHarness.set(a.harness, b);
  }
  for (const a of registry().agents) {
    const b = byHarness.get(a.harness);
    if (b && a.model && !b.models.includes(a.model)) b.models.push(a.model);
  }
  return [...byHarness.values()].sort((x, y) => x.label.localeCompare(y.label));
}

export async function listPlatformHarnesses() {
  await refreshPlatformHarnesses();
  const rows = await (await getDb()).query<PlatformHarness>(`SELECT ${COLS} FROM platform_harnesses ORDER BY created_at, id`);
  const live = new Map(registry().agents.map((a) => [a.id, a]));
  return {
    harnesses: rows.map((r) => ({ ...r, base_agent: live.get(r.id)?.base_agent ?? null, effective_version: live.get(r.id)?.harness_version ?? null, active: live.has(r.id) })),
    bases: harnessBases(),
  };
}

/** Checked base + model: the CLI exists in registry.json and a file entry of it routes this kind of model. */
function checkModel(harness: string, model: string) {
  if (!baseEntriesFor(harness).length) throw new HarnessError(`Unknown harness ${harness || "(none)"}: pick a CLI from harnesses/registry.json`);
  if (!MODEL_RE.test(model)) throw new HarnessError("The model must be a model id (letters, digits, @ . _ / : -)");
  if (!baseEntriesFor(harness, model).length) {
    const routes = [...new Set(baseEntriesFor(harness).map((a) => modelRoute(a.model)))].map((r) => (r === "bare" ? "a plain model id" : `${r}/…`));
    throw new HarnessError(`${harness} has no verified gateway route for "${model}": use ${routes.join(" or ")}`);
  }
}

function checkVersion(v: unknown): string | null {
  const s = str(v, 60);
  if (!s) return null;
  if (!VERSION_RE.test(s)) throw new HarnessError("The version pin may hold letters, digits and . _ + - only");
  return s;
}

/** Add a harness. It is not in any mix until the admin gives it a weight and turns it on. */
export async function createPlatformHarness(actor: string, body: Record<string, unknown>) {
  const harness = str(body.harness, 40), model = str(body.model, 120);
  checkModel(harness, model);
  const base = baseEntriesFor(harness, model)[0]!;
  const slug = slugify(str(body.slug, 48) || model);
  if (!slug) throw new HarnessError("Could not make an id from the model; send a slug");
  const id = `${harness}/${slug}`;
  if (fileRegistry().agents.some((a) => a.id === id)) throw new HarnessError(`${id} is already in harnesses/registry.json`, 409);
  const label = str(body.label, 80) || `${base.label.split(" · ")[0]} · ${model}`;
  const version = checkVersion(body.harness_version);
  const notes = str(body.notes, 500) || null;
  const db = await getDb();
  const [row] = await db.query<PlatformHarness>(
    `INSERT INTO platform_harnesses (id, harness, model, label, harness_version, notes, enabled, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7, $7) ON CONFLICT (id) DO NOTHING RETURNING ${COLS}`,
    [id, harness, model, label, version, notes, actor]);
  if (!row) throw new HarnessError(`${id} already exists`, 409);
  await refreshPlatformHarnesses();
  return row;
}

async function adminRow(id: string): Promise<PlatformHarness> {
  const [row] = await (await getDb()).query<PlatformHarness>(`SELECT ${COLS} FROM platform_harnesses WHERE id = $1`, [id]);
  if (!row) throw new HarnessError(fileRegistry().agents.some((a) => a.id === id) ? `${id} comes from harnesses/registry.json; only added harnesses can be changed here` : `No added harness ${id}`, fileRegistry().agents.some((a) => a.id === id) ? 400 : 404);
  return row;
}

/** Change an added harness's model, label, version pin, notes or enabled (the id stays). */
export async function updatePlatformHarness(actor: string, id: string, body: Record<string, unknown>) {
  const row = await adminRow(id);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const model = has("model") ? str(body.model, 120) : row.model;
  checkModel(row.harness, model);
  const label = has("label") ? str(body.label, 80) || row.label : row.label;
  const version = has("harness_version") ? checkVersion(body.harness_version) : row.harness_version;
  const notes = has("notes") ? str(body.notes, 500) || null : row.notes;
  if (has("enabled") && typeof body.enabled !== "boolean") throw new HarnessError("enabled must be true or false");
  const enabled = has("enabled") ? Boolean(body.enabled) : row.enabled;
  const [next] = await (await getDb()).query<PlatformHarness>(
    `UPDATE platform_harnesses SET model = $2, label = $3, harness_version = $4, notes = $5, enabled = $6, updated_at = now(), updated_by = $7
      WHERE id = $1 RETURNING ${COLS}`, [id, model, label, version, notes, enabled, actor]);
  await refreshPlatformHarnesses();
  const changes = Object.fromEntries((["model", "label", "harness_version", "notes", "enabled"] as const)
    .filter((k) => row[k] !== next![k]).map((k) => [k, { from: row[k], to: next![k] }]));
  return { harness: next!, changes };
}

/** Delete an added harness and its share in every population (it leaves the mix). Sessions already run keep their agent_id. */
export async function deletePlatformHarness(id: string) {
  const row = await adminRow(id);
  const db = await getDb();
  let mixes = 0;
  await db.transaction(async (tx) => {
    // Populations are a host pack's table (mold_v0-049): a build without one has no mix to leave.
    if (hostTable("developer_population_agents")) mixes = (await tx.query("DELETE FROM developer_population_agents WHERE agent_id = $1 RETURNING population_id", [id])).length;
    await tx.query("DELETE FROM platform_harnesses WHERE id = $1", [id]);
  });
  await refreshPlatformHarnesses();
  return { harness: row, mixes };
}
