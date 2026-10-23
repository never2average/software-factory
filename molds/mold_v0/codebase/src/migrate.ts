/**
 * Versioned schema migrations, replacing schema-on-boot (every process used to re-run the whole of sql/schema.sql,
 * taking ALTER TABLE locks on every cold start, with no record of what a database had and no way to make a change that
 * is not idempotent).
 *
 *   sql/migrations/NNNN_name.sql   applied once each, in version order, recorded in schema_migrations with a checksum
 *   0001_baseline.sql              the schema as it stood when migrations were introduced (the old sql/schema.sql,
 *                                  byte for byte). It is idempotent, so a database created by schema-on-boot upgrades
 *                                  by running it once more and recording it; a new database is built by it
 *
 * Rules for new migrations (docs/migrations.md): never edit a file once it is merged (the checksum check refuses to
 * start on a changed file); add the next number instead. Keep changes backward compatible with the code still running
 * during a rolling deploy (add, backfill, then drop in a later release). A file runs in one transaction with the
 * others pending; it must not contain statements that cannot run in a transaction (CREATE INDEX CONCURRENTLY).
 *
 * When: `npm run db:migrate` (deploys run it before starting the new release), and on first database use in each
 * process unless APP_MIGRATE_ON_BOOT=off, in which case a process with pending migrations refuses to start.
 * Already-current databases cost one SELECT at boot: no DDL, no lock.
 *
 * Packs (mold_v0-038): each pack's own migrations (pack.json `migrations`, listed in src/pack-migrations.generated.ts
 * by scripts/gen-packs.mjs) run after the shell's, in pack order, in the same transaction, recorded per pack in
 * pack_schema_migrations under the same rules (numbered from 0001, never edited once applied). Before them the runner
 * (re)defines the two helpers a pack table is secured with, shell_pack_tenant_table and shell_pack_private_table, and
 * after them it refuses to commit while any table named for a pack lacks row-level security. With no pack migrations
 * none of this runs: the database is exactly the shell's.
 *
 * Host packs' own schema (mold_v0-049): the product's tables left the shell's base schema for its host pack, under the
 * names they had (pack.json host.schema.tables, with the functions it defines). Three shell migrations were split for
 * it (SPLIT_MIGRATIONS): a database that applied a split file's earlier version keeps that version's checksum, which
 * is accepted, and has the product's tables with their rows; the host pack's migration that took that part over
 * (host.schema.adopts) is then recorded there as applied without running, so nothing in it touches those rows. On any
 * other database it runs. A host pack's migrations are held to the same rule as every pack's: every table of its own
 * under row-level security, nothing else in the database changed (securitySnapshot), its declared tables and
 * functions counting as its own.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, Queryable } from "./db.js";
import { PACK_MIGRATION_DIRS, type HostSchema } from "./pack-migrations.generated.js";
import { ENV } from "./env-names.js";

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sql", "migrations");
/** The codebase root: pack migration directories are relative to it. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface Migration { version: number; name: string; checksum: string; sql: string }
export interface AppliedRow { version: number; name: string; checksum: string; applied_at: Date }
export class MigrationError extends Error {}

/** Line endings and a byte-order mark never change a checksum (an editor or a checkout on Windows). */
const checksum = (sql: string) => createHash("sha256").update(sql.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")).digest("hex");

/** Every migration file, in version order. Refuses gaps, duplicates and badly named files. */
export async function loadMigrations(dir = MIGRATIONS_DIR, where = "sql/migrations"): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const out: Migration[] = [];
  for (const f of files) {
    const m = FILE.exec(f);
    if (!m) throw new MigrationError(`${where}/${f}: name it NNNN_lowercase_words.sql`);
    const version = Number(m[1]);
    if (version !== out.length + 1) throw new MigrationError(`${where}/${f}: expected version ${String(out.length + 1).padStart(4, "0")} (no gaps or duplicates)`);
    const sql = await readFile(path.join(dir, f), "utf8");
    out.push({ version, name: m[2]!, checksum: checksum(sql), sql });
  }
  if (!out.length) throw new MigrationError(`no migrations in ${dir}`);
  return out;
}

const TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INT PRIMARY KEY,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

