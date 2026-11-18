-- Rolling back past 0072_run_delivered_secrets (mold_v0-320), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0072_run_delivered_secrets.sql
-- Drops the table of sealed values runs were given: they live only as long as a run's attempt, and the older release
-- keeps them in each process's memory instead (a wake still running loses only the other instances' redaction of a value
-- rotated since it started). Found by its name, so it also undoes it where it was recorded under another number.
-- Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'run_delivered_secrets');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'run_delivered_secrets is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (run_delivered_secrets): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP TABLE IF EXISTS run_delivered_secrets;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
