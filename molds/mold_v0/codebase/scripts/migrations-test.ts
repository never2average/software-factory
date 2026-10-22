// Versioned migrations (src/migrate.ts): proves that databases built at the shell's older schema versions upgrade
// with every row intact, and that the runner applies each migration once, in order, and refuses edited, missing or
// out-of-order files.
//
// mold_v0-049 moved the product's tables out of the shell's base schema into its host pack's migrations. The older
// versions are the pre-049 migrations (scripts/fixtures/pre-049-migrations: the three files split since, the others
// unchanged) recorded up to 0001, 0003, 0008 and 0013, and the schema-on-boot path before them, each with rows shaped
// like a live database in every table (fixtures/pre-049-migrations/seed.sql). In a build with no packs a new database
// has none of the product's tables, and an older one keeps them with their rows (its shell schema equal to a new
// one's). In a build whose host pack owns them (pack.json host.schema), a new database has them again, and every older
// one comes out identical to it, schema and rows.
//   npm run test:migrations                                  embedded Postgres (PGlite), temporary directories
//   MIGRATIONS_PG_URL=postgres://u:p@host/db npm run test:migrations   also on a real Postgres (creates and drops
//                                                            its own databases there; never touches the one named)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db.js";
import { ensureMigrated, loadMigrations, loadPackMigrations, MIGRATIONS_DIR, MigrationError, migrationStatus, runMigrations, SPLIT_MIGRATIONS } from "../src/migrate.js";

const tmp = mkdtempSync(path.join(tmpdir(), "octillion-migrations-"));
const pgUrl = process.env.MIGRATIONS_PG_URL;
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
    // Grants (mold_v0-049): on tables and sequences, and on columns, as the tenant role and everyone else hold them.
    grants: await q(`SELECT relname, relkind::text AS kind, relacl::text AS acl FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'S') ORDER BY 1`),
    column_grants: await q(`SELECT c.relname, a.attname, a.attacl::text AS acl FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                            WHERE c.relnamespace = 'public'::regnamespace AND a.attacl IS NOT NULL ORDER BY 1, 2`),
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

// ---------- before mold_v0-049: the shell's migrations as they were, the product's tables in them ----------

/**
 * The shell's migrations as a release before mold_v0-049 had them, up to `upTo`: the three files split since then from
 * scripts/fixtures/pre-049-migrations (their checksums are SPLIT_MIGRATIONS' `before`), the others as they are (never
 * edited). Run by this runner with no packs, that builds exactly the database such a release built.
 */