/** What the database has applied; null when it has never been migrated (no schema_migrations table). */
async function appliedRows(q: Queryable): Promise<AppliedRow[] | null> {
  const [t] = await q.query<{ t: string | null }>("SELECT to_regclass('schema_migrations')::text AS t");
  if (!t?.t) return null;
  return q.query<AppliedRow>("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version");
}

/**
 * Shell migrations rewritten once, when the product's tables moved to its host pack (mold_v0-049): each file's version
 * before, by checksum. A database that recorded that checksum ran the earlier file, which also created (0001) or
 * secured (0003, 0009) the product's tables; its shell part is exactly today's file, so it counts as applied, and the
 * host pack's migration that adopts it is recorded without running (runMigrations). The only edit of a merged
 * migration there has been; scripts/fixtures/pre-049-migrations/ keeps the earlier files (npm run test:migrations).
 */
export const SPLIT_MIGRATIONS: Readonly<Record<number, { name: string; before: string }>> = {
  1: { name: "baseline", before: "7907175b58dde62fb68b95fede076b9264a146c19d783bc884d8db35e0660662" },
  3: { name: "row_level_security", before: "4b8d22b6c071ec0b46c1d941ba767cbb92b42da5f50bc2ece1b6e6f345d1bbe0" },
  9: { name: "usage_and_limits", before: "cc70747ef6074ec8e9f9a6fde4afd7e30f9a769a8ce20f053c03bf4dc8ea6221" },
};
/** Whether an applied row is a split migration's earlier version (SPLIT_MIGRATIONS). */
const splitBefore = (r: { version: number; name: string; checksum: string }) =>
  SPLIT_MIGRATIONS[r.version]?.name === r.name && SPLIT_MIGRATIONS[r.version]?.before === r.checksum;

export interface MigrationStatus {
  applied: AppliedRow[]; pending: Migration[]; legacy: boolean;
  /** Applied here but not in these files: this release is older than the database (a rollback). */
  newer: AppliedRow[];
  /** Applied, but the file now differs: edited after it was merged, or a different migration under the same number. */
  conflicts: string[];
}

const label = (v: number, name: string) => `${String(v).padStart(4, "0")}_${name}`;

/**
 * Compare the database with the files. Never throws: callers decide what a conflict means (src/migrate.ts below).
 * `split`: the shell's own list, where a split migration's earlier checksum is not a conflict (SPLIT_MIGRATIONS).
 */
export function compare(rows: AppliedRow[] | null, migrations: Migration[], where = "sql/migrations", split = where === "sql/migrations"): MigrationStatus {
  const applied = rows ?? [];
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  const newer: AppliedRow[] = [], conflicts: string[] = [];
  for (const r of applied) {
    const m = byVersion.get(r.version);
    if (!m) newer.push(r);
    else if (m.name !== r.name) conflicts.push(`version ${r.version} is ${label(r.version, r.name)} in the database but ${label(m.version, m.name)} here: the migration history has diverged`);
    else if (m.checksum !== r.checksum && !(split && splitBefore(r))) conflicts.push(`${where}/${label(m.version, m.name)}.sql changed after it was applied (checksum ${r.checksum.slice(0, 12)} → ${m.checksum.slice(0, 12)}): never edit a merged migration, add a new one`);
  }
  const done = new Set(applied.map((r) => r.version));
  const pending = migrations.filter((m) => !done.has(m.version));
  if (newer.length && pending.length)
    conflicts.push(`the database has ${newer.map((r) => label(r.version, r.name)).join(", ")} that this release does not, but lacks ${pending.map((m) => label(m.version, m.name)).join(", ")}: the migration history has diverged`);
  return { applied, pending, legacy: rows === null, newer, conflicts };
}

// ---------- packs ----------

export interface PackMigrationSet { pack: string; dir: string; migrations: Migration[]; schema?: HostSchema }
export interface PackStatus { pack: string; applied: AppliedRow[]; pending: Migration[]; newer: AppliedRow[]; conflicts: string[] }

/** The tables the shell's own migrations create: no pack's `<id>_` prefix may cover one (scripts/gen-packs.mjs checks it too). */
const shellTables = (migrations: Migration[]) => new Set(["schema_migrations", "pack_schema_migrations",
  ...migrations.flatMap((m) => [...m.sql.matchAll(/CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)/gi)].map((x) => x[1]!.toLowerCase()))]);
