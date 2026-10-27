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
migrations are applied there too (Vercel has no release step), unless `APP_MIGRATE_ON_BOOT=off`, in which case
the process refuses to start until `db:migrate` has run. Vercel preview deployments (`VERCEL_ENV=preview`) only check
by default, so a preview's unmerged migration is never recorded in a database production also uses. A migration waits
at most 15 seconds for a table or the migration lock (`lock_timeout`), so it fails instead of queueing traffic behind
it; `db:migrate` retries a lock timeout three times. Replicas starting together take turns on a
transaction-level advisory lock and re-read what is applied after taking it, so each migration runs once.

**From schema-on-boot.** Before this, every process re-ran the whole of `sql/schema.sql` (idempotent `IF NOT EXISTS`
statements and guarded backfills) on start. `0001_baseline.sql` is that file, byte for byte. A database created the
old way has no `schema_migrations` table; the first `db:migrate` (or boot) runs the baseline once more, which changes
nothing that is already there and adds whatever an older release had not created yet, then records it.
Repairs and seed rows in the baseline (zero limits, agent profile copies, sandbox error splits, model prices) used to re-run
on every boot; now they run once. A repair or seed that must happen again goes in a new migration (or in code).
`npm run test:migrations` proves it: databases built by the old schema-on-boot path and by the migrations as they were
before mold_v0-049 (recorded up to 0001, 0003, 0008, 0013 and 0016), each with rows in every table, are migrated, and every
row comes out identical; their shell tables, columns, defaults, constraints, indexes, functions and policies equal a
database built from scratch (with the host pack, every one of them does, the product's tables included); a second run
applies nothing; an edited migration is refused. `MIGRATIONS_PG_URL` runs the same on a real Postgres (plus replicas
racing to migrate).

**The product's tables left the base schema (mold_v0-049).** `0001_baseline.sql` was the product's whole schema; its
own tables (its products, run definitions, runs and their sessions, agent profiles, tasks and the rest) moved to its host pack's
migrations, under the names they had (MOLD.md "Host packs": `host.schema`), so a database built with no packs has none
of them. Three merged files were rewritten once for it, the only time: `0001_baseline` (the shell's tables only),
`0003_row_level_security` and `0009_usage_and_limits` (the gateway's session rule through a function, `app_session_org()` since 0024, so
it no longer names the sessions table). `src/migrate.ts` `SPLIT_MIGRATIONS` lists each file's earlier checksum: a
database that applied the earlier version keeps it, and it is not reported as edited. That database already has the
product's tables with their rows, so the host pack's migrations that took them over (`host.schema.adopts`) are recorded
there without running; nothing in them touches its rows. `0017_gateway_session_policies` gives an older database the
same gateway policies a new one gets. `scripts/fixtures/pre-049-migrations/` keeps the three earlier files: `npm run
test:migrations` builds databases at the older versions from them (with rows in every table) and upgrades each.
Any other edit of a merged file is still refused.

**Tables a host pack hands back (mold_v0-142).** The account context and memory tables (`account_context`,
`user_context`, `context_memories`) were the first product's host pack's and are the shell's again:
`0025_account_context_memory` makes them with exactly the statements that made them, and the same row-level security.
Where a database already has all three in the shape that migration gives them (`src/migrate.ts` `tableShape`: columns,
constraints, indexes, row-level security, policies, the tenant role's grants; the same on any server version), it is
recorded as **adopted** without running: nothing touches those tables or their rows, and the ledger
`schema_adoptions` keeps what was adopted, from what, and the shape's sha256 (the pack migrations adopted for the split
above are written there too). Where none is, it runs. Some of them, or another shape: refused, nothing changed, and the
message lists what differs. The host pack's migrations that made them are rewritten without them once, and their earlier
checksums are accepted for those files only (pack.json `host.schema.split`).

**And again (mold_v0-143).** `0026_journeys_and_tips` does the same for the six tables of the `journeys` and `tips`
components (`nudges`, `nudge_prefs`, `journey_templates`, `journey_progress`, `adoption_help`, `journey_seed`), with
their own rules (the templates' table shared: the platform's rows, `org_id` NULL, readable by every workspace; the seed
ledger read-only). One more case runs it on a database that has them: one that never had row-level security before
this run (the schema-on-boot path, or one recorded only up to 0001), where `0003_row_level_security` secures every
workspace table its own way in the same run (`ADOPTING_MIGRATIONS` `secured_after`); their structure must be exactly
0026's, and its statements, idempotent, give them their own rules. The host pack's files rewritten a second time keep
both earlier checksums: `host.schema.split` takes a list.

| Command | What it does |
|---|---|
| `npm run db:rehearse -- [--dry-run] [--json]` | applies what is pending to the database it is given and reports, measured from the database: pending, applied or adopted, every relation created, changed or dropped, the adopted tables' rows and catalog rows before and after (equal catalog stamps: no DDL reached the table), every row count, and `check:rls`. It changes that database: give it a copy |

Rolling back to a release from before 0026: `sql/rollback/0026_journeys_and_tips.sql` first, the same way (adopted:
only its ledger rows go; made: dropped only when all six are empty). Rolling back to a release from before 0025:
`sql/rollback/0025_account_context_memory.sql` (before 0024's, which refuses while 0025 is applied; it refuses while
0026 is). Where 0025 was adopted it leaves the tables, rows, policies and grants exactly as they
are (the host pack's again in that release) and removes only 0025's ledger rows; where 0025 made them it drops them only
when all three are empty, and otherwise refuses and changes nothing.

The factory runs it on a copy of a live database (`provision.py <app> --rehearse-migrations`: a Neon branch, deleted
after). `npm run test:migrations` proves adoption on new, pre-049 and post-049 databases, with their rows and catalog
rows untouched, and the refusals.

**Writing a migration.****Writing a migration.**
- Add the next number: `sql/migrations/0002_what_it_does.sql`. Never edit a merged file: `db:migrate` refuses when an
  applied file changed (a booting process logs it and runs, unless something is also pending). Numbers have no gaps.
- A file runs inside a transaction with the other pending ones: no `CREATE INDEX CONCURRENTLY` or other statements
  that cannot run in a transaction.
- Keep it compatible with the release still running during a rolling deploy (and with the previous release, which a
  rollback runs against the newer schema: it starts, and logs that the schema is newer): add a column (nullable or with a
  default), backfill, ship the code that uses it, and drop the old one in a later migration.

**Rolling back.** A release older than the database (a rollback) runs and logs that the schema is newer; migrations
must stay backward compatible for that. One exception, with its own way back: `0024_neutral_database_names`
(mold_v0-097) renames the shell's database functions, the tenant role and the tenant setting to neutral names
(`app_tenant_role()`, `app_tenant_org()`, `app_session_org()`, `app_run_charge*()`, `app_tenant_<hash>`, `app.org_id`).
It renames in place: a policy, a trigger and a grant hold a function or a role by its id, so every policy follows with
none rewritten, no table is locked and no row is touched (a catalog row per name). Rehearsed on Postgres 17 as a
non-superuser login with the right to create roles (as on a managed database), 520,000 rows, a long read open on the
busiest table and a release from before 0024 serving tenant transactions the whole time: 47 ms, no lock on any of the
app's tables (only catalog rows: functions, roles, memberships), no table or index rewritten, every row kept, no error
and no row of another workspace for the release serving through it, `check:rls` clean after. The old names stay until a later cleanup, for the release still serving during a rolling deploy and for a
pack migration written before: each old function is a one-line alias of the new one (the old role function names
the new role, so a pack migration that grants through it grants to the role tenant work runs as; a policy a pack
migration writes through an alias is re-pointed at the function by the runner, in the same transaction); the old role
is a role of its own with nothing but membership in the new one, which that release switches to; and the new function
reads the old setting when the new one is unset. `npm run check:rls` holds the alias role to that (no grant, no policy,
no other membership, no login) and probes a query made the old way: its own workspace's rows only, none with no
workspace set. A release from before 0024 started after it (a rollback) finds the new names in every policy and keeps
tenant queries refused (platform work carries on; nothing is opened): run `sql/rollback/0024_neutral_database_names.sql`
once (`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f ...`) before starting it; it is 0024 in reverse, renames only, and
`npm run test:migrations` proves it leaves exactly the database 0023 left. Rolling back to a release from before versioned migrations is not supported
once a migration after the baseline exists: those releases re-run the old schema file on every boot.
