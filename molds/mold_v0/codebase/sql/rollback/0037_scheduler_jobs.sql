-- Rolling back past 0037_scheduler_jobs (mold_v0-204), for a release from before it (and before rolling back an earlier
-- migration, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0037_scheduler_jobs.sql
-- The table holds only the scheduled work's last runs (platform bookkeeping the staff console's Health reads, no
-- workspace's data, written again by the next run), so it goes with its rows. Found by its name, so it also undoes it
-- where it was recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'scheduler_jobs');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'scheduler_jobs is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (scheduler_jobs): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP TABLE IF EXISTS scheduler_jobs;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