/** The functions the shell's own migrations define (and the pack helpers below): never a host pack's. */
const shellFunctions = (migrations: Migration[]) => new Set(["shell_pack_tenant_table", "shell_pack_private_table",
  ...migrations.flatMap((m) => [...m.sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-z_][a-z0-9_]*)/gi)].map((x) => x[1]!.toLowerCase()))]);
const IDENT = /^[a-z][a-z0-9_]{1,62}$/;
function refuseShellPrefixes(migrations: Migration[], sets: PackMigrationSet[]) {
  const shell = [...shellTables(migrations)];
  const fns = shellFunctions(migrations);
  const owner = new Map<string, string>();
  for (const s of sets) {
    const clash = shell.filter((t) => t.startsWith(`${s.pack}_`));
    if (clash.length) throw new MigrationError(`pack ${s.pack}: its table prefix ${s.pack}_ is taken by the shell's ${clash.join(", ")}`);
    // A host pack's own schema (mold_v0-049): never a shell table or function, another pack's, or a name in a pack prefix.
    for (const t of s.schema?.tables ?? []) {
      if (!IDENT.test(t)) throw new MigrationError(`pack ${s.pack}: host table ${JSON.stringify(t)} is not a table name`);
      if (shell.includes(t)) throw new MigrationError(`pack ${s.pack}: ${t} is a shell table`);
      const other = sets.find((o) => t.startsWith(`${o.pack}_`) && o.pack !== s.pack);
      if (other) throw new MigrationError(`pack ${s.pack}: ${t} is named with pack ${other.pack}'s prefix`);
      if (owner.has(t)) throw new MigrationError(`pack ${s.pack}: ${t} is also pack ${owner.get(t)}'s`);
      owner.set(t, s.pack);
    }
    for (const [col, t] of Object.entries(s.schema?.references ?? {}))
      if (!s.schema!.tables.includes(t) || !shell.includes(col.split(".")[0]!)) throw new MigrationError(`pack ${s.pack}: reference ${col} -> ${t} is not from a shell table to one of its tables`);
    for (const t of s.schema?.platform_read ?? [])
      if (!s.schema!.tables.includes(t)) throw new MigrationError(`pack ${s.pack}: platform library ${t} is not one of its tables`);
    for (const f of s.schema?.functions ?? [])
      if (!IDENT.test(f) || fns.has(f)) throw new MigrationError(`pack ${s.pack}: function ${f} is ${fns.has(f) ? "the shell's" : "not a function name"}`);
    for (const [mine, theirs] of Object.entries(s.schema?.adopts ?? {})) {
      const v = Number(theirs.slice(0, 4)), sp = SPLIT_MIGRATIONS[v];
      if (!sp || theirs !== label(v, sp.name)) throw new MigrationError(`pack ${s.pack}: ${mine} adopts ${theirs}, which is not a split shell migration (SPLIT_MIGRATIONS)`);
      if (!s.migrations.some((m) => label(m.version, m.name) === mine)) throw new MigrationError(`pack ${s.pack}: adopts names ${mine}, which is not one of its migrations`);
    }
  }
}

/** Each pack's migrations, in pack order (the generated list by default; a test passes its own). */
export async function loadPackMigrations(dirs: readonly { pack: string; dir: string; schema?: HostSchema }[] = PACK_MIGRATION_DIRS, root = ROOT): Promise<PackMigrationSet[]> {
  const out: PackMigrationSet[] = [];
  for (const d of dirs) {
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(d.pack)) throw new MigrationError(`pack id ${JSON.stringify(d.pack)} is not a pack id`);
    out.push({ pack: d.pack, dir: d.dir, migrations: await loadMigrations(path.resolve(root, d.dir), d.dir), ...(d.schema ? { schema: d.schema } : {}) });
  }
  return out;
}

const PACK_TABLE = `CREATE TABLE IF NOT EXISTS pack_schema_migrations (
  pack        TEXT NOT NULL,
  version     INT NOT NULL,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pack, version)
)`;

