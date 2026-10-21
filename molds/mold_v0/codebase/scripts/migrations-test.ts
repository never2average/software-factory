// Versioned migrations (src/migrate.ts): proves that a database built the old way (schema-on-boot: the whole schema
// re-run by every process) upgrades cleanly, and that the runner applies each migration once, in order, and refuses
// edited, missing or out-of-order files.
//   npm run test:migrations                                  embedded Postgres (PGlite), temporary directories
//   MIGRATIONS_PG_URL=postgres://u:p@host/db npm run test:migrations   also on a real Postgres (creates and drops
//                                                            its own databases there; never touches the one named)
//   MIGRATIONS_FROM_REFS="<git ref> ..."                     upgrade from sql/schema.sql as it was at those commits, each
//                                                            alone and all of them in order on one database (as a live
//                                                            database went through them); by default a spread of the
//                                                            file's history when git has it ("none" to skip)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db.js";
import { ensureMigrated, loadMigrations, MIGRATIONS_DIR, MigrationError, migrationStatus, runMigrations } from "../src/migrate.js";

const tmp = mkdtempSync(path.join(tmpdir(), "octillion-migrations-"));
const baseline = readFileSync(path.join(MIGRATIONS_DIR, "0001_baseline.sql"), "utf8");
const pgUrl = process.env.MIGRATIONS_PG_URL;
/** Older schema versions to upgrade from: MIGRATIONS_FROM_REFS, else up to 8 commits spread over the file's history. */
const REFS = (() => {
  const env = process.env.MIGRATIONS_FROM_REFS?.trim();
  if (env === "none") return [];
  if (env) return env.split(/\s+/);
  try {
    const all = execFileSync("git", ["log", "--format=%h", "--diff-filter=AM", "--", "sql/schema.sql"], { encoding: "utf8" }).split("\n").filter(Boolean).reverse();
    if (all.length < 2) return [];
    const pick = new Set([0, ...Array.from({ length: 6 }, (_, i) => Math.round(((i + 1) * (all.length - 1)) / 7)), all.length - 1].map((i) => all[i]!));
    return [...pick];
  } catch { return []; }
})();
let n = 0;

/** A new, empty database: a PGlite directory, or a fresh database on the real Postgres. */
async function fresh(kind: "pglite" | "postgres"): Promise<Db & { drop: () => Promise<void> }> {
  const id = `octillion_mig_${process.pid}_${++n}`;
  if (kind === "pglite") {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DIR = path.join(tmp, id);
    const db = await openDb();
    return Object.assign(db, { drop: async () => { await db.close(); rmSync(process.env.PGLITE_DIR!, { recursive: true, force: true }); } });
  }
  const admin = new URL(pgUrl!);
  process.env.DATABASE_URL = admin.toString();
  const root = await openDb();
  await root.exec(`CREATE DATABASE ${id}`);
  const url = new URL(pgUrl!); url.pathname = `/${id}`;
  process.env.DATABASE_URL = url.toString();
  const db = await openDb();
  return Object.assign(db, { drop: async () => { await db.close(); await root.exec(`DROP DATABASE ${id} WITH (FORCE)`); await root.close(); } });
}

