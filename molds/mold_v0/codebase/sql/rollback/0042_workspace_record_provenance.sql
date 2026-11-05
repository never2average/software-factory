-- Rolling back past 0042_workspace_record_provenance (mold_v0-236), for a release from before it (and before rolling
-- back 0041_email_files, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0042_workspace_record_provenance.sql
-- Drops what each workspace row records of its writers (provenance, written_by, updated_by). The rows themselves, their
-- fields and their sources stay exactly as they are; the older release never read the marks. Found by its name, so it
-- also undoes it where it was recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'workspace_record_provenance');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'workspace_record_provenance is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (workspace_record_provenance): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  ALTER TABLE workspace_records DROP COLUMN IF EXISTS updated_by;
  ALTER TABLE workspace_records DROP COLUMN IF EXISTS written_by;
  ALTER TABLE workspace_records DROP COLUMN IF EXISTS provenance;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