const PRE = path.join(import.meta.dirname, "fixtures", "pre-049-migrations");
async function preDir(upTo: number) {
  const dir = path.join(tmp, `pre049-${upTo}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const m of (await loadMigrations()).filter((x) => x.version <= upTo)) {
    const f = `${String(m.version).padStart(4, "0")}_${m.name}.sql`;
    writeFileSync(path.join(dir, f), SPLIT_MIGRATIONS[m.version] ? readFileSync(path.join(PRE, f), "utf8") : m.sql);
  }
  return dir;
}
/** The tables the product had in the shell's base schema before mold_v0-049: none of them in a shell with no packs. */
const PRODUCT_TABLES = ["adoption_help", "account_context", "agent_sessions", "context_memories", "developer_population_agents", "developer_populations",
  "developer_profiles", "journey_progress", "journey_seed", "journey_templates", "library_submissions", "library_tasks", "nudge_prefs", "nudges",
  "org_harnesses", "org_task_sets", "product_personas", "product_research", "products", "scenarios", "simulations", "transcript_events",
  "user_context", "visibility_reports"].sort();
const tables = async (db: Db) => (await db.query<{ t: string }>(
  "SELECT relname AS t FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') ORDER BY 1")).map((r) => r.t);

/**
 * Every row of every table, as it stood: per table its row count and an md5 of its rows over the columns it had then
 * (a later migration may add a column; the rows' own values must not change).
 */
async function fingerprint(db: Db, cols?: Map<string, string[]>) {
  const out = new Map<string, { rows: number; md5: string }>();
  const have = cols ?? new Map<string, string[]>();
  if (!cols) for (const r of await db.query<{ t: string; c: string }>(
    `SELECT c.relname AS t, a.attname AS c FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
        AND c.relname NOT IN ('schema_migrations', 'pack_schema_migrations') ORDER BY c.relname, a.attnum`))
    have.set(r.t, [...(have.get(r.t) ?? []), r.c]);
  for (const [t, cs] of have) {
    const row = `row(${cs.map((c) => `"${c}"`).join(", ")})::text`;
    const [r] = await db.query<{ n: number; h: string | null }>(`SELECT count(*)::int AS n, md5(coalesce(string_agg(${row}, '|' ORDER BY ${row}), '')) AS h FROM "${t}"`);
    out.set(t, { rows: Number(r!.n), md5: r!.h ?? "" });
  }
  return { cols: have, rows: out };
}
const seedSql = readFileSync(path.join(PRE, "seed.sql"), "utf8");
async function seed(db: Db) { await db.exec(seedSql); return fingerprint(db); }
/** The rows of every table that was there before are exactly the same after (counts and contents). */
async function sameRows(db: Db, before: Awaited<ReturnType<typeof fingerprint>>, what: string) {
  const after = await fingerprint(db, before.cols);
  let total = 0;
  for (const [t, b] of before.rows) {
    const a = after.rows.get(t)!;
    assert.deepEqual(a, b, `${what}: rows of ${t} changed (${b.rows} -> ${a.rows})`);
    total += b.rows;
  }
  return { tables: before.rows.size, rows: total };
}

/**
 * The catalogs agree, but for the earlier product tables a database with no host pack keeps (with their rows): the
 * differences may only be about those tables (theirs, or a reference to one) and the function only they use.
 */
function sameShellCatalog(a: Awaited<ReturnType<typeof catalog>>, b: Awaited<ReturnType<typeof catalog>>, lingering: string[], what: string) {
  // A lingering table's own objects: the table, its indexes and sequences (named after it), references to it.
  const word = new RegExp(`\\b(${[...lingering, "octillion_platform_of"].join("|")})(_[a-z0-9_]*)?\\b`);
  for (const k of Object.keys(a) as (keyof typeof a)[]) {
    const onlyA = a[k].filter((x) => !b[k].includes(x) && !word.test(x)), onlyB = b[k].filter((x) => !a[k].includes(x));
    assert.ok(!onlyA.length && !onlyB.length, `${what}: ${k} differ\n  upgraded only: ${onlyA.slice(0, 5).join("\n    ")}\n  fresh only: ${onlyB.slice(0, 5).join("\n    ")}`);
  }
}

async function suite(kind: "pglite" | "postgres") {
  const ref = await fresh(kind);
  const r1 = await runMigrations(ref);
  const packSets = await loadPackMigrations();
  const shellApplied = (await loadMigrations()).map((m) => `${String(m.version).padStart(4, "0")}_${m.name}`);
  assert.deepEqual(r1.applied.slice(0, shellApplied.length), shellApplied, "a new database gets every migration");
  assert.deepEqual((await runMigrations(ref)).applied, [], "a second run applies nothing");
  const want = await catalog(ref);
  assert.ok(want.columns.length > 100, "the reference schema is the real one");
  // The host packs of this build that own the earlier product tables (mold_v0-049): with one, a new database has those
  // tables again, and every upgraded database must equal it exactly; with none, a new database has none of them.
  const hostTables = packSets.flatMap((s) => [...(s.schema?.tables ?? [])]).sort();
  const ownsAll = PRODUCT_TABLES.every((t) => hostTables.includes(t));
  const freshTables = await tables(ref);
  if (ownsAll) assert.deepEqual(PRODUCT_TABLES.filter((t) => !freshTables.includes(t)), [], "with the host pack a new database has every product table");
  else assert.deepEqual(PRODUCT_TABLES.filter((t) => freshTables.includes(t) && !hostTables.includes(t)), [], "a new database has none of the product's tables (mold_v0-049)");
  console.log(`  ✓ ${kind}: a new database has ${ownsAll ? "the host pack's" : "none of the"} ${PRODUCT_TABLES.length} product tables (${freshTables.length} tables in all)`);

  // Re-mint parity (mold_v0-049): the database a release before the split built, migrated by this one, is the new one.
  const main = await fresh(kind);
  await runMigrations(main, { dir: await preDir(13), packDirs: [] });
  const mainCatalog = await catalog(main);
  if (ownsAll) {
    // From scratch, the differences from the earlier schema are only: the runner's own record of pack migrations and
    // its two helpers (every build with pack migrations has them), and the gateway's session rule through a function
    // (0003, 0009, 0014). Every table, column, default, constraint, index, policy and grant of the product is the same.
    const diff = (Object.keys(want) as (keyof typeof want)[]).flatMap((k) => [...want[k].filter((x) => !mainCatalog[k].includes(x)).map((x) => `+${k} ${x}`),
      ...mainCatalog[k].filter((x) => !want[k].includes(x)).map((x) => `-${k} ${x}`)]);
    const why = (d: string) => /pack_schema_migrations|shell_pack_(tenant|private)_table/.test(d) ? "pack bookkeeping"
      : /^[+-]policies .*"(gateway_tokens|gateway_usage)"|^\+functions .*octillion_session_org/.test(d) ? "gateway session rule" : null;
    const unexplained = diff.filter((d) => !why(d));
    assert.deepEqual(unexplained, [], "a new database (shell + host pack) differs from the earlier schema only where expected");
    const counts = diff.reduce((m: Record<string, number>, d) => ({ ...m, [why(d)!]: (m[why(d)!] ?? 0) + 1 }), {});
    console.log(`  ✓ ${kind}: from scratch, shell + host pack = the earlier schema (every table, column, constraint and index), but ${JSON.stringify(counts)}`);
  }
  await main.drop();

  // Databases at the shell's older versions, with rows in every table: the legacy schema-on-boot path (the earlier
  // baseline booted twice, as every deploy did), and the pre-049 migrations recorded up to 1, 3, 8 and 13.
  const starts: { name: string; build: (db: Db) => Promise<Awaited<ReturnType<typeof fingerprint>>> }[] = [
    { name: "schema-on-boot", build: async (db) => {
      const old = readFileSync(path.join(PRE, "0001_baseline.sql"), "utf8");
      await oldBoot(db, old);
      await db.exec(seedSql);
      await oldBoot(db, old); // the next boot ran its repairs over the rows as they were
      assert.equal((await migrationStatus(db)).legacy, true, "the old way leaves no schema_migrations table");
      return fingerprint(db);
    } },
    ...[1, 3, 8, 13].map((v) => ({ name: `pre-049 at ${String(v).padStart(4, "0")}`, build: async (db: Db) => {
      await runMigrations(db, { dir: await preDir(v), packDirs: [] });
      return seed(db);
    } })),
  ];
  for (const st of starts) {
    const old = await fresh(kind);
    const rows = await st.build(old);
    const lingering = PRODUCT_TABLES.filter((t) => rows.rows.has(t) && !hostTables.includes(t));
    const applied = await runMigrations(old, { log: () => {} });
    const s = await migrationStatus(old);
    assert.ok(!s.pending.length && !s.conflicts.length && s.packs.every((p) => !p.pending.length && !p.conflicts.length), `${st.name}: nothing pending, no conflict`);
    const kept = await sameRows(old, rows, `${kind}: ${st.name}`);
    if (ownsAll) sameCatalog(await catalog(old), want, `${kind}: ${st.name} after migrating with the host pack`);
    else sameShellCatalog(await catalog(old), want, lingering, `${kind}: ${st.name} after migrating with no packs`);
    const adopted = applied.applied.filter((x) => x.endsWith("(adopted)"));
    if (ownsAll && adopted.length && st.name.endsWith("0013")) {
      // Why adopting matters: running the adopted migration on this database would change its rows (its one-time
      // repairs: the reworded library task, the picked persona copy, the loss reason skipped before the fix).
      const set = packSets.find((x) => x.schema?.adopts)!, m = set.migrations.find((x) => set.schema!.adopts[`${String(x.version).padStart(4, "0")}_${x.name}`])!;
      class Undo extends Error {}
      let changed: string[] = [];
      await old.migrate(async (tx) => {
        await tx.exec(m.sql);
        const after = await fingerprint(tx as unknown as Db, rows.cols);
        changed = [...rows.rows].filter(([t, b]) => JSON.stringify(after.rows.get(t)) !== JSON.stringify(b)).map(([t]) => t);
        throw new Undo();
      }).catch((e) => { if (!(e instanceof Undo)) throw e; });
      assert.ok(changed.length > 0, "running the adopted migration again would have changed rows (so adopting it is what keeps them)");
      assert.equal((await sameRows(old, rows, `${kind}: after the rolled-back rerun`)).rows, kept.rows);
      console.log(`  ✓ ${kind}: running the adopted ${set.pack} migration instead would change rows of ${changed.join(", ")}; adopting it changes none`);
    }
    assert.deepEqual((await runMigrations(old)).applied, [], `${st.name}: migrating again applies nothing`);
    console.log(`  ✓ ${kind}: ${st.name} → ${applied.applied.length} applied${adopted.length ? ` (${adopted.join(", ")})` : ""}; ${kept.rows} rows in ${kept.tables} tables identical` +
      (ownsAll ? "; schema identical to a new database" : `; shell schema identical, ${lingering.length} earlier product tables kept with their rows`));
    await old.drop();
  }
  // A host pack's own schema, held by the runner whatever the build let through (mold_v0-049): its declared tables may
  // carry its own policies and its declared functions are its own; every other object of the database stays as it was.
  {
    const hp = (sql: string, schema: Record<string, unknown> = {}) => {
      const dir = path.join(tmp, `hp-${kind}-${++n}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "0001_widgets.sql"), sql);
      return [{ pack: "hp", dir, schema: { tables: ["widgets"], functions: ["widget_score"], adopts: { "0001_widgets": "0001_baseline" }, ...schema } }] as never;
    };
    const W = "CREATE TABLE IF NOT EXISTS widgets (id SERIAL PRIMARY KEY, org_id INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE, name TEXT);\n";
    const SEC = "DO $mig$ DECLARE r TEXT := octillion_tenant_role(); BEGIN ALTER TABLE widgets ENABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS tenant_isolation ON widgets;\n" +
      "  EXECUTE format('CREATE POLICY tenant_isolation ON widgets TO %I USING (org_id = octillion_tenant_org()) WITH CHECK (org_id = octillion_tenant_org())', r);\n" +
      "  EXECUTE format('GRANT SELECT, INSERT ON widgets TO %I', r); END $mig$;\n";
    const FN = "CREATE OR REPLACE FUNCTION widget_score(n TEXT) RETURNS INT LANGUAGE sql IMMUTABLE AS $$ SELECT length(n) $$;\n";
    const MARK = "UPDATE widgets SET name = 'the adopted migration ran';\n";
    const db = await fresh(kind);
    await runMigrations(db);
    const r = await runMigrations(db, { packDirs: hp(W + SEC + FN + MARK) });
    assert.deepEqual(r.applied, ["pack hp 0001_widgets"], "a new database runs the host pack's migration (nothing to adopt: its 0001 is today's)");
    assert.ok((await db.query<{ on: boolean }>("SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'widgets'"))[0]!.on, "its table is under row-level security");
    const refusedBy = async (what: string, sql: string, re: RegExp, schema: Record<string, unknown> = {}) => {
      const d = await fresh(kind);
      await runMigrations(d);
      await assert.rejects(runMigrations(d, { packDirs: hp(sql, schema) }), (e) => e instanceof MigrationError && re.test(e.message), what);
      assert.equal((await d.query<{ t: string | null }>("SELECT to_regclass('widgets')::text AS t"))[0]!.t, null, `${what}: rolled back whole`);
      await d.drop();
    };
    await refusedBy("a policy on a shell table", W + SEC + FN + "CREATE POLICY leak ON mcp_events FOR SELECT USING (true);\n", /policy leak on mcp_events/);
    await refusedBy("a grant on a shell table", W + SEC + FN + "DO $$ BEGIN EXECUTE format('GRANT SELECT ON vault_credentials TO %I', octillion_tenant_role()); END $$;\n", /relation vault_credentials/);
    await refusedBy("a column added to a shell table", W + SEC + FN + "ALTER TABLE organizations ADD COLUMN sneaky TEXT;\n", /column organizations.sneaky/);
    await refusedBy("a constraint on a shell table", W + SEC + FN + "ALTER TABLE organizations ADD CONSTRAINT sneaky CHECK (id > 0);\n", /constraint sneaky on organizations/);
    await refusedBy("a function it does not declare", W + SEC + FN + "CREATE FUNCTION other_fn() RETURNS INT LANGUAGE sql AS $$ SELECT 1 $$;\n", /function other_fn\(\)/);
    await refusedBy("its declared function as SECURITY DEFINER", W + SEC + FN.replace("IMMUTABLE", "IMMUTABLE SECURITY DEFINER"), /function widget_score\(text\)/);
    await refusedBy("a shell function redefined", W + SEC + FN + "CREATE OR REPLACE FUNCTION octillion_tenant_org() RETURNS INT LANGUAGE sql STABLE AS $$ SELECT 1 $$;\n", /function octillion_tenant_org\(\)/);
    await refusedBy("its table without row-level security", W + FN, /without row-level security: widgets/);
    await refusedBy("a declared table it does not create", W + SEC + FN, /do not create: gizmos/, { tables: ["widgets", "gizmos"] });
    await refusedBy("a reference from a shell table it does not declare", W.replace("name TEXT", "name TEXT UNIQUE") + SEC + FN +
      "ALTER TABLE gateway_tokens ADD CONSTRAINT gateway_tokens_widget_fkey FOREIGN KEY (orchestrator_id) REFERENCES widgets (name) ON DELETE CASCADE;\n", /constraint gateway_tokens_widget_fkey on gateway_tokens/);
    await refusedBy("a shell table as its own", W + SEC + FN, /api_keys is a shell table/, { tables: ["widgets", "api_keys"] });
    // A platform library (host.schema.platform_read): no row-level security, as in the shell, but never a workspace's
    // rows (no org_id) and never written by tenant work.
    const LIB = "CREATE TABLE IF NOT EXISTS widgets (id SERIAL PRIMARY KEY, name TEXT);\nDO $$ BEGIN EXECUTE format('GRANT SELECT ON widgets TO %I', octillion_tenant_role()); END $$;\n";
    {
      const d = await fresh(kind);
      await runMigrations(d);
      await runMigrations(d, { packDirs: hp(LIB + FN, { platform_read: ["widgets"] }) });
      assert.equal((await d.query<{ on: boolean }>("SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'widgets'"))[0]!.on, false, "a platform library stays without row-level security, read only");
      await d.drop();
    }
    await refusedBy("a platform library without the declaration", LIB + FN, /without row-level security: widgets/);
    await refusedBy("a platform library with workspace rows", W + FN, /platform library widgets has an org_id/, { platform_read: ["widgets"] });
    await refusedBy("a platform library tenant work may write", LIB.replace("GRANT SELECT", "GRANT SELECT, INSERT") + FN, /platform library widgets is writable by tenant work/, { platform_read: ["widgets"] });
    await refusedBy("a platform library that is not its table", W + SEC + FN, /platform library gadgets is not one of its tables/, { platform_read: ["gadgets"] });
    await refusedBy("a shell function as its own", W + SEC + FN, /function octillion_tenant_org is the shell's/, { functions: ["widget_score", "octillion_tenant_org"] });
    await refusedBy("adopting a shell migration that was not split", W + SEC + FN, /0002_admin_tokens, which is not a split shell migration/, { adopts: { "0001_widgets": "0002_admin_tokens" } });
    // A reference from a shell table's column to its own table (the sessions' gateway tokens) is the one change allowed there.
    {
      const d = await fresh(kind);
      await runMigrations(d);
      await runMigrations(d, { packDirs: hp(W.replace("name TEXT", "name TEXT UNIQUE") + SEC + FN +
        "ALTER TABLE gateway_tokens ADD CONSTRAINT gateway_tokens_widget_fkey FOREIGN KEY (orchestrator_id) REFERENCES widgets (name);\n", { references: { "gateway_tokens.orchestrator_id": "widgets" } }) });
      assert.equal((await d.query("SELECT 1 FROM pg_constraint WHERE conname = 'gateway_tokens_widget_fkey'")).length, 1, "a reference it declares, from a shell table to its own table, is allowed");
      await d.drop();
    }
    // Adoption: a database that ran the earlier baseline has the host pack's tables (here, made by hand as that file
    // would have): the migration that adopts it is recorded and not run, so the rows stay as they were.
    {
      const d = await fresh(kind);
      await runMigrations(d, { dir: await preDir(13), packDirs: [] });
      await d.exec(W + SEC + "INSERT INTO organizations (slug, name) VALUES ('hp-org', 'HP');\nINSERT INTO widgets (org_id, name) SELECT id, 'as it was' FROM organizations WHERE slug = 'hp-org';\n");
      const r2 = await runMigrations(d, { packDirs: hp(W + SEC + FN + MARK) });
      assert.ok(r2.applied.includes("pack hp 0001_widgets (adopted)"), `the database that ran the earlier baseline adopts it: ${r2.applied.join(", ")}`);
      assert.deepEqual((await d.query<{ name: string }>("SELECT name FROM widgets")).map((x) => x.name), ["as it was"], "and nothing of it ran");
      assert.equal((await d.query<{ n: number }>("SELECT count(*)::int AS n FROM pack_schema_migrations WHERE pack = 'hp'"))[0]!.n, 1, "recorded once");
      // Without its table there, adoption is refused: a database that never had the product's tables cannot pretend to.
      const e = await fresh(kind);
      await runMigrations(e, { dir: await preDir(13), packDirs: [] });
      await e.exec("DROP TABLE IF EXISTS widgets");
      await assert.rejects(runMigrations(e, { packDirs: hp(W + SEC + FN + MARK) }), /do not create: widgets/, "an adopted migration whose tables are missing is refused");
      await d.drop(); await e.drop();
    }
    await db.drop();
    console.log(`  ✓ ${kind}: a host pack's own schema: its tables, policies and declared function run; adopted on a pre-049 database (nothing run); policies, grants, columns, constraints and functions outside it refused`);
  }

  // A split migration's earlier checksum is accepted only for that file: any other edit is still refused below.
  assert.deepEqual(Object.keys(SPLIT_MIGRATIONS).map(Number), [1, 3, 9]);
  for (const [v, sp] of Object.entries(SPLIT_MIGRATIONS)) {
    const f = `${String(v).padStart(4, "0")}_${sp.name}.sql`;
    assert.equal(createHash("sha256").update(readFileSync(path.join(PRE, f), "utf8")).digest("hex"), sp.before, `${f}: the fixture is the earlier file`);
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
