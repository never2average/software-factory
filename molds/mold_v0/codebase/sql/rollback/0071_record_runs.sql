-- Rolling back past 0071_record_runs (mold_v0-310), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0071_record_runs.sql
-- Drops the via columns and the indexes: the records and their history stay, with their writers (written_by, updated_by,
-- by), only without the agent session behind a person's write (the older release never wrote or read one). Found by
-- its name, so it also undoes it where it was recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'record_runs');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'record_runs is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (record_runs): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP INDEX IF EXISTS workspace_records_written_run_idx;
  DROP INDEX IF EXISTS workspace_records_updated_run_idx;
  DROP INDEX IF EXISTS workspace_records_via_idx;
  DROP INDEX IF EXISTS workspace_records_written_via_idx;
  DROP INDEX IF EXISTS record_changes_run_idx;
  DROP INDEX IF EXISTS record_changes_via_idx;
  ALTER TABLE workspace_records DROP COLUMN IF EXISTS written_via;
  ALTER TABLE workspace_records DROP COLUMN IF EXISTS updated_via;
  ALTER TABLE record_changes DROP COLUMN IF EXISTS via;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
