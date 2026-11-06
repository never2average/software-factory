-- Rolling back past 0047_run_record_link (mold_v0-254), for a release from before it (and before rolling back
-- 0046_model_price_gpt_56_luna, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0047_run_record_link.sql
-- Drops the record a run was started on. The runs themselves stay, with their spend and results; a record's page in the
-- older release has no runs section, so nothing there reads the link. Found by its name, so it also undoes it where it
-- was recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'run_record_link');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'run_record_link is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (run_record_link): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP INDEX IF EXISTS runs_record_idx;
  ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_record_both;
  ALTER TABLE runs DROP COLUMN IF EXISTS record_key;
  ALTER TABLE runs DROP COLUMN IF EXISTS record_area;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
