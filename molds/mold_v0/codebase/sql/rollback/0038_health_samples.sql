-- Rolling back past 0038_health_samples (mold_v0-210), for a release from before it (and before rolling back an earlier
-- migration, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0038_health_samples.sql
-- The table holds only the Health › Status samples (numbers and states, platform bookkeeping, no workspace's data, kept
-- 35 days at most), so it goes with its rows: the graphs start again from the next sample. Found by its name, so it also
-- undoes it where it was recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'health_samples');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'health_samples is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (health_samples): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP TABLE IF EXISTS health_samples;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
