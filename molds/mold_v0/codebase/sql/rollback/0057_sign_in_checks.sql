-- Rolling back past 0057_sign_in_checks (mold_v0-270), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0057_sign_in_checks.sql
-- Drops Health › Sign-in's last report and the callbacks it saw: the older release has no such tab, and a later one
-- checks again from nothing. Found by its name, so it also undoes it where it was recorded under another number.
-- Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'sign_in_checks');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'sign_in_checks is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (sign_in_checks): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP TABLE IF EXISTS sign_in_checks;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
