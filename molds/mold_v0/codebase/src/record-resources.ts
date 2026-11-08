/**
 * Record-owned resources (mold_v0-282, flag record_resources; molds/mold_v0/MOLD.md "Record-owned resources"): two field
 * types of a shared (platform) area whose records staff write, each a thing the record owns outside the record store.
 *
 *   repository   an existing GitHub repository (owner/name) staff link to the record: linked, never created. Every hand
 *                write that names one (new or changed) reads it first through the platform's GitHub App (Admin ›
 *                Key vault, GitHub App, mounted for it since mold_v0-283; src/github-app.ts
 *                readRecordRepository): a repository the app cannot read refuses the write in plain words, naming
 *                where to fix it. The record's page shows its default branch and last commit, read live.
 *   database     one Postgres database of the record's own, CREATED when the record is created (never linked, never
 *                shared): a Neon project per record and field (provider "neon", Neon's API v2 called directly with
 *                fetch, no SDK), made with the key vault's `neon` key (a platform owner's, Admin › Key vault; never
 *                given to a session or a run: src/agent-profiles.ts KEYS_NEVER_INJECTED, src/gateway.ts
 *                ORCHESTRATOR_ONLY_PROVIDERS). Its connection string is sealed with the key vault's master key into
 *                the record's own row of record_resources (sql/migrations/0061_record_resources.sql), never into the
 *                record's fields, never in an answer, a log line or an error. Its status (provisioning, ready, failed
 *                with the reason) is on the record's page with a Retry; deleting the record deletes the Neon project
 *                first, and a project that cannot be deleted refuses the record's delete. A missing Neon key is named in
 *                plain words on the New form and on Health, with where to add it.
 *
 * Nothing here runs unless the flag is on and an area declares one of the two types (src/record-areas.ts ownsResources);
 * NEON_API_URL points the client elsewhere (the offline test's stand-in).
 */
import { getDb } from "./db.js";
import { ENV } from "./env-names.js";
import { decrypt, encrypt } from "./keyvault.js";
import { PackError } from "./pack-api.js";
import { asPlatform } from "./tenant-scope.js";
import type { RecordArea } from "./record-areas.js";

export const NEON_PROVIDER = "neon";
export const neonApiUrl = () => (ENV.NEON_API_URL || "https://console.neon.tech/api/v2").replace(/\/+$/, "");
/** A database still "provisioning" this long after its last attempt was cut short (a process gone): staff may retry it. */
export const STALE_PROVISIONING_MS = 2 * 60_000;

type Field = RecordArea["fields"][number];
export const repositoryFields = (a: Pick<RecordArea, "fields">): Field[] => a.fields.filter((f) => f.type === "repository");
export const databaseFields = (a: Pick<RecordArea, "fields">): Field[] => a.fields.filter((f) => f.type === "database");

// ---------- the Neon key ----------

/** Where the Neon key is added, in words (the New form, Health, a failed database's reason). */
export const NEON_KEY_MISSING = "No Neon key in the key vault, so a new record's database cannot be created. A platform owner adds it in Admin › Key vault: "
  + "Neon (the key is made at console.neon.tech, Account settings › API keys).";

/** Whether the key vault holds a Neon key that is turned on. Never reads it. */
export async function neonKeySet(): Promise<boolean> {
  const [r] = await asPlatform(async () => (await getDb()).query<{ n: number }>("SELECT count(*)::int AS n FROM vault_credentials WHERE provider = $1 AND enabled", [NEON_PROVIDER]));
  return Number(r?.n ?? 0) > 0;
}
async function neonKey(): Promise<string | null> {
  const { useCredential } = await import("./keyvault.js");
  try { return (await useCredential(NEON_PROVIDER)).secret; } catch { return null; }
}

// ---------- Neon's API v2 (the calls needed and nothing else) ----------

class NeonError extends Error { constructor(readonly status: number, message: string) { super(message); } }
/** Anything that reads like a connection string, cut out of what Neon says before it is kept or shown. */
const scrub = (t: string) => t.replace(/postgres(?:ql)?:\/\/\S+/gi, "[connection string]").replace(/\s+/g, " ").trim().slice(0, 240);

