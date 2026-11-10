-- Rolling back past 0066_nested_runs (mold_v0-291), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0066_nested_runs.sql
-- Refused while any child is unsettled (stop the trees first: an older release would not settle them or return their
-- budgets). Drops programs, handles, evaluations and champions. Child sessions stay, as ordinary ended sessions: their
-- transcripts and spend are kept; the columns that placed them in a tree go. Found by its name, so it also undoes it where
-- it was recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'nested_runs');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'nested_runs is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (nested_runs): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  IF EXISTS (SELECT 1 FROM harness_children WHERE settled_at IS NULL) THEN
    RAISE EXCEPTION 'some child runs have not settled: stop their root sessions first, so their budgets are returned';
  END IF;
  DROP TABLE IF EXISTS harness_evaluations;
  DROP TABLE IF EXISTS harness_champions;
  DROP TABLE IF EXISTS harness_program_versions;
  DROP TABLE IF EXISTS harness_programs;
  DROP TABLE IF EXISTS harness_gateway_holds;
  DROP TABLE IF EXISTS harness_children;
  DROP INDEX IF EXISTS harness_sessions_ref_uq;
  DROP INDEX IF EXISTS harness_sessions_tree_idx;
  ALTER TABLE harness_sessions DROP COLUMN IF EXISTS program_version, DROP COLUMN IF EXISTS program_id, DROP COLUMN IF EXISTS children_spent_usd,
    DROP COLUMN IF EXISTS carved_usd, DROP COLUMN IF EXISTS ref, DROP COLUMN IF EXISTS depth, DROP COLUMN IF EXISTS root_id, DROP COLUMN IF EXISTS parent_id;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
