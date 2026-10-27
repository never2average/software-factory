// A migration rehearsal (mold_v0-142; src/migration-rehearsal.ts): apply this build's pending migrations to the database
// DATABASE_URL names (else the local PGlite of PGLITE_DIR) and report what they did, measured from the database: what was
// pending, what ran and what was adopted (nothing run), every relation whose definition changed, the adopted tables' rows
// and catalog rows before and after, every row count that changed, and check:rls on the result.
//
// IT CHANGES THE DATABASE IT IS GIVEN: run it on a copy (the factory's `provision.py <app> --rehearse-migrations` makes
// one: a Neon branch, or a dump restored into a scratch Postgres, and deletes it after). It never prints the database's
// address.
//   npm run db:rehearse -- [--dry-run] [--json]
// Exit 0: the adopted tables kept every row and no DDL reached them, they are in their migration's shape and check:rls
// passed; 1: one of those did not hold (the report says which); 2: it could not run. Other tables whose row count
// changed (a migration that seeds rows) are listed, not failed.
const json = process.argv.includes("--json");
const dryRun = process.argv.includes("--dry-run");
// The database is opened without the migration step a server's first use runs (src/db.ts openDb): the "before" is
// measured first, then the runner applies what is pending.
process.env.APP_MIGRATE_ON_BOOT = "off";
const { openDb } = await import("../src/db.js");
const { rehearse } = await import("../src/migration-rehearsal.js");
let db: Awaited<ReturnType<typeof openDb>> | null = null;
try {
  db = await openDb();
  const r = await rehearse(db, { dryRun });
  const problems = [
    ...r.adopted_tables.filter((t) => t.rows_before !== null && (!t.rows_identical || !t.catalog_unchanged))
      .map((t) => `${t.table}: ${!t.rows_identical ? `rows changed (${t.rows_before} -> ${t.rows_after})` : "DDL reached it (its catalog rows were rewritten)"}`),
    ...r.adopted_tables.filter((t) => !dryRun && t.shape !== "as_migration_gives").map((t) => `${t.table}: ${t.shape === "absent" ? "absent after migrating" : "not in the shape its migration gives"}`),
    ...r.rls.problems.map((p) => `check:rls: ${p}`),
  ];
  const out = { status: problems.length ? "failed" : "ok", dry_run: dryRun, database: db.kind, problems, ...r };
  if (json) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  else {
    console.log(`migration rehearsal on ${db.kind}${dryRun ? " (dry run: nothing applied)" : ""}`);
    console.log(`  pending before: ${r.pending.join(", ") || "none"}`);
    if (!dryRun) console.log(`  applied: ${r.applied.join(", ") || "none"}`);
    console.log(`  DDL: created ${r.ddl.created.join(", ") || "nothing"}; changed ${r.ddl.changed.join(", ") || "nothing"}; dropped ${r.ddl.dropped.join(", ") || "nothing"}`);
    for (const t of r.adopted_tables)
      console.log(`  ${t.table}: rows ${t.rows_before ?? "absent"} -> ${t.rows_after ?? "absent"}${t.rows_before !== null ? `, ${t.rows_identical ? "identical" : "CHANGED"}, catalog ${t.catalog_unchanged ? "unchanged (no DDL)" : "REWRITTEN"}` : ""}, shape ${t.shape}`);
    console.log(`  row counts: ${r.rows_changed.length ? r.rows_changed.map((t) => `${t.table} ${t.before} -> ${t.after}`).join(", ") : `unchanged in all ${r.tables_checked} tables`}`);
    console.log(`  check:rls: ${r.rls.pass ? `pass (${r.rls.probe_checks} probe checks)` : `FAIL: ${r.rls.problems.join("; ")}`}`);
    console.log(problems.length ? `REHEARSAL FAILED: ${problems.join("; ")}` : "REHEARSAL OK");
  }
  process.exitCode = problems.length ? 1 : 0;
} catch (e) {
  const message = (e as Error).message.replace(/postgres(ql)?:\/\/[^\s"']+/g, "<database url>");
  if (json) process.stdout.write(JSON.stringify({ status: "error", error: message }) + "\n");
  else console.error(`migration rehearsal could not run: ${message}`);
  process.exitCode = 2;
} finally {
  await db?.close();
}
