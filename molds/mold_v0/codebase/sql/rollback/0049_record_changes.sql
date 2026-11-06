-- Rolling back past 0049_record_changes (mold_v0-256), for a release from before it (and before rolling back
-- 0048_harness_session_tokens, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0049_record_changes.sql
-- Drops the records' change history: the records themselves stay as they are, and the data trail (0031) keeps who
-- changed what. A record's page in the older release has no history section, so nothing there reads it. Found by its
-- name, so it also undoes it where it was recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'record_changes');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'record_changes is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (record_changes): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP TABLE IF EXISTS record_changes;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