/**
 * The only ways a pack table gets row-level security (pack migrations may not write policies or grants themselves;
 * scripts/gen-packs.mjs refuses them). The same rules 0003_row_level_security gives the shell's own tenant tables.
 *   shell_pack_tenant_table(t)   a workspace table: org_id NOT NULL; the tenant role reads and writes only rows of the
 *                                workspace it acts for, sees nothing with no workspace set; a single-column reference to
 *                                a table under row-level security must name a row the tenant can see; nextval only
 *   shell_pack_private_table(t)  row-level security on and no tenant access at all (platform work only)
 */
const PACK_HELPERS = `
CREATE OR REPLACE FUNCTION shell_pack_tenant_table(t regclass) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  r TEXT := octillion_tenant_role();
  fk RECORD;
  seq RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = t AND attname = 'org_id' AND attnotnull AND NOT attisdropped) THEN
    RAISE EXCEPTION '%: a workspace table needs org_id NOT NULL', t;
  END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS pack_tenant_isolation ON %s', t);
  EXECUTE format('CREATE POLICY pack_tenant_isolation ON %s TO %I USING (org_id = octillion_tenant_org()) WITH CHECK (org_id = octillion_tenant_org())', t, r);
  EXECUTE format('REVOKE ALL ON %s FROM %I', t, r);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO %I', t, r);
  FOR fk IN
    SELECT a.attname AS col, c.confrelid::regclass::text AS parent, pa.attname AS pcol
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
      JOIN pg_class pc ON pc.oid = c.confrelid
     WHERE c.conrelid = t AND c.contype = 'f' AND cardinality(c.conkey) = 1 AND pc.relrowsecurity
       AND c.confrelid <> 'organizations'::regclass
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', 'ref_' || fk.col, t);
    EXECUTE format('CREATE POLICY %I ON %s AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (%I IS NULL OR EXISTS (SELECT 1 FROM %s p WHERE p.%I = %I))',
                   'ref_' || fk.col, t, r, fk.col, fk.parent, fk.pcol, fk.col);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', 'ref_upd_' || fk.col, t);
    EXECUTE format('CREATE POLICY %I ON %s AS RESTRICTIVE FOR UPDATE TO %I USING (true) WITH CHECK (%I IS NULL OR EXISTS (SELECT 1 FROM %s p WHERE p.%I = %I))',
                   'ref_upd_' || fk.col, t, r, fk.col, fk.parent, fk.pcol, fk.col);
  END LOOP;
  FOR seq IN
    SELECT s.oid::regclass::text AS seq
      FROM pg_class s JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
     WHERE s.relkind = 'S' AND d.refobjid = t
  LOOP
    EXECUTE format('GRANT USAGE ON SEQUENCE %s TO %I', seq.seq, r);
  END LOOP;
END $fn$;
CREATE OR REPLACE FUNCTION shell_pack_private_table(t regclass) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON %s FROM %I', t, octillion_tenant_role());
END $fn$;
REVOKE ALL ON FUNCTION shell_pack_tenant_table(regclass) FROM PUBLIC;
REVOKE ALL ON FUNCTION shell_pack_private_table(regclass) FROM PUBLIC;
`;

/** What the database has applied for packs; null when no pack migration ever ran here. */
async function appliedPackRows(q: Queryable): Promise<Map<string, AppliedRow[]> | null> {
  const [t] = await q.query<{ t: string | null }>("SELECT to_regclass('pack_schema_migrations')::text AS t");
  if (!t?.t) return null;
  const rows = await q.query<AppliedRow & { pack: string }>("SELECT pack, version, name, checksum, applied_at FROM pack_schema_migrations ORDER BY pack, version");
  const by = new Map<string, AppliedRow[]>();
  for (const { pack, ...r } of rows) by.set(pack, [...(by.get(pack) ?? []), r]);
  return by;
}

function comparePacks(rows: Map<string, AppliedRow[]> | null, sets: PackMigrationSet[]): PackStatus[] {
  return sets.map((s) => {
    const c = compare(rows?.get(s.pack) ?? [], s.migrations, s.dir);
    return { pack: s.pack, applied: c.applied, pending: c.pending, newer: c.newer, conflicts: c.conflicts.map((x) => `pack ${s.pack}: ${x}`) };
  });
}