/** Everything the schema defines: tables and columns (type, null, default), constraints, indexes, functions, policies. */
async function catalog(db: Db) {
  // The tenant role is named per database (0003_row_level_security): compare it by kind, not by name.
  const q = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).map((r) => JSON.stringify(r).replace(/octillion_tenant_[0-9a-f]{10}/g, "octillion_tenant_<db>"));
  return {
    columns: await q(`SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns
                      WHERE table_schema = 'public' ORDER BY table_name, column_name`),
    constraints: await q(`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
                          WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`),
    indexes: await q(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`),
    functions: await q(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(pg_get_functiondef(p.oid)) AS def FROM pg_proc p
                        WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' ORDER BY 1, 2`),
    policies: await q(`SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2`),
    rls: await q(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1`),
  };
}
const sameCatalog = (a: Awaited<ReturnType<typeof catalog>>, b: Awaited<ReturnType<typeof catalog>>, what: string) => {
  for (const k of Object.keys(a) as (keyof typeof a)[]) {
    const onlyA = a[k].filter((x) => !b[k].includes(x)), onlyB = b[k].filter((x) => !a[k].includes(x));
    assert.ok(!onlyA.length && !onlyB.length, `${what}: ${k} differ\n  upgraded only: ${onlyA.slice(0, 5).join("\n    ")}\n  fresh only: ${onlyB.slice(0, 5).join("\n    ")}`);
  }
};

/** What the old boot did: the whole schema file, under the lock, in one transaction (src/db.ts before migrations). */
const oldBoot = (db: Db, sql: string) => db.migrate((tx) => tx.exec(sql));

/** Rows a live database has: accounts, keys, products. Returns a fingerprint to compare after the upgrade. */
async function seed(db: Db) {
  const [o] = await db.query<{ id: number }>("INSERT INTO organizations (slug, name) VALUES ('mig-acme', 'Acme') RETURNING id");
  await db.query("INSERT INTO api_keys (org_id, label, key_prefix, key_hash) VALUES ($1, 'default', 'oct_abcdef', 'hash-1')", [o!.id]);
  await db.query("INSERT INTO products (org_id, slug, name, packages) VALUES ($1, 'acmeq', 'Acme Queue', '{acmeq}')", [o!.id]);
  return fingerprint(db);
}
const fingerprint = async (db: Db) => JSON.stringify(await db.query(
  `SELECT o.id, o.slug, o.name, k.key_prefix, k.key_hash, p.slug AS product, p.packages FROM organizations o
     JOIN api_keys k ON k.org_id = o.id JOIN products p ON p.org_id = o.id WHERE o.slug = 'mig-acme'`));

async function suite(kind: "pglite" | "postgres") {
  const ref = await fresh(kind);
  const r1 = await runMigrations(ref);
  assert.deepEqual(r1.applied, (await loadMigrations()).map((m) => `${String(m.version).padStart(4, "0")}_${m.name}`), "a new database gets every migration");
  assert.deepEqual((await runMigrations(ref)).applied, [], "a second run applies nothing");
  const want = await catalog(ref);
  assert.ok(want.columns.length > 100, "the reference schema is the real one");

  // A database built by schema-on-boot at this release (booted twice, as every deploy did), with rows in it.
  {
    const old = await fresh(kind);
    await oldBoot(old, baseline);
    const rows = await seed(old);
    await oldBoot(old, baseline);
    assert.equal((await migrationStatus(old)).legacy, true, "the old way leaves no schema_migrations table");
    const applied = await runMigrations(old);
    assert.deepEqual(applied.applied.slice(0, 1), ["0001_baseline"], "the baseline is recorded on the old database");
    sameCatalog(await catalog(old), want, `${kind}: schema-on-boot database after migrating`);
    assert.equal(await fingerprint(old), rows, "its rows are intact");
    const st = await migrationStatus(old);
    assert.ok(!st.pending.length && !st.legacy, "and nothing is pending");
    assert.deepEqual((await runMigrations(old)).applied, [], "migrating again applies nothing");
    await old.drop();
  }

  // Databases from older releases: sql/schema.sql as it was at those commits, each alone, then all in order on one
  // database (every deploy re-ran the file of its release, so a live database went through each of them).
  const schemaAt = (r: string) => execFileSync("git", ["show", `${r}:sql/schema.sql`], { encoding: "utf8", maxBuffer: 1 << 26 });
  for (const gitRef of REFS) {
    const old = await fresh(kind);
    await oldBoot(old, schemaAt(gitRef));
    const rows = await seed(old);
    await runMigrations(old);
    sameCatalog(await catalog(old), want, `${kind}: database from ${gitRef} after migrating`);
    assert.equal(await fingerprint(old), rows, `${gitRef}: rows intact`);
    await old.drop();
    console.log(`  ✓ ${kind}: upgrade from ${gitRef}`);
  }
  if (REFS.length > 1) {
    const old = await fresh(kind);
    let rows = "";
    for (const [i, gitRef] of REFS.entries()) { await oldBoot(old, schemaAt(gitRef)); if (!i) rows = await seed(old); }
    await oldBoot(old, baseline);
    await runMigrations(old);
    sameCatalog(await catalog(old), want, `${kind}: database booted through ${REFS.length} releases in order`);
    assert.equal(await fingerprint(old), rows, "chained: rows intact");
    await old.drop();
    console.log(`  ✓ ${kind}: upgrade through ${REFS.join(" → ")} → baseline → migrations`);
  }

  // The runner: a new migration applies once; an edited one, a gap or a database newer than the code is refused.
  {
    const dir = path.join(tmp, `dir-${kind}`);
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const next = String((await loadMigrations()).length + 1).padStart(4, "0");
    writeFileSync(path.join(dir, `${next}_probe.sql`), "ALTER TABLE organizations ADD COLUMN migration_probe TEXT;\nUPDATE organizations SET migration_probe = 'once';\n");
    assert.deepEqual((await runMigrations(ref, { dir })).applied, [`${next}_probe`], "only the new migration runs");
    assert.deepEqual((await runMigrations(ref, { dir })).applied, [], "once");
    const older = await migrationStatus(ref);
    assert.ok(older.newer.length === 1 && !older.pending.length, "code older than the database (a rollback) sees the newer migration, nothing pending");
    await ensureMigrated(ref); // and boots
    // An edited migration with nothing pending: boot logs it and runs (the schema it needs is there); db:migrate refuses.
    const edited = path.join(tmp, `edited-${kind}`);
    cpSync(MIGRATIONS_DIR, edited, { recursive: true });
    appendFileSync(path.join(edited, "0001_baseline.sql"), "\n-- edited\n");
    assert.equal((await migrationStatus(ref, edited)).conflicts.length, 1, "the edit is reported as a conflict");
    const diverged = path.join(tmp, `diverged-${kind}`);
    cpSync(MIGRATIONS_DIR, diverged, { recursive: true });
    writeFileSync(path.join(diverged, `${next}_other.sql`), "SELECT 1;\n");
    writeFileSync(path.join(diverged, `${String(Number(next) + 1).padStart(4, "0")}_more.sql`), "SELECT 1;\n");
    await assert.rejects(runMigrations(ref, { dir: diverged }), /changed after it was applied|diverged/, "a different history under the same number is refused");
    appendFileSync(path.join(dir, "0001_baseline.sql"), "\n-- edited\n");
    await assert.rejects(runMigrations(ref, { dir }), (e) => e instanceof MigrationError && /changed after it was applied/.test(e.message), "an edited migration is refused");
    const gap = path.join(tmp, `gap-${kind}`);
    cpSync(MIGRATIONS_DIR, gap, { recursive: true });
    writeFileSync(path.join(gap, `${String(Number(next) + 1).padStart(4, "0")}_skipped.sql`), "SELECT 1;");
    await assert.rejects(loadMigrations(gap), /no gaps or duplicates/, "a gap is refused");
    const badName = path.join(tmp, `badname-${kind}`);
    cpSync(MIGRATIONS_DIR, badName, { recursive: true });
    writeFileSync(path.join(badName, "0000-bad name.sql"), "SELECT 1;");
    await assert.rejects(loadMigrations(badName), /name it NNNN_/, "a badly named file is refused");
  }

  // A failing migration rolls back whole: nothing of it, and nothing pending with it, is recorded or left behind.
  {
    const db = await fresh(kind);
    const dir = path.join(tmp, `fail-${kind}`);
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const next = String((await loadMigrations()).length + 1).padStart(4, "0");
    writeFileSync(path.join(dir, `${next}_broken.sql`), "CREATE TABLE migration_half (x INT);\nSELECT no_such_function();\n");
    await assert.rejects(runMigrations(db, { dir }));
    assert.equal((await migrationStatus(db)).legacy, true, "nothing recorded");
    assert.equal((await db.query<{ t: string | null }>("SELECT to_regclass('migration_half')::text AS t"))[0]!.t, null, "nothing left behind");
    assert.equal((await db.query<{ t: string | null }>("SELECT to_regclass('organizations')::text AS t"))[0]!.t, null, "not even the baseline that ran before it");
    await db.drop();
  }

  // Boot: current databases are left alone; with OCTILLION_MIGRATE_ON_BOOT=off a database that is behind refuses to start.
  {
    const db = await fresh(kind);
    process.env.OCTILLION_MIGRATE_ON_BOOT = "off";
    await assert.rejects(ensureMigrated(db), /migration\(s\) behind.*npm run db:migrate/, "off: pending migrations stop the boot");
    delete process.env.OCTILLION_MIGRATE_ON_BOOT;
    await ensureMigrated(db);
    assert.equal((await migrationStatus(db)).pending.length, 0, "on (the default): boot migrates");
    process.env.OCTILLION_MIGRATE_ON_BOOT = "off";
    await ensureMigrated(db);
    delete process.env.OCTILLION_MIGRATE_ON_BOOT;
    await db.drop();
  }

  // Replicas starting together: each migration runs once, the others wait on the lock and find nothing to do.
  if (kind === "postgres") {
    const db = await fresh(kind);
    const others = await Promise.all([1, 2, 3].map(() => openDb()));
    const results = await Promise.all([db, ...others].map((d) => runMigrations(d)));
    assert.equal(results.filter((r) => r.applied.length).length, 1, "exactly one replica applied the migrations");
    assert.equal(Number((await db.query<{ n: number }>("SELECT count(*) AS n FROM schema_migrations"))[0]!.n), (await loadMigrations()).length);
    for (const o of others) await o.close();
    await db.drop();
  }
  await ref.drop();
  console.log(`✓ migrations on ${kind}: schema-on-boot databases upgrade to the same schema with their rows; each migration once; edits, gaps and failures refused or rolled back`);
}

try {
  await suite("pglite");
  if (pgUrl) await suite("postgres");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
