-- Rolling back past 0030_run_output_missing (mold_v0-188), for a release from before it (and before rolling back an
-- earlier migration, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0030_run_output_missing.sql
-- A run that failed 'output_missing' becomes a 'run' failure, the kind an older release gave every failure of its
-- program (its error, naming the missing output, is kept as it is); then error_kind's check is the one 0005 made, and the
-- ledger row goes. Found by its name, so it also undoes it where it was recorded under another number. Refused when a
-- later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'run_output_missing');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'run_output_missing is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (run_output_missing): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  UPDATE runs SET error_kind = 'run' WHERE error_kind = 'output_missing';
  ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_error_kind_check;
  ALTER TABLE runs ADD CONSTRAINT runs_error_kind_check CHECK (error_kind IN ('infrastructure', 'run', 'validation', 'timeout', 'cancelled'));
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
