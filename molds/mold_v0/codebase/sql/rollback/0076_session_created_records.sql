-- Rolling back past 0076_session_created_records (mold_v0-333), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0076_session_created_records.sql
-- Drops the index on the record a session made (the older release never reads it; the sessions and their policies
-- stay). Found by its name, so it also undoes it where it was recorded under another number.
-- Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'session_created_records');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'session_created_records is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (session_created_records): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP INDEX IF EXISTS harness_sessions_created_record_idx;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