/** Tables named for a pack (its `<id>_` prefix), or a host pack's declared ones, without row-level security: none may be committed. */
async function unsecuredPackTables(q: Queryable, packIds: string[], hostTables: string[] = []): Promise<string[]> {
  if (!packIds.length) return [];
  const rows = await q.query<{ relname: string }>(
    `SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND NOT relrowsecurity
        AND (relname LIKE ANY ($1::text[]) OR relname = ANY ($2::text[])) ORDER BY 1`, [packIds.map((p) => `${p.replace(/_/g, "\\_")}\\_%`), hostTables]);
  return rows.map((r) => r.relname);
}

export async function migrationStatus(db: Queryable, dir?: string, packDirs?: readonly { pack: string; dir: string; schema?: HostSchema }[]): Promise<MigrationStatus & { packs: PackStatus[] }> {
  const shell = compare(await appliedRows(db), await loadMigrations(dir));
  const sets = await loadPackMigrations(packDirs);
  return { ...shell, packs: sets.length ? comparePacks(await appliedPackRows(db), sets) : [] };
}

/**
 * What a pack migration must never change: every policy, grant, row-level security switch, function, trigger, rule and
 * role outside the packs' own tables. Taken before and after the packs' migrations, inside the same transaction: any
 * difference (a policy on a shell table, a new function or view, a grant, a role) refuses the whole migration, whatever
 * the build-time checks (scripts/gen-packs.mjs) let through.
 */