async function neon<T = any>(key: string, method: "GET" | "POST" | "DELETE", p: string, body?: unknown): Promise<T> {
  let res: Response;
  const where = `${method} ${p.replace(/\/projects\/[^/?]+/, "/projects/:id")}`;
  try {
    res = await fetch(`${neonApiUrl()}${p}`, { method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) { throw new NeonError(0, `Neon could not be reached (${where}): ${scrub((e as Error).message)}`); }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const said = typeof json?.message === "string" ? scrub(json.message) : "";
    const what = res.status === 401 || res.status === 403 ? "Neon refused the key (check the Neon key in Admin › Key vault)" : `Neon answered ${res.status}`;
    throw new NeonError(res.status, `${what}${said ? `: ${said}` : ""}`);
  }
  return json as T;
}

/** The Neon project's name for a record's database: the pack, area, record and field (Neon's own limit, 64 characters). */
const projectName = (a: Pick<RecordArea, "pack" | "name">, key: string, field: string) =>
  `${a.pack}-${a.name}-${key}${field === "database" ? "" : `-${field}`}`.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64);

// ---------- the record's rows (record_resources) ----------

interface Row {
  id: number; field: string; provider: string; status: "provisioning" | "ready" | "failed"; reason: string | null; external_id: string | null;
  details: { region?: string; host?: string; database?: string; role?: string }; attempts: number; updated_at: Date | string; created_at: Date | string;
}
const COLS = "id, field, provider, status, reason, external_id, details, attempts, updated_at, created_at";
const db = async () => getDb();
const rowsOf = (a: RecordArea, key: string) => asPlatform(async () => (await db()).query<Row>(
  `SELECT ${COLS} FROM record_resources WHERE pack = $1 AND area = $2 AND record_key = $3 ORDER BY field`, [a.pack, a.name, key]));
const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();
const stale = (r: Row) => r.status === "provisioning" && Date.now() - Date.parse(iso(r.updated_at)) > STALE_PROVISIONING_MS;
const recordExists = async (a: RecordArea, key: string) => (await asPlatform(async () => (await db()).query(
  "SELECT 1 FROM platform_records WHERE pack = $1 AND area = $2 AND key = $3", [a.pack, a.name, key]))).length > 0;

/**
 * A stored record's databases (src/record-areas.ts putPlatform, after the write commits): one per database field, made
 * once; a record that already has its row keeps it (an edit, an import that updates). Never throws for the database: a
 * failure is its status.
 */
export async function ensureDatabases(area: RecordArea, key: string): Promise<void> {
  for (const f of databaseFields(area)) {
    const [r] = await asPlatform(async () => (await db()).query<{ id: number }>(
      `INSERT INTO record_resources (pack, area, record_key, field, provider, status) VALUES ($1, $2, $3, $4, $5, 'provisioning')
       ON CONFLICT (pack, area, record_key, field) DO NOTHING RETURNING id`, [area.pack, area.name, key, f.name, f.provider ?? NEON_PROVIDER]));
    if (r) await provision(area, key, f, r.id);
  }
}

