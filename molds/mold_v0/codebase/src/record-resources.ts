/**
 * Record-owned resources (mold_v0-282, flag record_resources; molds/mold_v0/MOLD.md "Record-owned resources"): two field
 * types of a shared (platform) area whose records staff write, each a thing the record owns outside the record store.
 *
 *   repository   an existing GitHub repository (owner/name) staff link to the record: linked, never created. Every hand
 *                write that names one (new or changed) reads it first through the platform's GitHub App (the same
 *                app private catalogs are read with: Admin › Key vault, GitHub App; src/github-app.ts
 *                readRecordRepository): a repository the app cannot read refuses the write in plain words, naming
 *                where to fix it. The record's page shows its default branch and last commit, read live.
 *   database     a database of the record's own, CREATED when the record is created (never linked, never shared), inside
 *                the app's OWN Postgres (provider "core", the only one; mold_v0-285: no outside provider, no key): a
 *                schema named for the record (rec_<area>_<hash of the database, pack, area, record and field>) and,
 *                where the database allows CREATE ROLE, a LOGIN role of the same name with a random password, limited
 *                to that schema: USAGE and CREATE on it, every privilege on what is made in it (default privileges),
 *                nothing on public's tables or any other schema (each revoked by name), no membership, no CREATEDB,
 *                CREATEROLE or BYPASSRLS, search_path set to the schema. A database that refuses CREATE ROLE (hosted
 *                Postgres often does) keeps the schema alone, said on the record's page: "schema only, no own login: the
 *                app's connection is used". Its connection string (the role's, or the app's own with search_path set to
 *                the schema) is sealed with the key vault's master key into the record's own row of record_resources
 *                (sql/migrations/0061, 0062), never into the record's fields, an answer, a log line or an error. Its
 *                status (provisioning, ready, failed with the reason) is on the record's page with a Retry; deleting the
 *                record drops the schema (CASCADE) and the role first, and one that cannot be dropped refuses the
 *                record's delete. Health names a database that refuses CREATE SCHEMA or CREATE ROLE, in plain words.
 *
 * Every statement here that is not a record_resources row is DDL on the app's own database, run as the app's own role
 * (platform work: never in a workspace's tenant scope). Names are made here, never taken from a request: the schema
 * and role match ^rec_[a-z0-9_]+$ and the password is hex, so each is written into its statement as it is.
 * Nothing here runs unless the flag is on and an area declares one of the two types (src/record-areas.ts ownsResources).
 */
import { createHash, randomBytes } from "node:crypto";
import { getDb, type Queryable } from "./db.js";
import { decrypt, encrypt } from "./keyvault.js";
import { PackError } from "./pack-api.js";
import { asPlatform } from "./tenant-scope.js";
import type { RecordArea } from "./record-areas.js";

/** The one database provider (mold_v0-285): a schema of the record's own in the app's own database. */
export const CORE_PROVIDER = "core";
/** A database still "provisioning" this long after its last attempt was cut short (a process gone): staff may retry it. */
export const STALE_PROVISIONING_MS = 2 * 60_000;
/** What the record's page says of a database the app's database gave no login of its own. */
export const SCHEMA_ONLY = "Schema only, no own login: the app's connection is used";

type Field = RecordArea["fields"][number];
export const repositoryFields = (a: Pick<RecordArea, "fields">): Field[] => a.fields.filter((f) => f.type === "repository");
export const databaseFields = (a: Pick<RecordArea, "fields">): Field[] => a.fields.filter((f) => f.type === "database");

// ---------- names, words ----------

const NAME = /^rec_[a-z0-9_]{1,59}$/;
/** The schema's (and its role's) name for a record's database: rec_<area>_<10 hex of the database, pack, area, record, field>. */
export function objectName(database: string, a: Pick<RecordArea, "pack" | "name">, key: string, field: string): string {
  const h = createHash("sha256").update([database, a.pack, a.name, key, field].join("\u0000")).digest("hex").slice(0, 10);
  const n = `rec_${a.name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 40)}_${h}`;
  if (!NAME.test(n)) throw new Error("a record database's name could not be made");
  return n;
}
const ident = (n: string) => { if (!NAME.test(n) && !/^[a-z_][a-z0-9_]{0,62}$/.test(n)) throw new Error("not a safe identifier"); return `"${n}"`; };
/** What the database said, without anything that reads like a connection string or a password. */
const said = (e: unknown) => String((e as Error)?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, "[connection string]").replace(/PASSWORD\s+'[^']*'/gi, "PASSWORD [hidden]")
  .replace(/\s+/g, " ").trim().slice(0, 200);
