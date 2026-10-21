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
 * process unless OCTILLION_MIGRATE_ON_BOOT=off, in which case a process with pending migrations refuses to start.
 * Already-current databases cost one SELECT at boot: no DDL, no lock.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, Queryable } from "./db.js";

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sql", "migrations");
const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface Migration { version: number; name: string; checksum: string; sql: string }
export interface AppliedRow { version: number; name: string; checksum: string; applied_at: Date }
export class MigrationError extends Error {}

/** Line endings and a byte-order mark never change a checksum (an editor or a checkout on Windows). */
const checksum = (sql: string) => createHash("sha256").update(sql.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")).digest("hex");

/** Every migration file, in version order. Refuses gaps, duplicates and badly named files. */
export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const out: Migration[] = [];
  for (const f of files) {
    const m = FILE.exec(f);
    if (!m) throw new MigrationError(`sql/migrations/${f}: name it NNNN_lowercase_words.sql`);
    const version = Number(m[1]);
    if (version !== out.length + 1) throw new MigrationError(`sql/migrations/${f}: expected version ${String(out.length + 1).padStart(4, "0")} (no gaps or duplicates)`);
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

export interface MigrationStatus {
  applied: AppliedRow[]; pending: Migration[]; legacy: boolean;
  /** Applied here but not in these files: this release is older than the database (a rollback). */
  newer: AppliedRow[];
  /** Applied, but the file now differs: edited after it was merged, or a different migration under the same number. */
  conflicts: string[];
}

const label = (v: number, name: string) => `${String(v).padStart(4, "0")}_${name}`;

/** Compare the database with the files. Never throws: callers decide what a conflict means (src/migrate.ts below). */
export function compare(rows: AppliedRow[] | null, migrations: Migration[]): MigrationStatus {
  const applied = rows ?? [];
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  const newer: AppliedRow[] = [], conflicts: string[] = [];
  for (const r of applied) {
    const m = byVersion.get(r.version);
    if (!m) newer.push(r);
    else if (m.name !== r.name) conflicts.push(`version ${r.version} is ${label(r.version, r.name)} in the database but ${label(m.version, m.name)} here: the migration history has diverged`);
    else if (m.checksum !== r.checksum) conflicts.push(`sql/migrations/${label(m.version, m.name)}.sql changed after it was applied (checksum ${r.checksum.slice(0, 12)} → ${m.checksum.slice(0, 12)}): never edit a merged migration, add a new one`);
  }
  const done = new Set(applied.map((r) => r.version));
  const pending = migrations.filter((m) => !done.has(m.version));
  if (newer.length && pending.length)
    conflicts.push(`the database has ${newer.map((r) => label(r.version, r.name)).join(", ")} that this release does not, but lacks ${pending.map((m) => label(m.version, m.name)).join(", ")}: the migration history has diverged`);
  return { applied, pending, legacy: rows === null, newer, conflicts };
}

export async function migrationStatus(db: Queryable, dir?: string): Promise<MigrationStatus> {
  return compare(await appliedRows(db), await loadMigrations(dir));
}

/**
 * Apply every pending migration, in order, in one transaction under the migration lock (src/db.ts migrate), and
 * record each. What is applied is re-read after the lock is taken, so a replica that waited finds nothing to do.
 */
export async function runMigrations(db: Db, opts: { dir?: string; log?: (line: string) => void } = {}): Promise<{ applied: string[] }> {
  const migrations = await loadMigrations(opts.dir);
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
    return { applied: pending.map((m) => `${String(m.version).padStart(4, "0")}_${m.name}`) };
  });
}

/**
 * Whether a process applies pending migrations itself on first database use. OCTILLION_MIGRATE_ON_BOOT=on|off; by
 * default on, except on Vercel preview deployments (VERCEL_ENV=preview), which only check: a preview's unmerged
 * migration must never be recorded in a database production also uses.
 */
export const migrateOnBoot = () => {
  const v = (process.env.OCTILLION_MIGRATE_ON_BOOT ?? "").trim().toLowerCase();
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
  const { pending, newer, conflicts } = compare(await appliedRows(db), migrations);
  // A rollback to an older release: migrations are backward compatible (docs/migrations.md), so it runs, and says so.
  if (newer.length) console.error(`database schema is newer than this release (has ${newer.map((r) => label(r.version, r.name)).join(", ")}): running anyway; migrations are backward compatible`);
  if (conflicts.length && pending.length) throw new MigrationError(conflicts.join("; "));
  if (conflicts.length) console.error(`MIGRATION CONFLICT (running anyway, nothing pending): ${conflicts.join("; ")}`);
  if (!pending.length) return;
  if (!migrateOnBoot())
    throw new MigrationError(`the database is ${pending.length} migration(s) behind (${pending.map((m) => m.version).join(", ")}): run \`npm run db:migrate\` (OCTILLION_MIGRATE_ON_BOOT=off)`);
  await runMigrations(db, { log: (l) => console.error(l) });
}