/** Create the record's Neon project and seal its connection string; the row says how it went. */
async function provision(area: RecordArea, key: string, f: Field, id: number): Promise<void> {
  const fail = (reason: string) => asPlatform(async () => (await db()).query(
    "UPDATE record_resources SET status = 'failed', reason = $2, attempts = attempts + 1, updated_at = now() WHERE id = $1", [id, reason.slice(0, 500)]));
  const k = await neonKey();
  if (!k) return void (await fail(NEON_KEY_MISSING));
  let created: { project?: { id?: string; region_id?: string }; connection_uris?: { connection_uri?: string; connection_parameters?: { database?: string; role?: string; host?: string } }[] };
  try { created = await neon(k, "POST", "/projects", { project: { name: projectName(area, key, f.name) } }); }
  catch (e) { return void (await fail(e instanceof NeonError ? e.message : "Neon could not be asked")); }
  const projectId = typeof created?.project?.id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(created.project.id) ? created.project.id : null;
  const uri = created?.connection_uris?.[0]?.connection_uri;
  if (!projectId || typeof uri !== "string" || !/^postgres(ql)?:\/\//.test(uri)) {
    if (projectId) await neon(k, "DELETE", `/projects/${encodeURIComponent(projectId)}`).catch(() => null);
    return void (await fail("Neon's answer had no project or connection string: nothing was kept (the project, if any, was deleted). Retry."));
  }
  const p = created.connection_uris![0]!.connection_parameters ?? {};
  const details = { region: created.project!.region_id ?? undefined, host: p.host, database: p.database, role: p.role };
  const sealed = encrypt(uri);
  const done = await asPlatform(async () => (await db()).query(
    `UPDATE record_resources SET status = 'ready', reason = NULL, external_id = $2, details = $3, secret_ciphertext = $4, secret_iv = $5, secret_tag = $6,
       secret_key_id = $7, attempts = attempts + 1, ready_at = now(), updated_at = now() WHERE id = $1 AND status = 'provisioning' RETURNING id`,
    [id, projectId, JSON.stringify(details), sealed.ciphertext, sealed.iv, sealed.tag, sealed.key_id]));
  // The record went (or its row did) while Neon was creating it: the project is nobody's, so it goes too.
  if (!done.length) await neon(k, "DELETE", `/projects/${encodeURIComponent(projectId)}`).catch(() => null);
}

/**
 * Staff's Retry of a record's database: a failed one (or one whose attempt was cut short), made again; a record with no
 * row yet (the flag turned on after it was written) gets its first. A project a failed attempt left is deleted first.
 */
export async function retryDatabase(area: RecordArea, key: string, field: string): Promise<DatabaseView> {
  const f = databaseFields(area).find((x) => x.name === field);
  if (!f) throw new PackError(`${area.label} has no database field ${field.slice(0, 64)}`, 404);
  if (!(await recordExists(area, key))) throw new PackError("Not found", 404);
  const [r] = (await rowsOf(area, key)).filter((x) => x.field === field);
  if (!r) { await ensureDatabases(area, key); return (await databasesOf(area, key)).find((d) => d.field === field)!; }
  if (r.status === "ready") throw new PackError(`The ${f.label} database of ${key} is ready: nothing to retry`, 409);
  if (r.status === "provisioning" && !stale(r)) throw new PackError(`The ${f.label} database of ${key} is being created: wait a minute, then look again`, 409);
  const [claimed] = await asPlatform(async () => (await db()).query<{ id: number }>(
    "UPDATE record_resources SET status = 'provisioning', updated_at = now() WHERE id = $1 AND status = $2 RETURNING id", [r.id, r.status]));
  if (!claimed) throw new PackError(`The ${f.label} database of ${key} changed meanwhile: look again`, 409);
  if (r.external_id) {
    const k = await neonKey();
    if (k) await neon(k, "DELETE", `/projects/${encodeURIComponent(r.external_id)}`).catch(() => null);
  }
  await provision(area, key, f, r.id);
  return (await databasesOf(area, key)).find((d) => d.field === field)!;
}

/**
 * Before a record is deleted (src/record-areas.ts deletePlatform): each of its databases deleted at Neon (one Neon no
 * longer knows counts as deleted), then its rows. One that cannot be deleted refuses the record's delete, nothing done.
 */
export async function releaseDatabases(area: RecordArea, key: string): Promise<void> {
  const rows = (await rowsOf(area, key)).filter((r) => databaseFields(area).some((f) => f.name === r.field) || r.provider === NEON_PROVIDER);
  if (!rows.length) return;
  const label = (r: Row) => area.fields.find((f) => f.name === r.field)?.label ?? r.field;
  const busy = rows.find((r) => r.status === "provisioning" && !stale(r));
  if (busy) throw new PackError(`The ${label(busy)} database of ${key} is still being created: wait a minute, then delete the record`, 409);
  const live = rows.filter((r) => r.external_id);
  const k = live.length ? await neonKey() : null;
  if (live.length && !k) throw new PackError(`${key} has a database at Neon, and with no Neon key it cannot be deleted, so the record stays. ${NEON_KEY_MISSING.replace(/^No Neon key in the key vault, so a new record's database cannot be created\. /, "")}`, 409);
  for (const r of live) {
    try { await neon(k!, "DELETE", `/projects/${encodeURIComponent(r.external_id!)}`); }
    catch (e) {
      if (e instanceof NeonError && e.status === 404) continue;
      throw new PackError(`The ${label(r)} database of ${key} could not be deleted at Neon (${e instanceof Error ? e.message : "no answer"}): nothing was deleted, the record stays. Try again`, 502);
    }
  }
  await asPlatform(async () => (await db()).query("DELETE FROM record_resources WHERE id = ANY($1::bigint[])", [rows.map((r) => r.id)]));
}

