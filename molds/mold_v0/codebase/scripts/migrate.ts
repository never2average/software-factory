// Versioned schema migrations (src/migrate.ts, docs/migrations.md) against DATABASE_URL (or the local PGlite).
//   npm run db:migrate               apply what is pending (deploys run this before starting the new release)
//   npm run db:migrate -- --status   list applied and pending migrations
//   npm run db:migrate -- --check    exit 1 when anything is pending or conflicts (an edited migration)
// The server reads the database through getDb, which migrates on first use; this script opens the database without
// that, so --status and --check never change anything. It names its target (host and database, never credentials)
// and refuses the local PGlite when NODE_ENV=production (a container without DATABASE_URL would migrate nothing).
process.env.APP_MIGRATE_ON_BOOT = "off";
const { MigrationError, migrationStatus, runMigrations } = await import("../src/migrate.js");
const { openDb } = await import("../src/db.js");

const url = process.env.DATABASE_URL;
if (!url && process.env.NODE_ENV === "production") {
  console.error("DATABASE_URL is not set: refusing to migrate a local PGlite directory in production");
  process.exit(2);
}
const target = url ? (() => { try { const u = new URL(url); return `postgres ${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`; } catch { return "postgres (DATABASE_URL)"; } })()
  : `pglite ${process.env.PGLITE_DIR ?? ".pglite"}`;
console.log(`target: ${target}`);

const db = await openDb();
const pad = (v: number) => String(v).padStart(4, "0");
try {
  if (process.argv.includes("--status") || process.argv.includes("--check")) {
    const s = await migrationStatus(db);
    for (const r of s.applied) console.log(`applied  ${pad(r.version)}_${r.name}  ${new Date(r.applied_at).toISOString()}`);
    for (const m of s.pending) console.log(`pending  ${pad(m.version)}_${m.name}`);
    for (const c of s.conflicts) console.log(`CONFLICT ${c}`);
    // Packs' own migrations (mold_v0-038), after the shell's.
    for (const p of s.packs) {
      for (const r of p.applied) console.log(`applied  pack ${p.pack} ${pad(r.version)}_${r.name}  ${new Date(r.applied_at).toISOString()}`);
      for (const m of p.pending) console.log(`pending  pack ${p.pack} ${pad(m.version)}_${m.name}`);
      for (const c of p.conflicts) console.log(`CONFLICT ${c}`);
    }
    if (s.legacy) console.log("(no schema_migrations table yet: a database from before versioned migrations; 0001_baseline brings it in)");
    const pending = s.pending.length + s.packs.reduce((n, p) => n + p.pending.length, 0);
    const conflicts = s.conflicts.length + s.packs.reduce((n, p) => n + p.conflicts.length, 0);
    if (process.argv.includes("--check") && (pending || conflicts)) {
      console.error(`${pending} pending, ${conflicts} conflict(s)`);
      process.exitCode = 1;
    }
  } else {
    // A lock timeout (a long query holding a table) is retried a few times before giving up.
    for (let attempt = 1; ; attempt++) {
      try {
        const { applied } = await runMigrations(db, { log: (l) => console.log(l) });
        console.log(applied.length ? `applied ${applied.length}: ${applied.join(", ")}` : "up to date: nothing to apply");
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== "55P03" || attempt >= 4) throw e;
        console.error(`lock timeout (attempt ${attempt}); retrying in ${attempt * 5}s`);
        await new Promise((r) => setTimeout(r, attempt * 5000));
      }
    }
  }
} catch (e) {
  console.error(e instanceof MigrationError ? `migration error: ${e.message}` : e);
  process.exitCode = 1;
} finally {
  await db.close();
}