const refused = (e: unknown) => (e as { code?: string })?.code === "42501";
export const SCHEMA_REFUSED = "The app's database refused to create this record's schema (CREATE SCHEMA), so its database could not be made. "
  + "The app's database login needs the right to create schemas in its database (CREATE on the database); once it has it, press Retry";

/**
 * Test seam (scripts/record-resources-test.ts): the DDL runs as this role (SET LOCAL ROLE) inside its transaction, so the
 * database itself refuses what that role may not do (CREATE SCHEMA, CREATE ROLE). Never set outside a test.
 */
let ddlRole: string | null = null;
export const setDdlRoleForTest = (role: string | null) => { ddlRole = role; };
const asDdlRole = async (tx: Queryable) => { if (ddlRole) await tx.query(`SET LOCAL ROLE ${ident(ddlRole)}`); };
const backToApp = async (tx: Queryable) => { if (ddlRole) await tx.query("RESET ROLE"); };

/** The connection string the record's database is reached with: its own role's, or the app's own with search_path set. */
function connectionUrl(schema: string, login: { role: string; password: string } | null): { url: string; host: string; database: string } {
  const app = process.env.DATABASE_URL;
  const u = new URL(app || "postgresql://localhost/postgres");
  if (login) {
    u.username = login.role; u.password = login.password;
    u.searchParams.delete("options"); // the role's own search_path (ALTER ROLE ... SET) is the schema
  } else u.searchParams.set("options", `-c search_path=${schema}`);
  return { url: u.toString(), host: app ? u.hostname : "embedded (PGlite)", database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres" };
}

// ---------- the record's rows (record_resources) ----------

interface Details { schema?: string; role?: string | null; login?: boolean; host?: string; database?: string; note?: string | null; refused?: "schema" | "role" | null }
interface Row {
  id: number; field: string; provider: string; status: "provisioning" | "ready" | "failed"; reason: string | null; external_id: string | null;
  details: Details; attempts: number; updated_at: Date | string; created_at: Date | string;
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
       ON CONFLICT (pack, area, record_key, field) DO NOTHING RETURNING id`, [area.pack, area.name, key, f.name, CORE_PROVIDER]));
    if (r) await provision(area, key, f, r.id);
  }
}

class Gone extends Error {}

/**
 * Make the record's schema (and its role, where the database allows one) and seal its connection string, in ONE
 * transaction with its row: either all of it is there and the row is ready, or none of it and the row says why.
 */
async function provision(area: RecordArea, key: string, f: Field, id: number): Promise<void> {
  const d = await db();
  const fail = (reason: string, details: Details = {}) => asPlatform(async () => d.query(
    "UPDATE record_resources SET status = 'failed', reason = $2, details = $3, attempts = attempts + 1, updated_at = now() WHERE id = $1",
    [id, reason.slice(0, 500), JSON.stringify(details)]));
  let name: string;
  try {
    const [c] = await asPlatform(async () => d.query<{ db: string }>("SELECT current_database() AS db"));
    name = objectName(String(c?.db ?? ""), area, key, f.name);
  } catch (e) { return void (await fail(`The app's database could not be asked (${said(e)}). Retry`)); }
  const password = randomBytes(24).toString("hex");
  try {
    await asPlatform(() => d.transaction(async (tx) => {
      await asDdlRole(tx);
      /* tenant: admin-only (platform staff): the record's own schema, in the app's own database; no workspace table */
      try { await tx.query(`CREATE SCHEMA ${ident(name)}`); }
      catch (e) { throw Object.assign(new Error(refused(e) ? SCHEMA_REFUSED : `The app's database did not create this record's schema (${said(e)}). Retry`), { refusedSchema: refused(e) }); }
      /* tenant: admin-only (platform staff): nobody but the app (and the record's role below) reaches the schema */
      await tx.query(`REVOKE ALL ON SCHEMA ${ident(name)} FROM PUBLIC`);
      let login = false, roleWords: string | null = null;
      await tx.query("SAVEPOINT record_role");
      try {
        /* tenant: admin-only (platform staff): the record's own login, limited to its schema (no membership, no other rights) */
        await tx.query(`CREATE ROLE ${ident(name)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20`);
        /* tenant: admin-only (platform staff): its schema, and everything made in it */
        await tx.query(`GRANT USAGE, CREATE ON SCHEMA ${ident(name)} TO ${ident(name)}`);
        for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) await tx.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${ident(name)} GRANT ALL ON ${kind} TO ${ident(name)}`);
        /* tenant: admin-only (platform staff): nothing of the app's tables, nor of any other schema (each named) */
        await tx.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ident(name)}`);
        await tx.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${ident(name)}`);
        const others = await tx.query<{ n: string }>(
          "SELECT nspname AS n FROM pg_namespace WHERE nspname <> $1 AND nspname <> 'information_schema' AND nspname NOT LIKE 'pg\\_%' ORDER BY 1", [name]);
        for (const o of others) if (/^[a-z_][a-z0-9_]{0,62}$/.test(o.n)) await tx.query(`REVOKE ALL ON SCHEMA ${ident(o.n)} FROM ${ident(name)}`);
        /* tenant: admin-only (platform staff): it lands in its own schema */
        await tx.query(`ALTER ROLE ${ident(name)} SET search_path = ${ident(name)}`);
        const [cn] = await tx.query<{ ok: boolean }>(`SELECT has_database_privilege('${name}', current_database(), 'CONNECT') AS ok`);
        if (!cn?.ok) await tx.query(`GRANT CONNECT ON DATABASE ${ident(String((await tx.query<{ d: string }>("SELECT current_database() AS d"))[0]?.d))} TO ${ident(name)}`);
        await tx.query("RELEASE SAVEPOINT record_role");
        login = true;
      } catch (e) {
        await tx.query("ROLLBACK TO SAVEPOINT record_role");
        roleWords = said(e);
      }
      await backToApp(tx);
      const c = connectionUrl(name, login ? { role: name, password } : null);
      const details: Details = { schema: name, role: login ? name : null, login, host: c.host, database: c.database,
        note: login ? null : `${SCHEMA_ONLY} (the database refused a login of its own: ${roleWords}).`, refused: login ? null : "role" };
      const sealed = encrypt(c.url);
      const done = await tx.query(
        `UPDATE record_resources SET status = 'ready', reason = NULL, external_id = $2, details = $3, secret_ciphertext = $4, secret_iv = $5, secret_tag = $6,
           secret_key_id = $7, attempts = attempts + 1, ready_at = now(), updated_at = now() WHERE id = $1 AND status = 'provisioning' RETURNING id`,
        [id, name, JSON.stringify(details), sealed.ciphertext, sealed.iv, sealed.tag, sealed.key_id]);
      // The record went (or its row did) while the schema was being made: none of it is kept.
      if (!done.length) throw new Gone();
    }));
  } catch (e) {
    if (e instanceof Gone) return;
    const schema = (e as { refusedSchema?: boolean }).refusedSchema;
    return void (await fail(e instanceof Error ? e.message : "the record's schema could not be made", { schema: name, refused: schema ? "schema" : null }));
  }
}

/** Drop a record database's schema (CASCADE: everything in it) and its role, in the caller's transaction. */
async function dropObjects(tx: Queryable, r: Pick<Row, "external_id" | "details">): Promise<void> {
  const schema = r.external_id ?? r.details?.schema ?? null;
  await asDdlRole(tx);
  /* tenant: admin-only (platform staff): the record's own schema and login, nothing else */
  if (schema && NAME.test(schema)) await tx.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`);
  const role = r.details?.role;
  /* tenant: admin-only (platform staff): the record's own login */
  if (role && NAME.test(role)) await tx.query(`DROP ROLE IF EXISTS ${ident(role)}`);
  await backToApp(tx);
}

/**
 * Staff's Retry of a record's database: a failed one (or one whose attempt was cut short), made again; a record with no
 * row yet (the flag turned on after it was written) gets its first. Whatever an earlier attempt left is dropped first.
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
  if (r.external_id) await asPlatform(async () => (await db()).transaction((tx) => dropObjects(tx, r))).catch(() => null);
  await provision(area, key, f, r.id);
  return (await databasesOf(area, key)).find((d) => d.field === field)!;
}

/**
 * Before a record is deleted (src/record-areas.ts deletePlatform): each of its databases' schema and role dropped, and
 * its rows deleted, in one transaction. One that cannot be dropped refuses the record's delete, nothing done.
 */
export async function releaseDatabases(area: RecordArea, key: string): Promise<void> {
  const rows = (await rowsOf(area, key)).filter((r) => databaseFields(area).some((f) => f.name === r.field) || r.provider === CORE_PROVIDER);
  if (!rows.length) return;
  const label = (r: Row) => area.fields.find((f) => f.name === r.field)?.label ?? r.field;
  const busy = rows.find((r) => r.status === "provisioning" && !stale(r));
  if (busy) throw new PackError(`The ${label(busy)} database of ${key} is still being created: wait a minute, then delete the record`, 409);
  let at: Row | null = null;
  try {
    await asPlatform(async () => (await db()).transaction(async (tx) => {
      for (const r of rows) { at = r; if (r.external_id) await dropObjects(tx, r); }
      await tx.query("DELETE FROM record_resources WHERE id = ANY($1::bigint[])", [rows.map((r) => r.id)]);
    }));
  } catch (e) {
    throw new PackError(`The ${at ? label(at) : "record's"} database of ${key} could not be dropped (${said(e)}): nothing was deleted, the record stays. Try again`, 502);
  }
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
  /** What is not secret about it: its schema, its own role (null: none, the app's login is used), host and database. */
  schema: string | null; role: string | null; login: boolean | null; host: string | null; database: string | null;
  /** In words, when it has no login of its own (SCHEMA_ONLY, and what the database said). */
  note: string | null;
  retry: boolean; updated_at: string | null;
}
async function databasesOf(area: RecordArea, key: string): Promise<DatabaseView[]> {
  const rows = await rowsOf(area, key);
  return databaseFields(area).map((f) => {
    const r = rows.find((x) => x.field === f.name);
    if (!r) return { field: f.name, label: f.label, provider: CORE_PROVIDER, status: "none", reason: "No database was created for this record yet (it was written before databases were on, or its creation never started).", schema: null, role: null, login: null, host: null, database: null, note: null, retry: true, updated_at: null };
    const ready = r.status === "ready";
    return { field: f.name, label: f.label, provider: r.provider, status: r.status, reason: r.reason, schema: ready ? r.external_id : null,
      role: ready ? r.details?.role ?? null : null, login: ready ? r.details?.login === true : null, host: ready ? r.details?.host ?? null : null,
      database: ready ? r.details?.database ?? null : null, note: ready ? r.details?.note ?? null : null,
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
  return {
    repositories: repositoryFields(area).map((f) => ({ field: f.name, label: f.label })),
    databases: databaseFields(area).map((f) => ({ field: f.name, label: f.label, provider: CORE_PROVIDER })),
  };
}

/**
 * Health (src/health-tabs.ts): with an area that declares a database field, whether the app's database refused to
 * create a record's schema (no database made) or its login (schema only), and how many databases failed or are stuck.
 * `text` is null while there is nothing to say; null altogether when no area declares a database field.
 */
export async function resourcesHealth(areas: RecordArea[]): Promise<{ schema_refused: number; role_refused: number; failed: number; stuck: number; text: string | null } | null> {
  const owning = areas.filter((a) => databaseFields(a).length);
  if (!owning.length) return null;
  const [c] = await asPlatform(async () => (await db()).query<{ failed: number; stuck: number; schema_refused: number; role_refused: number }>(
    `SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'provisioning' AND updated_at < now() - make_interval(secs => $1))::int AS stuck,
            count(*) FILTER (WHERE status = 'failed' AND details->>'refused' = 'schema')::int AS schema_refused,
            count(*) FILTER (WHERE status = 'ready' AND details->>'refused' = 'role')::int AS role_refused FROM record_resources`, [STALE_PROVISIONING_MS / 1000]));
  const failed = Number(c?.failed ?? 0), stuck = Number(c?.stuck ?? 0), schemaRefused = Number(c?.schema_refused ?? 0), roleRefused = Number(c?.role_refused ?? 0);
  const n = (k: number, one: string) => `${k} record database${k > 1 ? "s" : ""} ${one}`;
  const words = [
    schemaRefused ? `The app's database refuses to create schemas (CREATE SCHEMA), so ${n(schemaRefused, "could not be made")}: give the app's database login the right to create schemas in its database, then open each record and press Retry.` : null,
    roleRefused ? `The app's database refuses to create logins (CREATE ROLE), so ${n(roleRefused, roleRefused > 1 ? "are schemas only" : "is a schema only")}, with no login of its own: the app's own connection is used inside each schema.` : null,
    failed - schemaRefused + stuck > 0 ? `${n(failed - schemaRefused + stuck, "could not be created")}: open the record and press Retry (its page says why).` : null,
  ].filter(Boolean);
  return { schema_refused: schemaRefused, role_refused: roleRefused, failed, stuck, text: words.length ? words.join(" ") : null };
}