/**
 * A record's database's connection string, for the server's own code only (never an answer, a session or a run): null
 * when it has none ready. Each read is the sealed value opened.
 */
export async function recordDatabaseUrl(area: RecordArea, key: string, field: string): Promise<string | null> {
  const [r] = await asPlatform(async () => (await db()).query<{ secret_ciphertext: string; secret_iv: string; secret_tag: string; secret_key_id: string }>(
    `SELECT secret_ciphertext, secret_iv, secret_tag, secret_key_id FROM record_resources
      WHERE pack = $1 AND area = $2 AND record_key = $3 AND field = $4 AND status = 'ready'`, [area.pack, area.name, key, field]));
  return r ? decrypt({ ciphertext: r.secret_ciphertext, iv: r.secret_iv, tag: r.secret_tag, key_id: r.secret_key_id }) : null;
}

/** After APP_VAULT_KEY is rotated (src/keyvault.ts rekey): every sealed connection string re-sealed with the current key. */
export async function rekeyResourceSecrets(currentId: string): Promise<number> {
  const d = await db();
  const rows = await d.query<{ id: number; secret_ciphertext: string; secret_iv: string; secret_tag: string; secret_key_id: string }>(
    "SELECT id, secret_ciphertext, secret_iv, secret_tag, secret_key_id FROM record_resources WHERE secret_ciphertext IS NOT NULL AND secret_key_id <> $1", [currentId]);
  for (const r of rows) {
    const e = encrypt(decrypt({ ciphertext: r.secret_ciphertext, iv: r.secret_iv, tag: r.secret_tag, key_id: r.secret_key_id }));
    await d.query("UPDATE record_resources SET secret_ciphertext = $2, secret_iv = $3, secret_tag = $4, secret_key_id = $5 WHERE id = $1", [r.id, e.ciphertext, e.iv, e.tag, e.key_id]);
  }
  return rows.length;
}

// ---------- repositories ----------

const repoCache = new Map<string, { at: number; value: RepositoryView | { error: string } }>();
const REPO_TTL_MS = 60_000;
export interface RepositoryView { repository: string; url: string; default_branch: string; private: boolean; last_commit: { sha: string; message: string; date: string | null; author: string | null } | null }

/** One repository as the platform's GitHub App reads it now (a minute's memory for the record's page). */
async function readRepository(full: string, fresh = false): Promise<RepositoryView> {
  const c = repoCache.get(full.toLowerCase());
  if (!fresh && c && Date.now() - c.at < REPO_TTL_MS) { if ("error" in c.value) throw new PackError(c.value.error, 400); return c.value; }
  const { readRecordRepository } = await import("./github-app.js");
  try {
    const v = await readRecordRepository(full);
    repoCache.set(full.toLowerCase(), { at: Date.now(), value: v });
    return v;
  } catch (e) {
    const error = e instanceof Error ? e.message : `The platform's GitHub App cannot read ${full}`;
    repoCache.set(full.toLowerCase(), { at: Date.now(), value: { error } });
    throw e instanceof PackError ? e : new PackError(error, 502);
  }
}

/**
 * A hand write's repositories (src/record-areas.ts putPlatform, before anything is stored): each one it names that is
 * new or changed is read through the platform's GitHub App now; one that cannot be read refuses the write.
 */
