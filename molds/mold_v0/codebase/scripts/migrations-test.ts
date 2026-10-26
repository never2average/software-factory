// Versioned migrations (src/migrate.ts): proves that databases built at the shell's older schema versions upgrade
// with every row intact, and that the runner applies each migration once, in order, and refuses edited, missing or
// out-of-order files.
//
// mold_v0-049 moved the product's tables out of the shell's base schema into its host pack's migrations. The older
// versions are the pre-049 migrations (scripts/fixtures/pre-049-migrations: the three files split since, the others
// unchanged) recorded up to 0001, 0003, 0008, 0013 and 0016, and the schema-on-boot path before them, each with rows shaped
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

const tmp = mkdtempSync(path.join(tmpdir(), "app-migrations-"));
const pgUrl = process.env.MIGRATIONS_PG_URL;
let n = 0;

/** A new, empty database: a PGlite directory, or a fresh database on the real Postgres. */
async function fresh(kind: "pglite" | "postgres"): Promise<Db & { drop: () => Promise<void> }> {
  const id = `app_mig_${process.pid}_${++n}`;
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
  // The tenant role is named per database (0003_row_level_security; app_tenant_ since 0024, its old name an alias role):
  // compare it by kind, not by name.
  const q = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).map((r) => JSON.stringify(r).replace(/\b([a-z]+)_tenant_[0-9a-f]{10}\b/g, "$1_tenant_<db>"));
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
/** The last shell migration released before mold_v0-049 (0016_run_approvals_egress, mold_v0-078); 0017 is the split's own. */
const LAST_PRE = 16;
async function preDir(upTo: number, asToday = false) {
  const dir = path.join(tmp, `${asToday ? "shell" : "pre049"}-${upTo}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const m of (await loadMigrations()).filter((x) => x.version <= upTo)) {
    const f = `${String(m.version).padStart(4, "0")}_${m.name}.sql`;
    writeFileSync(path.join(dir, f), SPLIT_MIGRATIONS[m.version] && !asToday ? readFileSync(path.join(PRE, f), "utf8") : m.sql);
  }
  return dir;
}
type Catalog = Awaited<ReturnType<typeof catalog>>;
/** Each catalog line in `a` and not in `b`, as `+kind line`, and in `b` and not in `a`, as `-kind line`. */
const catalogDiff = (a: Catalog, b: Catalog) => (Object.keys(a) as (keyof Catalog)[]).flatMap((k) => [
  ...a[k].filter((x) => !b[k].includes(x)).map((x) => `+${k} ${x}`), ...b[k].filter((x) => !a[k].includes(x)).map((x) => `-${k} ${x}`)]);
/**
 * What the shell's own migrations after the split's release changed (0017 onwards, whatever lands next), measured, not
 * listed: a database with no packs from today's shell migrations up to LAST_PRE against one from all of them. Every
 * table, column, index, policy or function a later shell migration adds, changes or drops is in it, and nothing of a
 * host pack's (mold_v0-158: a hand-kept list had drifted by 289 lines, the tables of 0018 to 0024).
 */
/** The catalog of a new database from the shell's migrations alone (no packs), up to `upTo` (all by default). */
async function shellCatalog(kind: "pglite" | "postgres", upTo?: number) {
  const db = await fresh(kind);
  await runMigrations(db, { ...(upTo === undefined ? {} : { dir: await preDir(upTo, true) }), packDirs: [] });
  const c = await catalog(db);
  await db.drop();
  return c;
}
async function laterShellChanges(kind: "pglite" | "postgres") {
  return new Set(catalogDiff(await shellCatalog(kind), await shellCatalog(kind, LAST_PRE)));
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
  const out = new Map<string, { rows: number; md5: string; texts: string[] }>();
  const have = cols ?? new Map<string, string[]>();
  if (!cols) for (const r of await db.query<{ t: string; c: string }>(
    `SELECT c.relname AS t, a.attname AS c FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
        AND c.relname NOT IN ('schema_migrations', 'pack_schema_migrations') ORDER BY c.relname, a.attnum`))
    have.set(r.t, [...(have.get(r.t) ?? []), r.c]);
  for (const [t, cs] of have) {
    const row = `row(${cs.map((c) => `"${c}"`).join(", ")})::text`;
    const texts = (await db.query<{ r: string }>(`SELECT ${row} AS r FROM "${t}" ORDER BY 1`)).map((x) => x.r);
    out.set(t, { rows: texts.length, md5: createHash("md5").update(texts.join("|")).digest("hex"), texts });
  }
  return { cols: have, rows: out };
}
const seedSql = readFileSync(path.join(PRE, "seed.sql"), "utf8");
async function seed(db: Db) { await db.exec(seedSql); return fingerprint(db); }
/**
 * Every row that was there before is there after, unchanged (over the columns its table had then): none lost, none
 * changed. The product's tables come out exactly as they were; a shell table may also gain the seed rows a later shell
 * migration adds (0016 seeds a vault provider), counted and shown.
 */
async function sameRows(db: Db, before: Awaited<ReturnType<typeof fingerprint>>, what: string) {
  const after = await fingerprint(db, before.cols);
  let total = 0, added = 0;
  for (const [t, b] of before.rows) {
    const a = after.rows.get(t)!;
    if (PRODUCT_TABLES.includes(t)) assert.deepEqual({ rows: a.rows, md5: a.md5 }, { rows: b.rows, md5: b.md5 }, `${what}: rows of ${t} changed (${b.rows} -> ${a.rows})`);
    const left = new Map<string, number>();
    for (const x of a.texts) left.set(x, (left.get(x) ?? 0) + 1);
    for (const x of b.texts) {
      assert.ok((left.get(x) ?? 0) > 0, `${what}: a row of ${t} was lost or changed: ${x.slice(0, 160)}`);
      left.set(x, left.get(x)! - 1);
    }
    added += a.rows - b.rows;
    total += b.rows;
  }
  return { tables: before.rows.size, rows: total, added };
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
  await runMigrations(main, { dir: await preDir(LAST_PRE), packDirs: [] });
  const mainCatalog = await catalog(main);
  if (ownsAll) {
    // From scratch, the differences from the earlier schema are only: the runner's own record of pack migrations and
    // its two helpers (every build with pack migrations has them), and the gateway's session rule through a function
    // (0003, 0009, 0017), the neutral names (0024), and whatever the shell's own later migrations changed (measured by
    // laterShellChanges, never listed here). Every table, column, default, constraint, index, policy and grant of the
    // product is the same.
    const diff = catalogDiff(want, mainCatalog);
    const later = await laterShellChanges(kind);
    // The neutral names (0024_neutral_database_names): the same policy, grant or function under the new names, and the
    // old names' aliases.
    const renamed = (d: string) => d.slice(1).replace(/\b[a-z]+_(tenant_role|tenant_org|session_org|run_charge(?:_figures|_refresh|_on_end)?|tenant_<db>)/g, "app_$1");
    const olds = new Set(diff.filter((d) => d.startsWith("-")).map(renamed));
    const why = (d: string) => /pack_schema_migrations|shell_pack_(tenant|private)_table/.test(d) ? "pack bookkeeping"
      : /^[+-]policies .*"(gateway_tokens|gateway_usage)"|^\+functions .*_session_org/.test(d) ? "gateway session rule"
      : (d.startsWith("+") && olds.has(renamed(d))) || (d.startsWith("-") && diff.some((x) => x.startsWith("+") && renamed(x) === renamed(d)))
        || /^[+-]functions .*"[a-z]+_(tenant_role|tenant_org|session_org|run_charge(_figures|_refresh|_on_end)?)"/.test(d) ? "neutral names (0024)"
      : later.has(d) ? `later shell migrations (${String(LAST_PRE + 1).padStart(4, "0")} on)` : null;
    const unexplained = diff.filter((d) => !why(d));
    assert.deepEqual(unexplained, [], "a new database (shell + host pack) differs from the earlier schema only where expected");
    const counts = diff.reduce((m: Record<string, number>, d) => ({ ...m, [why(d)!]: (m[why(d)!] ?? 0) + 1 }), {});
    console.log(`  ✓ ${kind}: from scratch, shell + host pack = the earlier schema (every table, column, constraint and index), but ${JSON.stringify(counts)}`);
  }
  await main.drop();

  // Databases at the shell's older versions, with rows in every table: the legacy schema-on-boot path (the earlier
  // baseline booted twice, as every deploy did), and the pre-049 migrations recorded up to 1, 3, 8, 13 and 14.
  const starts: { name: string; build: (db: Db) => Promise<Awaited<ReturnType<typeof fingerprint>>> }[] = [
    { name: "schema-on-boot", build: async (db) => {
      const old = readFileSync(path.join(PRE, "0001_baseline.sql"), "utf8");
      await oldBoot(db, old);
      await db.exec(seedSql);
      await oldBoot(db, old); // the next boot ran its repairs over the rows as they were
      assert.equal((await migrationStatus(db)).legacy, true, "the old way leaves no schema_migrations table");
      return fingerprint(db);
    } },
    ...[1, 3, 8, 13, LAST_PRE].map((v) => ({ name: `pre-049 at ${String(v).padStart(4, "0")}`, build: async (db: Db) => {
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
    if (ownsAll && adopted.length && st.name.endsWith(String(LAST_PRE).padStart(4, "0"))) {
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
    console.log(`  ✓ ${kind}: ${st.name} → ${applied.applied.length} applied${adopted.length ? ` (${adopted.join(", ")})` : ""}; ${kept.rows} rows in ${kept.tables} tables identical${kept.added ? ` (+${kept.added} seed row(s) a later shell migration adds)` : ""}` +
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
    // Written with the shell's function names before 0024 (the aliases): granted to the tenant role, and its policy
    // re-pointed at the function itself, so no policy names an alias.
    assert.deepEqual(await db.query("SELECT qual, with_check FROM pg_policies WHERE tablename = 'widgets'"),
      [{ qual: "(org_id = app_tenant_org())", with_check: "(org_id = app_tenant_org())" }], "a pack migration written with the old names: its policy names app_tenant_org()");
    assert.ok((await db.query<{ ok: boolean }>("SELECT has_table_privilege(app_tenant_role(), 'widgets', 'INSERT') AS ok"))[0]!.ok, "and its grant is the tenant role's");
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
    await refusedBy("a shell function redefined", W + SEC + FN + "CREATE OR REPLACE FUNCTION app_tenant_org() RETURNS INT LANGUAGE sql STABLE AS $$ SELECT 1 $$;\n", /function app_tenant_org\(\)/);
    await refusedBy("a shell function's old name (its alias) redefined", W + SEC + FN + "CREATE OR REPLACE FUNCTION octillion_tenant_org() RETURNS INT LANGUAGE sql STABLE AS $$ SELECT 1 $$;\n", /function octillion_tenant_org\(\)/);
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
    await refusedBy("a shell function as its own", W + SEC + FN, /function app_tenant_org is the shell's/, { functions: ["widget_score", "app_tenant_org"] });
    await refusedBy("a shell function's old name as its own", W + SEC + FN, /function octillion_tenant_org is the shell's/, { functions: ["widget_score", "octillion_tenant_org"] });
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
      await runMigrations(d, { dir: await preDir(LAST_PRE), packDirs: [] });
      await d.exec(W + SEC + "INSERT INTO organizations (slug, name) VALUES ('hp-org', 'HP');\nINSERT INTO widgets (org_id, name) SELECT id, 'as it was' FROM organizations WHERE slug = 'hp-org';\n");
      const r2 = await runMigrations(d, { packDirs: hp(W + SEC + FN + MARK) });
      assert.ok(r2.applied.includes("pack hp 0001_widgets (adopted)"), `the database that ran the earlier baseline adopts it: ${r2.applied.join(", ")}`);
      assert.deepEqual((await d.query<{ name: string }>("SELECT name FROM widgets")).map((x) => x.name), ["as it was"], "and nothing of it ran");
      assert.equal((await d.query<{ n: number }>("SELECT count(*)::int AS n FROM pack_schema_migrations WHERE pack = 'hp'"))[0]!.n, 1, "recorded once");
      // Without its table there, adoption is refused: a database that never had the product's tables cannot pretend to.
      const e = await fresh(kind);
      await runMigrations(e, { dir: await preDir(LAST_PRE), packDirs: [] });
      await e.exec("DROP TABLE IF EXISTS widgets");
      await assert.rejects(runMigrations(e, { packDirs: hp(W + SEC + FN + MARK) }), /do not create: widgets/, "an adopted migration whose tables are missing is refused");
      await d.drop(); await e.drop();
    }
    await db.drop();
    console.log(`  ✓ ${kind}: a host pack's own schema: its tables, policies and declared function run; adopted on a pre-049 database (nothing run); policies, grants, columns, constraints and functions outside it refused`);
  }

  // The neutral names (0024_neutral_database_names, mold_v0-097): renamed in place, the old names kept as aliases for a
  // release from before it, and the rollback file puts the database back exactly as 0023 left it.
  {
    const upTo = async (v: number) => {
      const dir = path.join(tmp, `upto-${kind}-${v}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      for (const m of (await loadMigrations()).filter((x) => x.version <= v)) writeFileSync(path.join(dir, `${String(m.version).padStart(4, "0")}_${m.name}.sql`), m.sql);
      return dir;
    };
    const { rlsCatalogProblems, rlsProbe, legacyTenantRole } = await import("../src/rls.js");
    // The shell's own migrations only, throughout (packDirs: []): this runner re-points a pack's policies at 0024's
    // names, so it cannot make a database with packs as it stood at 0023. Every run below names no packs either
    // (mold_v0-158: the runs after 0023 took the build's host packs by default, so in a host-pack build the rolled-back
    // database had the product's tables and the database 0023 left had none). The host pack's own policies through
    // 0024 are graded above: every older database, migrated with the host pack, equals a new one.
    const at23 = await fresh(kind);
    await runMigrations(at23, { dir: await upTo(23), packDirs: [] });
    const before = await catalog(at23);
    const roleOf = async (d: Db) => (await d.query<{ r: string }>("SELECT app_tenant_role() AS r"))[0]!.r;
    // The release before this one, serving while the migration runs: its tenant transaction, as it opens one.
    const oldRole = (await at23.query<{ r: string }>("SELECT octillion_tenant_role() AS r"))[0]!.r;
    await at23.exec("INSERT INTO organizations (slug, name) VALUES ('nn-a', 'A'), ('nn-b', 'B')");
    const [oa, ob] = (await at23.query<{ id: number }>("SELECT id FROM organizations WHERE slug IN ('nn-a', 'nn-b') ORDER BY slug")).map((r) => r.id);
    await at23.exec(`INSERT INTO mcp_events (org_id, method) VALUES (${oa}, 'a'), (${ob}, 'b')`);
    const oldWay = async (d: Db, org: number | null) => (await d.transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE ${oldRole}`);
      await tx.query("SELECT set_config('octillion.org_id', $1, true)", [org === null ? "" : String(org)]);
      return tx.query<{ org_id: number }>("SELECT org_id FROM mcp_events ORDER BY org_id");
    })).map((r) => r.org_id);
    assert.deepEqual(await oldWay(at23, oa!), [oa], "before: the old release's tenant transaction sees its own rows");
    const t0 = Date.now();
    assert.deepEqual((await runMigrations(at23, { packDirs: [] })).applied, ["0024_neutral_database_names"]);
    const ms = Date.now() - t0;
    assert.match(await roleOf(at23), /^app_tenant_[0-9a-f]{10}$/, "the tenant role is app_tenant_<hash>");
    assert.equal(legacyTenantRole(await roleOf(at23)), oldRole);
    assert.equal((await at23.query<{ r: string }>("SELECT octillion_tenant_role() AS r"))[0]!.r, await roleOf(at23), "the old function names the new role (a pack migration grants to it)");
    assert.deepEqual(await oldWay(at23, oa!), [oa], "after: the old release's tenant transaction, unchanged, still sees its own rows only");
    assert.deepEqual(await oldWay(at23, null), [], "and none with no organization set");
    const policies = await at23.query<{ q: string }>("SELECT coalesce(qual, '') || coalesce(with_check, '') AS q FROM pg_policies WHERE schemaname = 'public'");
    assert.ok(policies.length > 20 && policies.every((p) => !p.q.includes("octillion_tenant_org") && !p.q.includes("octillion_session_org")), "every policy names the new functions (renamed in place, none rewritten)");
    assert.deepEqual(await rlsCatalogProblems(at23), [], "check:rls catalog after the rename");
    const probe = await rlsProbe(at23);
    assert.deepEqual(probe.problems, [], "check:rls probe after the rename, the old names' path included");
    // The alias role holds nothing of its own: a grant to it is a failure of the catalog check (fail closed).
    await at23.exec(`GRANT SELECT ON vault_credentials TO ${oldRole}`);
    assert.ok((await rlsCatalogProblems(at23)).some((p) => p.includes(`role ${oldRole}`) && p.includes("privilege")), "a grant to the old name fails the check");
    await at23.exec(`REVOKE SELECT ON vault_credentials FROM ${oldRole}`);
    assert.deepEqual(await rlsCatalogProblems(at23), []);
    // Rolling back to a release from before 0024: the rollback file puts back the database 0023 left, exactly.
    await at23.exec(readFileSync(path.join(MIGRATIONS_DIR, "..", "rollback", "0024_neutral_database_names.sql"), "utf8"));
    const fresh23 = await fresh(kind);
    await runMigrations(fresh23, { dir: await upTo(23), packDirs: [] });
    sameCatalog(await catalog(at23), await catalog(fresh23), `${kind}: rolled back from 0024`);
    sameCatalog(before, await catalog(fresh23), `${kind}: at 0023`);
    assert.deepEqual(await oldWay(at23, oa!), [oa], "rolled back: the old release's tenant transaction sees its own rows");
    assert.deepEqual((await runMigrations(at23, { packDirs: [] })).applied, ["0024_neutral_database_names"], "and 0024 applies again");
    sameCatalog(await catalog(at23), packSets.length ? await shellCatalog(kind) : want, `${kind}: 0024 again after the rollback`);
    await fresh23.drop();
    await at23.drop();
    // Roles outlive databases (a real server): a database dropped and made again under the same name finds the roles
    // the first one renamed and made; 0003 and 0024 run again over them.
    if (kind === "postgres") {
      process.env.DATABASE_URL = pgUrl!;
      const admin = await openDb();
      const name = `app_mig_${process.pid}_again`;
      for (let i = 0; i < 2; i++) {
        await admin.exec(`CREATE DATABASE ${name}`);
        const url = new URL(pgUrl!); url.pathname = `/${name}`;
        process.env.DATABASE_URL = url.toString();
        const d = await openDb();
        await runMigrations(d, { packDirs: [] });
        assert.deepEqual(await rlsCatalogProblems(d), [], `database made ${i ? "again" : "once"} under one name: check:rls catalog`);
        assert.deepEqual((await rlsProbe(d)).problems, [], `database made ${i ? "again" : "once"} under one name: check:rls probe`);
        await d.close();
        process.env.DATABASE_URL = pgUrl!;
        await admin.exec(`DROP DATABASE ${name} WITH (FORCE)`);
      }
      await admin.close();
    }
    console.log(`  ✓ ${kind}: 0024 renames the functions, the tenant role and its setting in place (${ms} ms, every policy follows); the old release's tenant transaction keeps its own rows only; the rollback file restores 0023 exactly`);
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

  // Boot: current databases are left alone; with APP_MIGRATE_ON_BOOT=off a database that is behind refuses to start.
  {
    const db = await fresh(kind);
    process.env.APP_MIGRATE_ON_BOOT = "off";
    await assert.rejects(ensureMigrated(db), /migration\(s\) behind.*npm run db:migrate/, "off: pending migrations stop the boot");
    delete process.env.APP_MIGRATE_ON_BOOT;
    await ensureMigrated(db);
    assert.equal((await migrationStatus(db)).pending.length, 0, "on (the default): boot migrates");
    process.env.APP_MIGRATE_ON_BOOT = "off";
    await ensureMigrated(db);
    delete process.env.APP_MIGRATE_ON_BOOT;
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
