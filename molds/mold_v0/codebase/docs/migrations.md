# Database migrations

The schema is versioned: `sql/migrations/NNNN_name.sql`, applied once each, in order, and recorded in
`schema_migrations` (version, name, checksum, when). `src/migrate.ts` runs them; `npm run db:migrate` is the command.

| Command | What it does |
|---|---|
| `npm run db:migrate` | applies what is pending, in one transaction under the migration lock |
| `npm run db:migrate -- --status` | lists applied and pending migrations; changes nothing |
| `npm run db:migrate -- --check` | exits 1 when anything is pending (for a deploy gate); changes nothing |
| `npm run test:migrations` | proves an existing database upgrades cleanly (below) |

**When they run.** The VM deploy (`deploy/rolling-deploy.sh`) runs `db:migrate` in a one-off container of the new
image before starting the new replica; a failed migration stops the deploy with the old replicas still serving. Every
process also checks on first database use: a current database costs two catalog reads (no DDL, no lock); pending
migrations are applied there too (Vercel has no release step), unless `OCTILLION_MIGRATE_ON_BOOT=off`, in which case
the process refuses to start until `db:migrate` has run. Vercel preview deployments (`VERCEL_ENV=preview`) only check
by default, so a preview's unmerged migration is never recorded in a database production also uses. A migration waits
at most 15 seconds for a table or the migration lock (`lock_timeout`), so it fails instead of queueing traffic behind
it; `db:migrate` retries a lock timeout three times. Replicas starting together take turns on a
transaction-level advisory lock and re-read what is applied after taking it, so each migration runs once.

**From schema-on-boot.** Before this, every process re-ran the whole of `sql/schema.sql` (idempotent `IF NOT EXISTS`
statements and guarded backfills) on start. `0001_baseline.sql` is that file, byte for byte. A database created the
old way has no `schema_migrations` table; the first `db:migrate` (or boot) runs the baseline once more, which changes
nothing that is already there and adds whatever an older release had not created yet, then records it.
Repairs and seed rows in the baseline (zero limits, persona copies, sandbox error splits, model prices) used to re-run
on every boot; now they run once. A repair or seed that must happen again goes in a new migration (or in code).
`npm run test:migrations` proves it: databases built by the old schema-on-boot path and by the migrations as they were
before mold_v0-049 (recorded up to 0001, 0003, 0008, 0013 and 0016), each with rows in every table, are migrated, and every
row comes out identical; their shell tables, columns, defaults, constraints, indexes, functions and policies equal a
database built from scratch (with the host pack, every one of them does, the product's tables included); a second run
applies nothing; an edited migration is refused. `MIGRATIONS_PG_URL` runs the same on a real Postgres (plus replicas
racing to migrate).

**The product's tables left the base schema (mold_v0-049).** `0001_baseline.sql` was the product's whole schema; its
own tables (products, scenarios, simulations and their sessions, personas, tasks and the rest) moved to its host pack's
migrations, under the names they had (MOLD.md "Host packs": `host.schema`), so a database built with no packs has none
of them. Three merged files were rewritten once for it, the only time: `0001_baseline` (the shell's tables only),
`0003_row_level_security` and `0009_usage_and_limits` (the gateway's session rule through `octillion_session_org()`, so
it no longer names the sessions table). `src/migrate.ts` `SPLIT_MIGRATIONS` lists each file's earlier checksum: a
database that applied the earlier version keeps it, and it is not reported as edited. That database already has the
product's tables with their rows, so the host pack's migrations that took them over (`host.schema.adopts`) are recorded
there without running; nothing in them touches its rows. `0017_gateway_session_policies` gives an older database the
same gateway policies a new one gets. `scripts/fixtures/pre-049-migrations/` keeps the three earlier files: `npm run
test:migrations` builds databases at the older versions from them (with rows in every table) and upgrades each.
Any other edit of a merged file is still refused.

**Writing a migration.**
- Add the next number: `sql/migrations/0002_what_it_does.sql`. Never edit a merged file: `db:migrate` refuses when an
  applied file changed (a booting process logs it and runs, unless something is also pending). Numbers have no gaps.
- A file runs inside a transaction with the other pending ones: no `CREATE INDEX CONCURRENTLY` or other statements
  that cannot run in a transaction.
- Keep it compatible with the release still running during a rolling deploy (and with the previous release, which a
  rollback runs against the newer schema: it starts, and logs that the schema is newer): add a column (nullable or with a
  default), backfill, ship the code that uses it, and drop the old one in a later migration.

**Rolling back.** A release older than the database (a rollback) runs and logs that the schema is newer; migrations
must stay backward compatible for that. Rolling back to a release from before versioned migrations is not supported
once a migration after the baseline exists: those releases re-run the old schema file on every boot.