export async function checkRepositories(area: RecordArea, data: Record<string, unknown>, prev: Record<string, unknown> | null): Promise<void> {
  const problems: string[] = [];
  for (const f of repositoryFields(area)) {
    const v = data[f.name];
    if (typeof v !== "string" || !v || (prev && prev[f.name] === v)) continue;
    try { await readRepository(v, true); }
    catch (e) { problems.push(`${f.label}: ${e instanceof Error ? e.message : `the platform's GitHub App cannot read ${v}`}`); }
  }
  if (problems.length) throw new PackError(problems.join("; "), 400);
}

// ---------- what staff see ----------

export interface DatabaseView {
  field: string; label: string; provider: string;
  status: "provisioning" | "ready" | "failed" | "none"; reason: string | null;
  /** The provider's id of it (a Neon project id) and what is not secret about it: region, host, database, role. */
  project_id: string | null; region: string | null; host: string | null; database: string | null; role: string | null;
  retry: boolean; updated_at: string | null;
}
async function databasesOf(area: RecordArea, key: string): Promise<DatabaseView[]> {
  const rows = await rowsOf(area, key);
  return databaseFields(area).map((f) => {
    const r = rows.find((x) => x.field === f.name);
    if (!r) return { field: f.name, label: f.label, provider: f.provider ?? NEON_PROVIDER, status: "none", reason: "No database was created for this record yet (it was written before databases were on, or its creation never started).", project_id: null, region: null, host: null, database: null, role: null, retry: true, updated_at: null };
    return { field: f.name, label: f.label, provider: r.provider, status: r.status, reason: r.reason, project_id: r.external_id,
      region: r.details?.region ?? null, host: r.details?.host ?? null, database: r.details?.database ?? null, role: r.details?.role ?? null,
      retry: r.status === "failed" || stale(r), updated_at: iso(r.updated_at) };
  });
}

/** A shared record's resources, for its page (GET /api/admin/records/_resources/<area>/<key>): never a secret. */
export async function recordResources(area: RecordArea, key: string, data: Record<string, unknown>) {
  const repositories = await Promise.all(repositoryFields(area).map(async (f) => {
    const v = data[f.name];
    if (typeof v !== "string" || !v) return { field: f.name, label: f.label, repository: null };
    try { return { field: f.name, label: f.label, ...(await readRepository(v)) }; }
    catch (e) { return { field: f.name, label: f.label, repository: v, url: `https://github.com/${v}`, error: e instanceof Error ? e.message : "unreadable" }; }
  }));
  return { repositories, databases: await databasesOf(area, key) };
}

/** What the New form says of the area's resources (src/record-routes.ts `_console/<area>/form`). */
export async function formResources(area: RecordArea) {
  const dbs = databaseFields(area);
  const keySet = dbs.length ? await neonKeySet() : true;
  return {
    repositories: repositoryFields(area).map((f) => ({ field: f.name, label: f.label })),
    databases: dbs.map((f) => ({ field: f.name, label: f.label, provider: f.provider ?? NEON_PROVIDER })),
    database_key_missing: keySet ? null : NEON_KEY_MISSING,
  };
}

/**
 * Health (src/health-tabs.ts): with an area that declares a database field, whether the Neon key is there, and how many
 * databases failed or are stuck. Null when no area declares one (nothing to say).
 */
export async function resourcesHealth(areas: RecordArea[]): Promise<{ key_set: boolean; failed: number; stuck: number; text: string | null } | null> {
  const owning = areas.filter((a) => databaseFields(a).length);
  if (!owning.length) return null;
  const keySet = await neonKeySet();
  const [c] = await asPlatform(async () => (await db()).query<{ failed: number; stuck: number }>(
    `SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'provisioning' AND updated_at < now() - make_interval(secs => $1))::int AS stuck FROM record_resources`, [STALE_PROVISIONING_MS / 1000]));
  const failed = Number(c?.failed ?? 0), stuck = Number(c?.stuck ?? 0);
  const text = !keySet ? NEON_KEY_MISSING
    : failed || stuck ? `${failed + stuck} record database${failed + stuck > 1 ? "s" : ""} could not be created: open the record and press Retry (its page says why).` : null;
  return { key_set: keySet, failed, stuck, text };
}