async function securitySnapshot(q: Queryable, packIds: string[], host: { tables: string[]; functions: string[]; references?: Record<string, string> } = { tables: [], functions: [] }): Promise<Map<string, string>> {
  // A host pack's declared tables (mold_v0-049) are its own, with their indexes and the sequences they own.
  const hostRels = new Set(host.tables.length ? (await q.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND (c.relname = ANY ($1::text[])
        OR EXISTS (SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid WHERE i.indexrelid = c.oid AND t.relnamespace = 'public'::regnamespace AND t.relname = ANY ($1::text[]))
        OR (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass
              AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i') AND t.relnamespace = 'public'::regnamespace AND t.relname = ANY ($1::text[]))))`, [host.tables])).map((r) => r.relname) : []);
  const hostTable = new Set(host.tables);
  const own = (name: string) => packIds.some((p) => name.startsWith(`${p}_`)) || hostRels.has(name);
  const out = new Map<string, string>();
  const put = (k: string, v: unknown) => out.set(k, JSON.stringify(v));
  for (const r of await q.query<{ relname: string; relkind: string; relacl: string | null; rls: boolean; force: boolean }>(
    "SELECT relname, relkind::text AS relkind, relacl::text AS relacl, relrowsecurity AS rls, relforcerowsecurity AS force, relhassubclass AS sub, relispartition AS part FROM pg_class WHERE relnamespace = 'public'::regnamespace"))
    if (!own(r.relname)) put(`relation ${r.relname}`, r);
  for (const r of await q.query<{ tablename: string; policyname: string }>(
    "SELECT tablename, policyname, permissive, roles::text AS roles, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public'")) {
    // A host pack's declared table carries the product's own policies (mold_v0-049): check:rls probes them.
    if (hostTable.has(r.tablename)) continue;
    if (own(r.tablename)) {
      // On a pack's own table only the shell's helper writes policies, under its names.
      if (!/^(pack_tenant_isolation|ref_upd_[a-z0-9_]+|ref_[a-z0-9_]+)$/.test(r.policyname)) put(`foreign policy ${r.policyname} on ${r.tablename}`, r);
    } else put(`policy ${r.policyname} on ${r.tablename}`, r);
  }
  for (const r of await q.query<{ f: string; name: string; secdef: boolean }>(
    "SELECT p.oid::regprocedure::text AS f, p.proname AS name, md5(pg_get_functiondef(p.oid)) AS def, p.proacl::text AS acl, p.prosecdef AS secdef FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')"))
    // A host pack's declared functions (mold_v0-049), never SECURITY DEFINER (gen-packs refuses it; checked here too).
    if (!(host.functions.includes(r.name) && !r.secdef)) put(`function ${r.f}`, r);
  // The columns and constraints of every table that is not the packs' own: a host pack may add a reference it declares
  // (host.schema.references: a shell table's column to one of its tables, without cascading onto the shell's rows
  // beyond what the declaration names; mold_v0-049), and change nothing else of them.
  for (const r of await q.query<{ t: string; a: string }>(
    `SELECT c.relname AS t, a.attname AS a, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`))
    if (!own(r.t)) put(`column ${r.t}.${r.a}`, r);
  for (const r of await q.query<{ t: string; conname: string; contype: string; parent: string | null; col: string | null }>(
    `SELECT c.conrelid::regclass::text AS t, c.conname, c.contype::text AS contype, p.relname AS parent, pg_get_constraintdef(c.oid) AS def,
            CASE WHEN cardinality(c.conkey) = 1 THEN (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) END AS col
       FROM pg_constraint c LEFT JOIN pg_class p ON p.oid = c.confrelid WHERE c.connamespace = 'public'::regnamespace AND c.conrelid <> 0`))
    if (!own(r.t) && !(r.contype === "f" && r.parent !== null && r.col !== null && host.references?.[`${r.t}.${r.col}`] === r.parent)) put(`constraint ${r.conname} on ${r.t}`, r);
  for (const r of await q.query<{ t: string; tgname: string }>(
    "SELECT tgrelid::regclass::text AS t, tgname, tgenabled::text AS enabled FROM pg_trigger WHERE NOT tgisinternal"))
    put(`trigger ${r.tgname} on ${r.t}`, r);
  for (const r of await q.query<{ tablename: string; rulename: string }>("SELECT tablename, rulename, definition FROM pg_rules WHERE schemaname = 'public'"))
    put(`rule ${r.rulename} on ${r.tablename}`, r);
  for (const r of await q.query<{ rolname: string }>("SELECT rolname, rolsuper, rolbypassrls, rolinherit, rolcanlogin FROM pg_roles"))
    put(`role ${r.rolname}`, r);
  for (const r of await q.query<{ k: string }>("SELECT roleid::regrole::text || ' > ' || member::regrole::text AS k FROM pg_auth_members"))
    put(`membership ${r.k}`, r);
  for (const r of await q.query<{ k: string }>("SELECT defaclrole::regrole::text || ' ' || defaclobjtype::text AS k, defaclacl::text AS acl FROM pg_default_acl"))
    put(`default privileges ${r.k}`, r);
  for (const r of await q.query<{ t: string; a: string }>(
    "SELECT c.relname AS t, a.attname AS a, a.attacl::text AS acl FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'public'::regnamespace AND a.attacl IS NOT NULL"))
    if (!own(r.t)) put(`column privileges ${r.t}.${r.a}`, r);
  // Inheritance and partitions: a pack table attached under a shell table would mix its rows into the shell's reads.
  for (const r of await q.query<{ child: string; parent: string }>("SELECT inhrelid::regclass::text AS child, inhparent::regclass::text AS parent FROM pg_inherits"))
    put(`inheritance ${r.child} -> ${r.parent}`, r);
  for (const r of await q.query<{ evtname: string }>("SELECT evtname, evtevent, evtenabled::text AS enabled FROM pg_event_trigger"))
    put(`event trigger ${r.evtname}`, r);
  for (const r of await q.query<{ pubname: string }>("SELECT pubname, puballtables FROM pg_publication")) put(`publication ${r.pubname}`, r);
  for (const r of await q.query<{ nspname: string }>("SELECT nspname, nspacl::text AS acl FROM pg_namespace")) put(`schema ${r.nspname}`, r);
  return out;
}

const changedSecurity = (before: Map<string, string>, after: Map<string, string>) =>
  [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k)).sort();

const plabel = (pack: string, m: Migration) => `pack ${pack} ${String(m.version).padStart(4, "0")}_${m.name}`;

/**
 * Apply every pending migration, in order, in one transaction under the migration lock (src/db.ts migrate), and
 * record each: the shell's first, then each pack's. What is applied is re-read after the lock is taken, so a replica
 * that waited finds nothing to do.
 */
export async function runMigrations(db: Db, opts: { dir?: string; packDirs?: readonly { pack: string; dir: string; schema?: HostSchema }[]; log?: (line: string) => void } = {}): Promise<{ applied: string[] }> {
  const migrations = await loadMigrations(opts.dir);
  const sets = await loadPackMigrations(opts.packDirs);
  refuseShellPrefixes(migrations, sets);
  return db.migrate(async (tx) => {
    await tx.exec(TABLE);
    const { pending, conflicts } = compare(await appliedRows(tx), migrations);
    if (conflicts.length) throw new MigrationError(conflicts.join("; "));
    for (const m of pending) {
      const t0 = Date.now();
      await tx.exec(m.sql);
      await tx.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [m.version, m.name, m.checksum]);
      opts.log?.(`migration ${String(m.version).padStart(4, "0")}_${m.name} applied (${Date.now() - t0} ms)`);
    }
    const applied = pending.map((m) => `${String(m.version).padStart(4, "0")}_${m.name}`);
    if (!sets.length) return { applied };
    // Packs, after the shell: only when this build has pack migrations (with none, nothing below touches the database).
    const status = comparePacks(await appliedPackRows(tx), sets);
    const packConflicts = status.flatMap((s) => s.conflicts);
    if (packConflicts.length) throw new MigrationError(packConflicts.join("; "));
    if (!status.some((s) => s.pending.length)) return { applied };
    await tx.exec(PACK_TABLE);
    await tx.exec(PACK_HELPERS);
    const packIds = sets.map((s) => s.pack);
    const host = { tables: sets.flatMap((s) => [...(s.schema?.tables ?? [])]), functions: sets.flatMap((s) => [...(s.schema?.functions ?? [])]),
      references: Object.assign({}, ...sets.map((s) => s.schema?.references ?? {})) as Record<string, string> };
    const before = await securitySnapshot(tx, packIds, host);
    // The shell's split migrations this database ran in their earlier version (mold_v0-049): a host pack's migration
    // that adopts one is already here, rows and all, and is recorded without running.
    const ranBefore = new Set((await appliedRows(tx) ?? []).filter(splitBefore).map((r) => label(r.version, r.name)));
    for (const s of status) {
      for (const m of s.pending) {
        const t0 = Date.now();
        const adopted = sets.find((x) => x.pack === s.pack)?.schema?.adopts?.[label(m.version, m.name)];
        if (adopted && ranBefore.has(adopted)) {
          await tx.query("INSERT INTO pack_schema_migrations (pack, version, name, checksum) VALUES ($1, $2, $3, $4)", [s.pack, m.version, m.name, m.checksum]);
          opts.log?.(`migration ${plabel(s.pack, m)} adopted: this database ran ${adopted} before it was split (nothing run)`);
          applied.push(`${plabel(s.pack, m)} (adopted)`);
          continue;
        }
        await tx.exec(m.sql);
        await tx.query("INSERT INTO pack_schema_migrations (pack, version, name, checksum) VALUES ($1, $2, $3, $4)", [s.pack, m.version, m.name, m.checksum]);
        opts.log?.(`migration ${plabel(s.pack, m)} applied (${Date.now() - t0} ms)`);
        applied.push(plabel(s.pack, m));
      }
    }
    // Once every pack table exists: secure each workspace table again, so a reference to a table secured after it
    // (another pack's, or a later migration's) gets its check too. Idempotent.
    for (const { t } of await tx.query<{ t: string }>("SELECT DISTINCT tablename AS t FROM pg_policies WHERE schemaname = 'public' AND policyname = 'pack_tenant_isolation' ORDER BY 1"))
      await tx.query("SELECT shell_pack_tenant_table($1::regclass)", [t]);
    const changed = changedSecurity(before, await securitySnapshot(tx, packIds, host));
    if (changed.length) throw new MigrationError(`pack migrations may change only their own tables: refused, they changed ${changed.slice(0, 10).join("; ")}${changed.length > 10 ? ` and ${changed.length - 10} more` : ""}`);
    const missing = (await tx.query<{ t: string }>("SELECT t FROM unnest($1::text[]) t WHERE to_regclass('public.' || quote_ident(t)) IS NULL ORDER BY 1", [host.tables])).map((r) => r.t);
    if (missing.length) throw new MigrationError(`host pack table(s) its migrations do not create: ${missing.join(", ")} (pack.json host.schema.tables)`);
    // A host pack's platform libraries (host.schema.platform_read) stay as they were in the shell: readable by every
    // workspace, no row-level security; each must carry no org_id and the tenant role may only read it.
    const platformRead = sets.flatMap((s) => [...(s.schema?.platform_read ?? [])]);
    for (const r of platformRead.length ? await tx.query<{ t: string; org: boolean; writes: boolean }>(
      `SELECT t, EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || quote_ident(t)) AND a.attname = 'org_id' AND NOT a.attisdropped) AS org,
              has_table_privilege(octillion_tenant_role(), to_regclass('public.' || quote_ident(t)), 'INSERT')
                OR has_table_privilege(octillion_tenant_role(), to_regclass('public.' || quote_ident(t)), 'UPDATE')
                OR has_table_privilege(octillion_tenant_role(), to_regclass('public.' || quote_ident(t)), 'DELETE')
                OR has_any_column_privilege(octillion_tenant_role(), to_regclass('public.' || quote_ident(t)), 'INSERT')
                OR has_any_column_privilege(octillion_tenant_role(), to_regclass('public.' || quote_ident(t)), 'UPDATE') AS writes
         FROM unnest($1::text[]) t`, [platformRead]) : [])
      if (r.org || r.writes) throw new MigrationError(`host pack platform library ${r.t} ${r.org ? "has an org_id (a workspace table needs row-level security)" : "is writable by tenant work"} (host.schema.platform_read)`);
    const open = (await unsecuredPackTables(tx, packIds, host.tables)).filter((t) => !platformRead.includes(t));
    if (open.length) throw new MigrationError(`pack table(s) without row-level security: ${open.join(", ")} (secure each with shell_pack_tenant_table or shell_pack_private_table in its migration${host.tables.length ? ", or a host pack's own policies" : ""})`);
    return { applied };
  });
}

/**
 * Whether a process applies pending migrations itself on first database use. APP_MIGRATE_ON_BOOT=on|off; by
 * default on, except on Vercel preview deployments (VERCEL_ENV=preview), which only check: a preview's unmerged
 * migration must never be recorded in a database production also uses.
 */
export const migrateOnBoot = () => {
  const v = (ENV.APP_MIGRATE_ON_BOOT ?? "").trim().toLowerCase();
  if (v) return v !== "off";
  return process.env.VERCEL_ENV !== "preview";
};

/**
 * At first database use: nothing to do when current (two catalog reads, no DDL, no lock); else migrate, or refuse
 * when migrating on boot is off. A conflict (an edited migration, a diverged history) with nothing pending is logged,
 * not fatal: the schema this release needs is there, and `npm run db:migrate` refuses until it is sorted out.
 */
export async function ensureMigrated(db: Db): Promise<void> {
  const migrations = await loadMigrations();
  const shell = compare(await appliedRows(db), migrations);
  const sets = await loadPackMigrations();
  const packStatus = sets.length ? comparePacks(await appliedPackRows(db), sets) : [];
  const pending = [...shell.pending, ...packStatus.flatMap((s) => s.pending)];
  const newer = [...shell.newer, ...packStatus.flatMap((s) => s.newer)];
  const conflicts = [...shell.conflicts, ...packStatus.flatMap((s) => s.conflicts)];
  // A rollback to an older release: migrations are backward compatible (docs/migrations.md), so it runs, and says so.
  if (newer.length) console.error(`database schema is newer than this release (has ${newer.map((r) => label(r.version, r.name)).join(", ")}): running anyway; migrations are backward compatible`);
  if (conflicts.length && pending.length) throw new MigrationError(conflicts.join("; "));
  if (conflicts.length) console.error(`MIGRATION CONFLICT (running anyway, nothing pending): ${conflicts.join("; ")}`);
  if (!pending.length) return;
  if (!migrateOnBoot())
    throw new MigrationError(`the database is ${pending.length} migration(s) behind (${pending.map((m) => m.version).join(", ")}): run \`npm run db:migrate\` (APP_MIGRATE_ON_BOOT=off)`);
  await runMigrations(db, { log: (l) => console.error(l) });
}
