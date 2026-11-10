-- Rolling back past 0068_health_samples_scheduler (mold_v0-293), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0068_health_samples_scheduler.sql
-- Drops the four scheduled-work columns of Health's samples (numbers only, platform bookkeeping): the older release
-- draws Scheduled work's cards without sparklines. Found by its name, so it also undoes it where it was recorded under
-- another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'health_samples_scheduler');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'health_samples_scheduler is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (health_samples_scheduler): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  ALTER TABLE health_samples DROP COLUMN IF EXISTS scheduler_ms;
  ALTER TABLE health_samples DROP COLUMN IF EXISTS scheduler_failures;
  ALTER TABLE health_samples DROP COLUMN IF EXISTS scheduler_runs;
  ALTER TABLE health_samples DROP COLUMN IF EXISTS scheduler_jobs;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
